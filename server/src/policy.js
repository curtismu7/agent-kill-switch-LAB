// Fixed demo tables. Frozen; no route edits them. The prices are ILLUSTRATIVE numbers invented for this demo: they are not
// any vendor's price list and say nothing about what any real model costs.
//  - Money is an integer count of micro-dollars (1 micro-dollar = 0.000001 USD), so budgets never suffer float error.
//  - A price is micro-dollars per 1000 tokens, separately for input and output.
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

export const MODELS = deepFreeze({
  'demo-small': { inPer1k: 150, outPer1k: 600 },
  'demo-large': { inPer1k: 3000, outPer1k: 15000 },
});

// Mock tools the scripted agent calls. durationMs is how long a call stays in flight on the virtual clock.
export const TOOLS = deepFreeze({
  lookup: { durationMs: 200, summary: 'look up a record (mock)' },
  summarize: { durationMs: 800, summary: 'summarise a document (mock)' },
  bulk_export: { durationMs: 3000, summary: 'export many records (mock, slow)' },
});

export const AGENTS = deepFreeze({
  'agent-alpha': { label: 'Alpha (the agent that misbehaves)' },
  'agent-beta': { label: 'Beta (a bystander)' },
});

// Per-agent limits. rate: at most `max` admitted calls in any `windowMs` window. cost: a token budget and a money budget for the
// life of the world (no periodic refill). cooldownMs/autoReset: see gateway.js.
export const DEFAULT_LIMITS = deepFreeze({
  rate: { max: 5, windowMs: 10_000 },
  cost: { maxTokens: 20_000, maxMicros: 50_000 },
  cooldownMs: 30_000,
  autoReset: false,
});

// Gateway and token-service settings.
//  flagCheck:       the gateway reads the kill-switch state on every call (true), or relies on token revocation alone (false).
//  tokenValidation: 'introspect' asks the token service on every call; 'local' trusts a token until the gateway's cached
//                   revocation list refreshes (revocationSyncMs) or the token expires (tokenTtlMs).
//  inFlight:        what a kill does to a call already admitted: 'finish' (it completes) or 'cancel'.
export const DEFAULT_GATEWAY = deepFreeze({
  tokenTtlMs: 60_000,
  tokenValidation: 'introspect',
  revocationSyncMs: 30_000,
  flagCheck: true,
  inFlight: 'finish',
});

// Integer cost of one call, rounded up so a call never costs less than it should.
export function costMicros(model, tokensIn, tokensOut) {
  const p = MODELS[model];
  if (!p) throw new RangeError('unknown model');
  return Math.ceil((tokensIn * p.inPer1k + tokensOut * p.outPer1k) / 1000);
}

// The kill and the gate must agree on which agent they mean (the AI-DEMO2 "write key == read key" bug class): one function
// turns whatever id arrives into the canonical id or null. NFKC fold, trim, lower-case; the placeholder "default-agent"
// resolves to the first registered agent, as the demo's UI placeholder does.
export const PLACEHOLDER_AGENT = 'default-agent';
export function deriveAgentKey(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const k = input.normalize('NFKC').trim().toLowerCase();
  if (k === PLACEHOLDER_AGENT) return Object.keys(AGENTS)[0];
  return Object.hasOwn(AGENTS, k) ? k : null;
}
