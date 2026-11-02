// The mock gateway: every tool call passes through call(), which checks, in this order,
//   1. the global kill switch            (flagCheck)   -> global_kill
//   2. the agent's kill-switch state     (flagCheck)   -> agent_tripped / agent_killed
//   3. the access token                                -> token_missing / token_unknown / token_agent_mismatch / token_expired / token_revoked
//   4. the request shape                               -> unknown_tool / unknown_model / bad_request
//   5. the rate cap (sliding window)                   -> rate_cap  (trips the agent)
//   6. the cost cap (token and money budget)           -> cost_cap  (trips the agent)
// and only then admits the call. Nothing is cached between calls except the revocation list in 'local' validation mode,
// which is the point of that mode.
//
// States per agent: armed | tripped (automatic, a cap was breached) | killed (an operator did it) | reset (just cleared;
// behaves like armed and becomes armed on the next admitted call). A global switch is armed | killed.
//
// IN-FLIGHT SEMANTICS. A call is authorised at the moment it is admitted. A kill or trip that lands while it is running does
// not un-authorise it: with inFlight 'finish' (default, the behaviour the AI-DEMO2 kill switch documents: "in-flight calls
// finish") it runs to its end and its result is returned, flagged completedAfterStop; with inFlight 'cancel' (a demo option,
// not documented as a product behaviour) it is cancelled at once. Either way the call was charged when admitted and the
// charge is not refunded. The NEXT call is what is refused.
import { AGENTS, DEFAULT_GATEWAY, DEFAULT_LIMITS, MODELS, TOOLS, costMicros, deriveAgentKey } from './policy.js';
import { redactText } from './redaction.js';
import { revealText } from './sanitize.js';
import { maskText } from './mask.js';

export const CALL_CAP = 200;
const MAX_TOKENS_PER_CALL = 10_000_000;
const text = (v, max = 64) => revealText(redactText(String(v ?? '')), max);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_TOKENS_PER_CALL;

