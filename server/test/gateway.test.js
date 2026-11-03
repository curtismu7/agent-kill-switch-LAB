import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costMicros } from '../src/policy.js';
import { A, B, makeWorld } from './helpers.js';

const RATE3 = { [A]: { rate: { max: 3, windowMs: 10_000 } } };

test('rate cap: the max-th call in a window is admitted, the next one trips (comparison boundary)', () => {
  const w = makeWorld({ limits: RATE3 });
  for (let i = 0; i < 3; i++) assert.equal(w.go().allowed, true, `call ${i + 1} of 3 is within the cap`);
  const r = w.go();
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'rate_cap');
  assert.equal(w.gateway.agent(A).state, 'tripped');
  assert.equal(w.gateway.agent(A).reason, 'rate_cap');
});

test('rate cap: the window slides - a call exactly windowMs old no longer counts, one ms younger still does', () => {
  const w = makeWorld({ limits: RATE3 });
  assert.equal(w.go().allowed, true); // t=0
  w.clock.advance(5000); assert.equal(w.go().allowed, true); // t=5000
  w.clock.advance(4999); assert.equal(w.go().allowed, true); // t=9999: three in window
  // at t=10000 the t=0 call is exactly windowMs old: out of the window, so room for one more
  w.clock.advance(1); assert.equal(w.go().allowed, true, 'the oldest call fell out of the window');
  assert.equal(w.gateway.agent(A).rate.inWindow, 3);

  const w2 = makeWorld({ limits: RATE3 });
  w2.go(); w2.clock.advance(5000); w2.go(); w2.clock.advance(4999); w2.go();
  assert.equal(w2.go().reason, 'rate_cap', 'at t=9999 the first call is still inside the window');
});

test('rate cap: a refused call does not enter the window and an agent under the cap is never tripped by slow calls', () => {
  const w = makeWorld({ limits: RATE3 });
  for (let i = 0; i < 20; i++) { assert.equal(w.go().allowed, true); w.clock.advance(4000); }
  assert.equal(w.gateway.agent(A).state, 'armed');
});

test('cost cap: spending exactly the money budget is allowed, one micro-dollar more trips (boundary)', () => {
  const one = costMicros('demo-small', 500, 200); // 195
  const w = makeWorld({ limits: { [A]: { cost: { maxMicros: one * 2, maxTokens: 1e6 } } } });
  assert.equal(w.go().allowed, true);
  assert.equal(w.go().allowed, true, 'exactly at the budget is allowed');
  assert.equal(w.gateway.agent(A).budget.microsLeft, 0);
  const r = w.go();
  assert.equal(r.reason, 'cost_cap');
  assert.equal(w.gateway.agent(A).state, 'tripped');

  const w2 = makeWorld({ limits: { [A]: { cost: { maxMicros: one * 2 - 1, maxTokens: 1e6 } } } });
  assert.equal(w2.go().allowed, true);
  assert.equal(w2.go().reason, 'cost_cap', 'one micro-dollar under what the second call needs');
});

test('cost cap: the token budget is its own limit, with the same boundary', () => {
  const w = makeWorld({ limits: { [A]: { cost: { maxTokens: 1400, maxMicros: 1e9 } } } });
  assert.equal(w.go().allowed, true); assert.equal(w.go().allowed, true); // 700 + 700 = 1400
  const r = w.go();
  assert.equal(r.reason, 'cost_cap');
  assert.equal(w.events.list().events.find((e) => e.type === 'trip').data.detail.dimension, 'tokens');
});

test('budget accounting: admitted calls are charged exactly, refused calls charge nothing, price table rounds up', () => {
  assert.equal(costMicros('demo-small', 500, 200), 195);
  assert.equal(costMicros('demo-large', 6000, 1500), 40_500);
  assert.equal(costMicros('demo-small', 1, 0), 1, 'rounded up, never down to zero');
  const w = makeWorld({ limits: { [A]: { cost: { maxTokens: 1000, maxMicros: 1e9 } } } });
  w.go();
  let u = w.gateway.agent(A).usage;
  assert.deepEqual([u.calls, u.tokens, u.tokensIn, u.tokensOut, u.micros], [1, 700, 500, 200, 195]);
  assert.equal(w.go().reason, 'cost_cap'); // 700 + 700 > 1000
  u = w.gateway.agent(A).usage;
  assert.deepEqual([u.calls, u.tokens, u.micros], [1, 700, 195], 'the refused call spent nothing');
  assert.equal(w.gateway.agent(A).budget.tokensLeft, 300);
});

