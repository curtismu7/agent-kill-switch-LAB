// Rule 27 for this lab: the stdout line per event, one run per record, and the honesty of every row. Mock only: this demo has no Real mode.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHttpServer } from '../src/app.js';
import { createClock } from '../src/clock.js';
import { DENIED, MAX_RUN_EVENTS, createRunLog, decisionLine, lineValue, rowOf } from '../src/runObs.js';
import { assertRunObservability, classify, layerMatchers } from '../src/runObservability.js';
import { createRuntime } from '../src/runtime.js';
import { SCENARIOS } from '../src/scenarios.js';
import { A, B, T0, freePort, request } from './helpers.js';

const make = () => { const lines = []; const rt = createRuntime({ clock: createClock({ fixed: T0 }), log: (l) => lines.push(l) }); return { rt, lines }; };
const rec = async (rt) => { const r = await rt.runLog.record(); assert.deepEqual(assertRunObservability(r), []); return r; };
const simulated = (r) => r.rows.filter((x) => x.origin === 'simulated');
const LINE = /^\d{4}-\d\d-\d\dT[\d:.]+Z agent-kill-switch decision step=[a-z-]+ actor=\S+ agent=\S+ result=(?:passed|stopped|unclear) cause=\S+ run=\S+$/;
const WORDS = /refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served/i;

test('a permitted-then-killed run: every row is simulated, in the order the lab computed it, and no call after the kill is allowed', async () => {
  const { rt } = make();
  rt.stepScenario('manual-kill'); rt.stepScenario('manual-kill'); rt.stepScenario('manual-kill');
  rt.kill({ scope: 'agent', agentId: A, operator: 'on-call-operator', reason: 'runaway', inFlight: 'finish' });
  rt.stepScenario('manual-kill'); // the script's own kill is the 4th action: a second kill is refused (already killed), nothing is invented for it
  for (let i = 0; i < 3; i += 1) rt.stepScenario('manual-kill');
  const r = await rec(rt);
  assert.equal(r.source, 'mock');
  assert.ok(simulated(r).length > 0 && r.rows.filter((x) => x.origin !== 'simulated' && x.origin !== 'not-logged').length === 0, 'no row is tagged logged or response');
  assert.deepEqual(r.coverage, { person: 'simulated', agent: 'simulated', authorize: 'not-logged', privilege: 'not-logged', gateway: 'simulated', resource: 'simulated' });
  for (const l of ['authorize', 'privilege']) assert.match(r.reasons[l], /does not call/);
  const kill = r.rows.findIndex((x) => x.layer === 'person' && /pressed the kill switch/.test(x.message));
  assert.ok(kill > 0);
  assert.match(r.rows[kill].message, /Operator "on-call-operator"/);
  assert.match(r.rows[kill].message, /no sign-in/);
  const gw = r.rows.filter((x) => x.layer === 'gateway' && x.origin === 'simulated');
  const after = r.rows.slice(kill + 1).filter((x) => x.layer === 'gateway');
  assert.ok(after.length >= 3 && after.every((x) => x.outcome === 'blocked'), 'after the kill the gateway stops every call');
  assert.ok(gw.filter((x) => x.outcome === 'allowed').length === 3, 'the three calls before the kill went through');
  assert.ok(r.rows.slice(0, kill).filter((x) => x.layer === 'gateway' && x.outcome === 'allowed').length === 3, 'the kill row comes after the three admitted calls, never before them');
  assert.ok(r.summary.blocked >= 3 && r.summary.refused === 0);
  assert.match(after[0].message, /operator kill is in force/);
});

