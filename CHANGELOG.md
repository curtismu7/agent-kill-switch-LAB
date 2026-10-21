# Changelog

## 0.1.0 (unreleased)

- KS0: server core. Injectable clock; stub token service (short-lived tokens, revocation list, issuance switch); mock gateway with a sliding-window rate cap, a token and money cost cap, a per-call kill-switch check, token validation (introspect or local with a stale revocation list) and the armed / tripped / killed / reset state machine with a global switch; in-flight call semantics (finish or cancel); cooldown and auto-reset for rate trips; operator kill and unrevoke (audited); scripted runaway agent and nine scenarios; event cursor; HMAC hash-chained audit with verify; HTTP API; `GET /api/health` (`demo-health/1`); doctor; loopback-published Docker files; gitleaks pre-commit hook; red-check script. No web UI yet.