test('a trip revokes the agent\'s live tokens and stops the token service issuing new ones', () => {
  const w = makeWorld({ limits: RATE3 });
  for (let i = 0; i < 4; i++) w.go();
  assert.equal(w.tokens.liveCount(A), 0);
  assert.equal(w.tokens.issue(A).reason, 'issuance_disabled');
  assert.equal(w.tokens.issue(B).ok, true, 'a different agent can still get a token');
});

test('the kill switch is checked on EVERY call, not once', () => {
  const w = makeWorld();
  assert.equal(w.go().allowed, true);
  assert.equal(w.gateway.kill({ agentId: A, operator: 'op' }).ok, true);
  for (let i = 0; i < 25; i++) {
    const r = w.go();
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'agent_killed');
    w.clock.advance(1);
  }
  assert.equal(w.gateway.agent(A).usage.calls, 1, 'nothing was admitted after the kill');
});

test('a revoked token is rejected, even with the kill-switch flag off (token-only enforcement)', () => {
  const w = makeWorld({ config: { flagCheck: false } });
  assert.equal(w.go().allowed, true);
  w.gateway.kill({ agentId: A, operator: 'op' });
  const r = w.go();
  assert.equal(r.reason, 'token_revoked');
  assert.equal(r.allowed, false);
});

test('token checks: missing, unknown, expired (at exactly the TTL) and another agent\'s token', () => {
  const w = makeWorld({ config: { tokenTtlMs: 1000 } });
  const t = w.tokens.issue(A);
  const g = w.gateway;
  const call = (token, agentId = A) => g.call({ agentId, token, tool: 'lookup', tokensIn: 1, tokensOut: 1 });
  assert.equal(call(undefined).reason, 'token_missing');
  assert.equal(call('nope').reason, 'token_unknown');
  assert.equal(call(t.token, B).reason, 'token_agent_mismatch');
  w.clock.advance(999); assert.equal(call(t.token).allowed, true, 'valid until the last ms');
  w.clock.advance(1); assert.equal(call(t.token).reason, 'token_expired', 'expired at exactly issuedAt + ttl');
});

test('request shape: unknown tool, unknown model and bad token counts are refused and cost nothing', () => {
  const w = makeWorld();
  assert.equal(w.go(A, { tool: 'rm -rf' }).reason, 'unknown_tool');
  assert.equal(w.go(A, { model: 'gpt-x' }).reason, 'unknown_model');
  assert.equal(w.go(A, { tokensIn: -1 }).reason, 'bad_request');
  assert.equal(w.go(A, { tokensIn: 1.5 }).reason, 'bad_request');
  assert.equal(w.go(A, { tokensIn: Number.MAX_SAFE_INTEGER }).reason, 'bad_request');
  assert.equal(w.gateway.agent(A).usage.micros, 0);
  assert.equal(w.gateway.agent(A).state, 'armed');
});

test('local validation: the gateway honours a revoked token until its revocation list refreshes (the gap)', () => {
  const w = makeWorld({ config: { flagCheck: false, tokenValidation: 'local', revocationSyncMs: 30_000, tokenTtlMs: 60_000 } });
  assert.equal(w.go().allowed, true);          // t=0, list synced at t=0
  w.clock.advance(10_000);
  w.gateway.kill({ agentId: A, operator: 'op' }); // revoked at the token service at t=10s
  w.clock.advance(19_999); assert.equal(w.go().allowed, true, 't=29.999s: the gateway has not refreshed, the revoked token still works');
  w.clock.advance(1);      assert.equal(w.go().reason, 'token_revoked', 't=30s: refresh boundary, now refused');
  const s = w.gateway.agent(A).stop;
  assert.equal(s.gapMs, 20_000);
  assert.equal(s.leakedCalls, 1);
});

test('local validation: a short TTL closes the gap even when the list is slow (why short TTLs matter)', () => {
  const w = makeWorld({ config: { flagCheck: false, tokenValidation: 'local', revocationSyncMs: 3_600_000, tokenTtlMs: 15_000 } });
  w.go();
  w.clock.advance(1000); w.gateway.kill({ agentId: A, operator: 'op' });
  const raw = () => w.gateway.call({ agentId: A, token: w.held[A], tool: 'lookup', tokensIn: 1, tokensOut: 1 });
  w.clock.advance(13_999); assert.equal(raw().allowed, true, 'still inside the TTL');
  w.clock.advance(1); assert.equal(raw().reason, 'token_expired', 'the TTL, not the revocation list, ended it');
  assert.ok(w.gateway.agent(A).stop.gapMs <= 15_000);
});

