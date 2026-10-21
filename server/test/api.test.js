import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHttpServer } from '../src/app.js';
import { createClock } from '../src/clock.js';
import { createRuntime } from '../src/runtime.js';
import { A, B, T0, freePort, request } from './helpers.js';

async function boot(t) {
  const runtime = createRuntime({ clock: createClock({ fixed: T0 }) });
  const srv = await startHttpServer({ port: await freePort('api'), runtime });
  t.after(() => srv.close());
  const call = (method, path, opts) => request(srv.port, method, path, opts);
  return { srv, runtime, call, post: (p, body) => call('POST', p, { body: body ?? {} }) };
}

test('health is demo-health/1 and ready', async (t) => {
  const { call } = await boot(t);
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.schema, 'demo-health/1');
  assert.equal(r.json.state, 'ready');
  assert.equal(r.json.demo.id, 'agent-kill-switch');
  assert.equal(r.json.runtime, 'offline');
  assert.deepEqual(Object.keys(r.json).sort(), ['at', 'demo', 'runtime', 'schema', 'state']);
  assert.equal((await call('POST', '/api/health', { body: {} })).status, 405);
});

test('scenarios: list, run each one over HTTP, expectation met', async (t) => {
  const { call, post } = await boot(t);
  const list = (await call('GET', '/api/scenarios')).json.scenarios;
  assert.equal(list.length, 9);
  for (const s of list) {
    const r = await post(`/api/scenarios/${s.id}/run`);
    assert.equal(r.status, 200, s.id);
    assert.equal(r.json.run.expectation.ok, true, s.id);
    assert.equal(r.json.mode, 'demo');
  }
  assert.equal((await post('/api/scenarios/nope/run')).status, 404);
  assert.equal((await post('/api/scenarios/BAD..id/run')).status, 404);
  assert.equal((await post('/api/scenarios/normal/run', { x: 1 })).status, 400);
});

test('step: one action at a time; a finished run answers 409', async (t) => {
  const { post } = await boot(t);
  const first = await post('/api/scenarios/manual-kill/step');
  assert.equal(first.status, 200);
  assert.equal(first.json.run.cursor, 1);
  assert.equal(first.json.entry.allowed, true);
  let last;
  for (let i = 1; i < first.json.run.total; i++) last = await post('/api/scenarios/manual-kill/step');
  assert.equal(last.json.run.done, true);
  assert.equal(last.json.run.expectation.ok, true);
  assert.equal((await post('/api/scenarios/manual-kill/step')).status, 409);
});

test('kill and unrevoke over HTTP: the audit trail records both, verify passes, state and events follow', async (t) => {
  const { call, post } = await boot(t);
  await post('/api/scenarios/normal/run');
  const k = await post('/api/kill', { scope: 'agent', agentId: A, operator: 'alice', reason: 'looks wrong' });
  assert.equal(k.status, 200);
  assert.equal(k.json.state.agents.find((a) => a.id === A).state, 'killed');
  assert.equal((await post('/api/kill', { scope: 'agent', agentId: A })).status, 409);
  const u = await post('/api/unrevoke', { scope: 'agent', agentId: A, operator: 'bob', reason: 'ok now' });
  assert.equal(u.status, 200);
  assert.equal(u.json.state.agents.find((a) => a.id === A).state, 'reset');
  const audit = (await call('GET', '/api/audit')).json;
  assert.deepEqual(audit.entries.map((e) => e.type), ['scenario_start', 'kill', 'unrevoke']);
  assert.equal(audit.entries[1].data.operator, 'alice');
  assert.equal(audit.entries[2].data.operator, 'bob');
  assert.equal((await call('GET', '/api/audit/verify')).json.ok, true);
  const ev = (await call('GET', '/api/events?since=0&limit=500')).json;
  assert.ok(ev.events.some((e) => e.type === 'kill') && ev.events.some((e) => e.type === 'unrevoke'));
});

test('kill and unrevoke: validation', async (t) => {
  const { post } = await boot(t);
  const bad = async (path, body, code = 400) => assert.equal((await post(path, body)).status, code, JSON.stringify(body));
  await bad('/api/kill', {});
  await bad('/api/kill', { scope: 'planet' });
  await bad('/api/kill', { scope: 'agent' });
  await bad('/api/kill', { scope: 'agent', agentId: 5 });
  await bad('/api/kill', { scope: 'agent', agentId: 'x'.repeat(65) });
  await bad('/api/kill', { scope: 'global', agentId: A });
  await bad('/api/kill', { scope: 'agent', agentId: A, token: 'kst_x' });
  await bad('/api/kill', { scope: 'agent', agentId: A, inFlight: 'maybe' });
  await bad('/api/kill', { scope: 'agent', agentId: A, reason: 'r'.repeat(201) });
  await bad('/api/kill', { scope: 'agent', agentId: 'nobody' }, 404);
  await bad('/api/unrevoke', { scope: 'agent', agentId: A }); // an operator name is required
  await bad('/api/unrevoke', { scope: 'agent', agentId: A, operator: '   ' });
  await bad('/api/unrevoke', { scope: 'agent', agentId: A, operator: 'op' }, 409); // not revoked
  await bad('/api/unrevoke', { scope: 'agent', agentId: A, operator: 'op', resetBudget: 'yes' });
  await bad('/api/unrevoke', { scope: 'agent', agentId: 'nobody', operator: 'op' }, 404);
  await bad('/api/kill', [1]);
});

