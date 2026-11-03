// Every claim the Federated Identity revoke section makes, with where it comes from. The page, the talk track and the content pack are
// all generated from this file, so a claim cannot appear in one and not in the others.
//
// Tags (per field, never per page):
//   deck claim                                    said by the Ping deck "ID4AI Workforce - H2 2026" (slide in `slide`)
//   console swagger name (schema only)            a field or path name in the Privilege console swagger, 2026-10-31. It proves the name exists, not how it behaves
//   lab reading                                   how this lab chose to read a deck line or a name; the deck does not say it
//   lab-invented                                  made up for this demo (names, hosts, numbers, the story)
//   measured (our note)                           computed from a run of this lab's own engine; says nothing about Ping's product
//   roadmap                                       slide 21 marks it Q4 2026 or Planned: no behaviour is claimed or modelled
// Ping's own numbers (15 minutes, one hour) are quoted as the deck's, never as something this lab measured.

export const TAGS = Object.freeze(['deck claim', 'console swagger name (schema only)', 'lab reading', 'lab-invented', 'measured (our note)', 'roadmap']);
export const BANNER = 'Ping release claim, UNVERIFIED on our tenant';
export const BANNER_DETAIL = 'The 2026-11-02 release is not on our tenant. Everything here is simulated in this process: no tenant, platform or real agent is touched.';
export const DECK = 'ID4AI Workforce - H2 2026';

export const LEDE = 'When a Federated Identity is revoked, the workload that holds its platform-issued token is cut off on its next request, even though the token itself is still valid. This shows what is cut, what stays valid, and what the deck does not say.';

// What the deck says (slide numbers are the deck's).
export const FACTS = Object.freeze([
  { id: 'platforms', slide: 40, tag: 'deck claim', text: 'Platforms: Kubernetes service-account tokens, GitHub Actions and GitLab CI job tokens, SPIFFE JWT-SVIDs, and any platform that issues OIDC tokens with published keys.' },
  { id: 'families', slide: 40, tag: 'deck claim', text: 'One credential, three service families: the same identity reaches MCP servers, peer agents (A2A) and LLM providers, distinguished only by the scopes on the key.' },
  { id: 'binding', slide: 40, tag: 'deck claim', text: 'Issuer and subject are matched exactly, and the audience is mandatory.' },
  { id: 'lifetimes', slide: 40, tag: 'deck claim', text: 'Expiry is required and the lifetime is capped (default one hour). Only asymmetric signature algorithms are accepted.' },
  { id: 'keys', slide: 40, tag: 'deck claim', text: "The issuer's key set is validated when the access key is created, refreshed every fifteen minutes and on sight of an unknown signing key, and the last known good set is kept through issuer outages." },
  { id: 'key-owned', slide: 40, tag: 'deck claim', text: 'An agent access key can name a Federated Identity as the principal it acts as; that identity supplies the verification material for the key.' },
  { id: 'isolation', slide: 40, tag: 'deck claim', text: "Backend isolation: the token stops at the gateway and is never forwarded. Backends receive the application's own configured credential: static, per-user from the vault, or OAuth." },
  { id: 'revoke', slide: 40, tag: 'deck claim', text: 'Revoking the identity cuts the workload off immediately, and every request is attributed to a specific deployment in audit.' },
  { id: 'per-request', slide: 40, tag: 'deck claim', text: 'Tokens are verified per request against the issuer and are instantly revocable (the Technical value line).' },
  { id: 'sensor', slide: 41, tag: 'deck claim', text: 'Context only, not built here: removing the identity of a self-hosted agent (the Kubernetes sensor) cuts it off immediately, and every finding stays attributable to the node that reported it.' },
  { id: 'delegated-admin', slide: 21, tag: 'deck claim', text: 'Context: Agent Delegated Administration (grant or revoke agent access) is GA on the governance slide.' },
]);

// Names from the console swagger (2026-10-31). Nothing was called; the API objects keep the old name NonHumanIdentity.
export const SWAGGER = Object.freeze([
  { id: 'sw-spec', tag: 'console swagger name (schema only)', text: 'imodelNonHumanIdentitySpec has Description, Enabled, Federation, Scopes, SubjectBinding, UserClaim and NotAfter. The object path is /v1/nonhumanidentities (the API did not rename; Federated Identity is the display name).' },
  { id: 'sw-workload', tag: 'console swagger name (schema only)', text: 'modelAgentWorkloadIdentity has Issuer, Subject, Audience, JwksURI, JWKS, MaxTokenLifetimeSec, RequiredClaims, Platform and AllowAnySubject.' },
  { id: 'sw-key', tag: 'console swagger name (schema only)', text: 'imodelAgentAccessKeySpec has WorkloadIdentity and Revoked fields. The paths for the identity object list delete and put operations.' },
]);

