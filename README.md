# Agent Kill Switch

A demo of how an organization stops a runaway AI agent: per-agent **rate caps** and **cost caps** that trip automatically, an operator **kill switch** that revokes the agent's access, and the very next call failing. It shows the access token being revoked, the token service refusing to issue a new one, what happens to a call that was already in flight, and how little the other agent notices.

Everything is a mock. A scripted agent calls mock tools through a mock gateway, with a stub token service. There is no tenant, no real model and no network beyond `127.0.0.1`.

## Status

Steps KS0 (server core) and KS1 (web UI, served by the server itself) are built and tested. Not built: content pack, shelf entry, CI and a runner.

## Provenance, in one paragraph

The kill-switch behaviour (revoke blocks the next call, in-flight calls finish, the kill is checked on every call, kill and gate use the same agent key, unrevoke, auto-reset, live steps) is reproduced from the AI-DEMO2 demo environment. **How real PingOne products implement revoke and caps is as modelled in the demo environment, UNVERIFIED against product documentation. This app makes no claim about real product defaults, limits or latency.** All numbers (windows, budgets, prices, TTLs, cooldowns) are invented. See [docs/safety.md](docs/safety.md) for the sourced-versus-invented table and the exact in-flight semantics.

## Run it

```bash
npm install
npm run doctor      # node, bind, port range, scenario tables, and whether port 6550 is free (a busy port is a warning, not a failure)
npm test            # server suite (node:test, fake clock) + web suite (vitest) + compose/hook/docs checks
npm run build       # build the web UI into web/dist; the server serves it
npm start           # http://127.0.0.1:6550/  (KILL_SWITCH_PORT to change; ports 6550-6599 only)
npm run dev         # Vite on http://127.0.0.1:6560/, proxying /api to the server on 6550
npm run e2e         # headless Chromium drives the real server on 6570 (needs npm run build first)
npm run red-checks  # slow: mutate each server safety check in a copy and require the suite to fail
npm run red-checks-web  # the same for the UI behaviours
```

```bash
curl -s http://127.0.0.1:6550/api/health
curl -s http://127.0.0.1:6550/api/scenarios
curl -s -X POST http://127.0.0.1:6550/api/scenarios/manual-kill/run -H 'content-type: application/json' -d '{}'
curl -s http://127.0.0.1:6550/api/state
curl -s -X POST http://127.0.0.1:6550/api/unrevoke -H 'content-type: application/json' \
  -d '{"scope":"agent","agentId":"agent-alpha","operator":"you","reason":"checked the logs"}'
curl -s http://127.0.0.1:6550/api/audit/verify
```

Step through a run one action at a time (`POST /api/scenarios/:id/step`), and pull the kill yourself part-way:

```bash
curl -s -X POST http://127.0.0.1:6550/api/scenarios/rate-loop/step -H 'content-type: application/json' -d '{}'
curl -s -X POST http://127.0.0.1:6550/api/kill -H 'content-type: application/json' -d '{"scope":"agent","agentId":"agent-alpha","operator":"you"}'
curl -s -X POST http://127.0.0.1:6550/api/scenarios/rate-loop/step -H 'content-type: application/json' -d '{}'   # entry.reason is agent_killed
curl -s 'http://127.0.0.1:6550/api/events?since=0'
```

Docker (OrbStack, never Docker Desktop): `docker compose up --build -d` (the host port is fixed at 6550, with no override variable, so it cannot be pointed outside 6550-6599). The port is published on `127.0.0.1` only, which `scripts/compose.test.mjs` pins.

## The web UI

Open `http://127.0.0.1:6550/` after `npm run build && npm start`. Story first: a four-step strip (the agent works, a cap or an operator steps in, access is revoked, the next call fails) that follows the real state, then:

* **Run it**: scenario picker, **Run** (whole script), **Step** (one action), **Simulate** (real steps at 0.5x to 4x, with Pause) and **Reset**. You can pull the kill switch part-way through a Simulate; the end-state check then says you intervened.
* **Where each call goes**: React Flow diagram (agent, revocation check, rate cap, cost cap, tools, with the token service, the kill switch and the audit trail). Boxes are movable (arrow keys too). The highlight is the last real step, and a refused call shows the box it stopped at.
* **Caps**: the rate window as cells up to the cap, and the money and token budgets burning down with the cap line at the empty end.
* **Kill switch**: armed / tripped (auto) / killed (manual) / reset per agent, a big **Kill** button, **Unrevoke** behind a confirm step that needs an operator name, a global switch, and the choice of what happens to work already in flight.
* **Live activity**, **Access tokens** (TTL countdown, revoked marks), **The gap** (a timeline from the revoke to the first refused call, with the short-lifetime lesson), **Blast radius** (two agents, one killed) and the **Audit trail** with a Verify button.
* DEMO badge on every page, `MODEL, UNVERIFIED` badges wherever product behaviour is described, dark and light themes (no purple), `aria-live` announcements of trips and kills, keyboard-only reach of Run and Kill.

