// Rule 27: this lab's side of the shared run-observability panel. The vendored collector (runObservability.js) is never edited here.
//
// Every event the runtime computes (events.js emit) is stamped ONCE, there. This module is handed that stored event and does two
// things with it: writes ONE stdout line for it, and keeps it as a row of the current run. The record is built from those stored
// events only: nothing is re-run, no time is invented, and an event the mock did not compute is never shown. Time is the lab's own
// scenario clock (clock.js): it starts at the wall-clock time the workspace was created and moves only when the script moves.
//
// Mock only, by design (this lab has no Real mode): every row is `simulated`. A layer the lab never touched says so.
//
// Stdout line (what a collector would ship): `<iso> agent-kill-switch decision step=<step> actor=<who> agent=<agent|all> result=<passed|stopped|unclear> cause=<cause> run=<id>`.
// The family's matchers read words such as refused, denied, rejected, forbidden, failed, invalid, expired, mismatch, token, audience,
// scope and served, so the line uses none of them (steps and causes come from the tables below). A test runs every line through the shared classify().
import { createRunObservability } from './runObservability.js';

export const MAX_RUN_EVENTS = 1000; // per run; the shared collector keeps at most 500 rows and says so (truncated), so this only bounds memory
const SERVICE = 'agent-kill-switch';

// Only safe characters survive, so an operator name cannot add a second key=value pair, a quote or a line.
export const lineValue = (v, n = 64) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').slice(0, n) || '-';
const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear' };

// call_denied reason -> [outcome, word for the stdout line, sentence for the row]. `blocked` = the lab's own kill switch or cap stopped the call;
// `refused` = an ordinary check on the call did not pass.
export const DENIED = {
  global_kill: ['blocked', 'global-kill', () => 'the global kill switch is on'],
  agent_killed: ['blocked', 'killed', () => 'an operator kill is in force for this agent (the kill is checked on every call)'],
  agent_tripped: ['blocked', 'tripped', (d) => `this agent is tripped (${d.cause})`],
  rate_cap: ['blocked', 'rate-cap', (d) => `the rate cap was reached (${d.inWindow} calls in the window, cap ${d.max})`],
  cost_cap: ['blocked', 'cost-cap', (d) => `the cost cap would be exceeded (${d.dimension})`],
  token_revoked: ['blocked', 'credential-revoked', () => 'the access token was revoked'],
  token_missing: ['refused', 'no-credential', () => 'no access token was sent'],
  token_unknown: ['refused', 'unknown-credential', () => 'the access token is not one the token service issued'],
  token_agent_mismatch: ['refused', 'wrong-agent', () => 'the access token belongs to another agent'],
  token_expired: ['refused', 'lapsed-credential', () => 'the access token has run out'],
  unknown_agent: ['refused', 'unknown-agent', () => 'the agent is not registered'],
  unknown_tool: ['refused', 'unknown-tool', () => 'the tool is not one the gateway knows'],
  unknown_model: ['refused', 'unknown-model', () => 'the model is not one the gateway knows'],
  bad_request: ['refused', 'bad-request', () => 'the request is malformed'],
};
const TRIP_WHY = { rate_cap: 'the rate cap was breached', cost_cap: 'the cost cap was breached' };