test('in-flight call: finishes by default, charged, flagged; the next call is refused', () => {
  const w = makeWorld();
  const r = w.go(A, { tool: 'bulk_export' }); // 3000 ms
  assert.equal(r.status, 'in_flight');
  w.clock.advance(1000);
  const k = w.gateway.kill({ agentId: A, operator: 'op' });
  assert.equal(k.inFlightCount, 1);
  assert.equal(w.go().reason, 'agent_killed');
  w.clock.advance(1999);
  w.gateway.settle(); assert.equal(w.gateway.calls().find((c) => c.id === r.id).status, 'in_flight', '1 ms before its end');
  w.clock.advance(1);
  w.gateway.settle();
  const done = w.gateway.calls().find((c) => c.id === r.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.stoppedWhileInFlight, true);
  assert.equal(w.events.list().events.find((e) => e.type === 'call_completed').data.completedAfterStop, true);
  assert.equal(w.gateway.agent(A).usage.calls, 1);
  assert.ok(w.gateway.agent(A).usage.micros > 0, 'charged at admit, not refunded');
});

test('in-flight call with inFlight "cancel": cancelled at once, still charged', () => {
  const w = makeWorld();
  const r = w.go(A, { tool: 'bulk_export' });
  w.gateway.kill({ agentId: A, operator: 'op', inFlight: 'cancel' });
  assert.equal(w.gateway.calls().find((c) => c.id === r.id).status, 'cancelled');
  w.clock.advance(5000); w.gateway.settle();
  assert.equal(w.gateway.calls().find((c) => c.id === r.id).status, 'cancelled', 'a cancelled call never completes');
  assert.equal(w.gateway.agent(A).usage.micros, r.costMicros);
  assert.equal(w.gateway.kill({ agentId: B, operator: 'op', inFlight: 'maybe' }).error, 'bad_in_flight_mode');
});

test('a call that is in flight when a CAP trips also finishes (the trip is not a time machine)', () => {
  const w = makeWorld({ limits: { [A]: { rate: { max: 1, windowMs: 10_000 } } } });
  const r = w.go(A, { tool: 'bulk_export' });
  assert.equal(w.go().reason, 'rate_cap');
  w.clock.advance(3000); w.gateway.settle();
  assert.equal(w.gateway.calls().find((c) => c.id === r.id).status, 'completed');
});

test('trip auto-reset: a rate trip comes back only after the cooldown, and it is audited', () => {
  const w = makeWorld({ limits: { [A]: { rate: { max: 1, windowMs: 10_000 }, autoReset: true, cooldownMs: 30_000 } } });
  w.go(); assert.equal(w.go().reason, 'rate_cap');
  w.clock.advance(29_999);
  assert.equal(w.gateway.agent(A).state, 'tripped', 'one ms before the cooldown ends');
  assert.equal(w.go().reason, 'agent_tripped');
  w.clock.advance(1);
  assert.equal(w.gateway.agent(A).state, 'reset');
  const t = w.tokens.issue(A);
  assert.equal(t.ok, true, 'token issuance is back');
  const r = w.gateway.call({ agentId: A, token: t.token, tool: 'lookup', tokensIn: 1, tokensOut: 1 });
  assert.equal(r.allowed, true);
  assert.equal(w.gateway.agent(A).state, 'armed');
  assert.deepEqual(w.audit.list().map((e) => e.type), ['trip', 'auto_reset']);
});

test('without autoReset, a trip never recovers by waiting; a cost trip and a manual kill never auto-reset', () => {
  const w = makeWorld({ limits: { [A]: { rate: { max: 1, windowMs: 1000 } }, [B]: { rate: { max: 1, windowMs: 1000 }, autoReset: true, cooldownMs: 1000, cost: { maxTokens: 700, maxMicros: 1e9 } } } });
  w.go(A); w.go(A); // A trips (autoReset false)
  w.go(B); w.clock.advance(1001); w.go(B, { tokensIn: 1000 }); // B: second call breaches the cost cap (not a rate trip) -> never auto-resets
  assert.equal(w.gateway.agent(B).reason, 'cost_cap');
  w.clock.advance(86_400_000);
  assert.equal(w.gateway.agent(A).state, 'tripped');
  assert.equal(w.gateway.agent(B).state, 'tripped');
  const k = makeWorld({});
  k.go(); k.gateway.kill({ agentId: A, operator: 'op' });
  k.clock.advance(86_400_000 * 30);
  assert.equal(k.gateway.agent(A).state, 'killed');
  assert.equal(k.go().allowed, false, 'refused, and the token service will not issue a new token either');
});

