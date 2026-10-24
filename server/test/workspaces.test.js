// Per-visitor workspaces (the hosted build's isolation) and the MODE refusals. Ports: the ws slice (6597; one server at a time).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { modeChecks } from '../src/mode.js';
import { createRuntime } from '../src/runtime.js';
import { runChecks, allPassed } from '../src/doctor.js';
import { COOKIE, createWorkspaces } from '../src/workspaces.js';
import { A, freePort, request } from './helpers.js';

const cookieOf = (res) => {
  const sc = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith(`${COOKIE}=`));
  return sc ? sc.split(';')[0] : null;
};
const LOCAL = { HOME: '/nonexistent' }; // no MODE: the local build

test('two browsers get two workspaces; a kill, a run and the audit in one never reach the other', async (t) => {
  const port = await freePort('ws');
  const srv = await startHttpServer({ port, env: LOCAL });
  t.after(() => srv.close());
  const alice = await request(port, 'GET', '/api/state');
  const bob = await request(port, 'GET', '/api/state');
  const ca = cookieOf(alice); const cb = cookieOf(bob);
  assert.ok(ca && cb, 'each first visit is given a workspace cookie');
  assert.notEqual(ca, cb, 'the two workspace ids differ');

  // Alice runs a scenario and kills an agent; Bob does nothing.
  const run = await request(port, 'POST', '/api/scenarios/rate-loop/run', { body: {}, headers: { cookie: ca } });
  assert.equal(run.status, 200);
  const kill = await request(port, 'POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: 'alice' }, headers: { cookie: ca } });
  assert.equal(kill.status, 200);

  const sa = await request(port, 'GET', '/api/state', { headers: { cookie: ca } });
  const sb = await request(port, 'GET', '/api/state', { headers: { cookie: cb } });
  assert.notEqual(sa.json.run, null, 'alice has a run');
  assert.equal(sb.json.run, null, 'bob has no run');
  assert.deepEqual(sb.json.operatorKills, [], 'bob has no operator kill');
  assert.equal(sb.json.recentCalls.length, 0, 'bob has no calls');
  assert.ok(sa.json.operatorKills.length > 0, 'alice has her kill in force');

  const auditA = await request(port, 'GET', '/api/audit?limit=500', { headers: { cookie: ca } });
  const auditB = await request(port, 'GET', '/api/audit?limit=500', { headers: { cookie: cb } });
  assert.ok(auditA.json.entries.some((e) => e.type === 'kill'), 'alice audit holds the kill');
  assert.equal(auditB.json.entries.length, 0, 'bob audit is empty');

  const evB = await request(port, 'GET', '/api/events?since=0', { headers: { cookie: cb } });
  assert.equal(evB.json.events.length, 0, 'bob sees no events from alice');

  // A reset by Bob does not touch Alice's kill or audit.
  await request(port, 'POST', '/api/reset', { body: {}, headers: { cookie: cb } });
  const sa2 = await request(port, 'GET', '/api/state', { headers: { cookie: ca } });
  assert.ok(sa2.json.operatorKills.length > 0, 'bob reset does not clear alice kill');
});

test('the same cookie returns the same workspace; a malformed or unknown-format cookie gets a new id', async (t) => {
  const port = await freePort('ws');
  const srv = await startHttpServer({ port, env: LOCAL });
  t.after(() => srv.close());
  const first = await request(port, 'GET', '/api/state');
  const c = cookieOf(first);
  await request(port, 'POST', '/api/scenarios/rate-loop/run', { body: {}, headers: { cookie: c } });
  const again = await request(port, 'GET', '/api/state', { headers: { cookie: c } });
  assert.notEqual(again.json.run, null, 'the same cookie keeps its run');
  assert.equal(cookieOf(again), null, 'a valid cookie is not reissued');
  const bad = await request(port, 'GET', '/api/state', { headers: { cookie: `${COOKIE}=not-an-id` } });
  assert.match(cookieOf(bad), /^ks_ws=[a-f0-9]{32}$/, 'a malformed id is replaced');
  assert.equal(bad.json.run, null, 'and gets a fresh workspace');
});

test('the workspace cookie is HttpOnly and SameSite=Strict; Secure only in the hosted build', () => {
  const make = (hosted) => {
    const headers = [];
    createWorkspaces({ hosted }).resolve({ headers: {} }, { append: (_k, v) => headers.push(v) });
    return headers[0];
  };
  const local = make(false); const hosted = make(true);
  for (const h of [local, hosted]) { assert.match(h, /HttpOnly/); assert.match(h, /SameSite=Strict/); assert.match(h, /Path=\//); }
  assert.doesNotMatch(local, /Secure/);
  assert.match(hosted, /; Secure/);
});

test('memory is bounded: the least recently used workspace is dropped at the cap', () => {
  const made = [];
  const ws = createWorkspaces({ cap: 2, make: () => { const rt = { n: made.length }; made.push(rt); return rt; } });
  const res = { append() {} };
  const a = ws.resolve({ headers: {} }, res);
  ws.resolve({ headers: {} }, res);
  assert.equal(ws.size, 2);
  const c = ws.resolve({ headers: {} }, res);
  assert.equal(ws.size, 2, 'a third visitor does not grow the registry past the cap');
  assert.equal(made.length, 3, 'three runtimes were made');
  assert.notEqual(c, a, 'a new visitor gets a new runtime');
});

test('the hosted build refuses live and credential settings, an unset or invalid public host, and a wide bind', () => {
  const good = { MODE: 'se-mock', KILL_SWITCH_PUBLIC_HOST: 'ai-demo.example.com', KILL_SWITCH_BIND: '0.0.0.0' };
  assert.equal(modeChecks(good).some((c) => c.level === 'fail'), false, 'a clean hosted config passes');
  assert.equal(modeChecks({ MODE: 'se-mock' }).find((c) => c.id === 'se-mock-host').level, 'fail', 'public host required');
  for (const bad of ['localhost', '127.0.0.1', 'https://ai-demo.example.com', 'ai-demo.example.com:443', 'ai-demo.example.com/x', 'a b.example.com']) {
    assert.equal(modeChecks({ ...good, KILL_SWITCH_PUBLIC_HOST: bad }).find((c) => c.id === 'se-mock-host').level, 'fail', `${bad} refused`);
  }
  const secret = modeChecks({ ...good, PINGONE_CLIENT_SECRET: 'x' }).find((c) => c.id === 'se-mock-no-live');
  assert.equal(secret.level, 'fail');
  assert.doesNotMatch(secret.detail, /PINGONE|CLIENT_SECRET/, 'the refusal does not print the setting name');
  assert.equal(modeChecks({ ...good, TENANT_ID: 'x' }).find((c) => c.id === 'se-mock-no-live').level, 'fail');
  assert.equal(modeChecks({ ...good, KILL_SWITCH_BIND: '10.0.0.7' }).find((c) => c.id === 'se-mock-bind').level, 'fail');
  assert.equal(modeChecks({ MODE: 'live' })[0].level, 'fail', 'an unknown MODE is refused');
  assert.equal(modeChecks({})[0].detail, 'local', 'the default is local');
});

test('the doctor refuses to start a hosted build with a live setting (the same check index.js runs)', () => {
  const env = { MODE: 'se-mock', KILL_SWITCH_PUBLIC_HOST: 'ai-demo.example.com', KILL_SWITCH_BIND: '0.0.0.0', OKTA_CLIENT_SECRET: 'x' };
  assert.equal(allPassed(runChecks({ env })), false);
  assert.equal(allPassed(runChecks({ env: { MODE: 'se-mock', KILL_SWITCH_PUBLIC_HOST: 'ai-demo.example.com', KILL_SWITCH_BIND: '0.0.0.0' } })), true);
});

test('hosted guards: the public host and its https origin pass; any other Host or Origin is refused; loopback still works', async (t) => {
  const port = await freePort('ws');
  const app = createApp({ runtime: createRuntime({ hosted: true }), health: createHealth({ runChecks: () => [], env: {} }), publicHost: 'ai-demo.example.com' });
  const srv = app.listen(port, '127.0.0.1');
  t.after(() => new Promise((r) => srv.close(r)));
  assert.equal((await request(port, 'GET', '/api/state', { host: 'ai-demo.example.com' })).status, 200, 'the public host reads');
  assert.equal((await request(port, 'POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: 'op' }, host: 'ai-demo.example.com', headers: { origin: 'https://ai-demo.example.com' } })).status, 200, 'same-origin https write passes');
  assert.equal((await request(port, 'POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: 'op' }, host: 'ai-demo.example.com', headers: { origin: 'https://evil.example.net' } })).status, 403, 'a foreign origin is refused');
  assert.equal((await request(port, 'POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: 'op' }, host: 'ai-demo.example.com', headers: { origin: 'http://ai-demo.example.com' } })).status, 403, 'http origin on the public host is refused');
  assert.equal((await request(port, 'GET', '/api/state', { host: 'other.example.com' })).status, 421, 'another host is refused');
  assert.equal((await request(port, 'GET', '/api/health', { host: '127.0.0.1' })).status, 200, 'the loopback probe still passes');
  assert.equal((await request(port, 'GET', '/api/health', { host: '10.1.2.3' })).status, 421, 'a pod-IP probe is refused (probes must send the loopback Host)');
});
