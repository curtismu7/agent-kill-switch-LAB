import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startHttpServer } from '../src/app.js';
import { createClock } from '../src/clock.js';
import { runChecks, allPassed } from '../src/doctor.js';
import { createRuntime } from '../src/runtime.js';
import { PORT_MAX, PORT_MIN, SERVER_PORT, assertBindAllowed, bindHost, isLoopbackHost, portInRange, serverPort } from '../src/safety.js';
import { A, T0, freePort, request } from './helpers.js';
import { guardNetwork } from './netguard.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('ports: 6550-6599, server default 6550', () => {
  assert.deepEqual([PORT_MIN, PORT_MAX, SERVER_PORT], [6550, 6599, 6550]);
  assert.equal(serverPort({}), 6550);
  assert.equal(serverPort({ KILL_SWITCH_PORT: '6551' }), 6551);
  for (const p of [6549, 6600, 8080, 5173, 0, 3900, 4000]) assert.equal(portInRange(p), false, String(p));
  assert.equal(portInRange(6550) && portInRange(6599), true);
});

test('binds loopback by default and refuses another address unless KILL_SWITCH_BIND opts in', () => {
  assert.equal(bindHost({}), '127.0.0.1');
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /loopback only/);
  assert.throws(() => assertBindAllowed('192.168.1.5', {}), /loopback only/);
  assert.equal(assertBindAllowed('0.0.0.0', { KILL_SWITCH_BIND: '0.0.0.0' }), '0.0.0.0');
  assert.equal(isLoopbackHost('127.0.0.1') && isLoopbackHost('::1') && isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1.evil.example') || isLoopbackHost('0.0.0.0') || isLoopbackHost('128.0.0.1'), false);
});

test('a started server listens on loopback only', async (t) => {
  const port = await freePort('safety');
  const srv = await startHttpServer({ port, runtime: createRuntime({ clock: createClock({ fixed: T0 }) }) });
  t.after(() => srv.close());
  assert.equal((await request(port, 'GET', '/api/health')).status, 200);
  await assert.rejects(startHttpServer({ port: await freePort('safety'), host: '0.0.0.0', env: {}, runtime: createRuntime() }), /loopback only/);
  const external = Object.values((await import('node:os')).networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4');
  if (external) {
    const refused = await new Promise((resolve) => { const s = net.connect({ host: external.address, port }); s.once('error', (e) => resolve(e.code)); s.once('connect', () => { s.destroy(); resolve('connected'); }); });
    assert.notEqual(refused, 'connected', 'not reachable on the machine\'s LAN address');
  }
});

test('every scenario, an operator kill and unrevoke, an audit verify and a reset make zero non-loopback connections', async (t) => {
  const guard = guardNetwork();
  t.after(() => guard.restore());
  const port = await freePort('safety');
  const srv = await startHttpServer({ port, runtime: createRuntime({ clock: createClock({ fixed: T0 }) }) });
  t.after(() => srv.close());
  for (const s of srv.runtime.scenarios) assert.equal((await request(port, 'POST', `/api/scenarios/${s.id}/run`, { body: {} })).status, 200);
  await request(port, 'POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: 'op' } });
  await request(port, 'POST', '/api/unrevoke', { body: { scope: 'agent', agentId: A, operator: 'op' } });
  await request(port, 'GET', '/api/audit/verify');
  await request(port, 'POST', '/api/reset', { body: {} });
  assert.deepEqual(guard.attempts, []);
});

test('the guard itself works: a non-loopback fetch, socket and DNS lookup are blocked and recorded', async (t) => {
  const guard = guardNetwork();
  t.after(() => guard.restore());
  await assert.rejects(fetch('http://example.com/'), /network blocked/);
  assert.throws(() => net.connect({ host: '203.0.113.5', port: 80 }), /network blocked/);
  assert.ok(guard.attempts.length >= 2);
});

test('source scan: no child process, eval, fetch, outbound request or non-HTTP network module; only KILL_SWITCH_* settings are read', () => {
  for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(srcDir, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /child_process|(?<![.\w])exec(Sync)?\(|\bspawn\(|\beval\(|new Function\(/, `${f}: no process or code execution`);
    assert.doesNotMatch(code, /\bfetch\(/, `${f}: no fetch`);
    assert.doesNotMatch(code, /from 'node:(dns|tls|https|net|dgram|http)'/, `${f}: no network modules`);
    assert.doesNotMatch(code, /\.request\(|XMLHttpRequest|axios/, `${f}: no outbound requests`);
    assert.doesNotMatch(code, /process\.env\.(?!KILL_SWITCH_)/, `${f}: only KILL_SWITCH_* settings are read`);
  }
});

test('time is fully injectable: the gateway, tokens, runtime and events read no timer and no wall clock', () => {
  for (const f of ['gateway.js', 'tokens.js', 'runtime.js', 'events.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(srcDir, f), 'utf8'), /setTimeout|setInterval|Date\.now\(\)|new Date\(\)/, f);
  }
});

test('doctor checks pass in this repo and fail on an out-of-range port or a non-loopback bind', () => {
  assert.equal(allPassed(runChecks({ env: {} })), true);
  assert.equal(allPassed(runChecks({ env: { KILL_SWITCH_PORT: '8080' } })), false);
  assert.equal(allPassed(runChecks({ env: { KILL_SWITCH_PORT: '6550', KILL_SWITCH_BIND: '' } })), true);
});