test('rows come from the stored events only: each row is an event the runtime stored, with the same time; none is invented', async () => {
  for (const s of SCENARIOS) {
    const { rt } = make();
    rt.runScenario(s.id);
    const r = await rec(rt);
    const stored = new Map(rt.events.list({ since: 0, limit: 500 }).events.map((e) => [e.seq, e]));
    const rows = simulated(r);
    assert.ok(rows.length > 0, s.id);
    for (const row of rows) {
      const e = stored.get(row.detail.eventSeq);
      assert.ok(e, `${s.id}: row ${row.id} has a stored event`);
      assert.equal(row.at, e.at, `${s.id}: the row carries the event's own time`);
      assert.equal(row.layer, rowOf(e).layer);
    }
    const expected = [...stored.values()].filter((e) => rowOf(e));
    assert.equal(rows.length, expected.length, `${s.id}: one row per row-producing event, no more`);
    const times = rows.map((x) => Date.parse(x.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    const seqs = rows.map((x) => x.detail.eventSeq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), `${s.id}: equal times keep the order the lab computed them in`);
  }
});

test('a cap trip: the breaching call is blocked, the trip is information, and a trip comes with the stub token service', async () => {
  const { rt } = make();
  rt.runScenario('rate-loop');
  const r = await rec(rt);
  const trip = r.rows.find((x) => /tripped agent-alpha/.test(x.message));
  assert.equal(trip.outcome, 'info');
  assert.match(trip.message, /rate cap was breached/);
  const gw = r.rows.filter((x) => x.layer === 'gateway' && x.outcome !== 'info');
  assert.deepEqual(gw.map((x) => x.outcome), [...Array(5).fill('allowed'), ...Array(5).fill('blocked')]);
  assert.match(gw[5].message, /rate cap was reached \(5 calls in the window, cap 5\)/);
  const cost = make();
  cost.rt.runScenario('cost-expensive');
  const c = await rec(cost.rt);
  assert.match(c.rows.find((x) => x.outcome === 'blocked').message, /cost cap would be exceeded \(/);
});

test('unrevoke and auto-reset are shown; an in-flight call finishes after the kill (resource) and a cancelled one is blocked (gateway)', async () => {
  const k = make(); k.rt.runScenario('kill-unrevoke');
  const kr = await rec(k.rt);
  assert.ok(kr.rows.some((x) => x.layer === 'person' && /unrevoked/.test(x.message)));
  assert.equal(kr.rows.filter((x) => x.layer === 'agent').length, 2, 'two credentials were issued: the agent needed a fresh one after the unrevoke');
  const a = make(); a.rt.runScenario('auto-reset');
  const ar = await rec(a.rt);
  assert.ok(ar.rows.some((x) => /Auto-reset set for \d{4}-\d\d-\d\dT[\d:.]+Z\./.test(x.message)), 'the auto-reset time is a date, not epoch milliseconds');
  assert.ok(ar.rows.some((x) => /cleared the rate_cap trip on agent-alpha by itself/.test(x.message)));
  assert.equal(ar.coverage.person, 'not-logged', 'no operator acted: no person row, and it says why');
  assert.match(ar.reasons.person, /no sign-in/);
  const f = make(); f.rt.runScenario('in-flight');
  const fr = await rec(f.rt);
  assert.ok(fr.rows.some((x) => x.layer === 'resource' && /ran to its end/.test(x.message)));
  const c = make();
  c.rt.stepScenario('in-flight');
  c.rt.kill({ scope: 'agent', agentId: A, operator: 'op', inFlight: 'cancel' });
  const cr = await rec(c.rt);
  const cancelled = cr.rows.find((x) => /cancelled the in-flight/.test(x.message));
  assert.equal(cancelled.layer, 'gateway');
  assert.equal(cancelled.outcome, 'blocked');
});

test('one run per record: the next scenario replaces the open one, and an event after the final verdict joins no record', async () => {
  const { rt, lines } = make();
  rt.stepScenario('rate-loop'); rt.stepScenario('rate-loop');
  assert.equal((await rec(rt)).runId, 'run-1');
  rt.stepScenario('normal'); // an unfinished run is replaced by the next one
  const second = await rec(rt);
  assert.equal(second.runId, 'run-2');
  assert.ok(simulated(second).every((x) => !/rate cap/.test(x.message)), 'nothing of run-1 in run-2');
  assert.equal(rt.runLog.current.open, true);
  rt.runScenario('normal'); // run-2 is not finished: running it again starts run-3
  const n = lines.length;
  const before = JSON.stringify(simulated(await rec(rt)).map((x) => x.detail.eventSeq));
  rt.kill({ scope: 'agent', agentId: B, operator: 'late-operator' }); // after the verdict: logged on stdout, in no record
  assert.equal(lines.length, n + 1);
  assert.match(lines.at(-1), / step=operator-kill actor=late-operator agent=agent-beta .* run=-$/);
  assert.equal(JSON.stringify(simulated(await rec(rt)).map((x) => x.detail.eventSeq)), before);
  assert.equal(rt.runLog.current.open, false);
  rt.reset();
  assert.equal(await rt.runLog.record(), null, 'Reset forgets the run');
});

test('the run keeps at most MAX_RUN_EVENTS events and never drops the run itself', async () => {
  const lines = [];
  const log = createRunLog({ write: (l) => lines.push(l) });
  log.observe({ seq: 1, at: new Date(T0).toISOString(), type: 'scenario_start', agentId: null, data: { run: 'run-1' } });
  for (let i = 0; i < MAX_RUN_EVENTS + 20; i += 1) log.observe({ seq: i + 2, at: new Date(T0 + i).toISOString(), type: 'kill', agentId: A, data: { operator: 'op', tokensRevoked: 0, inFlightCount: 0, inFlightMode: 'finish' } });
  assert.equal(log.current.events, MAX_RUN_EVENTS);
  assert.equal(lines.length, MAX_RUN_EVENTS + 20, 'every event still wrote its line');
  const r = await log.record();
  assert.equal(r.truncated, true, 'the shared collector says it cut rows');
  assert.deepEqual(assertRunObservability(r), []);
});

test('the stdout line: one per row-producing event, the same time as the row, no word the shared matchers read, no way to forge a second line', async () => {
  const { rt, lines } = make();
  for (const s of SCENARIOS) rt.runScenario(s.id);
  rt.kill({ scope: 'agent', agentId: A, operator: 'x'.repeat(40), reason: 'r' });
  const products = [...new Set(layerMatchers.map((m) => m.product))];
  assert.ok(products.length >= 5);
  const steps = new Set();
  for (const line of lines) {
    assert.match(line, LINE);
    const fixed = line.replace(/ actor=\S+/, '');
    assert.ok(!WORDS.test(fixed), fixed);
    steps.add(/ step=(\S+)/.exec(line)[1]);
    for (const product of products) {
      assert.equal(classify({ product, message: line, at: Date.parse(line.split(' ')[0]), atExact: line.split(' ')[0] }, []), null, `${product}: ${line}`);
      assert.equal(classify({ product, message: `[${line.split(' ')[0]}] INFO: ${line.split(' ').slice(1).join(' ')}`, at: 0, atExact: '' }, []), null, `${product} behind a header`);
    }
  }
  for (const s of ['credential-issued', 'credential-withheld', 'call-admitted', 'call-stopped', 'cap-tripped', 'auto-reset', 'operator-kill', 'operator-unrevoke', 'call-finished', 'call-cancelled']) {
    if (s === 'call-cancelled' || s === 'credential-withheld') continue; // not in a stock scenario: the next tests produce them
    assert.ok(steps.has(s), `${s} was written`);
  }
  // line time == row time, for the last run of the sweep (the kill above came after its verdict and is stdout only)
  const r = await rec(rt);
  const own = lines.filter((l) => / run=run-9$/.test(l));
  assert.equal(own.length, simulated(r).length, 'one line per row');
  assert.deepEqual(own.map((l) => l.split(' ')[0]), simulated(r).map((x) => x.at));
});

test('every way the gateway can turn a call away has a row and a line that avoid the matchers\' words; the kill and the caps are blocked, the ordinary checks refused', () => {
  const products = [...new Set(layerMatchers.map((m) => m.product))];
  const STOPPED = ['global_kill', 'agent_killed', 'agent_tripped', 'rate_cap', 'cost_cap', 'token_revoked'];
  for (const reason of Object.keys(DENIED)) {
    const at = new Date(T0).toISOString();
    const row = rowOf({ seq: 1, at, type: 'call_denied', agentId: A, data: { callId: 'call-0001', tool: 'lookup', stage: 's', reason, cause: 'rate_cap', inWindow: 5, max: 5, dimension: 'money' } });
    assert.equal(row.outcome, STOPPED.includes(reason) ? 'blocked' : 'refused', reason);
    const line = decisionLine(row, at, A, 'run-1');
    assert.match(line, LINE, reason);
    assert.ok(!WORDS.test(line.replace(/ actor=\S+/, '')), line);
    for (const product of products) assert.equal(classify({ product, message: line, at: T0, atExact: at }, []), null, `${product}: ${line}`);
  }
  for (const type of ['token_issued', 'token_refused', 'call_allowed', 'call_cancelled', 'trip', 'auto_reset', 'call_completed', 'kill', 'unrevoke']) {
    const at = new Date(T0).toISOString();
    const row = rowOf({ seq: 1, at, type, agentId: A, data: { callId: 'c', tool: 't', model: 'm', tokens: 1, costMicros: 1, budget: { tokensLeft: 1 }, rate: { inWindow: 1, max: 1 }, ttlMs: 1000, tokenId: 'tok-0001', reason: 'rate_cap', from: 'rate_cap', operator: 'o', charged: 1 } });
    const line = decisionLine(row, at, A, 'run-1');
    assert.match(line, LINE, type);
    assert.ok(!WORDS.test(line.replace(/ actor=\S+/, '')), line);
  }
});

test('hostile operator names and notes stay inert: no second key=value, no second line, nothing unmasked in the record', async () => {
  const { rt, lines } = make();
  rt.stepScenario('normal');
  const nasty = 'evil result=passed cause=x\nFAKE decision step=call-admitted <img src=x onerror=alert(1)>';
  rt.kill({ scope: 'agent', agentId: A, operator: nasty.slice(0, 40), reason: `Bearer abcdefghijklmnopqrstuv ${nasty}` });
  const r = await rec(rt);
  const text = JSON.stringify(r) + lines.join('\n');
  assert.ok(!/abcdefghijklmnopqrstuv/.test(text), 'a bearer credential in the note is masked');
  for (const l of lines) { assert.ok(!l.includes('\n')); assert.match(l, LINE); }
  const kill = lines.find((l) => / step=operator-kill /.test(l));
  assert.equal(kill.split(' ').filter((p) => p.startsWith('result=')).length, 1);
  assert.equal(lineValue('a b\nc=d'), 'a_b_c_d');
  assert.equal(lineValue(''), '-');
  assert.equal(decisionLine({ step: 's', who: 'a b', outcome: 'info', cause: undefined }, 'T', null, null), 'T agent-kill-switch decision step=s actor=a_b agent=all result=unclear cause=- run=-');
});

test('the route: empty before a run, one record in the workspace\'s own run, nothing across workspaces, Reset clears it, rows hold no token value', async (t) => {
  const port = await freePort('spare');
  const srv = await startHttpServer({ port, env: { HOME: '/nonexistent' } });
  t.after(() => srv.close());
  const ck = async () => { const r = await request(port, 'GET', '/api/state'); return String(r.headers['set-cookie']).split(';')[0]; };
  const [alice, bob] = [await ck(), await ck()];
  const get = (cookie) => request(port, 'GET', '/api/run-observability', { headers: { cookie } });
  const empty = await get(alice);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { record: null, message: 'No run yet in this workspace: pick a scenario and press Run, Step or Simulate.' });
  assert.equal((await request(port, 'POST', '/api/scenarios/rate-loop/run', { body: {}, headers: { cookie: alice } })).status, 200);
  const a = await get(alice);
  assert.equal(a.json.record.source, 'mock');
  assert.deepEqual(assertRunObservability(a.json.record), []);
  assert.ok(!/kst_[0-9a-f]{8}/.test(a.raw), 'no token value');
  assert.equal((await get(bob)).json.record, null, 'another workspace has no run');
  await request(port, 'POST', '/api/reset', { body: {}, headers: { cookie: alice } });
  assert.equal((await get(alice)).json.record, null);
  assert.equal((await request(port, 'POST', '/api/run-observability', { body: {}, headers: { cookie: alice } })).status, 404, 'GET only');
});
