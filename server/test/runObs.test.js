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
  assert.deepEqual(r.coverage, { person: 'simulated', agent: 'simulated', authorize: 'not-logged', privilege: 'not-logged', gateway: 'simulated', resource: 'not-logged' });
  assert.match(r.reasons.resource, /no tool server/);
  for (const l of ['authorize', 'privilege']) assert.match(r.reasons[l], /does not call/);
  const kill = r.rows.findIndex((x) => x.layer === 'person' && /pressed the kill switch/.test(x.message));
  assert.ok(kill > 0);
  assert.match(r.rows[kill].message, /Operator "on-call-operator"/);
  assert.match(r.rows[kill].message, /no sign-in/);
  const gw = r.rows.filter((x) => x.layer === 'gateway' && x.origin === 'simulated');
  const after = r.rows.slice(kill + 1).filter((x) => x.layer === 'gateway' && x.outcome !== 'info'); // decisions, not the in-flight tracker settling
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

test('unrevoke and auto-reset are shown; an in-flight call settles after the kill (gateway, information) and a cancelled one is blocked (gateway)', async () => {
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
  assert.ok(fr.rows.some((x) => x.layer === 'gateway' && /in-flight tracker settled call-0001.*ran to its end/.test(x.message)));
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
  const first = (await rec(rt)).runId;
  assert.match(first, /^run-1-[0-9a-f]{6}-1$/);
  rt.stepScenario('normal'); // an unfinished run is replaced by the next one
  const second = await rec(rt);
  assert.match(second.runId, /^run-2-[0-9a-f]{6}-2$/);
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
  for (const s of ['credential-issued', 'credential-withheld', 'call-admitted', 'call-stopped', 'cap-tripped', 'auto-reset', 'operator-kill', 'operator-unrevoke', 'call-settled', 'call-cancelled']) {
    if (s === 'call-cancelled' || s === 'credential-withheld') continue; // not in a stock scenario: the next tests produce them
    assert.ok(steps.has(s), `${s} was written`);
  }
  // line time == row time, for the last run of the sweep (the kill above came after its verdict and is stdout only)
  const r = await rec(rt);
  const own = lines.filter((l) => / run=run-9-[0-9a-f]{6}-9$/.test(l));
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

const scenarioRows = async (id) => { const { rt, lines } = make(); rt.runScenario(id); return { rt, lines, r: await rec(rt) }; };

test('the in-flight tracker row is a gateway row stamped when it ran, and says when the call was due to end; the Resource lane stays not logged', async () => {
  for (const id of ['stale-token-gap', 'in-flight']) {
    const { rt, r } = await scenarioRows(id);
    assert.equal(r.coverage.resource, 'not-logged', id);
    assert.ok(!r.rows.some((x) => x.layer === 'resource' && x.origin === 'simulated'), id);
    const settled = r.rows.filter((x) => /in-flight tracker settled/.test(x.message));
    assert.ok(settled.length > 0, id);
    const calls = new Map(rt.gateway.calls({ limit: 200 }).map((c) => [c.id, c]));
    for (const x of settled) {
      assert.equal(x.layer, 'gateway'); assert.equal(x.outcome, 'info');
      const call = calls.get(x.detail.callId);
      assert.equal(x.detail.endsAt, new Date(call.endsAt).toISOString(), 'endsAt is the call\'s own due time');
      assert.ok(x.message.includes(x.detail.endsAt), 'the message says when it was due');
      assert.ok(Date.parse(x.at) >= call.endsAt, 'the stamp is when the tracker ran, never before the call was due');
      assert.ok(!/\bended\b/.test(x.message), 'it never claims the tool ended at the stamp');
    }
  }
  const { r } = await scenarioRows('in-flight');
  const row = r.rows.find((x) => /settled call-0001/.test(x.message));
  assert.equal(Date.parse(row.at) - Date.parse(row.detail.endsAt), 1000, 'bulk_export was due 1 s before the tracker ran (the stamp is not the end time)');
});

test('a call admitted after the kill (a gateway that does not check the kill flag) is never an unremarkable allow', async () => {
  const { lines, r } = await scenarioRows('stale-token-gap');
  const kill = r.rows.findIndex((x) => x.layer === 'person');
  const admitted = r.rows.slice(kill + 1).filter((x) => x.layer === 'gateway' && x.outcome === 'allowed');
  assert.ok(admitted.length >= 3);
  for (const x of admitted) {
    assert.equal(x.detail.afterKill, true);
    assert.match(x.message, /through although agent-alpha is killed \(this scenario's gateway does not check the kill flag\)/);
    assert.ok(x.message.length < 300, 'not cut by the 300 character cap');
  }
  assert.equal(r.rows.slice(0, kill).filter((x) => x.outcome === 'allowed' && x.detail?.afterKill).length, 0, 'calls before the kill are plain allows');
  assert.equal(lines.filter((l) => /step=call-admitted .* cause=after-stop /.test(l)).length, admitted.length);
  assert.ok(lines.filter((l) => /step=call-admitted/.test(l)).some((l) => /cause=-/.test(l)), 'calls before the kill keep cause=-');
});

test('the stopped state is tracked from the events: trip, global kill, unrevoke and auto-reset clear or set it, and a new scenario starts clean', async () => {
  const log = createRunLog({ write: () => {} });
  let seq = 0; const at = () => new Date(T0 + seq * 100).toISOString();
  const ev = (type, agentId, data = {}) => { seq += 1; log.observe({ seq, at: at(), type, agentId, data }); };
  const allowed = () => ({ callId: 'call-1', tool: 'lookup', model: 'm', tokens: 1, costMicros: 1, budget: { tokensLeft: 1 }, rate: { inWindow: 1, max: 1 } });
  const mark = async () => (await log.record()).rows.filter((x) => x.layer === 'gateway' && x.outcome === 'allowed').at(-1).detail.afterKill === true;
  ev('scenario_start', null, { run: 'run-1' });
  ev('call_allowed', A, allowed());
  {
    assert.equal(await mark(), false);
    ev('trip', A, { reason: 'rate_cap', tokensRevoked: 0, inFlight: 0 }); ev('call_allowed', A, allowed());
    assert.equal(await mark(), true, 'tripped');
    ev('auto_reset', A, { from: 'rate_cap', cooldownMs: 1 }); ev('call_allowed', A, allowed());
    assert.equal(await mark(), false, 'auto-reset clears it');
    ev('kill', null, { operator: 'o', tokensRevoked: 0, inFlightCount: 0, inFlightMode: 'finish' }); ev('call_allowed', B, allowed());
    assert.equal(await mark(), true, 'global kill stops everyone');
    ev('unrevoke', null, { operator: 'o' }); ev('call_allowed', B, allowed());
    assert.equal(await mark(), false, 'global unrevoke');
    ev('kill', A, { operator: 'o', tokensRevoked: 0, inFlightCount: 0, inFlightMode: 'finish' });
    ev('scenario_start', null, { run: 'run-2' }); ev('call_allowed', A, allowed());
    assert.equal(await mark(), false, 'a new scenario builds a fresh world: the old kill is gone');
  }
});

test('a throwing writer or observer changes nothing: same events, same audit, same scenario result as with no writer', async () => {
  const strip = (r) => JSON.stringify({ ...r, id: undefined });
  const base = createRuntime({ clock: createClock({ fixed: T0 }) });
  const baseRun = base.runScenario('rate-loop');
  const errors = [];
  const orig = console.error; console.error = (m) => errors.push(String(m));
  let bad; let badRun;
  try {
    bad = createRuntime({ clock: createClock({ fixed: T0 }), log: () => { throw new Error('disk full'); } });
    badRun = bad.runScenario('rate-loop');
  } finally { console.error = orig; }
  assert.equal(strip(badRun), strip(baseRun));
  assert.equal(bad.events.head, base.events.head);
  assert.deepEqual(bad.audit.list().map((e) => e.type), base.audit.list().map((e) => e.type));
  assert.ok(bad.audit.list().some((e) => e.type === 'trip'), 'the trip is in the audit');
  assert.ok(errors.length > 0 && errors.every((m) => /event observer failed: Error: disk full/.test(m)), errors[0]);
  assert.equal((await bad.runLog.record()).summary.blocked, 5, 'the rows are still kept when only the writer failed');
  // a reason that names an Object.prototype member is just an unknown reason
  for (const reason of ['__proto__', 'constructor', 'toString']) assert.equal(rowOf({ seq: 1, at: 'x', type: 'call_denied', agentId: A, data: { callId: 'c', tool: 't', reason } }).outcome, 'refused');
});

test('an operator action after the verdict is counted for the page, and the count starts again with the next run', async (t) => {
  const { rt } = make();
  rt.runScenario('normal');
  assert.deepEqual(rt.runLog.stdoutOnly, { count: 0, steps: {} });
  rt.kill({ scope: 'agent', agentId: A, operator: 'late' });
  rt.unrevoke({ scope: 'agent', agentId: A, operator: 'late' });
  assert.deepEqual(rt.runLog.stdoutOnly, { count: 2, steps: { 'operator-kill': 1, 'operator-unrevoke': 1 } });
  rt.runScenario('normal');
  assert.deepEqual(rt.runLog.stdoutOnly, { count: 0, steps: {} });
  const port = await freePort('spare');
  const srv = await startHttpServer({ port, env: { HOME: '/nonexistent' } });
  t.after(() => srv.close());
  const cookie = String((await request(port, 'GET', '/api/state')).headers['set-cookie']).split(';')[0];
  await request(port, 'POST', '/api/scenarios/normal/run', { body: {}, headers: { cookie } });
  await request(port, 'POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: 'late' }, headers: { cookie } });
  const r = await request(port, 'GET', '/api/run-observability', { headers: { cookie } });
  assert.deepEqual(r.json.stdoutOnly, { count: 1, steps: { 'operator-kill': 1 } });
});

test('run ids are unique across a Reset and across workspaces, and safe in the stdout line', async () => {
  const { rt, lines } = make();
  rt.runScenario('normal'); const a = (await rec(rt)).runId;
  rt.reset(); rt.runScenario('normal'); const b = (await rec(rt)).runId;
  const other = make(); other.rt.runScenario('normal'); const c = (await rec(other.rt)).runId;
  assert.equal(new Set([a, b, c]).size, 3, `${a} ${b} ${c}`);
  for (const id of [a, b, c]) assert.match(id, /^run-\d+-[0-9a-f]{6}-\d+$/);
  assert.ok(lines.some((l) => l.endsWith(` run=${a}`)) && lines.some((l) => l.endsWith(` run=${b}`)));
});

test('the stdout line masks an operator name typed as an email or an address, as the panel does, and still holds one key=value each', async () => {
  const { rt, lines } = make();
  rt.stepScenario('normal');
  for (const operator of ['a.b@corp.example', '10.0.0.1', 'fe80::1']) rt.kill({ scope: 'agent', agentId: A, operator }) && rt.unrevoke({ scope: 'agent', agentId: A, operator });
  const kills = lines.filter((l) => / step=operator-/.test(l));
  assert.equal(kills.length, 6);
  for (const l of kills) { assert.match(l, LINE); assert.ok(!/corp\.example|@|10\.0\.0\.1|fe80/.test(l), l); }
  const r = await rec(rt);
  assert.ok(!r.rows.some((x) => /corp\.example|10\.0\.0\.1/.test(JSON.stringify(x))), 'and the rows were already masked');
});

test('the scripted operator is not called a person typing; a typed name is', async () => {
  const { rt } = make();
  rt.runScenario('manual-kill');
  let r = await rec(rt);
  const scripted = r.rows.find((x) => x.layer === 'person');
  assert.match(scripted.message, /^The scripted operator "demo-script" pressed the kill switch.*The scenario script did this, not a person/);
  assert.ok(!/typed/.test(scripted.message));
  const t = make(); t.rt.stepScenario('normal'); t.rt.kill({ scope: 'agent', agentId: A, operator: 'ann' });
  r = await rec(t.rt);
  assert.match(r.rows.find((x) => x.layer === 'person').message, /^Operator "ann" pressed.*The name is only what was typed/);
});
