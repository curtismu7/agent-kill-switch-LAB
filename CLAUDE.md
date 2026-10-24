# CLAUDE.md

Agent Kill Switch (tier Demo, port 6550): a fully mocked demo of how an organization stops a runaway AI agent. Per-agent rate and cost caps trip on their own, an operator kills access, and the very next call is refused. A scripted agent, mock gateway and stub token service all run in one process. Overview, scenarios and API: [README.md](README.md). Safety rules and the test behind each: [docs/safety.md](docs/safety.md). Presenter script: [docs/talk-track.md](docs/talk-track.md).

## Commands

```bash
npm install
npm test             # server (node:test) + web (vitest) + compose/hooks/docs/doctor/content-pack/shelf-entry script tests
npm run build        # web UI into web/dist (the server serves it)
npm run doctor
npm run e2e          # headless Chromium on 6570; needs npm run build first
npm run content-pack # regenerate and validate content-pack.json from content/*.json
npm start            # http://127.0.0.1:6550/  (KILL_SWITCH_PORT overrides; only 6550-6599 accepted)
k8s/deploy.sh --dry-run  # hosted mock build: renders k8s/ (needs NAMESPACE, IMAGE, SE_HOST); apply needs OWNER_APPROVED=1
```

Ports: server 6550, Vite dev 6560, e2e 6570, tests 6580-6599. Slow mutation checks: `npm run red-checks`, `npm run red-checks-web`.

## Rules that bite here

- Loopback bind only; Host guard (421) and same-origin writes (403). No credential headers.
- No real network, tenants, models or identifiers. Only `.invalid` / `.example` hosts. Netguard tests assert zero outbound attempts.
- All text from the server or the operator is rendered inert (React text, no `dangerouslySetInnerHTML`).
- Test scripts use globs (`test/*.test.js`), never a directory (fails on Node 22).
- Never use `crypto.generateKeyPairSync` or async `generateKeyPair` (aborts on Node 20 in CI).
- Never parse `node:test` stdout; use the exit code, or pass `--test-reporter=spec`.
- The forbidden-strings history scan must print 0: `git log -p --all | grep -cF -f ~/.config/demo-kit/forbidden-strings.txt`. Never print that file.
- gitleaks runs in `.githooks/pre-commit`; the commit is refused if it is missing.
- Docker is OrbStack only, never Docker Desktop. The compose file publishes `127.0.0.1:6550` only.
- Tokens are mock and labelled; the server never sends token values, only ids.
- Product claims are UNVERIFIED unless sourced. All caps, windows, prices and TTLs are invented.
- Scenario time is virtual; do not add wall-clock timers to the gateway.

## Where the safety claims are pinned

- `server/test/safety.test.js`: zero non-loopback connections, loopback bind, ports, injectable time.
- `server/test/guards.test.js`: CSRF, Host guard, credential refusal, hostile text.
- `server/test/gateway.test.js`: kill checked every call, caps, in-flight semantics, blast radius.
- `server/test/audit.test.js`, `ks2.test.js`, `api.test.js`, `scenarios.test.js`, `static.test.js`: audit chain, operator-kill block, API bounds, scenario end states, CSP.
- `scripts/compose.test.mjs` (container), `scripts/hooks.test.mjs` (gitleaks hook), `scripts/docs.test.mjs` (README and docs stay true), `scripts/e2e.mjs` (real browser).

## Shelf and content pack

- Edit `content/terms.json` and `content/stories.json`, then `npm run content-pack` (validates against `docs/content-pack.schema.json`). Commit the regenerated `content-pack.json`.
- Shelf entry: `docs/shelf-entry.json` (catalog id D14, port 6550), tested by `scripts/shelf-entry.test.mjs`. Set `composeFile` to your checkout path.
- Hosted build (`MODE=se-mock`, rule 18): mock only; `ks_ws` cookie per browser workspace; the public host is the only non-loopback Host. Details and the owner-approval gate: [docs/k8s.md](docs/k8s.md).
- A new scenario goes in `server/src/scenarios.js` and must be described in the README (a docs test checks it).
