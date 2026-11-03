// The Mock/Real switch (owner rule 19). This demo is mock only by design, so Real is refused unless the test-only
// `realAvailable` seam of createApp is on. Every test runs under the network guard: the switch makes zero outbound attempts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { createClock } from '../src/clock.js';
import { createRuntime } from '../src/runtime.js';
import { T0, request } from './helpers.js';
import { guardNetwork } from './netguard.js';

// Port 0: the OS picks a free loopback port, so this file never collides with the numbered slices of the other files.
async function withApp(fn, { realAvailable = false } = {}) {
  const guard = guardNetwork();
  const runtime = createRuntime({ clock: createClock({ fixed: T0 }) });
  const srv = createApp({ runtime, realAvailable }).listen(0, '127.0.0.1');
  await new Promise((r) => { srv.once('listening', r); });
  const { port } = srv.address();
  const call = (method, path, body) => request(port, method, path, { body });
  try { await fn({ call, mode: (body) => call('POST', '/api/mode', body), info: async () => (await call('GET', '/api/info')).json }); } finally { srv.closeAllConnections?.(); await new Promise((r) => { srv.close(r); }); guard.restore(); }
  assert.deepEqual(guard.attempts, [], 'the switch made no outbound attempt');
}

test('GET /api/info: Mock by default, Real not available, with the reason', () => withApp(async ({ info }) => {
  const i = await info();
  assert.equal(i.source, 'mock');
  assert.equal(i.realAvailable, false);
  assert.match(i.realReason, /mock only by design and has no real server to call/);
}));

test('POST /api/mode real is refused with 409 and the mode stays Mock; mock is accepted', () => withApp(async ({ mode, info }) => {
  const r = await mode({ source: 'real' });
  assert.equal(r.status, 409);
  assert.match(r.json.message, /no real server to call/);
  assert.equal((await info()).source, 'mock');
  const m = await mode({ source: 'mock' });
  assert.equal(m.status, 200);
  assert.equal(m.json.source, 'mock');
}));

test('POST /api/mode needs exactly {source: "mock" | "real"}: anything else is 400', () => withApp(async ({ mode }) => {
  for (const body of [{}, { source: 'live' }, { mode: 'mock' }, { source: 'mock', extra: 1 }, { source: 1 }, [], 'null', '[]', '{not json']) {
    assert.equal((await mode(body)).status, 400, JSON.stringify(body));
  }
}));

test('with Real configured (test seam): Real is the default, the switch goes both ways without a restart, and the demo keeps its state', () => withApp(async ({ mode, info, call }) => {
  const first = await info();
  assert.equal(first.source, 'real');
  assert.equal(first.realAvailable, true);
  assert.equal(first.realReason, null);
  assert.equal((await call('POST', '/api/scenarios/normal/run', {})).status, 200);
  const before = (await call('GET', '/api/state')).json;
  const toMock = await mode({ source: 'mock' });
  assert.equal(toMock.status, 200);
  assert.equal(toMock.json.source, 'mock');
  assert.equal((await info()).source, 'mock');
  const back = await mode({ source: 'real' });
  assert.equal(back.status, 200);
  assert.equal(back.json.source, 'real');
  assert.equal((await info()).source, 'real');
  assert.deepEqual((await call('GET', '/api/state')).json.run, before.run, 'a switch does not touch the run');
}, { realAvailable: true }));

test('the mode is per app instance, not module-global', async () => {
  await withApp(async ({ mode, info }) => {
    await mode({ source: 'mock' });
    assert.equal((await info()).source, 'mock');
  }, { realAvailable: true });
  await withApp(async ({ info }) => assert.equal((await info()).source, 'real'), { realAvailable: true });
});
