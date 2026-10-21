# Safety

This app simulates stopping a runaway agent. It is built so that running it cannot reach anything real, and so that the stop it shows cannot be faked or triggered from outside. Each rule names the test that enforces it. Run them all with `npm test`.

## Provenance: what is sourced and what is invented

**As modelled in the demo environment, UNVERIFIED against product documentation.** The behaviour of the revoke / kill switch here is reproduced from the AI-DEMO2 demo environment's kill switch (`killSwitchService.js`, `killSwitchSseHub.js`, their tests, and `planning/PLAN-killswitch-explain-and-live-steps.md`). It is how that demo environment behaves. It has not been checked against Ping product documentation, and this app makes **no claim about how any real PingOne or Ping product implements revoke, rate caps or cost caps, and none about real defaults, limits or latency.**

| Behaviour | Where it comes from |
| --- | --- |
| Revoke blocks the agent's NEXT call; a call already in progress finishes | AI-DEMO2 plan (problem 1) and `agentRateLimit` checking revocation before each request, as described there |
| The kill is checked on every tool call, before the gateway/local branch | AI-DEMO2 test `mcpToolPipeline.killSwitch` |
| Kill writes and the gate reads the same derived key, so a placeholder id cannot make the kill a silent no-op | AI-DEMO2 tests `killSwitchKeyAlignment.integration`, `adminKillSwitchRoute.derivedKey` |
| `unrevoke` clears the flag so calls pass again | AI-DEMO2 test `killSwitchUnrevoke` |
| A kill expires by itself after a fixed time | AI-DEMO2 `AUTO_RESET_MS` (10 minutes) and test `killSwitchAutoReset`. **Not copied:** here a manual kill never expires; only a rate trip can auto-reset, after a cooldown |
| Revoking tokens, and disabling the identity so no NEW token is issued | AI-DEMO2 `killSwitchService` (token revocation and application disable steps) |
| The stop is shown step by step as it happens | AI-DEMO2 `killSwitchSseHub`; here a cursor-polled event stream instead of SSE |
| Per-agent rate limiting at a gateway denies with 429 | AI-DEMO2 `docs/demo-resource-server-capabilities.md` (use case UC18) and `docs/p1az-vs-gateway-token-checks.md` list it |

