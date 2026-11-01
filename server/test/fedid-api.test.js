// /api/fedid over real HTTP: honest statuses, JSON 404s, guards, the raw token only in one answer, concurrency, Reset, the hosted refusal.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHttpServer } from '../src/app.js';
import { createClock } from '../src/clock.js';
import { REQUEST_CAP } from '../src/fedid/tables.js';
import { createRuntime } from '../src/runtime.js';
import { T0, freePort, request } from './helpers.js';
import { guardNetwork } from './netguard.js';

const B = 'fi-billing-agent';
const N = 'fi-nightly-job';
async function boot(t, { hosted = false } = {}) {
  const runtime = createRuntime({ clock: createClock({ fixed: T0 }), hosted });
  const srv = await startHttpServer({ port: await freePort('fedid'), runtime });
  t.after(() => srv.close());
  const call = (method, path, opts) => request(srv.port, method, path, opts);
  return { srv, runtime, call, post: (p, body) => call('POST', `/api/fedid${p}`, { body: body ?? {} }), get: (p) => call('GET', `/api/fedid${p}`) };
}

test('the catalogue, the diagram, the Mock table and the Live state are served', async (t) => {
  const { get } = await boot(t);
  const c = (await get('')).json;
  assert.equal(c.banner, 'Ping release claim, UNVERIFIED on our tenant');
  assert.equal(c.story.length, 18);
  assert.equal(c.limits.maxLifetimeSec, 3600);
  assert.ok(c.facts.every((f) => f.tag === 'deck claim'));
  assert.equal((await get('/diagram')).json.name, 'fedid-revoke');
  const m = (await get('/mock')).json;
  assert.deepEqual([m.mode, m.table.schema], ['mock', 'fedid-mock/1']);
  const s = (await get('/state')).json;
  assert.equal(s.mode, 'live');
  assert.equal(s.state.requests, 0);
  assert.equal(s.state.identities.length, 2);
});