// One stored event -> { layer, product, step, outcome, cause, who, message, detail }, or null for an event that is not a log row of any layer
// (scenario_start, scenario_end and reset only open, close and clear a run).
export function rowOf(e) {
  const d = e.data || {};
  const agent = e.agentId;
  const target = agent ?? 'all agents';
  const call = `${d.callId} (${agent}, ${d.tool})`;
  switch (e.type) {
    case 'token_issued':
      return { layer: 'agent', product: 'stub token service', step: 'credential-issued', outcome: 'info', who: agent, message: `The stub token service issued ${d.tokenId} to ${agent}, valid for ${d.ttlMs / 1000} s.`, detail: { ttlMs: d.ttlMs, expiresAt: d.expiresAt } };
    case 'token_refused':
      return { layer: 'agent', product: 'stub token service', step: 'credential-withheld', outcome: 'blocked', cause: 'issuance-off', who: agent, message: `The stub token service would not issue a token to ${agent}: issuance is switched off for it by a trip or a kill.`, detail: { reason: d.reason } };
    case 'call_allowed':
      return { layer: 'gateway', product: 'mock gateway', step: 'call-admitted', outcome: 'allowed', who: agent, message: `The mock gateway let ${call} through: ${d.model}, ${d.tokens} tokens, ${d.costMicros} micro-dollars. Rate ${d.rate.inWindow} of ${d.rate.max} in the window; ${d.budget.tokensLeft} tokens of budget left.`, detail: { callId: d.callId, tool: d.tool, model: d.model, tokens: d.tokens, costMicros: d.costMicros, budget: d.budget, rate: d.rate } };
    case 'call_denied': {
      const [outcome, cause, why] = DENIED[d.reason] || ['refused', 'other', () => 'a check on the call did not pass'];
      const { callId, tool, stage, reason, ...more } = d;
      return { layer: 'gateway', product: 'mock gateway', step: outcome === 'blocked' ? 'call-stopped' : 'call-turned-away', outcome, cause, who: agent, message: `The mock gateway ${outcome === 'blocked' ? 'stopped' : 'refused'} ${call}: ${why(d)}.`, detail: { callId, tool, stage, reason, ...more } };
    }
    case 'call_cancelled':
      return { layer: 'gateway', product: 'mock gateway', step: 'call-cancelled', outcome: 'blocked', cause: 'cancel-in-flight', who: agent, message: `The mock gateway cancelled the in-flight ${call} when the stop landed (in-flight policy "cancel"). It had already been charged ${d.charged} micro-dollars.`, detail: { callId: d.callId, tool: d.tool, charged: d.charged } };
    case 'trip': {
      const resetAt = d.autoResetAt ? new Date(d.autoResetAt).toISOString() : null; // the event holds epoch ms
      return { layer: 'gateway', product: 'mock gateway', step: 'cap-tripped', outcome: 'info', cause: lineValue(d.reason).replace(/_/g, '-'), who: agent, message: `The mock gateway tripped ${agent}: ${TRIP_WHY[d.reason] || d.reason}. Live tokens revoked: ${d.tokensRevoked}; calls in flight: ${d.inFlight}.${resetAt ? ` Auto-reset set for ${resetAt}.` : ''}`, detail: { reason: d.reason, detail: d.detail, tokensRevoked: d.tokensRevoked, inFlight: d.inFlight, autoResetAt: resetAt } };
    }
    case 'auto_reset':
      return { layer: 'gateway', product: 'mock gateway', step: 'auto-reset', outcome: 'info', cause: lineValue(d.from).replace(/_/g, '-'), who: agent, message: `The mock gateway cleared the ${d.from} trip on ${agent} by itself after the ${d.cooldownMs / 1000} s cooldown.`, detail: { from: d.from, cooldownMs: d.cooldownMs } };
    case 'call_completed':
      return { layer: 'resource', product: 'mock tool', step: 'call-finished', outcome: 'info', cause: d.completedAfterStop ? 'after-stop' : '-', who: agent, message: `The mock tool ${d.tool} ended for ${d.callId} (${agent}) on the scenario clock${d.completedAfterStop ? '; the call was authorised before the stop, so it ran to its end' : ''}. The mock tools return nothing.`, detail: { callId: d.callId, tool: d.tool, completedAfterStop: d.completedAfterStop } };
    case 'kill':
    case 'unrevoke': {
      const kill = e.type === 'kill';
      const extra = kill ? ` Live tokens revoked: ${d.tokensRevoked}; in-flight calls: ${d.inFlightCount} (${d.inFlightMode}).` : ` ${d.budgetReset ? 'Budget reset.' : ''}`;
      return { layer: 'person', product: 'operator form', step: kill ? 'operator-kill' : 'operator-unrevoke', outcome: 'info', cause: '-', who: d.operator, message: `Operator "${d.operator}" ${kill ? 'pressed the kill switch' : 'unrevoked'} for ${target}.${extra.trimEnd()} The name is only what was typed: the lab has no sign-in.`, detail: kill ? { operator: d.operator, note: d.note, from: d.from, scope: d.scope, tokensRevoked: d.tokensRevoked, inFlightMode: d.inFlightMode, inFlightCount: d.inFlightCount } : { operator: d.operator, note: d.note, from: d.from, cause: d.cause, scope: d.scope, budgetReset: d.budgetReset } };
    }
    default:
      return null;
  }
}

