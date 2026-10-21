import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHttpServer } from '../src/app.js';
import { createClock } from '../src/clock.js';
import { createRuntime } from '../src/runtime.js';
import { A, T0, freePort, request } from './helpers.js';

async function boot(t) {
  const runtime = createRuntime({ clock: createClock({ fixed: T0 }) });
  const srv = await startHttpServer({ port: await freePort('guards'), runtime });
  t.after(() => srv.close());
  return { srv, runtime, call: (m, p, o) => request(srv.port, m, p, o) };
}
const fingerprint = (rt) => JSON.stringify([rt.snapshot().agents, rt.snapshot().global, rt.audit.verify().headHash, rt.audit.size, rt.events.head]);

test('CSRF: a cross-origin page cannot kill an agent, kill globally, run a scenario or reset', async (t) => {
  const { srv, runtime, call } = await boot(t);
  await call('POST', '/api/scenarios/normal/run', { body: {} });
  const before = fingerprint(runtime);
  const evil = [
    { origin: 'http://evil.example' }, { origin: 'http://127.0.0.1:1' }, { origin: 'null' }, { origin: `http://localhost:${srv.port}` },
    { origin: `https://127.0.0.1:${srv.port}` }, { origin: `http://127.0.0.1:${srv.port}/x` }, { origin: `http://user@127.0.0.1:${srv.port}` },
  ];
  for (const h of evil) {
    for (const [p, body] of [['/api/kill', { scope: 'agent', agentId: A }], ['/api/kill', { scope: 'global' }], ['/api/scenarios/rate-loop/run', {}], ['/api/reset', {}]]) {
      const r = await call('POST', p, { body, headers: h });
      assert.equal(r.status, 403, `${p} with Origin ${h.origin}`);
      assert.equal(r.json.error, 'bad_origin');
    }
  }
  assert.equal(fingerprint(runtime), before, 'state, audit and events are unchanged by every refused request');
});

test('CSRF: a cross-origin page cannot unrevoke a killed agent', async (t) => {
  const { srv, runtime, call } = await boot(t);
  assert.equal((await call('POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: 'alice' } })).status, 200);
  assert.equal((await call('POST', '/api/kill', { body: { scope: 'global', operator: 'alice' } })).status, 200);
  const before = fingerprint(runtime);
  for (const h of [{ origin: 'http://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'cross-site', origin: `http://127.0.0.1:${srv.port}` }]) {
    for (const body of [{ scope: 'agent', agentId: A, operator: 'mallory' }, { scope: 'global', operator: 'mallory' }]) {
      const r = await call('POST', '/api/unrevoke', { body, headers: h });
      assert.equal(r.status, 403, JSON.stringify(h));
    }
  }
  assert.equal(fingerprint(runtime), before);
  assert.equal(runtime.gateway.agent(A).state, 'killed');
  assert.equal(runtime.gateway.global().state, 'killed');
  // the same request from the page's own origin works
  const ok = await call('POST', '/api/unrevoke', { body: { scope: 'agent', agentId: A, operator: 'alice' }, headers: { origin: `http://127.0.0.1:${srv.port}`, 'sec-fetch-site': 'same-origin' } });
  assert.equal(ok.status, 200);
});

test('CSRF: a "simple" form post (text/plain or urlencoded body) is refused with 415 and changes nothing', async (t) => {
  const { runtime, call } = await boot(t);
  const before = fingerprint(runtime);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const r = await call('POST', '/api/kill', { body: JSON.stringify({ scope: 'global' }), headers: { 'content-type': type } });
    assert.equal(r.status, 415, type);
  }
  const noType = await call('POST', '/api/kill', { body: '{"scope":"global"}', headers: { 'content-type': '' } });
  assert.equal(noType.status, 415);
  assert.equal(fingerprint(runtime), before);
});

test('Sec-Fetch-Site: same-origin, same-site and none are allowed; cross-site is not', async (t) => {
  const { call } = await boot(t);
  for (const v of ['same-origin', 'same-site', 'none']) assert.equal((await call('POST', '/api/reset', { body: {}, headers: { 'sec-fetch-site': v } })).status, 200, v);
  assert.equal((await call('POST', '/api/reset', { body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});

test('Host guard: DNS-rebinding hosts get 421 on reads and writes alike', async (t) => {
  const { runtime, call } = await boot(t);
  const before = fingerprint(runtime);
  for (const host of ['evil.example', 'evil.example:6550', '127.0.0.1.evil.example', 'localhost.evil.example', '0.0.0.0', '10.0.0.5', '[::2]', '127.0.0.1:99999', 'localhost:abc', ' ']) {
    assert.equal((await call('GET', '/api/health', { host })).status, 421, host);
    assert.equal((await call('POST', '/api/kill', { host, body: { scope: 'global' } })).status, 421, host);
  }
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST:6550', '127.1.2.3']) assert.equal((await call('GET', '/api/health', { host })).status, 200, host);
  assert.equal(fingerprint(runtime), before);
});

test('credentials are refused on every route, writes included', async (t) => {
  const { runtime, call } = await boot(t);
  const before = fingerprint(runtime);
  for (const h of [{ authorization: 'Bearer x' }, { 'proxy-authorization': 'Basic x' }, { 'x-api-key': 'k' }]) {
    for (const [m, p] of [['GET', '/api/health'], ['GET', '/api/state'], ['POST', '/api/kill'], ['POST', '/api/unrevoke'], ['GET', '/nope']]) {
      const r = await call(m, p, { headers: h, body: m === 'POST' ? { scope: 'global', operator: 'x' } : undefined });
      assert.equal(r.status, 400, `${m} ${p}`);
      assert.equal(r.json.error, 'credentials_not_accepted');
    }
  }
  assert.equal(fingerprint(runtime), before);
});

test('no body field can carry a credential, a token, a URL or a target', async (t) => {
  const { runtime, call } = await boot(t);
  const before = fingerprint(runtime);
  for (const extra of [{ token: 'x' }, { access_token: 'x' }, { authorization: 'Bearer x' }, { url: 'http://evil.example' }, { host: 'evil.example' }, { upstream: 'x' }]) {
    assert.equal((await call('POST', '/api/kill', { body: { scope: 'agent', agentId: A, ...extra } })).status, 400, JSON.stringify(extra));
    assert.equal((await call('POST', '/api/unrevoke', { body: { scope: 'agent', agentId: A, operator: 'x', ...extra } })).status, 400);
  }
  assert.equal((await call('POST', '/api/scenarios/normal/run', { body: { url: 'x' } })).status, 400);
  assert.equal(fingerprint(runtime), before);
});

test('there is no route that makes a call, issues a token or edits a limit', async (t) => {
  const { call } = await boot(t);
  for (const [m, p] of [['POST', '/api/call'], ['POST', '/api/calls'], ['POST', '/api/token'], ['POST', '/api/tokens'], ['PUT', '/api/agents'], ['PATCH', '/api/agents/agent-alpha'], ['POST', '/api/limits'], ['POST', '/api/config'], ['DELETE', '/api/audit']]) {
    const r = await call(m, p, { body: {} });
    assert.ok([404, 405].includes(r.status), `${m} ${p} -> ${r.status}`);
  }
});

test('hostile operator text is stored inert and redacted', async (t) => {
  const { call } = await boot(t);
  await call('POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: 'eve‮', reason: '<img src=x onerror=alert(1)> password=hunter2 ​' } });
  const e = (await call('GET', '/api/audit')).json.entries[0];
  assert.doesNotMatch(JSON.stringify(e), /hunter2|[‮​]/);
  assert.match(e.data.operator, /\[U\+202E\]/);
});