export function createGateway({ clock, tokens, audit, events, limits = {}, config = {} } = {}) {
  const cfg = { ...DEFAULT_GATEWAY, ...config };
  const agents = new Map(Object.keys(AGENTS).map((id) => {
    const l = limits[id] || {};
    return [id, {
      id,
      limits: { ...DEFAULT_LIMITS, ...l, rate: { ...DEFAULT_LIMITS.rate, ...l.rate }, cost: { ...DEFAULT_LIMITS.cost, ...l.cost } },
      state: 'armed', reason: null, stoppedAt: null, autoResetAt: null, resetAt: null, trips: 0, window: [],
      usage: { calls: 0, denied: 0, tokens: 0, tokensIn: 0, tokensOut: 0, micros: 0 },
      stop: { leakedCalls: 0, firstDeniedAt: null },
      inflight: new Map(),
    }];
  }));
  const global = { state: 'armed', stoppedAt: null, firstDeniedAt: null, leakedCalls: 0 };
  let callSeq = 0;
  let calls = [];
  let snapshot = new Set(tokens.revokedIds());
  let lastSync = clock.now();

  const get = (id) => agents.get(id);
  const remember = (rec) => { calls.push(rec); if (calls.length > CALL_CAP) calls = calls.slice(calls.length - CALL_CAP); };

  // ---- in-flight bookkeeping -------------------------------------------------------------------------------------------
  function settle() {
    const now = clock.now();
    const due = [];
    for (const a of agents.values()) for (const rec of a.inflight.values()) if (rec.endsAt <= now) due.push([a, rec]);
    due.sort((x, y) => x[1].endsAt - y[1].endsAt);
    for (const [a, rec] of due) {
      a.inflight.delete(rec.id);
      rec.status = 'completed';
      events.emit('call_completed', a.id, { callId: rec.id, tool: rec.tool, completedAfterStop: rec.stoppedWhileInFlight });
    }
  }
  function stopInFlight(a, mode) {
    let n = 0;
    for (const rec of a.inflight.values()) {
      n += 1;
      if (mode === 'cancel') {
        rec.status = 'cancelled';
        events.emit('call_cancelled', a.id, { callId: rec.id, tool: rec.tool, charged: rec.costMicros });
      } else rec.stoppedWhileInFlight = true;
    }
    if (mode === 'cancel') a.inflight.clear();
    return n;
  }

  // ---- state transitions ------------------------------------------------------------------------------------------------
  const usageSnapshot = (a) => ({ ...a.usage });
  function stopAgent(a, state, reason, extra = {}) {
    const now = clock.now();
    const from = a.state;
    a.state = state; a.reason = reason; a.stoppedAt = now; a.autoResetAt = null; a.stop = { leakedCalls: 0, firstDeniedAt: extra.firstDeniedAt ?? null };
    const revoked = tokens.revoke(a.id);
    tokens.disable(a.id);
    return { from, revoked, inFlight: stopInFlight(a, extra.inFlight ?? cfg.inFlight) };
  }

  function trip(a, reason, detail) {
    if (a.state === 'tripped' || a.state === 'killed') return; // already stopped: the breach is just another denial
    a.trips += 1;
    const { revoked, inFlight } = stopAgent(a, 'tripped', reason, { firstDeniedAt: clock.now() });
    if (a.limits.autoReset && reason === 'rate_cap') a.autoResetAt = clock.now() + a.limits.cooldownMs;
    events.emit('trip', a.id, { reason, detail, autoResetAt: a.autoResetAt, tokensRevoked: revoked.length, inFlight });
    audit.append('trip', a.id, { reason, detail, usage: usageSnapshot(a), autoResetAt: a.autoResetAt, tokensRevoked: revoked.length, inFlight });
  }

  function clearAgent(a, { resetBudget = false } = {}) {
    const from = { state: a.state, reason: a.reason };
    a.state = 'reset'; a.reason = null; a.stoppedAt = null; a.autoResetAt = null; a.resetAt = clock.now(); a.window = [];
    if (resetBudget) { a.usage.tokens = 0; a.usage.tokensIn = 0; a.usage.tokensOut = 0; a.usage.micros = 0; }
    if (global.state !== 'killed') tokens.enable(a.id); // while the global switch holds, the identity layer stays shut (also on auto-reset)
    return from;
  }

  // Lazy auto-reset: evaluated whenever the agent is looked at (a call or a state read). Only a rate trip with autoReset on
  // comes back by itself, and only after the cooldown. A cost trip needs money back, and a manual kill needs an operator.
  function refresh(a) {
    if (a.state === 'tripped' && a.autoResetAt !== null && clock.now() >= a.autoResetAt) {
      const from = clearAgent(a);
      events.emit('auto_reset', a.id, { from: from.reason, cooldownMs: a.limits.cooldownMs });
      audit.append('auto_reset', a.id, { from: from.reason, cooldownMs: a.limits.cooldownMs, budgetReset: false });
    }
  }

  // ---- the call path ----------------------------------------------------------------------------------------------------
  function call(input = {}) {
    settle();
    const now = clock.now();
    const key = deriveAgentKey(input.agentId);
    const a = key ? get(key) : null;
    if (a) refresh(a);
    callSeq += 1;
    const model = input.model ?? 'demo-small';
    const rec = {
      id: `call-${String(callSeq).padStart(4, '0')}`, at: clock.iso(), atMs: now, agentId: key ?? text(input.agentId), tool: text(input.tool), model: text(model),
      tokensIn: isCount(input.tokensIn) ? input.tokensIn : 0, tokensOut: isCount(input.tokensOut) ? input.tokensOut : 0,
      costMicros: 0, tokenId: null, allowed: false, stage: null, reason: null, status: 'denied', endsAt: null, stoppedWhileInFlight: false,
    };
    remember(rec);

    const deny = (stage, reason, detail) => {
      rec.stage = stage; rec.reason = reason;
      if (a) a.usage.denied += 1;
      if (stage === 'global' && global.stoppedAt !== null && global.firstDeniedAt === null) global.firstDeniedAt = now;
      if (a && a.stoppedAt !== null && a.stop.firstDeniedAt === null) a.stop.firstDeniedAt = now;
      events.emit('call_denied', rec.agentId, { callId: rec.id, tool: rec.tool, stage, reason, ...detail });
      return { ...rec };
    };

    if (!a) return deny('identity', 'unknown_agent');

    if (cfg.flagCheck) {
      if (global.state === 'killed') return deny('global', 'global_kill');
      if (a.state === 'tripped') return deny('state', 'agent_tripped', { cause: a.reason });
      if (a.state === 'killed') return deny('state', 'agent_killed');
    }

    // token check
    const token = tokens.lookup(input.token);
    let tokenReason = null;
    if (typeof input.token !== 'string' || input.token === '') tokenReason = 'token_missing';
    else if (!token) tokenReason = 'token_unknown';
    else if (token.agentId !== a.id) tokenReason = 'token_agent_mismatch';
    else if (now >= token.expiresAt) tokenReason = 'token_expired';
    else {
      if (cfg.tokenValidation === 'local' && now - lastSync >= cfg.revocationSyncMs) { snapshot = new Set(tokens.revokedIds()); lastSync = now; }
      const revoked = cfg.tokenValidation === 'local' ? snapshot.has(token.id) : token.revokedAt !== null;
      if (revoked) tokenReason = 'token_revoked';
    }
    if (tokenReason) return deny('token', tokenReason, { tokenId: token?.id ?? null });
    rec.tokenId = token.id;

    // request shape
    if (typeof input.tool !== 'string' || !Object.hasOwn(TOOLS, input.tool)) return deny('request', 'unknown_tool');
    if (typeof model !== 'string' || !Object.hasOwn(MODELS, model)) return deny('request', 'unknown_model');
    if (!isCount(input.tokensIn) || !isCount(input.tokensOut)) return deny('request', 'bad_request');
    const cost = costMicros(model, input.tokensIn, input.tokensOut);
    const tokenCount = input.tokensIn + input.tokensOut;

    // rate cap: sliding window. A call exactly windowMs old is outside the window.
    const { rate, cost: budget } = a.limits;
    a.window = a.window.filter((t) => t > now - rate.windowMs);
    if (a.window.length >= rate.max) {
      trip(a, 'rate_cap', { inWindow: a.window.length, max: rate.max, windowMs: rate.windowMs });
      return deny('cap', 'rate_cap', { inWindow: a.window.length, max: rate.max });
    }
    // cost cap: spending exactly up to the budget is allowed, one more unit is not. A denied call spends nothing.
    if (a.usage.tokens + tokenCount > budget.maxTokens) {
      trip(a, 'cost_cap', { dimension: 'tokens', spent: a.usage.tokens, wanted: tokenCount, budget: budget.maxTokens });
      return deny('cap', 'cost_cap', { dimension: 'tokens', remaining: budget.maxTokens - a.usage.tokens });
    }
    if (a.usage.micros + cost > budget.maxMicros) {
      trip(a, 'cost_cap', { dimension: 'money', spentMicros: a.usage.micros, wantedMicros: cost, budgetMicros: budget.maxMicros });
      return deny('cap', 'cost_cap', { dimension: 'money', remainingMicros: budget.maxMicros - a.usage.micros });
    }

    // admit
    if (a.state === 'reset') { a.state = 'armed'; a.reason = null; }
    if (a.state !== 'armed') a.stop.leakedCalls += 1; // only reachable when flagCheck is off: a stopped agent still got through
    if (global.state === 'killed') global.leakedCalls += 1;
    a.window.push(now);
    a.usage.calls += 1; a.usage.tokens += tokenCount; a.usage.tokensIn += input.tokensIn; a.usage.tokensOut += input.tokensOut; a.usage.micros += cost;
    rec.allowed = true; rec.status = 'in_flight'; rec.stage = 'admitted'; rec.costMicros = cost; rec.endsAt = now + TOOLS[input.tool].durationMs;
    a.inflight.set(rec.id, rec);
    events.emit('call_allowed', a.id, {
      callId: rec.id, tool: rec.tool, model, tokens: tokenCount, costMicros: cost,
      budget: { tokensLeft: budget.maxTokens - a.usage.tokens, microsLeft: budget.maxMicros - a.usage.micros },
      rate: { inWindow: a.window.length, max: rate.max },
    });
    return { ...rec };
  }

  // ---- operator actions -------------------------------------------------------------------------------------------------
  // The operator name and the reason are masked at write time (mask.js), so nothing raw is ever stored in the audit trail or the event feed. The
  // HTTP layer has already refused a name over 40 or a reason over 200 characters whole; nothing is cut here.
  const who = (operator) => maskText(operator) || 'operator';
  const note = (n) => maskText(n);

  function kill({ agentId, operator, reason, inFlight } = {}) {
    settle();
    const a = get(deriveAgentKey(agentId));
    if (!a) return { ok: false, status: 404, error: 'unknown_agent' };
    refresh(a);
    if (a.state === 'killed') return { ok: false, status: 409, error: 'already_killed' };
    const mode = inFlight ?? cfg.inFlight;
    if (mode !== 'finish' && mode !== 'cancel') return { ok: false, status: 400, error: 'bad_in_flight_mode' };
    const { from, revoked, inFlight: n } = stopAgent(a, 'killed', 'manual', { inFlight: mode });
    const data = { operator: who(operator), note: note(reason), from, tokensRevoked: revoked.length, inFlightMode: mode, inFlightCount: n };
    events.emit('kill', a.id, data);
    audit.append('kill', a.id, data);
    return { ok: true, agent: describeAgent(a), tokensRevoked: revoked.length, inFlightCount: n };
  }

  function killGlobal({ operator, reason, inFlight } = {}) {
    settle();
    if (global.state === 'killed') return { ok: false, status: 409, error: 'already_killed' };
    const mode = inFlight ?? cfg.inFlight;
    if (mode !== 'finish' && mode !== 'cancel') return { ok: false, status: 400, error: 'bad_in_flight_mode' };
    global.state = 'killed'; global.stoppedAt = clock.now(); global.firstDeniedAt = null; global.leakedCalls = 0;
    const revoked = tokens.revoke(null);
    let n = 0;
    for (const a of agents.values()) { tokens.disable(a.id); n += stopInFlight(a, mode); }
    const data = { operator: who(operator), note: note(reason), tokensRevoked: revoked.length, inFlightMode: mode, inFlightCount: n };
    events.emit('kill', null, { scope: 'global', ...data });
    audit.append('kill', null, { scope: 'global', ...data });
    return { ok: true, tokensRevoked: revoked.length, inFlightCount: n };
  }

  // Unrevoke is an operator action only: nothing in the call path, the clock or a scenario calls it on its own.
  function unrevoke({ agentId, operator, reason, resetBudget = false } = {}) {
    settle();
    const a = get(deriveAgentKey(agentId));
    if (!a) return { ok: false, status: 404, error: 'unknown_agent' };
    refresh(a);
    if (a.state !== 'tripped' && a.state !== 'killed') return { ok: false, status: 409, error: 'not_revoked' };
    const from = clearAgent(a, { resetBudget });
    const data = { operator: who(operator), note: note(reason), from: from.state, cause: from.reason, budgetReset: resetBudget === true };
    events.emit('unrevoke', a.id, data);
    audit.append('unrevoke', a.id, data);
    return { ok: true, agent: describeAgent(a) };
  }

  function unrevokeGlobal({ operator, reason } = {}) {
    settle();
    if (global.state !== 'killed') return { ok: false, status: 409, error: 'not_revoked' };
    global.state = 'armed'; global.stoppedAt = null;
    for (const a of agents.values()) if (a.state === 'armed' || a.state === 'reset') tokens.enable(a.id); // individually stopped agents stay stopped
    const data = { operator: who(operator), note: note(reason), scope: 'global' };
    events.emit('unrevoke', null, data);
    audit.append('unrevoke', null, data);
    return { ok: true };
  }

  // ---- read side --------------------------------------------------------------------------------------------------------
  function describeAgent(a) {
    refresh(a);
    const { rate, cost: budget } = a.limits;
    const inWin = a.window.filter((t) => t > clock.now() - rate.windowMs).length;
    const stopAt = a.stoppedAt;
    return {
      id: a.id, label: AGENTS[a.id].label, state: a.state, reason: a.reason, trips: a.trips, stoppedAt: stopAt === null ? null : new Date(stopAt).toISOString(),
      autoResetAt: a.autoResetAt === null ? null : new Date(a.autoResetAt).toISOString(),
      limits: structuredClone(a.limits), usage: { ...a.usage },
      budget: { tokensLeft: budget.maxTokens - a.usage.tokens, microsLeft: budget.maxMicros - a.usage.micros },
      rate: { inWindow: inWin, max: rate.max, windowMs: rate.windowMs },
      stop: stopAt === null ? null : {
        leakedCalls: a.stop.leakedCalls, firstDeniedAt: a.stop.firstDeniedAt === null ? null : new Date(a.stop.firstDeniedAt).toISOString(),
        gapMs: a.stop.firstDeniedAt === null ? null : a.stop.firstDeniedAt - stopAt,
      },
      inFlight: a.inflight.size, liveTokens: tokens.liveCount(a.id), issuanceDisabled: tokens.isDisabled(a.id),
    };
  }

  function describeGlobal() {
    return {
      state: global.state, stoppedAt: global.stoppedAt === null ? null : new Date(global.stoppedAt).toISOString(), leakedCalls: global.leakedCalls,
      gapMs: global.stoppedAt === null || global.firstDeniedAt === null ? null : global.firstDeniedAt - global.stoppedAt,
    };
  }

  return {
    config: Object.freeze({ ...cfg }), call, settle, kill, killGlobal, unrevoke, unrevokeGlobal,
    agent: (id) => { const a = get(deriveAgentKey(id)); return a ? describeAgent(a) : null; },
    agents: () => [...agents.values()].map(describeAgent),
    global: describeGlobal,
    calls: ({ limit = 50 } = {}) => calls.slice(-limit).map((c) => ({ ...c })),
  };
}
