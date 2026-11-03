// The older Kill switch endpoints and the HTTP edges, in one process: the sweep classes A-E of 2026-11-01 (probe secrets hunter2xyz and abcdefghijklmnop1234).
//  - A-D: what an operator types into the name and the reason of /api/kill, /api/unrevoke and /api/fedid/revoke is masked AT WRITE TIME, so the audit
//    trail, the event feed and every answer hold only the masked text (the raw stores are read directly, not only through the API);
//  - E: a wrong method on a known route is 405 with Allow, a missing file or path is a JSON 404 that never echoes the path, never Express's HTML;
//  - bounds: the name is at most 40 and the reason at most 200 characters, refused whole above that and kept whole below it (literal numbers).
// Masking is a heuristic: this test pins the shapes it knows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp, startHttpServer } from '../src/app.js';
import { createClock } from '../src/clock.js';
import { createRuntime } from '../src/runtime.js';
import { A, T0, freePort, request } from './helpers.js';

const H = 'hunter2xyz'; const K = 'abcdefghijklmnop1234';
const PAYLOADS = [
  ['p\u0001a\u0001s\u0001s\u0001w\u0001o\u0001r\u0001d: hunter2xyz', H], ['pass\u0000word=hunter2xyz', H], ['pass\u0085word=hunter2xyz', H], ['pass\u007fword=hunter2xyz', H],
  ['my pa\u0000ss\u0000word is hunter2xyz', H], ['tok\u0001en hunter2xyz', H], ['Bea\u0001rer hunter2xyz', H], ['s\u0001k-abcdefghijklmnop1234', K],
  ['password hunter2xyz', H], ['pw hunter2xyz', H], ['token hunter2xyz', H], ['secret hunter2xyz', H], ['api key hunter2xyz', H], ['the key is hunter2xyz', H],
  ['bob:hunter2xyz@host.example', H], ['//bob:hunter2xyz@host.example', H], ['https://bob:hunter2xyz@host.example', H], ['{"password":"hunter2xyz"}', H],
];