export const decisionLine = (row, at, agent, runId) => `${at} ${SERVICE} decision step=${row.step} actor=${lineValue(row.who)} agent=${lineValue(agent ?? 'all')} result=${RESULT[row.outcome]} cause=${lineValue(row.cause)} run=${runId ? lineValue(runId) : '-'}`;

// Why a layer has no row. Statements about this lab, used when the run has no event for the layer.
const WHY = {
  person: 'No operator pressed kill or unrevoke in this run. An operator is only a name typed into the form (or the script\'s own demo-script): the lab has no sign-in, so it never logs a person signing in.',
  agent: 'The stub token service issued or withheld nothing in this run so far.',
  authorize: 'This lab does not call PingOne Authorize. The mock gateway\'s own rate, cost and kill checks decide; they are shown under Agent gateway.',
  privilege: 'This lab does not call Privilege (policy, AI Guard or approvals). Everything is a mock in one process.',
  gateway: 'The mock gateway was not called in this run so far.',
  resource: 'No mock tool call ran to its end in this run. The mock tools return nothing: they only occupy time on the scenario clock, so there is no tool-server log.',
};
const LAYER_IDS = Object.keys(WHY);

// The run log of ONE runtime (one workspace). `observe(event)` is called by events.js for every event, in order, right after it was stamped.
// Only the latest run is kept: a run opens on scenario_start, closes on scenario_end (or is replaced by the next scenario_start), and an
// event outside an open run is written to stdout but joins no record. reset() forgets the run.
export function createRunLog({ write = () => {} } = {}) {
  let run = null; // { id, startedAt, endedAt, open, rows: [{ at, layer, product, outcome, message, detail }], dropped }

  function observe(e) {
    if (e.type === 'scenario_start') { run = { id: e.data.run, startedAt: e.at, endedAt: e.at, open: true, rows: [] }; return; }
    if (e.type === 'scenario_end') { if (run && run.id === e.data.run) { run.open = false; run.endedAt = e.at; } return; }
    if (e.type === 'reset') { run = null; return; }
    const row = rowOf(e);
    if (!row) return;
    const joins = run?.open === true;
    write(decisionLine(row, e.at, e.agentId, joins ? run.id : null));
    if (!joins) return;
    run.rows.push({ at: e.at, layer: row.layer, product: row.product, outcome: row.outcome, message: row.message, detail: { ...row.detail, eventSeq: e.seq } });
    if (run.rows.length > MAX_RUN_EVENTS) run.rows.shift();
    run.endedAt = e.at;
  }

  // The record of the current run, or null before one. Built from the stored rows only.
  async function record({ clock = Date.now } = {}) {
    if (!run) return null;
    const rec = await createRunObservability({ clock }).collectRun({
      runId: run.id, startedAt: run.startedAt, endedAt: run.endedAt, source: 'mock',
      layers: LAYER_IDS.map((layer) => ({ layer, products: [], reason: WHY[layer], simulated: run.rows.filter((r) => r.layer === layer) })),
    }); // no correlation: nothing is matched against logs here, so no id is declared and names stay readable
    // The scenario clock stamps every event of one script step with the same instant, and the collector breaks such a tie by layer. The order
    // the lab computed them in is the truth (a kill pressed after the third call must not read as before it), so ties are put back in event order.
    const stamped = rec.rows.filter((r) => r.at !== null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.detail.eventSeq - b.detail.eventSeq);
    return { ...rec, rows: [...stamped.map((r, i) => ({ ...r, id: `r${i + 1}` })), ...rec.rows.filter((r) => r.at === null)] };
  }

  return { observe, record, get current() { return run ? { id: run.id, open: run.open, events: run.rows.length } : null; } };
}