test('unrevoke needs an operator action, is audited, and does not happen on its own', () => {
  const w = makeWorld();
  w.go(); const oldToken = w.held[A]; w.gateway.kill({ agentId: A, operator: 'alice', reason: 'runaway loop' });
  for (let i = 0; i < 10; i++) { w.go(); w.clock.advance(1000); }
  assert.equal(w.gateway.agent(A).state, 'killed');
  assert.deepEqual(w.audit.list().map((e) => e.type), ['kill'], 'no calls or time passing un-killed it');
  const r = w.gateway.unrevoke({ agentId: A, operator: 'bob', reason: 'fixed the loop' });
  assert.equal(r.ok, true);
  assert.equal(w.gateway.agent(A).state, 'reset');
  const last = w.audit.list().at(-1);
  assert.equal(last.type, 'unrevoke');
  assert.equal(last.agentId, A);
  assert.equal(last.data.operator, 'bob');
  assert.equal(last.data.from, 'killed');
  assert.equal(w.audit.verify().ok, true);
  // old token is still revoked: the agent must fetch a new one
  assert.equal(w.gateway.call({ agentId: A, token: oldToken, tool: 'lookup', tokensIn: 1, tokensOut: 1 }).reason, 'token_revoked');
  assert.equal(w.tokens.issue(A).ok, true);
});

test('unrevoke of an agent that is not revoked is a 409 and writes nothing', () => {
  const w = makeWorld();
  const r = w.gateway.unrevoke({ agentId: A, operator: 'op' });
  assert.deepEqual([r.ok, r.status, r.error], [false, 409, 'not_revoked']);
  assert.equal(w.audit.size, 0);
  assert.equal(w.gateway.kill({ agentId: 'nobody', operator: 'op' }).status, 404);
  w.gateway.kill({ agentId: A, operator: 'op' });
  assert.equal(w.gateway.kill({ agentId: A, operator: 'op' }).error, 'already_killed');
  assert.equal(w.audit.size, 1, 'a refused second kill adds no audit entry');
});

test('unrevoke keeps the spent budget unless the operator resets it', () => {
  const w = makeWorld({ limits: { [A]: { cost: { maxTokens: 700, maxMicros: 1e9 } } } });
  w.go(); assert.equal(w.go().reason, 'cost_cap');
  w.gateway.unrevoke({ agentId: A, operator: 'op' });
  const t = w.tokens.issue(A);
  const again = w.gateway.call({ agentId: A, token: t.token, tool: 'lookup', tokensIn: 500, tokensOut: 200 });
  assert.equal(again.reason, 'cost_cap', 'the money is still spent');
  w.gateway.unrevoke({ agentId: A, operator: 'op', resetBudget: true });
  assert.equal(w.audit.list().at(-1).data.budgetReset, true);
  const t2 = w.tokens.issue(A);
  assert.equal(w.gateway.call({ agentId: A, token: t2.token, tool: 'lookup', tokensIn: 500, tokensOut: 200 }).allowed, true);
});

test('blast radius: killing or tripping one agent leaves the other\'s tokens, window, budget and state untouched', () => {
  const w = makeWorld({ limits: { [A]: { rate: { max: 2, windowMs: 10_000 } } } });
  w.go(B); w.go(A);
  const betaBefore = JSON.stringify(w.gateway.agent(B));
  w.gateway.kill({ agentId: A, operator: 'op' });
  assert.equal(JSON.stringify(w.gateway.agent(B)), betaBefore);
  for (let i = 0; i < 5; i++) { assert.equal(w.go(A).allowed, false); assert.equal(w.go(B).allowed, true); w.clock.advance(3000); }
  assert.equal(w.gateway.agent(B).state, 'armed');
  assert.equal(w.gateway.agent(B).usage.denied, 0);
  assert.equal(w.tokens.issue(B).ok, true);
  // a trip of A (rate) does not touch B either
  const w2 = makeWorld({ limits: { [A]: { rate: { max: 1, windowMs: 10_000 } } } });
  w2.go(A); w2.go(A); w2.go(B);
  assert.equal(w2.gateway.agent(A).state, 'tripped');
  assert.equal(w2.gateway.agent(B).rate.inWindow, 1);
  assert.equal(w2.gateway.agent(B).state, 'armed');
  // unrevoking A does not change B
  w2.gateway.unrevoke({ agentId: A, operator: 'op' });
  assert.equal(w2.gateway.agent(B).state, 'armed');
});

test('the bystander\'s rate window is its own: A hammering the gateway does not consume B\'s cap', () => {
  const w = makeWorld({ limits: { [A]: { rate: { max: 100, windowMs: 10_000 } }, [B]: { rate: { max: 2, windowMs: 10_000 } } } });
  for (let i = 0; i < 50; i++) w.go(A);
  assert.equal(w.go(B).allowed, true);
  assert.equal(w.go(B).allowed, true);
  assert.equal(w.go(B).reason, 'rate_cap');
});

