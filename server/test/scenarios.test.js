import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../src/clock.js';
import { createRuntime } from '../src/runtime.js';
import { SCENARIOS } from '../src/scenarios.js';
import { A, B, T0 } from './helpers.js';

const rt = () => createRuntime({ clock: createClock({ fixed: T0 }) });
// The transcript without anything random (token values never appear in it).
const strip = (run) => JSON.stringify({ ...run, id: undefined });

test('every scenario ends in the state it declares (run on a fake clock, no sleeps)', () => {
  assert.equal(SCENARIOS.length, 9);
  for (const s of SCENARIOS) {
    const r = rt().runScenario(s.id);
    assert.equal(r.done, true, s.id);
    assert.equal(r.cursor, s.actions.length, s.id);
    assert.deepEqual(r.expectation.checks.filter((c) => !c.pass), [], `${s.id}: ${JSON.stringify(r.expectation.checks.filter((c) => !c.pass))}`);
    assert.equal(r.expectation.ok, true, s.id);
    assert.ok(r.expectation.checks.length >= 2, `${s.id} asserts something about both agents`);
  }
});

test('the named end states: rate trip, cost trip, manual kill, kill+unrevoke, in-flight, blast radius', () => {
  const state = (id, agent = A) => { const r = rt(); r.runScenario(id); return r.gateway.agent(agent); };
  assert.deepEqual([state('rate-loop').state, state('rate-loop').reason], ['tripped', 'rate_cap']);
  assert.deepEqual([state('cost-expensive').state, state('cost-expensive').reason], ['tripped', 'cost_cap']);
  assert.deepEqual([state('manual-kill').state, state('manual-kill').reason], ['killed', 'manual']);
  assert.equal(state('kill-unrevoke').state, 'armed');
  assert.equal(state('in-flight').state, 'killed');
  assert.deepEqual([state('blast-radius').state, state('blast-radius', B).state], ['killed', 'armed']);
  assert.equal(state('blast-radius', B).usage.denied, 0);
});

test('the gap scenario shows leaked calls and a 20 second gap; the flagged scenario has none', () => {
  const g = rt(); g.runScenario('stale-token-gap');
  const s = g.gateway.agent(A).stop;
  assert.deepEqual([s.leakedCalls, s.gapMs], [3, 20_000]);
  const m = rt(); m.runScenario('manual-kill');
  assert.deepEqual([m.gateway.agent(A).stop.leakedCalls, m.gateway.agent(A).stop.gapMs], [0, 500]);
});

test('in-flight scenario: the in-flight export completed after the kill, and the next call was refused', () => {
  const r = rt(); const run = r.runScenario('in-flight');
  const calls = r.gateway.calls();
  const exp = calls.find((c) => c.tool === 'bulk_export');
  assert.equal(exp.status, 'completed');
  assert.equal(exp.stoppedWhileInFlight, true);
  assert.equal(calls.at(-1).reason, 'agent_killed');
  assert.equal(run.counts[A].denied, 1);
});

test('kill+unrevoke: the audit trail holds the kill and the unrevoke by an operator; the agent used a new token', () => {
  const r = rt(); r.runScenario('kill-unrevoke');
  assert.deepEqual(r.audit.list().map((e) => e.type), ['scenario_start', 'kill', 'unrevoke']);
  const tokenEvents = r.events.list({ limit: 500 }).events.filter((e) => e.type === 'token_issued');
  assert.equal(tokenEvents.length, 2, 'one token before the kill, a fresh one after the unrevoke');
  const denied = r.events.list({ limit: 500 }).events.filter((e) => e.type === 'call_denied').map((e) => e.data.reason);
  assert.deepEqual(denied, ['agent_killed', 'agent_killed', 'token_revoked'], 'the stale token was refused once; the agent fetched a new one');
});

test('auto-reset scenario: audited as auto_reset, never as an operator unrevoke', () => {
  const r = rt(); r.runScenario('auto-reset');
  assert.deepEqual(r.audit.list().map((e) => e.type), ['scenario_start', 'trip', 'auto_reset']);
});

test('deterministic: the same scenario twice gives the identical transcript and counts', () => {
  for (const s of SCENARIOS) {
    const a = rt().runScenario(s.id);
    const b = rt().runScenario(s.id);
    assert.equal(strip(a), strip(b), s.id);
  }
});

test('step-by-step reaches the same end as run, one action per step, and a finished run must be restarted', () => {
  for (const s of SCENARIOS) {
    const full = rt().runScenario(s.id);
    const r = rt();
    let last;
    for (let i = 0; i < s.actions.length; i++) {
      last = r.stepScenario(s.id);
      assert.equal(last.run.cursor, i + 1);
      assert.equal(last.run.done, i === s.actions.length - 1);
    }
    assert.equal(strip(last.run), strip(full), s.id);
    assert.equal(r.stepScenario(s.id).error, 'run_finished');
  }
  assert.equal(rt().runScenario('nope'), null);
});

test('audit and events survive a scenario start; reset opens a new audit epoch that records the discard', () => {
  const r = rt();
  r.runScenario('manual-kill');
  const n = r.audit.size;
  r.runScenario('rate-loop');
  assert.ok(r.audit.size > n);
  assert.equal(r.audit.verify().ok, true);
  const head = r.audit.verify().headHash;
  r.reset();
  const v = r.audit.verify();
  assert.equal(v.ok, true);
  assert.equal(v.epoch, 2);
  assert.equal(r.audit.list()[0].type, 'reset');
  assert.equal(r.audit.list()[0].data.discardedHeadHash, head);
  assert.equal(r.gateway.agent(A).state, 'armed');
  assert.equal(r.snapshot().run, null);
});

test('operator kill during a stepped run lands on the live world and changes the rest of the run', () => {
  const r = rt();
  r.stepScenario('rate-loop'); r.stepScenario('rate-loop');
  assert.equal(r.kill({ scope: 'agent', agentId: A, operator: 'human' }).ok, true);
  const s = r.stepScenario('rate-loop');
  assert.equal(s.entry.allowed, false);
  assert.equal(s.entry.reason, 'agent_killed');
});

test('the transcript is bounded', () => {
  const r = rt();
  const run = r.runScenario('rate-loop');
  assert.ok(run.transcript.length <= 300);
});