async function boot(t, { webDist = null } = {}) {
  const auditStore = [];
  const runtime = createRuntime({ clock: createClock({ fixed: T0 }), auditStore });
  const port = await freePort('maskapi');
  const server = createApp({ runtime, webDist }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return { port, runtime, auditStore, call: (m, p, o) => request(port, m, p, o) };
}

test('A-D: the name and the reason of kill, unrevoke (agent and global) and fedid revoke are masked at write time, in every store and every answer', async (t) => {
  const { call, runtime, auditStore } = await boot(t);
  for (const [typed, core] of PAYLOADS) {
    const seen = [];
    const post = async (p, body) => { const r = await call('POST', p, { body }); seen.push(r.raw); return r; };
    const op = typed.slice(0, 40);
    for (const scope of [{ scope: 'agent', agentId: A }, { scope: 'global' }]) {
      assert.equal((await post('/api/kill', { ...scope, operator: op, reason: typed })).status, 200, `kill ${typed}`);
      assert.equal((await post('/api/unrevoke', { ...scope, operator: op, reason: typed })).status, 200, `unrevoke ${typed}`);
    }
    assert.equal((await post('/api/fedid/revoke', { workload: 'fi-billing-agent', operator: op, reason: typed })).status, 200);
    for (const p of ['/api/audit', '/api/events', '/api/state', '/api/fedid/state', '/api/audit/verify']) seen.push((await call('GET', p)).raw);
    seen.push(JSON.stringify(auditStore), JSON.stringify(runtime.events.list({ limit: 500 })), JSON.stringify(runtime.fedid.state()));
    const all = seen.join('\n');
    assert.equal(all.includes(core), false, `${JSON.stringify(typed)} came back`);
    assert.equal(all.includes(typed), false);
    // survives Reset: the event feed is not cleared by Reset, so what it holds must already be masked; the audit trail opens a new epoch
    assert.equal((await call('POST', '/api/reset', { body: {} })).status, 200);
    const after = [(await call('GET', '/api/events')).raw, (await call('GET', '/api/audit')).raw, JSON.stringify(auditStore), JSON.stringify(runtime.events.list({ limit: 500 }))].join('\n');
    assert.equal(after.includes(core), false, `${JSON.stringify(typed)} survived Reset`);
  }
});

test('A-D: literal stored values for the probe payloads (operator and note) and the shape of the answer', async (t) => {
  const { call, runtime } = await boot(t);
  const cases = [
    ['p\u0001a\u0001s\u0001s\u0001w\u0001o\u0001r\u0001d: hunter2xyz', 'password: [REDACTED]'], ['pass\u0085word=hunter2xyz', 'password=[REDACTED]'], ['tok\u0001en hunter2xyz', 'token [REDACTED]'],
    ['password hunter2xyz', 'password [REDACTED]'], ['api key hunter2xyz', 'api key [REDACTED]'], ['the key is hunter2xyz', 'the key is [REDACTED]'],
    ['bob:hunter2xyz@host.example', '[REDACTED]@host.example'], ['//bob:hunter2xyz@host.example', '//[REDACTED]@host.example'], ['{"password":"hunter2xyz"}', '{"password":[REDACTED]}'],
    ['on-call-operator', 'on-call-operator'], ['suspected runaway loop', 'suspected runaway loop'],
  ];
  for (const [typed, want] of cases) {
    const r = await call('POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: typed, reason: typed } });
    assert.equal(r.status, 200);
    const e = runtime.audit.list().at(-1);
    assert.deepEqual([e.type, e.data.operator, e.data.note], ['kill', want, want], JSON.stringify(typed));
    const ev = runtime.events.list({ limit: 500 }).events.at(-1);
    assert.deepEqual([ev.type, ev.data.operator, ev.data.note], ['kill', want, want]);
    assert.equal((await call('POST', '/api/unrevoke', { body: { scope: 'agent', agentId: A, operator: 'ops' } })).status, 200);
  }
  const f = await call('POST', '/api/fedid/revoke', { body: { workload: 'fi-billing-agent', operator: 'password hunter2xyz', reason: 'pw hunter2xyz' } });
  assert.equal(f.status, 200);
  const id = f.json.state.identities.find((i) => i.id === 'fi-billing-agent');
  assert.deepEqual([id.revokedBy, id.note], ['password [REDACTED]', 'pw [REDACTED]']);
});

test('bounds: a name of 40 and a reason of 200 are kept whole; 41 and 201 are refused whole with a fixed message that does not repeat the text', async (t) => {
  const { call, runtime } = await boot(t);
  const op40 = `${'on call '.repeat(5).slice(0, 39)}1`; const why200 = `${'w '.repeat(99)}w1`;
  assert.deepEqual([op40.length, why200.length], [40, 200]);
  for (const [p, extra] of [['/api/kill', {}], ['/api/unrevoke', {}]]) {
    if (p === '/api/unrevoke') await call('POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: 'x' } });
    const long = await call('POST', p, { body: { scope: 'agent', agentId: A, operator: `${op40}Q`, reason: 'ok', ...extra } });
    assert.equal(long.status, 400, `${p} 41 characters`);
    const longWhy = await call('POST', p, { body: { scope: 'agent', agentId: A, operator: op40, reason: `${why200}Q`, ...extra } });
    assert.equal(longWhy.status, 400, `${p} 201 characters`);
    for (const r of [long, longWhy]) { assert.equal(r.json.message, 'operator (max 40) and reason (max 200) must be short strings'); assert.equal(r.raw.includes('on call'), false); }
    const ok = await call('POST', p, { body: { scope: 'agent', agentId: A, operator: op40, reason: why200, ...extra } });
    assert.equal(ok.status, 200, `${p} 40 and 200`);
    const e = runtime.audit.list().at(-1);
    assert.deepEqual([e.data.operator, e.data.note], [op40, why200], 'stored whole: no ellipsis, nothing cut');
  }
  // the same limits on the Federated Identity revoke
  const fi = (operator, reason) => call('POST', '/api/fedid/revoke', { body: { workload: 'fi-billing-agent', operator, reason } });
  assert.equal((await fi(`${op40}Q`, 'x')).status, 400);
  assert.equal((await fi('x', `${why200}Q`)).status, 400);
  assert.equal((await fi(op40, why200)).status, 200);
  const id = (await call('GET', '/api/fedid/state')).json.state.identities.find((i) => i.id === 'fi-billing-agent');
  assert.deepEqual([id.revokedBy, id.note], [op40, why200]);
});

test('the name is judged AFTER masking: unrevoke refuses a name of invisible or control characters; kill falls back to "operator"', async (t) => {
  const { call, runtime } = await boot(t);
  await call('POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: '​\u0001\u0085﻿' } });
  assert.equal(runtime.audit.list().at(-1).data.operator, 'operator');
  for (const operator of ['​\u0001\u0085﻿', '\u0000\u0000', ' \t ', '']) assert.equal((await call('POST', '/api/unrevoke', { body: { scope: 'agent', agentId: A, operator } })).status, 400, JSON.stringify(operator));
  assert.equal((await call('POST', '/api/unrevoke', { body: { scope: 'agent', agentId: A, operator: '​o\u0001ps' } })).status, 200, 'real characters among the invisible ones are accepted');
  assert.equal(runtime.audit.list().at(-1).data.operator, 'ops');
});

test('errors are fixed strings: a typed key, value or agent id never appears in a 4xx body', async (t) => {
  const { call } = await boot(t);
  for (const [typed, core] of PAYLOADS) {
    const bodies = [{ [typed]: 1 }, { scope: typed }, { scope: 'agent', agentId: typed }, { scope: 'agent', agentId: A, operator: { a: typed } }, { scope: 'agent', agentId: A, operator: 'x', inFlight: typed }, { scope: 'global', agentId: typed }];
    for (const p of ['/api/kill', '/api/unrevoke', '/api/fedid/revoke', '/api/fedid/request', '/api/scenarios/normal/run']) for (const body of bodies) {
      const r = await call('POST', p, { body });
      assert.ok(r.status >= 400 && r.status < 500, `${p} ${r.status}`);
      assert.equal(r.raw.includes(core), false, `${p} echoed ${JSON.stringify(typed)}`);
    }
  }
  assert.equal((await call('POST', '/api/kill', { body: { password: 1 } })).json.message, 'body must be JSON with only: scope, agentId, operator, reason, inFlight');
});

test('E: a wrong method on a known route is 405 with an Allow header, never a 404', async (t) => {
  const { call } = await boot(t);
  const GET_ONLY = ['/api/state', '/api/agents', '/api/events', '/api/scenarios', '/api/audit', '/api/audit/verify', '/api/health', '/api/fedid', '/api/fedid/state', '/api/fedid/mock', '/api/fedid/diagram'];
  const POST_ONLY = ['/api/kill', '/api/unrevoke', '/api/reset', '/api/scenarios/normal/run', '/api/scenarios/normal/step', '/api/fedid/request', '/api/fedid/revoke', '/api/fedid/issuer', '/api/fedid/advance'];
  for (const p of GET_ONLY) for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await call(m, p, { body: {} });
    assert.equal(r.status, 405, `${m} ${p}`); assert.equal(r.headers.allow, 'GET', `${m} ${p}`); assert.equal(r.json.error, 'method_not_allowed');
  }
  for (const p of POST_ONLY) for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    const r = await call(m, p, m === 'GET' ? {} : { body: {} });
    assert.equal(r.status, 405, `${m} ${p}`); assert.equal(r.headers.allow, 'POST', `${m} ${p}`);
  }
  // the three the sweep named
  assert.equal((await call('POST', '/api/state', { body: {} })).headers.allow, 'GET');
  assert.equal((await call('GET', '/api/kill')).headers.allow, 'POST');
  assert.equal((await call('DELETE', '/api/state')).headers.allow, 'GET');
  // an unknown path is still a JSON 404
  for (const p of ['/api/nope', '/api/fedid/nope', '/api/state/extra', '/api/kill/extra']) { const r = await call('GET', p); assert.equal(r.status, 404, p); assert.equal(r.json.error, 'not_found'); }
});

test('E: with a built UI, a missing static file is a JSON 404 (never 200 text/html), and no 404 or error page echoes the path', async (t) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-maskdist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>ui</title>');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  const { call } = await boot(t, { webDist: dist });
  assert.equal((await call('GET', '/assets/a.js')).status, 200);
  assert.match((await call('GET', '/')).headers['content-type'], /text\/html/);
  for (const p of ['/assets/missing.js', '/favicon.ico', '/robots.txt', '/foo.map', '/foo.svg', '/sitemap.xml', '/foo', '/.env', '/assets/', '/assets/..%2f..%2fetc%2fpasswd']) {
    const r = await call('GET', p);
    assert.equal(r.status, 404, p);
    assert.match(r.headers['content-type'], /application\/json/, p);
    assert.equal(r.json.error, 'not_found', p);
    assert.equal(r.raw.includes('Cannot'), false);
  }
  for (const [m, p] of [['POST', '/password-hunter2xyz'], ['PUT', '/secret/hunter2xyz'], ['DELETE', '/x/hunter2xyz.js'], ['POST', '/api/hunter2xyz'], ['PATCH', '/api/fedid/hunter2xyz']]) {
    const r = await call(m, p, { body: {} });
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.equal(r.raw.includes('hunter2xyz'), false, `${m} ${p} echoed the path`);
    assert.equal(r.raw.includes('Cannot'), false);
  }
  for (const [p, status] of [['/%ZZ', 404], ['/%E0%A4%A', 404], ['/api/%ZZ', 404], ['/api/fedid/%ZZ', 404], ['/api/scenarios/%ZZ/run', 400]]) { const r = await call('GET', p); assert.equal(r.status, status, p); assert.match(r.headers['content-type'], /application\/json/, p); assert.equal(r.raw.includes('ZZ'), false); }
  // malformed JSON and an over-long body are JSON errors that do not echo the body
  const bad = await call('POST', '/api/kill', { body: '{"operator":"password hunter2xyz' });
  assert.equal(bad.status, 400); assert.equal(bad.raw.includes('hunter2xyz'), false); assert.match(bad.headers['content-type'], /application\/json/);
  const big = await call('POST', '/api/kill', { body: JSON.stringify({ operator: 'x'.repeat(3000) }) });
  assert.equal(big.status, 413); assert.match(big.headers['content-type'], /application\/json/);
});

test('the started server (workspaces on) answers the same: a wrong method is 405 and a typed name is masked per workspace', async (t) => {
  const srv = await startHttpServer({ port: await freePort('maskapi'), webDist: null });
  t.after(() => srv.close());
  assert.equal((await request(srv.port, 'POST', '/api/state', { body: {} })).headers.allow, 'GET');
  assert.equal((await request(srv.port, 'GET', '/api/kill')).headers.allow, 'POST');
  const r = await request(srv.port, 'POST', '/api/kill', { body: { scope: 'global', operator: 'password hunter2xyz', reason: 'pw hunter2xyz' } });
  assert.equal(r.status, 200); assert.equal(r.raw.includes('hunter2xyz'), false);
});

test('E: an error thrown before the API router is a fixed JSON 500 that repeats nothing of the error or the request', async (t) => {
  const port = await freePort('maskapi');
  const server = createApp({ workspaces: { resolve() { throw new Error('boom password hunter2xyz'); } } }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  const r = await request(port, 'GET', '/api/state?x=hunter2xyz');
  assert.equal(r.status, 500);
  assert.match(r.headers['content-type'], /application\/json/);
  assert.deepEqual(r.json, { error: 'server_error' });
  assert.equal(r.raw.includes('hunter2xyz'), false);
  assert.equal(r.raw.includes('boom'), false);
});
