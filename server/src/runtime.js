// Runtime: owns the clock, the audit trail, the event buffer and the current "world" (token service + gateway + the agents'
// own copies of their tokens). Scenarios run here, step by step or all at once, on the virtual clock.
// Audit and events survive a scenario start; only reset() clears them (and the audit says so).
import { createAudit } from './audit.js';
import { createClock, wallNow as realNow } from './clock.js';
import { createEvents } from './events.js';
import { createGateway } from './gateway.js';
import { AGENTS, DEFAULT_GATEWAY, MODELS, TOOLS, deriveAgentKey } from './policy.js';
import { SCENARIOS, getScenario } from './scenarios.js';
import { createTokenService } from './tokens.js';

export const TRANSCRIPT_CAP = 300;
const OPERATOR = 'demo-script';
const TOKEN_REASONS = new Set(['token_expired', 'token_revoked', 'token_unknown', 'token_missing']);

export function createRuntime({ clock = createClock(), wallNow = realNow, auditStore, auditCap, hosted = false } = {}) {
  const events = createEvents({ clock });
  const audit = createAudit({ store: auditStore, now: () => new Date(wallNow()), scenarioNow: () => clock.iso(), cap: auditCap });
  let world = null;
  let run = null;

  function buildWorld(scenario = null) {
    const cfg = { ...DEFAULT_GATEWAY, ...(scenario?.config || {}) };
    const tokens = createTokenService({ clock, ttlMs: cfg.tokenTtlMs });
    const gateway = createGateway({ clock, tokens, audit, events, limits: scenario?.limits || {}, config: cfg });
    return { tokens, gateway, held: new Map() };
  }
  world = buildWorld();

  // ---- the scripted agent ------------------------------------------------------------------------------------------------
  // The agent holds its own token and trusts its expiry time; it does not know about revocation. On a token_* refusal it asks
  // the token service for a new token once (what a real client does on a 401). If the service refuses, the refusal stands.
  function agentCall(agentId, a) {
    const w = world;
    const attempt = () => {
      let held = w.held.get(agentId);
      if (!held || clock.now() >= held.expiresAt) {
        const t = w.tokens.issue(agentId);
        if (!t.ok) {
          events.emit('token_refused', agentId, { reason: t.reason });
          return { allowed: false, stage: 'token_service', reason: t.reason };
        }
        events.emit('token_issued', agentId, { tokenId: t.tokenId, ttlMs: t.ttlMs, expiresAt: new Date(t.expiresAt).toISOString() });
        held = { token: t.token, expiresAt: t.expiresAt };
        w.held.set(agentId, held);
      }
      return w.gateway.call({ agentId, token: held.token, tool: a.tool, model: a.model, tokensIn: a.tokensIn, tokensOut: a.tokensOut });
    };
    let r = attempt();
    if (!r.allowed && TOKEN_REASONS.has(r.reason)) {
      w.held.delete(agentId);
      const again = attempt();
      r = again.allowed ? { ...again, retriedAfter: r.reason } : { ...r, refusedBy: again.reason }; // the first refusal stands
    }
    return r;
  }

  // ---- operator actions, shared by scenarios and the HTTP endpoints -----------------------------------------------------
  const doKill = (body) => (body.scope === 'global' ? world.gateway.killGlobal(body) : world.gateway.kill(body));
  const doUnrevoke = (body) => (body.scope === 'global' ? world.gateway.unrevokeGlobal(body) : world.gateway.unrevoke(body));
  // A kill by an operator (the HTTP endpoints) is in force until an operator unrevokes it or resets the demo. Starting a scenario
  // builds a fresh world, which would silently clear it with no audit entry, so a scenario will not start while one is in force.
  // (A kill that a scenario script performs itself is part of that scenario and does not block the next one.)
  const manualKills = new Set();
  const killKey = (body) => (body.scope === 'global' ? 'global' : world.gateway.agent(body.agentId)?.id);
  function kill(body) { const r = doKill(body); if (r.ok) manualKills.add(killKey(body)); return r; }
  function unrevoke(body) { const r = doUnrevoke(body); if (r.ok) manualKills.delete(killKey(body)); return r; }
  const killInForce = () => {
    const live = [...manualKills].filter((k) => (k === 'global' ? world.gateway.global().state === 'killed' : world.gateway.agent(k)?.state === 'killed'));
    return live.length ? { error: 'kill_in_force', killed: live } : null;
  };

  // ---- scenario runner ---------------------------------------------------------------------------------------------------
  function startRun(scenario) {
    world = buildWorld(scenario);
    run = { id: `run-${(run ? Number(run.id.slice(4)) : 0) + 1}`, scenario: scenario.id, cursor: 0, done: false, transcript: [], counts: Object.fromEntries(Object.keys(AGENTS).map((id) => [id, { allowed: 0, denied: 0 }])), expectation: null };
    audit.append('scenario_start', null, { scenario: scenario.id, run: run.id });
    events.emit('scenario_start', null, { scenario: scenario.id, run: run.id, title: scenario.title });
  }

  function execute(action) {
    clock.advance(action.after || 0);
    world.gateway.settle();
    const entry = { n: run.cursor + 1, action: action.t, agent: action.agent ?? null, at: clock.iso() };
    if (action.t === 'call') {
      const r = agentCall(action.agent, action);
      const c = run.counts[action.agent];
      if (r.allowed) c.allowed += 1; else c.denied += 1;
      Object.assign(entry, { tool: action.tool, allowed: r.allowed, stage: r.stage, reason: r.reason ?? null, costMicros: r.costMicros ?? 0, retriedAfter: r.retriedAfter ?? null });
    } else if (action.t === 'kill') {
      const r = doKill({ scope: action.scope ?? 'agent', agentId: action.agent, operator: OPERATOR, reason: 'scripted', inFlight: action.inFlight });
      Object.assign(entry, { ok: r.ok, error: r.error ?? null });
    } else if (action.t === 'unrevoke') {
      const r = doUnrevoke({ scope: action.scope ?? 'agent', agentId: action.agent, operator: OPERATOR, reason: 'scripted', resetBudget: action.resetBudget === true });
      Object.assign(entry, { ok: r.ok, error: r.error ?? null });
    } else Object.assign(entry, { waitedMs: action.after });
    return entry;
  }

  function evaluate(scenario) {
    const checks = [];
    const all = world.gateway.calls({ limit: 200 });
    for (const e of scenario.expect) {
      const ag = world.gateway.agent(e.agent);
      const actual = {
        state: ag.state, reason: ag.reason, allowed: run.counts[e.agent].allowed, denied: run.counts[e.agent].denied,
        leaked: ag.stop?.leakedCalls ?? 0, gapMs: ag.stop?.gapMs ?? null,
        completedAfterStop: all.filter((c) => c.agentId === e.agent && c.status === 'completed' && c.stoppedWhileInFlight).length,
      };
      for (const field of ['state', 'reason', 'allowed', 'denied', 'leaked', 'gapMs', 'completedAfterStop']) {
        if (e[field] !== undefined) checks.push({ agent: e.agent, field, expected: e[field], actual: actual[field], pass: actual[field] === e[field] });
      }
    }
    return { ok: checks.every((c) => c.pass), checks };
  }

  function stepRun(scenario) {
    const action = scenario.actions[run.cursor];
    const entry = execute(action);
    run.cursor += 1;
    run.transcript.push(entry);
    if (run.transcript.length > TRANSCRIPT_CAP) run.transcript.shift();
    if (run.cursor >= scenario.actions.length) {
      world.gateway.settle();
      run.done = true;
      run.expectation = evaluate(scenario);
      events.emit('scenario_end', null, { scenario: scenario.id, run: run.id, ok: run.expectation.ok });
    }
    return entry;
  }

  const runInfo = () => (run ? { id: run.id, scenario: run.scenario, cursor: run.cursor, total: getScenario(run.scenario).actions.length, done: run.done, counts: structuredClone(run.counts), expectation: run.expectation, transcript: structuredClone(run.transcript) } : null);

  return {
    clock, audit, events, mode: 'demo', hosted,
    get gateway() { return world.gateway; },
    scenarios: SCENARIOS,
    // Start the scenario afresh and execute every action.
    runScenario(id) {
      const s = getScenario(id);
      if (!s) return null;
      const blocked = killInForce();
      if (blocked) return blocked;
      startRun(s);
      while (!run.done) stepRun(s);
      return runInfo();
    },
    // Execute the next action. Starts the scenario if no run of it is in progress; a finished run must be restarted with run or reset.
    stepScenario(id) {
      const s = getScenario(id);
      if (!s) return null;
      if (run && run.scenario === id && run.done) return { error: 'run_finished' };
      if (!run || run.scenario !== id || run.done) {
        const blocked = killInForce();
        if (blocked) return blocked;
        startRun(s);
      }
      const entry = stepRun(s);
      return { entry, run: runInfo() };
    },
    kill, unrevoke,
    // Everything back to the start. The audit trail is not erased silently: it opens a new epoch whose first entry records the head of the old one.
    reset() {
      world = buildWorld();
      manualKills.clear();
      run = null;
      audit.reset();
      events.emit('reset', null, {});
    },
    snapshot() {
      world.gateway.settle();
      return {
        mode: 'demo', hosted, now: clock.iso(), fakeClock: clock.fake, run: runInfo(), operatorKills: killInForce()?.killed ?? [], global: world.gateway.global(), agents: world.gateway.agents(),
        gateway: { ...world.gateway.config }, recentCalls: world.gateway.calls({ limit: 30 }),
      };
    },
    tables: { models: MODELS, tools: TOOLS, agents: AGENTS },
    deriveAgentKey,
  };
}
