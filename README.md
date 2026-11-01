# Agent Kill Switch LAB

A demo of how an organization stops a runaway AI agent: caps that trip on their own, an operator kill switch, and the very next call failing. The H2 2026 update adds a second tab that shows what revoking a Federated Identity cuts off.

Tier: Demo
Repo: https://github.com/ping-sandbox/agent-kill-switch-LAB
Catalog: D14

The repository is not created in that organization yet (creating it needs the owner's approval); the URL is where it will live.

## What is simulated

Everything. **Mock mode** (the default) runs fully offline in one process: a scripted agent, a mock gateway and a stub token service for the Kill switch tab, and a table generated from the engine for the Federated Identity tab. **Live mode** exists only on the Federated Identity tab and is a real engine inside the same process: real RS256 signing and verification with throwaway RSA keys, driven by your own actions. It contacts nothing outside `127.0.0.1` and uses no tenant, no model and no real platform. The banner on every tab says the same.

**Ping release claim, UNVERIFIED on our tenant.** The Federated Identity tab models lines from the deck "ID4AI Workforce - H2 2026" (slide 40, with slides 39 and 41 for context). The 2026-11-02 release is not on our tenant. Each claim carries one tag:

| Tag | Meaning |
| --- | --- |
| `deck claim` | said by the deck, with its slide number |
| `console swagger name (schema only)` | a field or path name in the console swagger; it proves the name exists, not how it behaves |
| `lab reading` | how this lab chose to read a deck line (for example "immediately" read as "the identity state is read on every request") |
| `lab-invented` | made up for this demo (identities, subjects, `.example` hosts, 600 s default lifetime, the story) |
| `measured (our note)` | computed from a run of this lab's own engine; says nothing about Ping's timing |
| `roadmap` | slide 21 marks it Q4 2026 or Planned; shown as roadmap, no behaviour claimed |

Ping's numbers (a fifteen-minute key set refresh, a one-hour default lifetime) are quoted as the deck's, never as this lab's.

### Provenance of the Kill switch tab

The kill-switch behaviour (revoke blocks the next call, in-flight calls finish, the kill is checked on every call, kill and gate use the same agent key, unrevoke, auto-reset, live steps) is reproduced from the AI-DEMO2 demo environment. **How real PingOne products implement revoke and caps is as modelled in the demo environment, UNVERIFIED against product documentation. This app makes no claim about real product defaults, limits or latency.** All numbers (windows, budgets, prices, TTLs, cooldowns) are invented. See [docs/safety.md](docs/safety.md) for the sourced-versus-invented table and the exact in-flight semantics.

### The Federated Identity revoke tab (H2 2026 update)

Open `http://127.0.0.1:6550/#federated-identity` (Mock first, then Live). It shows, for one revoke of one identity:

* **What is cut:** every service family (MCP, A2A, LLM) and the agent access key that names the identity, on the very next request, with the answer per service. The deck says "immediately" and gives no number; this lab counts requests, not milliseconds.
* **What stays valid:** the platform's token itself (signature, binding, lifetime and expiry still pass; only the identity is refused), the platform's willingness to keep minting tokens, the other identity (also during an issuer outage, on the last known good key set), and the backend's own credential. All counts are computed from the answers on screen.
* **What the deck does not say:** how fast as a number, in-flight requests, delete versus disable versus expire, restore, platform-side revocation, backend credentials, replicas. Each row says what the lab does about it and its tag.
* **Roadmap, not built:** Agent Lifecycle Management (provision, version, disable and decommission), Q4 2026 on slide 21. No behaviour.
* **Why it matters:** the Challenge, Technical and Business lines of slide 40, as Ping's claims.
* A diagram loaded as diagram-studio/1 data (movable boxes, Simulate with a step-time control, Reset that also restores the boxes), and Presenter mode (press P, Esc leaves it; the banner stays).

Not built here: the second half of the row (Agent Insights: Guard, Alerts, Prompts, slides 54) belongs to the agent-audit-trail app; slide 41 (Self-Hosted Agents) is context only.

## Run from a clone

Prerequisites: Node 26 or newer. Docker only for the Docker form.

```bash
git clone https://github.com/ping-sandbox/agent-kill-switch-LAB.git
cd agent-kill-switch-LAB
npm ci
npm run build       # builds the web UI into web/dist; the server serves it
npm start           # http://127.0.0.1:6550/
```

Open `http://127.0.0.1:6550/` (the Kill switch tab) or `http://127.0.0.1:6550/#federated-identity`. Everything works in Mock mode with no setup. The Live view of the Federated Identity tab also needs no setup: it is a local engine.

```bash
npm install         # instead of npm ci, when you change dependencies
npm run dev         # Vite on http://127.0.0.1:6560/, proxying /api to the server on 6550
npm run content-pack   # regenerate and validate content-pack.json from content/*.json
npm run fedid-mock     # regenerate server/src/fedid/mockTable.json from the engine
npm run talk-track     # regenerate the generated section of docs/talk-track.md
npm run e2e         # headless Chromium drives the Kill switch tab on 6570 (needs npm run build first)
npm run e2e-fedid   # headless Chromium drives the Federated Identity tab on 6571, Mock and Live, light and dark, 1280 and 375 px
npm run red-checks  # slow: mutate each server safety check in a copy and require the suite to fail
npm run red-checks-web  # the same for the UI behaviours
npm run red-checks-fedid  # the same for the Federated Identity section, server and page
```

## Settings file

This app needs no setting. It reads the repo-root `.env` (real environment variables win), and it does not read `~/Development/.env`. Every key is optional:

* `CUSTOMER_CONFIG`: path of a `customer.config.json` (default: the repo root) that brands the Federated Identity story; see `customer.config.example.json`.

* `KILL_SWITCH_PORT`: the server port (default 6550; only 6550-6599 accepted).
* `KILL_SWITCH_BIND`: the bind address; the container sets it, a local run never should.
* `MODE`: `local` (default) or `se-mock` (the hosted mock build; refuses every live or credential setting).
* `KILL_SWITCH_PUBLIC_HOST`: the one public host the hosted build answers to.

No admin or worker credential is used anywhere.

## Ports, and what to do if the port is taken

Ports: Agent Kill Switch listens on 6550 (set with KILL_SWITCH_PORT, default 6550).
Port range for this app: 6550-6599. 6551-6559 are reserved for stubs (none are opened), the Vite dev server uses 6560 (VITE_PORT), the e2e runs use 6570 and 6571 (E2E_PORT, E2E_FEDID_PORT), the Federated Identity tests 6572-6576, the other tests 6580-6599. The Docker host port is fixed at 6550 (no variable).

If the port is taken:
1. Find what is using it:
   lsof -iTCP:6550 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   KILL_SWITCH_PORT=6552 npm start
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.

## Mock and live modes

* **Kill switch tab:** Mock only (a scripted demo). The header shows `DEMO`.
* **Federated Identity tab:** the **Story vertical** picker (finance, health, retail) fills the `{{cast}}` tokens of the story (brand, host, team, operator name) from a synthetic pack; an optional git-ignored `customer.config.json` (see `customer.config.example.json`) overrides the brand, host label and operator name. The **Mock / Live** toggle is on the tab, the mode is named in the banner on every tab and in presenter mode.
  * **Mock:** the 18-step story as a table, generated from the engine with a fixed marker instead of a signature (`npm run fedid-mock`). A test regenerates it and fails on any drift, and another runs the same story with real signing and requires the same decisions (parity).
  * **Live:** the real engine. You choose the workload, service, what it presents (its token or an access key that names it), the token lifetime, then revoke an identity (operator and reason are masked for secret shapes first), switch an issuer outage on, move virtual time, or press Run the story. A refusal is a real 401 or 403 answer; the browser logs those as console messages, which is expected. The one raw token shown is mock-issued, signed with a throwaway key, and appears only in the answer to the request that presented it.
  * The hosted mock build refuses Live (403) and shows the Mock table.
* Reset (the button, `POST /api/reset`) puts everything back, including the audit epoch and every diagram's box positions.

Caps: 300 requests and 40 issuer outage changes per Live session (429, nothing evicted; Reset starts again), the virtual clock may move 30 days at most, request bodies are 2 KB. At most 200 visitor workspaces are held: a new visitor past that gets a JSON 503 and no existing workspace is evicted (an idle one expires after the 8 h cookie lifetime).

**Masking is a heuristic.** The text typed into the operator and reason fields is masked for the secret shapes listed in `docs/safety.md` before it is stored or shown; a secret in a shape not on that list can get through. Do not type real secrets.

## Health, doctor and reset

```bash
npm run doctor      # node, bind, port range, scenario tables, the Federated Identity Mock table and diagram, and whether port 6550 is free (a busy port is a warning, not a failure)
```

`GET /api/health` answers `demo-health/1`. `POST /api/reset` (or the Reset button) clears run state; there are no saved settings to keep.

```bash
curl -s http://127.0.0.1:6550/api/health
curl -s http://127.0.0.1:6550/api/fedid/mock
curl -s -X POST http://127.0.0.1:6550/api/reset -H 'content-type: application/json' -d '{}'
```

### The web UI

Open `http://127.0.0.1:6550/` after `npm run build && npm start`. Story first: a four-step strip (the agent works, a cap or an operator steps in, access is revoked, the next call fails) that follows the real state, then:

* **Run it**: scenario picker, **Run** (whole script), **Step** (one action), **Simulate** (real steps at 0.5x to 4x, with Pause) and **Reset**. You can pull the kill switch part-way through a Simulate; the end-state check then says you intervened.
* **Where each call goes**: React Flow diagram (agent, revocation check, rate cap, cost cap, tools, with the token service, the kill switch and the audit trail). Boxes are movable with the mouse (they are not tab stops; a second skip link goes straight to the kill switch). The highlight is the last real step, and a refused call shows the box it stopped at.
* **Caps**: the rate window as cells up to the cap, and the money and token budgets burning down with the cap line at the empty end.
* **Kill switch**: armed / tripped (auto) / killed (manual) / reset per agent, a big **Kill** button, **Unrevoke** behind a confirm step that needs an operator name, a global switch, and the choice of what happens to work already in flight.
* **Live activity**, **Access tokens** (TTL countdown, revoked marks), **The gap** (a timeline from the revoke to the first refused call, with the short-lifetime lesson), **Blast radius** (two agents, one killed) and the **Audit trail** with a Verify button.
* DEMO badge on every page, `MODEL, UNVERIFIED` badges wherever product behaviour is described, dark and light themes (no purple), `aria-live` announcements of trips and kills, keyboard-only reach of Run and Kill.

How it is built: the UI reads only the API above. The token list and the gap timeline are derived in the browser from the event stream (the server sends token ids, never token values). Every string from the server is rendered as text. The server serves `web/dist` itself with a same-origin CSP (`script-src 'self'`, `connect-src 'self'`, no framing), so there is no CORS and no off-origin request.

**Time is scenario time.** The running server's clock starts at the wall-clock time and then moves only when a scenario moves it, so a slow human cannot expire a rate window or a token by stepping slowly, and every scripted run gives the same numbers. The token countdown therefore counts down as the script advances, not with your wall clock. The **audit trail is the exception**: each entry has `at` (real wall-clock time, when it was written) and `scenarioAt` (the demo clock at that moment), so a kill and a later unrevoke are really apart in `at`. The audit cap (2000) can still evict old entries under a flood of scenario runs; `GET /api/audit/verify` reports `evicted`, and `ok: true` means the entries that remain are intact, not that nothing was dropped.

**An operator kill is not cleared by starting a scenario.** Run and Step answer `409 kill_in_force` while a kill made through `POST /api/kill` (or the Kill buttons) is in force, because a scenario builds a fresh world and would otherwise clear the kill with no audit entry. Unrevoke it (audited) or Reset. A kill that a scenario script performs itself does not block the next scenario.

### The scenarios

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

### API

`GET /api/health` (`demo-health/1`), `/api/scenarios`, `/api/agents`, `/api/state`, `/api/events?since=&limit=`, `/api/audit?after=&limit=`, `/api/audit/verify`;
`POST /api/scenarios/:id/run`, `/api/scenarios/:id/step`, `/api/kill`, `/api/unrevoke`, `/api/reset`.

* `POST /api/kill` `{scope: "agent"|"global", agentId?, operator?, reason?, inFlight?: "finish"|"cancel"}`
* `POST /api/unrevoke` `{scope, agentId?, operator (required), reason?, resetBudget?}`

JSON bodies only (2 KB), same-origin only (cross-origin `Origin` / `Sec-Fetch-Site: cross-site` get 403, and a cross-site or same-site browser read of any `/api` route except `/api/health` is refused too, because a read can apply a due auto-reset; a browser that sends no `Sec-Fetch-Site` is not covered), loopback `Host` only (421), no credential headers (400). Architecture: [docs/architecture.md](docs/architecture.md). Safety rules and the test behind each: [docs/safety.md](docs/safety.md).

The Federated Identity section adds, all under `/api/fedid`: `GET /` (catalogue and claims), `/diagram`, `/mock`, `/state` (Live), and `POST /request` (200 allowed, 401 token not acceptable, 403 refused, each with the full result), `/revoke` (409 if already revoked), `/issuer` and `/advance`. Bodies are checked by type and against fixed tables; a bad body is 400 with a fixed message that never echoes what was typed.

## Docker (optional)

```bash
docker compose up --build -d
```

It publishes `127.0.0.1:6550` only (OrbStack, never Docker Desktop). The host port is fixed at 6550, with no override variable, so it cannot be pointed outside 6550-6599; `scripts/compose.test.mjs` pins the loopback publish.

* **Docker:** multi-stage `Dockerfile` (builds `web/dist`, ships the server and the built UI only, runs as the non-root `node` user, `HEALTHCHECK` on `/api/health`). `docker-compose.yml` publishes `127.0.0.1:6550:6550` only, with no volumes, no docker socket, no host network, a read-only root filesystem and no capabilities; `scripts/compose.test.mjs` pins all of that.
* **Learning Hub content pack:** `content-pack.json` (format `demo-content-pack/1`) is generated by `npm run content-pack` from `content/terms.json` and `content/stories.json` and validated with ajv against `docs/content-pack.schema.json`. That schema is a copy of the Learning Hub's `server/schema/content-pack.schema.json`; a test compares the two byte for byte when the hub repo sits beside this one. The pack lists no sources (no public documentation URL is cited here as verified) and repeats the MODEL, UNVERIFIED statement. `scripts/content-pack.test.mjs` pins freshness, the schema, scenario coverage, the provenance wording and that each story matches the UI story strip.
* **Hosted mock build (SE k8s, deferred by the owner on 2026-10-31, not required now):** the same image with `MODE=se-mock`: mock only, per-visitor workspaces, a `HOSTED SIMULATION` banner, manifests in `k8s/` and an owner-gated `k8s/deploy.sh`. See [docs/k8s.md](docs/k8s.md).
* **Demo shelf entry:** `docs/shelf-entry.json` (catalog id D14, port 6550). The rules the shelf applies to an entry are copied into `scripts/lib/shelf-registry-rules.mjs` and tested by `scripts/shelf-entry.test.mjs`. Edit `composeFile` to your checkout's absolute path.

## Tests

```bash
npm test
```

On Node 26: 188 server tests (node:test), 49 web tests (vitest) and 56 script tests (55 run and 1 is skipped when the Learning Hub repo is not beside the clone), exit 0. The tests use a glob (`node --test test/*.test.js`), a fake clock and no sleeps, and no wall-clock assertions. `npm run e2e` reports 59 PASS for the Kill switch tab and `npm run e2e-fedid` all checks passed for the new tab.

Red checks (each mutation changes one behaviour in a copy and requires the tests to fail): `npm run red-checks` reports all 63 mutations caught and `npm run red-checks-web` all 23 UI mutations caught. Federated Identity red checks: all 89 mutations caught (`npm run red-checks-fedid`; every editable field has a mutant, on the server and in the page). `scripts/docs.test.mjs` and `scripts/fedid-docs.test.mjs` pin these counts to the scripts, so they cannot drift silently.

### What the mutation checks cover, and what is not verified

The Kill switch red checks remove or invert one check at a time: cap comparisons and window boundaries, budget accounting (money and token +1 boundaries), per-call kill check, revoked-token acceptance, revocation-list refresh, token expiry, audit entries for kill and unrevoke, eviction and sequence checks, auto-reset scope and the global-kill case, blast radius, key derivation (NFKC fold, 64-char bound), model and tool lookups, operator name on unrevoke, Origin, Sec-Fetch-Site, JSON-only and chunked-body checks, Host guard, credential guard, read/write method split, redaction patterns, event inertness and bounds, wall-time audit stamps, the operator-kill block on scenario start, and in the UI the confirm step, the always-available Kill, the kill skip link, non-tab-stop diagram boxes, the diagram remount on Reset and reduced motion.

Not verified: the numbers quoted from earlier runs (KS2) are not repeated here, because the suites have changed; run `npm test` for the current counts. Only Node 26 is supported and tested. On a phone width (375 px) the Federated Identity diagram is held at a readable zoom on its first boxes and you pan to the rest, while the Kill switch diagram is shown whole and small. Equivalent mutants that no test can kill by behaviour (for example removing the audit `prevHash` link check, which the HMAC over `prevHash` makes redundant) are not pinned. The Docker image was last built on OrbStack for the Kill switch tab before this update; see "Docker" above.

## Troubleshooting

* **The port is taken:** see "Ports, and what to do if the port is taken" above.
* **The page says it cannot reach the server:** run `npm run build && npm start`; the server serves `web/dist` itself. `npm run doctor` says what is wrong.
* **The browser console shows 401 or 403 on the Federated Identity tab:** those are the gateway's deliberate refusals, not errors in the page.
* **`npm test` fails on a loaded machine:** the web suite has a 30 s timeout and the e2e waits are configurable (`KS_E2E_WAIT_MS`); run one suite at a time.
* **`npm run e2e` cannot start Chromium:** run `npx playwright install chromium`, or set `E2E_CHROMIUM` to a browser binary.

## Ownership

* Owner: the Ping demo family owner.
* License: MIT.
* Found a problem? Open an issue on the repository.