test('statuses: 200 allowed, 403 identity_revoked and scope_missing, 401 lifetime; the body carries the whole result each time', async (t) => {
  const { post } = await boot(t);
  const ok = await post('/request', { workload: B, service: 'mcp' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.result.decision, 'allowed');
  const scope = await post('/request', { workload: N, service: 'a2a' });
  assert.deepEqual([scope.status, scope.json.result.reason, scope.json.result.status], [403, 'scope_missing', 403]);
  const rev = await post('/revoke', { workload: B, operator: 'ops', reason: 'test' });
  assert.equal(rev.status, 200);
  const cut = await post('/request', { workload: B, service: 'llm' });
  assert.deepEqual([cut.status, cut.json.result.reason, cut.json.result.tokenStillValid, cut.json.result.deployment.identity], [403, 'identity_revoked', true, B]);
  const long = await post('/request', { workload: N, service: 'mcp', lifetimeSec: 3601 });
  assert.deepEqual([long.status, long.json.result.reason], [401, 'lifetime_exceeds_cap']);
  assert.equal(cut.json.state.requests, 3);
});

test('the raw mock token is in the answer to the request that presented it, and in no read, state, log or audit response', async (t) => {
  const { post, get, call } = await boot(t);
  const r = await post('/request', { workload: B, service: 'mcp' });
  const raw = r.json.result.token.raw;
  assert.match(raw, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.match(r.json.result.token.rawLabel, /mock-issued/);
  for (const res of [await get('/state'), await get(''), await get('/mock'), await call('GET', '/api/state'), await call('GET', '/api/audit?limit=500'), await call('GET', '/api/events')]) {
    assert.equal(res.raw.includes(raw), false, 'the raw token must not be repeated');
  }
  assert.equal(JSON.stringify((await get('/state')).json).includes('"raw"'), false);
});

test('bad bodies are 400 with a fixed message that never echoes the input; 405 and JSON 404 for the rest', async (t) => {
  const { call, post } = await boot(t);
  const secret = 'hunter2-NOT-A-REAL-PASSWORD';
  for (const [p, body] of [['/request', { workload: secret, service: 'mcp' }], ['/request', { workload: B, service: secret }], ['/request', { [secret]: 1 }], ['/revoke', { workload: secret, operator: 'x' }], ['/issuer', { outage: secret }], ['/advance', { seconds: secret }]]) {
    const r = await post(p, body);
    assert.equal(r.status, 400, p);
    assert.equal(r.json.error, 'bad_request');
    assert.equal(r.raw.includes(secret), false);
  }
  assert.equal((await call('GET', '/api/fedid/request')).status, 405);
  assert.equal((await call('POST', '/api/fedid/state', { body: {} })).status, 405);
  const nf = await call('GET', `/api/fedid/${secret}`);
  assert.equal(nf.status, 404);
  assert.deepEqual(nf.json, { error: 'not_found', message: 'no such endpoint' });
  assert.equal((await call('GET', `/${secret}/x`)).status, 404);
  assert.equal((await call('POST', '/api/fedid/request', { body: '{not json', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await call('POST', '/api/fedid/request', { body: { workload: B, service: 'mcp', pad: 'x'.repeat(3000) } })).status, 413);
  assert.equal((await post('/revoke', { workload: 'nobody-here', operator: 'x' })).status, 400);
});

test('the guards apply: cross-origin and text bodies are refused, credential headers are refused, nothing changes', async (t) => {
  const { call, runtime } = await boot(t);
  const body = { workload: B, operator: 'x' };
  assert.equal((await call('POST', '/api/fedid/revoke', { body, headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await call('POST', '/api/fedid/revoke', { body, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call('POST', '/api/fedid/revoke', { body: 'workload=x', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call('POST', '/api/fedid/revoke', { body, headers: { authorization: 'Bearer nope' } })).status, 400);
  assert.equal((await call('POST', '/api/fedid/revoke', { body, host: 'evil.example' })).status, 421);
  assert.equal((await call('GET', '/api/fedid/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(runtime.fedid.state().identities.every((i) => i.state === 'active'), true);
});

test('CONCURRENCY: two revokes at once give one 200 and one 409; the request cap holds under parallel requests', async (t) => {
  const { post, runtime } = await boot(t);
  const two = await Promise.all([post('/revoke', { workload: B, operator: 'a' }), post('/revoke', { workload: B, operator: 'b' })]);
  assert.deepEqual(two.map((r) => r.status).sort(), [200, 409]);
  assert.equal(runtime.fedid.state().identities.find((i) => i.id === B).revokedBy === 'a' || runtime.fedid.state().identities.find((i) => i.id === B).revokedBy === 'b', true);
  for (let i = runtime.fedid.state().requests; i < REQUEST_CAP - 10; i += 1) runtime.fedid.request({ workload: N, service: 'mcp' });
  const many = await Promise.all(Array.from({ length: 25 }, () => post('/request', { workload: N, service: 'mcp' })));
  const statuses = many.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 429).length, 15);
  assert.equal(statuses.filter((s) => s === 200).length, 10);
  assert.equal(runtime.fedid.state().requests, REQUEST_CAP);
  assert.equal(many.find((r) => r.status === 429).json.error, 'request_cap');
});

test('time and the issuer: advance and outage change what the next request shows', async (t) => {
  const { post } = await boot(t);
  assert.equal((await post('/request', { workload: N, service: 'mcp' })).json.result.keySet.source, 'cache');
  assert.equal((await post('/advance', { seconds: 1000 })).status, 200);
  assert.equal((await post('/request', { workload: N, service: 'mcp' })).json.result.keySet.source, 'refreshed');
  assert.equal((await post('/issuer', { outage: true })).json.state.issuerOutage, true);
  await post('/advance', { seconds: 1000 });
  const out = (await post('/request', { workload: N, service: 'mcp' })).json.result;
  assert.deepEqual([out.decision, out.keySet.source, out.keySet.issuerReachable], ['allowed', 'cache', false]);
});

test('RESET: POST /api/reset restores the Federated Identity engine and the audit records it', async (t) => {
  const { post, call, get } = await boot(t);
  await post('/revoke', { workload: B, operator: 'ops' });
  await post('/request', { workload: B, service: 'mcp' });
  assert.equal((await get('/state')).json.state.identities.find((i) => i.id === B).state, 'revoked');
  assert.equal((await call('POST', '/api/reset', { body: {} })).status, 200);
  const s = (await get('/state')).json.state;
  assert.deepEqual([s.requests, s.identities.every((i) => i.state === 'active'), s.log.length], [0, true, 0]);
  assert.equal((await post('/request', { workload: B, service: 'mcp' })).status, 200);
});

test('the audit trail carries the revoke (operator masked) and every decision, and the chain verifies', async (t) => {
  const { post, call } = await boot(t);
  await post('/request', { workload: B, service: 'mcp' });
  await post('/revoke', { workload: B, operator: 'ops-9', reason: 'my password is hunter2-xyz987' });
  await post('/request', { workload: B, service: 'mcp' });
  const a = (await call('GET', '/api/audit?limit=500')).json;
  const types = a.entries.map((e) => e.type);
  assert.deepEqual(types.filter((x) => x.startsWith('fedid')), ['fedid_decision', 'fedid_revoke', 'fedid_decision']);
  const rev = a.entries.find((e) => e.type === 'fedid_revoke');
  assert.deepEqual([rev.agentId, rev.data.operator], [B, 'ops-9']);
  assert.equal(JSON.stringify(a).includes('hunter2-xyz987'), false);
  assert.equal((await call('GET', '/api/audit/verify')).json.ok, true);
});

test('HOSTED mock build: the Live endpoints are refused 403, the Mock table is served', async (t) => {
  const { get, post } = await boot(t, { hosted: true });
  assert.equal((await get('/mock')).status, 200);
  assert.equal((await get('')).status, 200);
  for (const r of [await get('/state'), await post('/request', { workload: B, service: 'mcp' }), await post('/revoke', { workload: B, operator: 'x' }), await post('/issuer', { outage: true }), await post('/advance', { seconds: 5 })]) {
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'live_not_available_in_hosted_mock');
  }
});

test('NETGUARD: the whole section makes zero non-loopback connections', async (t) => {
  const guard = guardNetwork();
  t.after(() => guard.restore());
  const { post, get } = await boot(t);
  await get(''); await get('/mock'); await get('/state'); await get('/diagram');
  await post('/request', { workload: B, service: 'mcp' }); await post('/revoke', { workload: B, operator: 'x' }); await post('/issuer', { outage: true }); await post('/advance', { seconds: 5 });
  assert.deepEqual(guard.attempts, []);
  // the guard itself works: a non-loopback fetch is recorded and refused
  await assert.rejects(fetch('http://203.0.113.9/'), /network blocked/);
  assert.deepEqual(guard.attempts, ['fetch:203.0.113.9']);
});
