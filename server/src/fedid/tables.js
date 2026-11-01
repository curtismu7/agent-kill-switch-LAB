// Fixed tables for the Federated Identity revoke section (H2 2026 release update). Frozen; no route edits them.
// Every host is an .example name and every identity, subject and credential id is invented for this demo (tag: lab-invented).
// The deck facts these tables illustrate are listed, with their tags, in facts.js.
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

// Deck, slide 40: the same identity reaches MCP servers, peer agents (A2A) and LLM providers, distinguished only by scopes.
export const SERVICES = deepFreeze(['mcp', 'a2a', 'llm']);
export const VIAS = deepFreeze(['token', 'key']);

// Two platforms that issue OIDC tokens (deck: Kubernetes service-account tokens, GitHub Actions job tokens, any OIDC platform).
export const ISSUERS = deepFreeze({
  k8s: { id: 'k8s', iss: 'https://cluster.k8s.example', kid: 'k8s-signing-1', platform: 'kubernetes' },
  ci: { id: 'ci', iss: 'https://token.ci.example', kid: 'ci-signing-1', platform: 'github-actions' },
});

export const AUDIENCE = 'https://gateway.privilege.example';

// Deck, slide 40: "lifetime is capped (default one hour)". The key set is "refreshed every fifteen minutes".
export const MAX_LIFETIME_SEC = 3600;
export const KEYSET_REFRESH_SEC = 900;
export const DEFAULT_LIFETIME_SEC = 600; // lab-invented: how long the platform's token lives when the visitor does not say

// The registered Federated Identities. `scopes` pick the service families (deck: "distinguished only by the scopes").
export const IDENTITIES = deepFreeze({
  'fi-billing-agent': {
    id: 'fi-billing-agent', label: 'Billing agent', platform: 'kubernetes', issuer: 'k8s',
    subject: 'system:serviceaccount:payments:billing-agent', audience: AUDIENCE, scopes: ['mcp', 'a2a', 'llm'], maxLifetimeSec: MAX_LIFETIME_SEC,
  },
  'fi-nightly-job': {
    id: 'fi-nightly-job', label: 'Nightly job', platform: 'github-actions', issuer: 'ci',
    subject: 'repo:example-org/shop:ref:refs/heads/main', audience: AUDIENCE, scopes: ['mcp', 'llm'], maxLifetimeSec: MAX_LIFETIME_SEC,
  },
});

// Deck, slide 40: "A key owned by an identity". One agent access key names the billing identity as the principal it acts as.
export const ACCESS_KEYS = deepFreeze({
  'key-billing': { id: 'key-billing', principal: 'fi-billing-agent' },
});

// Deck, slide 40: "Backends receive the application's own configured credential: static, per-user from the vault, or OAuth."
// The assignment of the three kinds to the three services is lab-invented. The ids are labels, not credentials.
export const APPS = deepFreeze({
  mcp: { service: 'mcp', credentialId: 'cred:app-mcp-static', kind: 'static' },
  a2a: { service: 'a2a', credentialId: 'cred:app-a2a-vault', kind: 'per-user vault' },
  llm: { service: 'llm', credentialId: 'cred:app-llm-oauth', kind: 'OAuth' },
});

export const REQUEST_CAP = 300; // lab-invented: requests one Live session may send before Reset
export const ISSUER_CAP = 40; // lab-invented: issuer outage changes one Live session may make before Reset (each change is one audit entry)
export const LOG_KEEP = 50; // newest results the state carries
export const ALGS_ALLOWED = deepFreeze(['RS256']); // deck: "Only asymmetric signature algorithms are accepted"

// reason -> HTTP status the gateway answers with. 401 = the token itself is not acceptable, 403 = the token is fine but access is not.
export const REASON_STATUS = deepFreeze({
  token_malformed: 401, alg_not_allowed: 401, signature_invalid: 401, lifetime_exceeds_cap: 401, token_expired: 401, no_matching_identity: 401,
  identity_revoked: 403, scope_missing: 403,
});

// Scenario time for the story and the Mock table: the release date of the deck (2026-11-02), 09:00 UTC.
export const STORY_START_MS = Date.UTC(2026, 10, 2, 9, 0, 0);
