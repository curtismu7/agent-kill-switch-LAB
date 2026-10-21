// Shapes copied from the real server responses (see server/src/gateway.js describeAgent / runtime.js snapshot).
export const agent = (o = {}) => ({
  id: "agent-alpha", label: "Alpha", state: "armed", reason: null, trips: 0, stoppedAt: null, autoResetAt: null,
  limits: { rate: { max: 5, windowMs: 10000 }, cost: { maxTokens: 20000, maxMicros: 50000 }, cooldownMs: 30000, autoReset: false },
  usage: { calls: 0, denied: 0, tokens: 0, tokensIn: 0, tokensOut: 0, micros: 0 },
  budget: { tokensLeft: 20000, microsLeft: 50000 }, rate: { inWindow: 0, max: 5, windowMs: 10000 },
  stop: null, inFlight: 0, liveTokens: 0, issuanceDisabled: false, ...o,
});
export const snapshot = (o = {}) => ({
  mode: "demo", now: "2026-01-01T12:00:10.000Z", fakeClock: false, run: null, operatorKills: [],
  global: { state: "armed", stoppedAt: null, leakedCalls: 0, gapMs: null },
  agents: [agent(), agent({ id: "agent-beta", label: "Beta" })],
  gateway: { tokenTtlMs: 60000, tokenValidation: "introspect", revocationSyncMs: 30000, flagCheck: true, inFlight: "finish" },
  recentCalls: [], ...o,
});
let seq = 0;
export const ev = (type, agentId, data = {}, at = "2026-01-01T12:00:00.000Z") => ({ seq: (seq += 1), at, type, agentId, data });
