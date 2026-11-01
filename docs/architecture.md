# Architecture

Everything runs in one Node process. There is no tenant, no model, no network beyond `127.0.0.1`.

```
 scripted agent --(call + its own token)--> GATEWAY --(admitted)--> mock tool
   (planner)                                  |  1 global kill switch
        ^                                     |  2 agent kill-switch state
        |  new token (or "issuance_disabled") |  3 token check (introspect | local + revocation list)
        |                                     |  4 request shape (tool, model, counts)
   TOKEN SERVICE <--- revoke / disable ------ |  5 rate cap  (sliding window)  -> trip
   (short-lived opaque tokens,                |  6 cost cap  (tokens + money)  -> trip
    revocation list)                          v
                                       events (cursor)  +  audit (HMAC hash chain)
```

## Modules (`server/src`)

| File | Role |
| --- | --- |
| `clock.js` | The only source of time. A fake clock (tests) moves only when told; the live clock is scenario time: it starts at the wall-clock time and then moves only when a scenario advances it, so a scripted run gives the same numbers every time and a slow human cannot expire a window or token by stepping slowly. No module uses a timer or `Date.now()` except this one (and the health refresh). `wallNow` is real time and is used only to stamp the audit trail. |
| `policy.js` | Frozen tables: the two agents, three mock tools, an illustrative price table, default limits, gateway settings, `costMicros()` and `deriveAgentKey()`. |
| `tokens.js` | Stub token service: opaque short-lived tokens, a revocation list, per-agent issuance switch, bounded store. |
| `gateway.js` | The gateway and the kill-switch state machine (below). |
| `scenarios.js` | Nine scripted scenarios as data, each with the end state it must reach. |
| `runtime.js` | Owns clock, audit, events and the current world; runs scenarios (all at once or one action per step); is what the operator endpoints call. The scripted agent lives here: it keeps its own token and refreshes it once on a `token_*` refusal. |
| `events.js` | Bounded ring (500) with a monotonically increasing `seq`; `GET /api/events?since=` is the cursor. |
| `audit.js` | Append-only, HMAC hash-chained, capped (2000). Records scenario starts, trips, kills, unrevokes, auto-resets and resets. |
| `app.js`, `safety.js` | Express app, Host/Origin/credential guards, strict body validation. |
| `health.js`, `doctor.js` | `demo-health/1` and the preflight checks both are built from. |
| `redaction.js`, `sanitize.js` | Secret-looking text removed, hidden/control characters shown as `[U+XXXX]`, before anything is stored. |

## State machine (per agent)

```
            cap breached                    operator kill
  armed ───────────────────▶ tripped ──────────────────────▶ killed
    ▲  ◀── first admitted call ─┐   │  (auto-reset: rate trips only,   │
    │                           │   │   after cooldown, if enabled)    │
   reset ◀──────────────────────┴───┴──── operator unrevoke ◀──────────┘
```

* `tripped` is automatic (reason `rate_cap` or `cost_cap`); `killed` is an operator (reason `manual`); a tripped agent can be escalated to killed.
* `reset` is what an agent shows after it was cleared, by an operator `unrevoke` or by auto-reset. It behaves like `armed` and becomes `armed` on its first admitted call.
* Entering `tripped` or `killed` does three things at once: sets the state flag, revokes the agent's live tokens, and makes the token service refuse to issue new ones. Leaving it re-enables issuance. The global switch does the same for every agent and keeps issuance shut after an individual unrevoke.
* Only a rate trip with `autoReset` on comes back by itself, after `cooldownMs`, audited as `auto_reset`. A cost trip needs money back (an operator `unrevoke` with `resetBudget`); a manual kill never comes back without an operator.
* Auto-reset is evaluated lazily whenever the agent is looked at (a call or a state read), so there are no timers and tests are deterministic.

## The gap between revoke and the next denied call

Two independent mechanisms stop an agent, and the scenarios show each on its own:

