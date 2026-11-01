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
| An operator kill is never silently cleared: a scenario will not start (409 `kill_in_force`) while one is in force; the audit stamps real time (`at`) and demo time (`scenarioAt`); `verify` reports `evicted`. | `ks2.test.js`: "a scenario will not start while an operator kill is in force ...", "audit entries carry wall-clock time ...", "audit: verify reports how many entries the cap evicted", "audit flood ...". |
| Model and tool names are looked up with `Object.hasOwn` on a string (`toString`, `constructor`, arrays are unknown); an auto-reset during a global kill leaves issuance shut; secret shapes (JWT, AWS key, PEM, URL query and userinfo, `sk-`/`ghp_`/`xox`) are redacted in text and in events. | `ks2.test.js`: "prototype names and non-strings ...", "an auto-reset that falls due during a global kill ...", "redactText removes each secret shape", "events: strings are redacted, made inert and bounded". |
| Time is injectable: the gateway, tokens, runtime and events use no timer and no wall clock (the audit's wall-clock stamp comes from `clock.js` `wallNow`, injectable in tests), so every cap window, TTL and cooldown is tested with a fake clock and no sleep. | `safety.test.js`: "time is fully injectable ..."; every test in `gateway.test.js`. |
| Scenarios are deterministic and every one ends in its declared state. | `scenarios.test.js`: "every scenario ends in the state it declares", "deterministic ...", "step-by-step reaches the same end as run". |
| The server binds `127.0.0.1` only and refuses another address unless `KILL_SWITCH_BIND` is set (the container does). Every port is in 6550-6599. | `safety.test.js`: "ports ...", "binds loopback by default ...", "a started server listens on loopback only". |
| The container publishes its port on loopback only, with no host mounts, no docker socket, no host network, a non-root user, a read-only root filesystem and no capabilities. | `scripts/compose.test.mjs`. |
| No real credentials in the repo. | `.githooks/pre-commit` runs gitleaks on staged changes and refuses the commit if gitleaks is missing (`scripts/hooks.test.mjs`). Token-shaped test fixtures are assembled at run time. |

## Federated Identity revoke section (H2 2026 update)

Ping release claim, UNVERIFIED on our tenant. Everything in this section is simulated in the server process; the deck is "ID4AI Workforce - H2 2026", slide 40 (39 and 41 for context). Each claim carries one tag, listed in `server/src/fedid/facts.js`:

| Tag | Meaning |
| --- | --- |
| `deck claim` | said by the deck, with its slide number. Ping's numbers (fifteen minutes, one hour) are only ever quoted as the deck's |
| `console swagger name (schema only)` | a field or path name in the console swagger (2026-10-31). It proves the name exists, not how it behaves |
| `lab reading` | how this lab chose to read a deck line or a name (for example "immediately" as "read on every request") |
| `lab-invented` | made up: identities, subjects, `.example` hosts, 600 s default lifetime, 300-request cap, the story |
| `measured (our note)` | computed from a run of this lab's own engine (counts of requests); says nothing about Ping's timing |
| `roadmap` | slide 21 says Q4 2026 or Planned (Agent Lifecycle Management): no behaviour is claimed or modelled |

Rules and the test behind each:

| Rule | Pinned by |
| --- | --- |
| The Mock table is generated from the engine (signing = a fixed marker) and a test regenerates it. Live uses real RS256 signing and verification with throwaway RSA keys made in the process. The two make the same decisions. | `fedid-mock.test.js`: DRIFT and PARITY |
| The token is verified on every request; every check is evaluated so the page can show that the token still validates after a revoke; the decision is the first failing check. A revoked identity is refused 403 `identity_revoked`, attributed to its deployment, on all three service families and on the key that names it; the other identity is untouched. An issuer outage does not bring it back. | `fedid.test.js` |
| The workload token stops at the gateway: what the gateway sends to the backend is built from the application's own credential and scanned for the token (computed, not a constant). | `fedid.test.js`: "the token stops at the gateway" |
| Honest statuses: 200 allowed, 401 token not acceptable, 403 refused, 400 bad body, 409 already revoked, 429 caps, 413/415/421 from the guards, JSON 404 and 405. The browser logs the deliberate 401/403 as console messages. | `fedid-api.test.js` |
| Every editable field (workload, service, presents, lifetime, revoke target, operator, reason, outage, seconds) is proven by a mutant that must fail a test, on the server and in the page. | `npm run red-checks-fedid` |
| Caps refuse the whole request: 300 requests per session (429, nothing evicted), 40 issuer outage changes per session (429 `issuer_cap`; a repeat of the current state is not a change and writes no audit entry, so toggles cannot push the revoke entry out of the 2000-entry audit trail), a 30-day limit on the virtual clock, 2 KB bodies. Check-and-change is synchronous, so two revokes at once give one 200 and one 409. | `fedid.test.js`, `fedid-api.test.js` |
| Text typed into the operator and reason fields is masked before it is stored, audited or returned; the same shapes typed into every other field, query, path, header and unknown key never come back, and never reach the server's stdout or stderr (a real server process is started and watched). **Masking is a heuristic**: it removes the secret shapes in `server/src/fedid/mask.js` (JWT, PEM, `sk-`/`ghp_`/`xox`/`AKIA` and short prefixed tokens, `name=value`, `my password is ...`, `pw: ...`, `Authorization:` lines, URL userinfo, long blobs, `the token is ...`, a quoted value up to its closing quote; zero-width and other control characters are deleted first, while tab, newline and the other whitespace controls become a space (so `password is<newline>value` is still seen), text is NFKC-folded and percent-decoded, and masking happens before truncating). A secret in another shape can get through. | `fedid-masking.test.js` |
| The operator name is judged after masking: a name made only of invisible characters is refused 400. | `fedid.test.js`, `fedid-api.test.js` |
| The Live endpoints are refused (403) in the hosted mock build; the Mock table is served. | `fedid-api.test.js`: HOSTED |
| Zero non-loopback connections (netguard with a self-test). | `fedid-api.test.js`: NETGUARD |
| The raw mock-issued token is shown only in the answer to the request that presented it, labelled mock; the state, log, audit and Mock table never contain it. | `fedid-api.test.js`, `fedid.test.js` |

What is not covered: this section carries over the app's single-user, in-memory model. The per-visitor workspaces hold at most 200: a NEW visitor past that is refused (503 `too_many_workspaces`, no cookie) and no existing workspace is evicted, so a flood of cookie-less requests cannot silently undo another visitor's revoke; a workspace is dropped only after it has been idle for the whole 8 h cookie lifetime (`workspaces.test.js`). Once the registry is full of recently used workspaces, a new visitor waits. The older Kill switch tab's operator and reason text still goes through the older, weaker redactor in `redaction.js` (no zero-width, NFKC or percent-decode handling); only the new section uses `fedid/mask.js`.

## Web UI rules

* The UI is served by the server itself with a same-origin CSP (no framing, no objects, no base tag, no form posts, `connect-src 'self'`). Pinned by `server/test/static.test.js` and, in a real browser, by `scripts/e2e.mjs` (no request leaves the origin, no console error).
* Every string the server sends is rendered as React text; there is no `dangerouslySetInnerHTML`. Pinned by the vitest hostile-string test and a red check that injects it.
* Kill and Unrevoke go through the same CSRF-guarded endpoints; `scripts/e2e.mjs` also fires cross-origin POSTs from another page and checks that nothing changed. Unrevoke needs a confirm step and an operator name in the UI, and an operator name at the API.
* On the Kill switch tab the UI never sees an access token value, only ids; the token list is derived from events. The Federated Identity tab shows one raw mock-issued token, labelled mock, only in the answer to the request that presented it (rulebook rule 4).

## Red checks

`npm run red-checks-web` does the same for the UI (confirm step, operator name, gauges, token revocation marks, gap, announcements, inert text, diagram highlight). `npm run red-checks` copies the server into a temporary directory, removes or inverts one safety check at a time, runs the suite, and requires it to fail. The list and the last result are in the README under "Verification".

## What is not covered

* **The operator is whoever can reach the page.** There is no operator login: the loopback origin is the human. What is guaranteed is that a page on another origin cannot kill or unrevoke. The operator name is a free label, not an identity.
* **The audit chain proves integrity inside this process, not to a third party.** The HMAC key lives in memory; there is no external anchor, and the trail is lost when the process exits. `POST /api/reset` discards it on purpose, recording the head of what it discarded.
* **Only trips, kills, unrevokes, auto-resets, resets and scenario starts are audited**, not every call. Calls are in the bounded call log and event stream.
* **Auto-reset and cooldown are evaluated lazily** when the agent is next looked at, so a state read can append the `auto_reset` audit entry.
* **Money is integer micro-dollars from invented prices.** It teaches the mechanism, not what any model costs.
* **The only cookie read is the workspace id (`ks_ws`).**
* **Single process, in memory.** No persistence, no clustering, no real distributed revocation: the gap model is a single cached list.