// What this lab decided where the deck is silent, and what it made up.
export const READINGS = Object.freeze([
  { id: 'rd-next-request', tag: 'lab reading', text: 'Deck word "immediately" is read as: the identity state is read on every request, so the first request after the revoke is refused. The deck gives no number.' },
  { id: 'rd-record', tag: 'lab reading', text: 'A revoked identity stays registered in the state "revoked", so a refused request can still be attributed to the deployment. Whether a real revoke deletes, disables (Enabled) or expires (NotAfter) the record is not stated.' },
  { id: 'rd-order', tag: 'lab reading', text: 'Check order: algorithm, signature, lifetime, expiry, exact binding, identity state, key principal, scope. The deck does not give an order.' },
  { id: 'rd-key', tag: 'lab reading', text: 'A key that names the revoked identity as its principal is refused too, because the identity supplies the key\'s verification material (deck) and that identity is revoked.' },
  { id: 'rd-platform', tag: 'lab reading', text: 'The platform that issues the token does not know about the revoke, so it keeps minting valid tokens; only the gateway refuses them.' },
  { id: 'rd-backend', tag: 'lab reading', text: "The backend credential the application is configured with is not changed by a revoke (the deck says the token is never forwarded, not what a revoke does to backend credentials)." },
]);

export const INVENTED = Object.freeze([
  { id: 'iv-names', tag: 'lab-invented', text: 'Both identities, their subjects, the two issuers, the audience, the access key id and the backend credential ids are made up. Every host is an .example name.' },
  { id: 'iv-numbers', tag: 'lab-invented', text: 'Default token lifetime 600 s, request cap 300 per session, virtual clock limit 30 days, which backend credential kind goes with which service, and the 18-step story.' },
  { id: 'iv-keys', tag: 'lab-invented', text: 'Live mode signs with throwaway local RSA keys made in this process. Mock mode uses a fixed marker instead of a signature.' },
]);

// Questions the deck leaves open. `lab` is what this lab does about it, `tag` says what kind of statement that is.
export const NOT_SAID = Object.freeze([
  { id: 'ns-number', question: 'How fast, as a number?', deck: 'The deck says "immediately" and gives no figure.', lab: 'Counts requests, not milliseconds: the first request after the revoke is refused.', tag: 'lab reading' },
  { id: 'ns-in-flight', question: 'What about a request already in flight?', deck: 'Not stated.', lab: 'Not modelled, nothing claimed. (The existing Kill switch tab models in-flight calls for its own caps.)', tag: 'lab-invented' },
  { id: 'ns-record', question: 'Does revoke delete, disable or expire the identity?', deck: 'Not stated ("revoking" and "removing" are both used).', lab: 'Keeps the record as "revoked" so refusals stay attributable.', tag: 'lab reading' },
  { id: 'ns-restore', question: 'Can a revoked identity be restored?', deck: 'Not stated. Agent Lifecycle Management (provision, version, disable and decommission) is Q4 2026 on slide 21.', lab: 'No restore: only Reset starts over. Lifecycle management is roadmap, no behaviour claimed.', tag: 'roadmap' },
  { id: 'ns-platform', question: 'Is the platform token cut at the platform?', deck: 'Not stated.', lab: 'No: the platform keeps minting valid tokens; only the gateway refuses them.', tag: 'lab reading' },
  { id: 'ns-backend', question: 'What happens to the backend credential?', deck: 'Not stated.', lab: 'Untouched.', tag: 'lab reading' },
  { id: 'ns-replicas', question: 'How do several gateway replicas, or caches, learn of the revoke?', deck: 'Not stated.', lab: 'One gateway that reads the state on every request. Nothing claimed about replicas.', tag: 'lab-invented' },
  { id: 'ns-unknown-kid', question: 'What does the refresh on an unknown signing key look like?', deck: 'The deck says the key set is refreshed on sight of an unknown key.', lab: 'Not built: only the 15-minute refresh and the last known good set are shown.', tag: 'lab-invented' },
]);

export const ROADMAP = Object.freeze([
  { id: 'rm-lifecycle', name: 'Agent Lifecycle Management', what: 'provision, version, disable and decommission', availability: 'Q4 2026', slide: 21, tag: 'roadmap', note: 'No behaviour is claimed or modelled here.' },
]);

// Section 10 of the prompt file, paraphrased from the deck's value panel on slide 40. Ping's claims, UNVERIFIED on our tenant.
export const WHY = Object.freeze({
  slide: 40, tag: 'deck claim',
  challenge: 'Stored API keys outlive workloads and stay valid from anywhere if they leak. Standing-secret findings block agent rollout, and unattended operation is held back by key risk.',
  technical: 'Secretless, exactly bound, short-lived tokens verified per request against the issuer, instantly revocable.',
  business: 'Standing-secret audit findings close, and unattended agents can be approved at all: lower breach risk, faster adoption.',
});

export const ALL_CLAIMS = Object.freeze([...FACTS, ...SWAGGER, ...READINGS, ...INVENTED, ...NOT_SAID.map((n) => ({ id: n.id, tag: n.tag, text: `${n.question} ${n.deck} Lab: ${n.lab}` })), ...ROADMAP.map((r) => ({ id: r.id, tag: r.tag, text: `${r.name} (${r.what}) is ${r.availability} on slide ${r.slide}. ${r.note}` }))]);
