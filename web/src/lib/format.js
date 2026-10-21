// Display helpers. Everything returns plain strings; React escapes them, nothing here builds HTML.
export const money = (micros) => `$${(Number(micros || 0) / 1e6).toFixed(4)}`;
export const ms = (v) => {
  if (v === null || v === undefined) return "n/a";
  const n = Math.abs(v);
  return n >= 1000 ? `${(v / 1000).toFixed(n >= 10000 ? 0 : 1)} s` : `${Math.round(v)} ms`;
};
export const clock = (iso) => (typeof iso === "string" && iso.length >= 19 ? iso.slice(11, 19) : "");
export const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const agentName = (id) => (id ? String(id).replace(/^agent-/, "") : "all agents");
export const pct = (n, d) => (d > 0 ? Math.max(0, Math.min(100, (n / d) * 100)) : 0);
export const STATE_GLYPH = { armed: "●", tripped: "▲", killed: "■", reset: "↻" };
export const STATE_TEXT = {
  armed: "Armed",
  tripped: "Tripped (auto)",
  killed: "Killed (manual)",
  reset: "Reset",
};
export const REASON_TEXT = {
  rate_cap: "rate cap breached",
  cost_cap: "cost cap breached",
  manual: "operator kill",
  agent_killed: "agent is killed",
  agent_tripped: "agent is tripped",
  global_kill: "global kill switch",
  token_revoked: "token revoked",
  token_expired: "token expired",
  token_unknown: "token unknown",
  token_missing: "no token",
  token_agent_mismatch: "token belongs to another agent",
  issuance_disabled: "token service refuses to issue",
  unknown_tool: "unknown tool",
  unknown_model: "unknown model",
  bad_request: "malformed call",
  unknown_agent: "unknown agent",
};
export const reasonText = (r) => REASON_TEXT[r] || String(r ?? "");
