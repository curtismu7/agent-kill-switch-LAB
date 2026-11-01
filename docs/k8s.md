# Hosted mock build (SE k8s, rule 18)

The same image as the local standalone, run with `MODE=se-mock` on the US SE cluster so that SEs can open it without installing anything. It is mock only.

## What changes in the hosted build

- **MODE.** `MODE=local` (default) is the standalone. `MODE=se-mock` is the hosted build (`server/src/mode.js`). The server refuses to start (doctor `fail`, `index.js` exits 1) when:
  - a setting whose name says live or credential (`SECRET`, `PASSWORD`, `TOKEN`, `API_KEY`, `CREDENTIAL`, `PRIVATE_KEY`, `PINGONE`, `TENANT`, `LIVE`, `REAL_`) is set to a non-empty value. The refusal counts them and never prints a name or a value;
  - `KILL_SWITCH_PUBLIC_HOST` is not one plain DNS host (no scheme, port, path, IP literal or `localhost`);
  - `KILL_SWITCH_BIND` is anything other than `0.0.0.0` or `127.0.0.1`;
  - `MODE` is not `local` or `se-mock` (an unknown value is never a silent fallback to local).
- **Public host.** The Host guard and the same-origin write check accept exactly `KILL_SWITCH_PUBLIC_HOST`, and for writes its `https://` origin. Loopback is accepted as before. Any other Host is 421 and any other Origin is 403. The ingress passes the Host header through unchanged; there is no rewrite (a rewrite would make the Origin and Host disagree, which is the failure mode this avoids).
- **Per-visitor workspaces** (`server/src/workspaces.js`). Each browser gets a random 128-bit id in an `HttpOnly; SameSite=Strict` cookie `ks_ws` (`Secure` in the hosted build, `Max-Age` 8 h). Each id has its own runtime: clock, token service, caps, gateway state, event buffer and audit trail. Nothing mutable is shared, so one visitor's run, kill, unrevoke, Reset or audit never reaches another visitor. The health probe is the only shared route. At most 200 workspaces are held in memory. A new visitor past that is refused (503 `too_many_workspaces`) and nothing is evicted, because an eviction would silently undo another visitor's revoke or kill; a workspace is dropped only after it has been idle for the whole cookie lifetime (8 h).
- **Banner.** When the server reports `hosted: true` the page shows a `HOSTED SIMULATION` banner above the header. The page now has a second tab (Federated Identity revoke, H2 2026 update) and a presenter mode on it; the release banner ("Ping release claim, UNVERIFIED on our tenant") is on every tab. In the hosted build the Federated Identity tab shows only the Mock table: the Live endpoints `/api/fedid/state`, `/request`, `/revoke`, `/issuer` and `/advance` answer 403 `live_not_available_in_hosted_mock` (pinned by `server/test/fedid-api.test.js`). This build is deferred by the owner (2026-10-31).

The cookie is a session selector, not a credential: the server never sends it anywhere, and a credential header is still refused.

## Manifests (`k8s/`)

- `deployment.yaml`: one replica, `runAsNonRoot`, uid/gid 1000, `readOnlyRootFilesystem`, `drop: [ALL]`, `allowPrivilegeEscalation: false`, `RuntimeDefault` seccomp on the pod and the container, no service-account token, no service-link env vars, requests and limits (50m/64Mi, 500m/256Mi). Readiness and liveness probe `GET /api/health` with `Host: 127.0.0.1:6550`, because the Host guard refuses a pod IP (421). The probe checks that the server answers, not the `state` field (the endpoint returns 200 for both `ready` and `broken`; the Docker healthcheck is the one that checks `ready`).
- `service.yaml`: ClusterIP, port 80 to 6550.
- `ingress.yaml`: host `__SE_HOST__`, path `/`, to the Service. No ingress class and no TLS block: the cluster defaults apply, which is UNVERIFIED for the SE cluster.
- The only tokens are `__IMAGE__` and `__SE_HOST__`. There is no `namespace:` field and no `${...}` form.

## Deploy script (`k8s/deploy.sh`)

```bash
NAMESPACE=<dns-label> IMAGE=<ref>:<explicit-tag> SE_HOST=<plain.host> k8s/deploy.sh --dry-run
NAMESPACE=<dns-label> IMAGE=<ref>:<tag> SE_HOST=<plain.host> OWNER_APPROVED=1 k8s/deploy.sh
```

- `NAMESPACE` has no default. The namespace the SE cluster uses is an owner decision (UNVERIFIED).
- `IMAGE` needs an explicit tag or a digest. `latest` is refused, and so are sed or shell metacharacters.
- `SE_HOST` is one plain DNS host.
- Values are checked, then rendered with `sed` (delimiter `|`). A render that still contains a `__TOKEN__` or a `${...}` is refused (exit 1).
- `--dry-run` prints the rendered manifests and applies nothing.
- Apply needs `OWNER_APPROVED=1` (exit 3 otherwise, and kubectl is not called). The first deploy of each app to the SE cluster is owner-approved.

Exit codes: 0 ok, 1 a token left in the render, 2 bad input or usage, 3 apply not approved, 4 kubectl missing or failed.

After an apply, verify by content, not by a 200: open the page and check the `HOSTED SIMULATION` banner and a working Run, and check the pod's `imageID` against the GHCR manifest digest.

## Tests

`scripts/k8s.test.mjs` (in `npm test`) checks the tokens, the security context, the probes, the absence of secrets, every refusal by exit code, the stray-token case on a temp copy, and the apply path with a stub `kubectl` (no cluster is contacted). `server/test/workspaces.test.js` pins the isolation, the cookie flags, the cap, the MODE refusals and the hosted guards. `web/src/test/app.test.jsx` pins the banner.

## Not verified

- The SE cluster: namespace, ingress class, TLS, the GHCR image path and whether the cluster admission policy accepts `RuntimeDefault` and the read-only root filesystem. No `kubectl` was run.
- The image in GHCR, its digest and the pod's `imageID`.
- A browser run against the hosted host. The workspace isolation is pinned over HTTP in tests, not in two real browser profiles.
- Only Node 26 is supported (CI runs Node 26 only). Only the local Node version was run.