* **Flag check** (`flagCheck: true`, the default): the gateway reads the kill-switch state on every call. The first call after the kill is refused, so the gap is the time to the agent's next call.
* **Token revocation**: with `tokenValidation: 'introspect'` the gateway asks the token service on every call (no gap). With `'local'` the gateway trusts a token it can verify itself and only refreshes its copy of the revocation list every `revocationSyncMs`; a revoked token keeps working until that refresh or until it expires, whichever is first. `stale-token-gap` runs this with the flag off: 3 calls get through and the first refusal comes 20 s after the kill. Shortening `tokenTtlMs` shrinks the worst case, which is the argument for short-lived tokens.

The state output reports `stop.leakedCalls` (calls admitted after the stop) and `stop.gapMs` (stop to first refusal).

## Time

A scenario action carries `after` (virtual ms). `runtime.execute` advances the clock, settles in-flight calls whose end time has passed, then acts. In tests the clock is fake, so the suite has no sleeps. In the running app the clock is scenario time: it starts at the wall-clock time and moves only when a scenario advances it, so cooldowns and TTLs elapse instantly during a scenario and real time never leaks into a run.

## API

`GET /api/health`, `/api/scenarios`, `/api/agents`, `/api/state`, `/api/events?since=&limit=`, `/api/audit?after=&limit=`, `/api/audit/verify`;
`POST /api/scenarios/:id/run`, `/api/scenarios/:id/step`, `/api/kill`, `/api/unrevoke`, `/api/reset`.
There is deliberately no endpoint that makes a call, issues a token or edits a limit. Events use cursor polling rather than SSE: simpler to bound and to test, and it needs no long-lived connections.

## Web UI (`web/`)

React + Vite, one `App` that polls `/api/state`, `/api/events?since=` and `/api/audit` every 1.5 s and refreshes after each action. `lib/derive.js` turns the event stream into the token list (a trip or kill revokes that agent's still-live tokens; a global kill revokes all; a new run or a reset starts a new world), the gap records (stop, calls admitted after it, first refusal), the diagram highlight for the last step, and the `aria-live` announcements. `Flow.jsx` draws the checks in the order the gateway runs them (revocation, rate, cost). The built files in `web/dist` are served by `app.js` (`webDist`, `UI_CSP`); API routes keep `default-src 'none'`.

## Not built

The content pack, the shelf entry, CI and a runner.

## Federated Identity revoke section (H2 2026 update, `server/src/fedid/`)

A workload presents the token its platform issued; the gateway verifies it on every request and reads the identity's state; a revoke makes the next request fail although the token still validates. The page is a second tab (`#federated-identity`) with a Mock view (a generated table) and a Live view (the real local engine).

| File | Role |
| --- | --- |
| `tables.js` | Frozen tables: two issuers, two identities, one access key, three backend credentials, the caps. All names invented, all hosts `.example`. |
| `jwt.js` | Real RS256 signing and verification with `node:crypto` and throwaway RSA keys (EC key generation is avoided). The Mock engine uses a fixed marker instead. |
| `engine.js` | The engine: platform token minting (real or mock), the gateway's checks, key-set cache (15-minute refresh, last known good through an outage), revoke, issuer outage, virtual time, request cap, `summarize()` (the computed rows both views show). All synchronous, so check-and-change is atomic. |
| `mask.js` | Masking for typed text (heuristic). |
| `story.js`, `mock.js` | The 18-step story as data, and the Mock table generated from it (`mockTable.json`, written by `npm run fedid-mock`, drift-tested). |
| `facts.js` | Every claim with its tag; the page, the talk track and the content pack are generated from it. |
| `diagram.js`, `diagrams/fedid-revoke.json`, `diagramStudioValidate.js` | The diagram as diagram-studio/1 data, validated with a copy of the studio's validator. |
| `routes.js` | `/api/fedid/*`. Mounted per workspace runtime; refused (403) for Live in the hosted build. |
| `talk.js` | The generated section of `docs/talk-track.md` (`npm run talk-track`). |

The engine writes `fedid_decision` and `fedid_revoke` entries to the same HMAC-chained audit trail, and `POST /api/reset` resets it with everything else.