How it is built: the UI reads only the API above. The token list and the gap timeline are derived in the browser from the event stream (the server sends token ids, never token values). Every string from the server is rendered as text. The server serves `web/dist` itself with a same-origin CSP (`script-src 'self'`, `connect-src 'self'`, no framing), so there is no CORS and no off-origin request.

**Time is scenario time.** The running server's clock starts at the wall-clock time and then moves only when a scenario moves it, so a slow human cannot expire a rate window or a token by stepping slowly, and every scripted run gives the same numbers. The token countdown therefore counts down as the script advances, not with your wall clock.

## The scenarios

| id | what happens | ends in |
| --- | --- | --- |
| `normal` | six calls well under every cap | alpha armed |
| `rate-loop` | a loop blows the rate cap (6th call in 10 s); the runaway keeps calling | alpha tripped (rate_cap), 5 allowed, 5 refused |
| `cost-expensive` | a huge large-model prompt takes the money budget over its limit | alpha tripped (cost_cap) |
| `manual-kill` | an operator kills alpha after three calls | alpha killed; gap 500 ms (to its next call) |
| `kill-unrevoke` | kill, two refused calls, operator unrevokes, fresh token, carries on | alpha armed |
| `in-flight` | the kill lands on a running 3 s export: it completes, the next call is refused | alpha killed, 1 completed after the stop |
| `blast-radius` | two agents; alpha killed, beta unaffected | alpha killed, beta armed with 6 of 6 allowed |
| `stale-token-gap` | kill revokes the token, but the gateway validates locally with a stale revocation list | 3 calls leak, first refusal 20 s after the kill |
| `auto-reset` | rate trip, 30 s cooldown, audited auto-reset | alpha armed again |

Each scenario declares its expected end state; the run response carries `run.expectation` with every check, and the tests assert them.

## API

`GET /api/health` (`demo-health/1`), `/api/scenarios`, `/api/agents`, `/api/state`, `/api/events?since=&limit=`, `/api/audit?after=&limit=`, `/api/audit/verify`;
`POST /api/scenarios/:id/run`, `/api/scenarios/:id/step`, `/api/kill`, `/api/unrevoke`, `/api/reset`.

* `POST /api/kill` `{scope: "agent"|"global", agentId?, operator?, reason?, inFlight?: "finish"|"cancel"}`
* `POST /api/unrevoke` `{scope, agentId?, operator (required), reason?, resetBudget?}`

JSON bodies only (2 KB), same-origin only (cross-origin `Origin` / `Sec-Fetch-Site: cross-site` get 403), loopback `Host` only (421), no credential headers (400). Architecture: [docs/architecture.md](docs/architecture.md). Safety rules and the test behind each: [docs/safety.md](docs/safety.md).

## Verification

Last run (KS0, working tree and a clean clone): `npm test` exits 0 with 81 server tests and 14 script tests; `npm run doctor` exits 0; `npm run red-checks` reports all 23 mutations caught. The mutations (each removes or inverts one check in a copy of the server): rate comparison `>=`, window boundary, money and token budget boundaries, per-call kill check, revoked-token acceptance, revocation-list refresh, token expiry boundary, missing kill/unrevoke audit entries, auto-reset scope, blast-radius token revocation, token issuance left open after a stop, charging a refused call, kill/gate key derivation, operator name on unrevoke, Origin check, Sec-Fetch-Site check, JSON-only body check, Host guard, credential guard, audit hash verification, and a token value leaking into events.

Docker (OrbStack): `docker compose up` built the image, the container answered `GET /api/health` with `state: ready` on `127.0.0.1:6550`, and `docker ps` showed the port published as `127.0.0.1:6550->6550/tcp`; the loopback publish is also pinned by `scripts/compose.test.mjs`. 

## Ports

Server 6550. 6551-6559 are reserved for stub listeners (none are opened, the tools are in-process). Vite dev uses 6560, the e2e run 6570, tests 6580-6599.

## License

MIT