test('global kill and unrevoke over HTTP; in-flight cancel option', async (t) => {
  const { call, post } = await boot(t);
  const g = await post('/api/kill', { scope: 'global', operator: 'op', inFlight: 'cancel' });
  assert.equal(g.status, 200);
  assert.equal(g.json.state.global.state, 'killed');
  assert.equal((await post('/api/unrevoke', { scope: 'global', operator: 'op' })).json.state.global.state, 'armed');
  assert.equal((await call('GET', '/api/audit')).json.entries.length, 2);
});

test('agents, state and events: shapes, cursor, bounds', async (t) => {
  const { call, post } = await boot(t);
  await post('/api/scenarios/rate-loop/run');
  const agents = (await call('GET', '/api/agents')).json;
  assert.equal(agents.agents.length, 2);
  assert.ok(agents.models['demo-small'] && agents.tools.lookup);
  const state = (await call('GET', '/api/state')).json;
  assert.equal(state.agents.find((a) => a.id === A).state, 'tripped');
  assert.equal(state.run.done, true);
  const e1 = (await call('GET', '/api/events?limit=3')).json;
  assert.equal(e1.events.length, 3);
  const e2 = (await call('GET', `/api/events?since=${e1.next}&limit=500`)).json;
  assert.ok(e2.events[0].seq > e1.next);
  assert.equal((await call('GET', '/api/events?since=abc')).status, 400);
  assert.equal((await call('GET', '/api/events?limit=0')).status, 400);
  assert.equal((await call('GET', '/api/events?limit=501')).status, 400);
  assert.equal((await call('GET', '/api/audit?after=-1')).status, 400);
});

test('the audit trail is read-only over HTTP', async (t) => {
  const { call, runtime, post } = await boot(t);
  await post('/api/scenarios/manual-kill/run');
  const before = runtime.audit.verify().headHash;
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const p of ['/api/audit', '/api/audit/verify']) assert.equal((await call(m, p, { body: {} })).status, 405, `${m} ${p}`);
  }
  assert.equal(runtime.audit.verify().headHash, before);
});

test('reset: clears the world and says so in the audit; takes no parameters', async (t) => {
  const { call, post } = await boot(t);
  await post('/api/scenarios/manual-kill/run');
  assert.equal((await post('/api/reset', { x: 1 })).status, 400);
  assert.equal((await post('/api/reset')).status, 200);
  const s = (await call('GET', '/api/state')).json;
  assert.equal(s.run, null);
  assert.equal(s.agents.every((a) => a.state === 'armed'), true);
  assert.equal((await call('GET', '/api/audit')).json.entries[0].type, 'reset');
  assert.equal((await call('GET', '/api/audit/verify')).json.epoch, 2);
});

test('no response ever contains an access token value or its prefix', async (t) => {
  const { call, post, runtime } = await boot(t);
  const paths = ['/api/health', '/api/scenarios', '/api/agents', '/api/state', '/api/events?limit=500', '/api/audit', '/api/audit/verify'];
  for (const s of runtime.scenarios) {
    const run = await post(`/api/scenarios/${s.id}/run`);
    assert.doesNotMatch(run.raw, /kst_/);
    for (const p of paths) assert.doesNotMatch((await call('GET', p)).raw, /kst_/, `${s.id} ${p}`);
  }
});

test('responses are JSON with nosniff and a locked-down CSP; unknown routes are JSON 404', async (t) => {
  const { call } = await boot(t);
  const r = await call('GET', '/api/state');
  assert.match(r.headers['content-type'], /application\/json/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['content-security-policy'], "default-src 'none'");
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('bodies: invalid JSON is 400, over 2 KB is 413, nothing leaks', async (t) => {
  const { call } = await boot(t);
  const bad = await call('POST', '/api/kill', { body: '{not json' });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(bad.raw, /Unexpected|at \w+|node_modules/);
  assert.equal((await call('POST', '/api/kill', { body: { scope: 'agent', agentId: A, reason: 'x'.repeat(3000) } })).status, 413);
});

test('a 500 never leaks the error message or a stack', async (t) => {
  const { call, runtime } = await boot(t);
  const secret = 'SECRET-INTERNAL-DETAIL';
  const orig = runtime.snapshot;
  runtime.snapshot = () => { throw new Error(secret); };
  const origErr = console.error; console.error = () => {};
  try {
    const r = await call('GET', '/api/state');
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'server_error' });
    assert.ok(!r.raw.includes(secret));
  } finally { runtime.snapshot = orig; console.error = origErr; }
  assert.equal(B, 'agent-beta');
});