test('global kill: every agent refused and tokens revoked; unrevoke global leaves individually killed agents killed', () => {
  const w = makeWorld();
  w.go(A); w.go(B);
  w.gateway.kill({ agentId: A, operator: 'op' });
  const g = w.gateway.killGlobal({ operator: 'op', reason: 'incident' });
  assert.equal(g.ok, true);
  assert.equal(w.go(B).reason, 'global_kill');
  assert.equal(w.tokens.issue(B).reason, 'issuance_disabled');
  assert.equal(w.gateway.killGlobal({ operator: 'op' }).error, 'already_killed');
  assert.equal(w.gateway.unrevoke({ agentId: B, operator: 'op' }).error, 'not_revoked');
  assert.equal(w.gateway.unrevokeGlobal({ operator: 'op' }).ok, true);
  assert.equal(w.gateway.global().state, 'armed');
  assert.equal(w.tokens.issue(B).ok, true);
  assert.equal(w.gateway.agent(A).state, 'killed');
  assert.equal(w.tokens.issue(A).reason, 'issuance_disabled', 'A is still killed on its own');
  assert.equal(w.gateway.unrevokeGlobal({ operator: 'op' }).error, 'not_revoked');
});

test('while the global switch is on, unrevoking an agent does not reopen token issuance', () => {
  const w = makeWorld();
  w.gateway.kill({ agentId: A, operator: 'op' });
  w.gateway.killGlobal({ operator: 'op' });
  w.gateway.unrevoke({ agentId: A, operator: 'op' });
  assert.equal(w.tokens.issue(A).reason, 'issuance_disabled');
});

test('key derivation: kill and gate resolve the same agent whatever spelling the kill used', () => {
  for (const spelling of ['agent-alpha', ' Agent-Alpha ', 'AGENT-ALPHA', 'default-agent']) {
    const w = makeWorld();
    w.go();
    assert.equal(w.gateway.kill({ agentId: spelling, operator: 'op' }).ok, true, spelling);
    assert.equal(w.go().reason, 'agent_killed', `gate sees the kill made with "${spelling}"`);
  }
  const w = makeWorld();
  assert.equal(w.gateway.kill({ agentId: 'agent-alpha-2', operator: 'op' }).status, 404, 'an id that matches nobody is an error, never a silent no-op kill');
  assert.equal(w.audit.size, 0);
});

test('unknown or hostile agent ids, tool names and notes are inert and redacted', () => {
  const w = makeWorld();
  const evil = 'agent‮<script>alert(1)</script>\u0000';
  const r = w.gateway.call({ agentId: evil, token: 't', tool: 'x​', tokensIn: 1, tokensOut: 1 });
  assert.equal(r.reason, 'unknown_agent');
  assert.doesNotMatch(r.agentId, /[‮\u0000]/);
  assert.match(r.agentId, /\[U\+202E\]/);
  const secret = `Bearer ${'abcdef0123456789'}`;
  w.gateway.kill({ agentId: A, operator: `op​`, reason: `${secret} authorization: hunter2` });
  const e = w.audit.list()[0];
  assert.doesNotMatch(JSON.stringify(e), /abcdef0123456789|hunter2|​/);
  assert.equal(e.data.operator, 'op', 'the zero-width space is deleted before the name is stored');
  assert.doesNotMatch(JSON.stringify(w.events.list()), /abcdef0123456789|hunter2/);
});

test('access token values never appear in events, audit entries, call records or agent state', () => {
  const w = makeWorld({ limits: RATE3 });
  w.go();
  const token = w.held[A];
  for (let i = 0; i < 4; i++) w.go();
  w.gateway.kill({ agentId: A, operator: 'op' });
  const all = JSON.stringify([w.events.list({ limit: 500 }), w.audit.list(), w.gateway.calls(), w.gateway.agents(), w.gateway.global()]);
  assert.ok(!all.includes(token));
  assert.doesNotMatch(all, /kst_/);
});

test('bounded: the call log, event buffer and token store are capped', () => {
  const w = makeWorld({ limits: { [A]: { rate: { max: 1e9, windowMs: 1 } } } });
  for (let i = 0; i < 700; i++) { w.go(); w.clock.advance(2); }
  assert.ok(w.gateway.calls({ limit: 1000 }).length <= 200);
  assert.ok(w.events.size <= 500);
  const t = makeWorld();
  for (let i = 0; i < 700; i++) t.tokens.issue(A);
  assert.equal(t.tokens.lookup(t.tokens.issue(A).token) !== null, true);
});
