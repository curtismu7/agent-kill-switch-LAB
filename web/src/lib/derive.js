// Everything the panels show beyond the raw state is derived here from the event stream, so it is testable without a browser.
const t = (iso) => Date.parse(iso);

// Short-lived access tokens, rebuilt from the events. The server never sends a token value, only ids.
// A trip or a kill revokes every token of that agent (or of all agents for the global kill) that was still live at that moment.
export function deriveTokens(events) {
  const tokens = [];
  for (const e of events) {
    if (e.type === "reset" || e.type === "scenario_start") tokens.length = 0; // a new run builds a new world: token ids restart
    else if (e.type === "token_issued") {
      tokens.push({ id: e.data.tokenId, agentId: e.agentId, issuedAt: t(e.at), expiresAt: t(e.data.expiresAt), ttlMs: e.data.ttlMs, revokedAt: null });
    } else if (e.type === "trip" || e.type === "kill") {
      const at = t(e.at);
      for (const k of tokens) if ((e.agentId === null || k.agentId === e.agentId) && k.revokedAt === null && k.expiresAt > at) k.revokedAt = at;
    }
  }
  return tokens;
}

export const tokenStatus = (k, nowMs) => (k.revokedAt !== null ? "revoked" : nowMs >= k.expiresAt ? "expired" : "live");

// One gap record per stop (trip, kill or global kill): when it landed, which calls still got through, and the first refusal.
// Trips refuse the very call that breached the cap, so their gap is zero. Returns newest last.
export function deriveGaps(events) {
  const gaps = [];
  const open = new Map(); // agentId (or "*") -> gap still waiting for its first refusal
  for (const e of events) {
    if (e.type === "reset" || e.type === "scenario_start") { gaps.length = 0; open.clear(); continue; }
    if (e.type === "kill" || e.type === "trip") {
      const key = e.agentId ?? "*";
      const g = { agentId: e.agentId, kind: e.type, scope: e.data.scope === "global" ? "global" : "agent", reason: e.type === "kill" ? "manual" : e.data.reason, stopAt: t(e.at), leaked: [], firstDeniedAt: null, tokenExpiry: null, cause: null };
      if (e.type === "trip") { g.firstDeniedAt = g.stopAt; } else open.set(key, g);
      gaps.push(g);
    } else if (e.type === "call_allowed") {
      for (const [key, g] of open) if (key === "*" || key === e.agentId) g.leaked.push({ at: t(e.at), callId: e.data.callId });
    } else if (e.type === "call_denied") {
      for (const [key, g] of [...open]) if (key === "*" || key === e.agentId) { g.firstDeniedAt = t(e.at); g.cause = e.data.reason; open.delete(key); }
    } else if (e.type === "unrevoke" || e.type === "auto_reset") {
      open.delete(e.agentId ?? "*");
      if (e.agentId === null) open.clear();
    }
  }
  return gaps;
}

// Which boxes and arrows the last scripted action touched, and where a refused call stopped.
export function pathFor(entry) {
  if (!entry) return { nodes: [], edges: [], bad: null };
  if (entry.action === "kill") return { nodes: ["kill", "token", "revoke", "audit"], edges: ["e-kill-token", "e-kill-rev", "e-kill-audit"], bad: "kill" };
  if (entry.action === "unrevoke") return { nodes: ["kill", "token", "audit"], edges: ["e-kill-token", "e-kill-audit"], bad: null };
  if (entry.action !== "call") return { nodes: [], edges: [], bad: null };
  const viaToken = entry.retriedAfter ? ["token"] : [];
  const tokenEdge = entry.retriedAfter ? ["e-token"] : [];
  if (entry.allowed) return { nodes: [...viaToken, "agent", "revoke", "rate", "cost", "tools"], edges: [...tokenEdge, "e-call", "e-rev-rate", "e-rate-cost", "e-cost-tools"], bad: null };
  if (entry.stage === "token_service") return { nodes: ["token", "agent"], edges: ["e-token"], bad: "token" };
  if (entry.stage === "cap") {
    const cost = entry.reason === "cost_cap";
    return { nodes: ["agent", "revoke", "rate", ...(cost ? ["cost"] : []), "kill", "audit"], edges: ["e-call", "e-rev-rate", ...(cost ? ["e-rate-cost", "e-trip-cost"] : ["e-trip-rate"]), "e-kill-audit"], bad: cost ? "cost" : "rate" };
  }
  return { nodes: [...viaToken, "agent", "revoke"], edges: [...tokenEdge, "e-call"], bad: "revoke" };
}

// One line of English per event, for the live feed. Every field comes from the server and is rendered as text.
export function describeEvent(e) {
  const d = e.data || {};
  const who = e.agentId ? e.agentId.replace(/^agent-/, "") : "all agents";
  switch (e.type) {
    case "call_allowed": return { tone: "ok", text: `${who} called ${d.tool}: allowed (${d.tokens} tokens, ${d.costMicros} micro-dollars)` };
    case "call_denied": return { tone: "bad", text: `${who} called ${d.tool}: REFUSED at ${d.stage} (${d.reason})` };
    case "call_completed": return { tone: "info", text: `${who}: ${d.tool} finished${d.completedAfterStop ? " AFTER the stop (in-flight work is not interrupted)" : ""}` };
    case "call_cancelled": return { tone: "warn", text: `${who}: ${d.tool} cancelled in flight (already charged)` };
    case "token_issued": return { tone: "info", text: `${who} got token ${d.tokenId}, valid ${Math.round((d.ttlMs || 0) / 1000)} s` };
    case "token_refused": return { tone: "bad", text: `${who} asked for a token: refused (${d.reason})` };
    case "trip": return { tone: "warn", text: `TRIPPED ${who}: ${d.reason}; ${d.tokensRevoked} token(s) revoked${d.autoResetAt ? ", auto-reset scheduled" : ""}` };
    case "kill": return { tone: "bad", text: `KILLED ${d.scope === "global" ? "ALL AGENTS" : who} by ${d.operator}; ${d.tokensRevoked} token(s) revoked, ${d.inFlightCount} in flight (${d.inFlightMode})` };
    case "unrevoke": return { tone: "ok", text: `UNREVOKED ${d.scope === "global" ? "ALL AGENTS" : who} by ${d.operator}${d.budgetReset ? ", budget reset" : ""}` };
    case "auto_reset": return { tone: "ok", text: `AUTO-RESET ${who} after cooldown (was ${d.from})` };
    case "scenario_start": return { tone: "info", text: `Scenario started: ${d.title}` };
    case "scenario_end": return { tone: d.ok ? "ok" : "warn", text: `Scenario ended: ${d.ok ? "expected end state reached" : "end state differs from the script"}` };
    case "reset": return { tone: "info", text: "Everything reset" };
    default: return { tone: "info", text: `${e.type} ${who}` };
  }
}

// Words for an aria-live announcement, or "" when the event is not a stop/start worth interrupting for.
export function announce(e) {
  const d = e.data || {};
  const who = e.agentId || "all agents";
  if (e.type === "trip") return `${who} tripped automatically: ${d.reason}. Its tokens are revoked.`;
  if (e.type === "kill") return `${d.scope === "global" ? "All agents" : who} killed by ${d.operator}. Tokens revoked.`;
  if (e.type === "unrevoke") return `${d.scope === "global" ? "All agents" : who} unrevoked by ${d.operator}.`;
  if (e.type === "auto_reset") return `${who} reset automatically after the cooldown.`;
  return "";
}