**Invented for this demo, not sourced from any Ping product or from AI-DEMO2:** the numbers (window sizes, call counts, token and money budgets, cooldown, token lifetime, revocation-list refresh interval), the price table (illustrative micro-dollar figures, not any vendor's prices), the token-and-money cost cap and how it trips, the trip/kill/reset state names and transitions, the local-validation revocation-list gap, the `cancel` in-flight option, and the whole scripted agent. In AI-DEMO2 the only cost cap found by searching `docs/` and `planning/` is a demo-application control in a design and plan, not a Ping product feature: a per-session turn counter that answers 429 for an optional Bedrock path (`docs/superpowers/specs/2026-07-09-bedrock-agentcore-integration-design.md`, `plans/...-plan.md` Task 6), alongside a trace event that records input and output token counts. Other AI-DEMO2 docs mention cost budgets only as features of other vendors' model gateways (`docs/strata-ai-gateway-comparison.md`). Nothing found documents a token-or-money cost cap, or its defaults, in a Ping product.

## In-flight semantics (exactly what happens to a call when the stop lands)

* A call is authorised once, at the moment the gateway admits it. Admitting it charges the budget and puts it in flight for the tool's duration on the virtual clock.
* A kill (manual) or a trip (cap) that lands while it is in flight **does not interrupt it**. With the default `inFlight: "finish"` it runs to its end, its result is delivered, and it is flagged `completedAfterStop` in the call record and the `call_completed` event. This is the AI-DEMO2 behaviour ("in-flight calls finish").
* With `inFlight: "cancel"` (an option of this demo, not a documented product behaviour) it is cancelled at once (`call_cancelled`).
* Either way the call **stays charged**: nothing is refunded.
* The very next call from that agent is refused (`agent_killed` / `agent_tripped`) and nothing new is admitted. Its already-issued tokens are revoked at the token service at the same moment, and the token service will not issue it a new one.
* With the flag check off and local token validation, "the next call" can still be admitted until the gateway's revocation list refreshes or the token expires. That is a measured gap, not a hidden one (`stale-token-gap`).

Pinned by `gateway.test.js`: "in-flight call: finishes by default, charged, flagged; the next call is refused", "in-flight call with inFlight "cancel"", "a call that is in flight when a CAP trips also finishes", and by `scenarios.test.js`: "in-flight scenario".

## Rules

| Rule | Enforced by |
| --- | --- |
| Everything is in-process: gateway, token service, tools and agent are code in this process. No tenant, no model, no outbound call. | `safety.test.js`: "every scenario, an operator kill and unrevoke, an audit verify and a reset make zero non-loopback connections" (every non-loopback socket, DNS lookup and `fetch` is replaced by one that records and throws), "the guard itself works", "source scan". |
| The kill is checked on every call. | `gateway.test.js`: "the kill switch is checked on EVERY call, not once". |
| Cap comparisons are exact: the `max`-th call and spending exactly up to a budget are allowed, the next unit trips. | `gateway.test.js`: "rate cap: the max-th call ...", "cost cap: spending exactly the money budget ...", "cost cap: the token budget ...". |
| The rate window slides: a call exactly `windowMs` old is outside it. | `gateway.test.js`: "rate cap: the window slides ...". |
| Budget accounting: calls are charged exactly once when admitted, refused calls cost nothing, prices round up. | `gateway.test.js`: "budget accounting ...". |
| A revoked token is refused; an expired token is refused at exactly its TTL; another agent's token is refused. | `gateway.test.js`: "a revoked token is rejected ...", "token checks ...". |
| Revocation propagation gap and why short TTLs matter. | `gateway.test.js`: "local validation: the gateway honours a revoked token until its revocation list refreshes", "... a short TTL closes the gap"; `scenarios.test.js`: "the gap scenario ...". |
| A trip or kill revokes the agent's live tokens and closes token issuance; unrevoke reopens it. | `gateway.test.js`: "a trip revokes the agent's live tokens ...", "unrevoke needs an operator action ...". |
| Unrevoke needs an operator action and is audited; nothing (calls, time, a scenario script's idle steps) un-kills an agent; a manual kill and a cost trip never auto-reset; an unrevoke over HTTP needs an operator name. | `gateway.test.js`: "unrevoke needs an operator action, is audited, and does not happen on its own", "without autoReset ...", "unrevoke keeps the spent budget ..."; `api.test.js`: "kill and unrevoke: validation". |
| Auto-reset is explicit: rate trips only, after the cooldown (to the millisecond), audited as `auto_reset`. | `gateway.test.js`: "trip auto-reset ...". |
| Blast radius: killing or tripping one agent changes nothing about the other (tokens, window, budget, state); the global switch is the only thing that stops both. | `gateway.test.js`: "blast radius ...", "the bystander's rate window is its own", "global kill ..."; `scenarios.test.js`: "the named end states". |
| Kill and gate resolve the same agent (spelling, case, the `default-agent` placeholder); an id that matches nobody is a 404, never a silent no-op. | `gateway.test.js`: "key derivation ...". |
| Cross-origin pages cannot kill or unrevoke. A non-GET request is refused with 403 when `Sec-Fetch-Site` is `cross-site` or when `Origin` is present and is not an `http` loopback origin identical to the `Host`; a body must be `application/json` (415). Refused requests leave state, audit and events byte-for-byte unchanged. | `guards.test.js`: "CSRF: a cross-origin page cannot kill an agent ...", "CSRF: a cross-origin page cannot unrevoke a killed agent", "CSRF: a "simple" form post ...", "Sec-Fetch-Site ...". |
| Host guard: a missing, malformed or non-loopback `Host` gets 421 (DNS rebinding). | `guards.test.js`: "Host guard ...". |
| No credential is accepted or used: `Authorization`, `Proxy-Authorization` and `X-API-Key` are refused (400) on every route. No body field carries a credential, token, URL or target; unknown fields are refused. | `guards.test.js`: "credentials are refused ...", "no body field can carry ...". |
| There is no route that makes a call, issues a token, edits a limit or writes to the audit trail. | `guards.test.js`: "there is no route that makes a call ..."; `api.test.js`: "the audit trail is read-only over HTTP". |
| Access token values never appear in any response, event, audit entry or call record. | `gateway.test.js`: "access token values never appear ..."; `api.test.js`: "no response ever contains an access token value". |
| The audit trail is append-only and tamper-evident: an HMAC chain with a per-process key; editing, deleting, inserting, reordering or forging is found at the first bad sequence number; a reset opens a new epoch that records the discarded head. | `audit.test.js`; `scenarios.test.js`: "audit and events survive a scenario start; reset opens a new audit epoch". |
| Agent- and operator-supplied strings are redacted and made inert (hidden and control characters shown as `[U+XXXX]`, sizes bounded) before they are stored or returned. Responses are JSON with `nosniff` and `Content-Security-Policy: default-src 'none'`. | `gateway.test.js`: "unknown or hostile agent ids ..."; `guards.test.js`: "hostile operator text ..."; `api.test.js`: "responses are JSON with nosniff ..."; `sanitize`/redaction code is shared in shape with the sibling apps. |
| Queues and buffers are capped: 200 call records, 500 events, 2000 audit entries, 500 tokens, 300 transcript lines, request bodies 2 KB. | `gateway.test.js`: "bounded ..."; `scenarios.test.js`: "the transcript is bounded"; `api.test.js`: "bodies: ... over 2 KB is 413". |
| A 500 never returns `err.message` or a stack. | `api.test.js`: "a 500 never leaks ...". |
| Time is injectable: the gateway, tokens, runtime and events use no timer and no wall clock, so every cap window, TTL and cooldown is tested with a fake clock and no sleep. | `safety.test.js`: "time is fully injectable ..."; every test in `gateway.test.js`. |
| Scenarios are deterministic and every one ends in its declared state. | `scenarios.test.js`: "every scenario ends in the state it declares", "deterministic ...", "step-by-step reaches the same end as run". |
| The server binds `127.0.0.1` only and refuses another address unless `KILL_SWITCH_BIND` is set (the container does). Every port is in 6550-6599. | `safety.test.js`: "ports ...", "binds loopback by default ...", "a started server listens on loopback only". |
| The container publishes its port on loopback only, with no host mounts, no docker socket, no host network, a non-root user, a read-only root filesystem and no capabilities. | `scripts/compose.test.mjs`. |
| No real credentials in the repo. | `.githooks/pre-commit` runs gitleaks on staged changes and refuses the commit if gitleaks is missing (`scripts/hooks.test.mjs`). Token-shaped test fixtures are assembled at run time. |

## Web UI rules

* The UI is served by the server itself with a same-origin CSP (no framing, no objects, no base tag, no form posts, `connect-src 'self'`). Pinned by `server/test/static.test.js` and, in a real browser, by `scripts/e2e.mjs` (no request leaves the origin, no console error).
* Every string the server sends is rendered as React text; there is no `dangerouslySetInnerHTML`. Pinned by the vitest hostile-string test and a red check that injects it.
* Kill and Unrevoke go through the same CSRF-guarded endpoints; `scripts/e2e.mjs` also fires cross-origin POSTs from another page and checks that nothing changed. Unrevoke needs a confirm step and an operator name in the UI, and an operator name at the API.
* The UI never sees an access token value, only ids; the token list is derived from events.

## Red checks

`npm run red-checks-web` does the same for the UI (confirm step, operator name, gauges, token revocation marks, gap, announcements, inert text, diagram highlight). `npm run red-checks` copies the server into a temporary directory, removes or inverts one safety check at a time, runs the suite, and requires it to fail. The list and the last result are in the README under "Verification".

## What is not covered

* **The operator is whoever can reach the page.** There is no operator login: the loopback origin is the human. What is guaranteed is that a page on another origin cannot kill or unrevoke. The operator name is a free label, not an identity.
* **The audit chain proves integrity inside this process, not to a third party.** The HMAC key lives in memory; there is no external anchor, and the trail is lost when the process exits. `POST /api/reset` discards it on purpose, recording the head of what it discarded.
* **Only trips, kills, unrevokes, auto-resets, resets and scenario starts are audited**, not every call. Calls are in the bounded call log and event stream.
* **Auto-reset and cooldown are evaluated lazily** when the agent is next looked at, so a state read can append the `auto_reset` audit entry.
* **Money is integer micro-dollars from invented prices.** It teaches the mechanism, not what any model costs.
* **Cookies are never read.**
* **Single process, in memory.** No persistence, no clustering, no real distributed revocation: the gap model is a single cached list.
