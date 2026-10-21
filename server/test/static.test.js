import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UI_CSP, createApp } from '../src/app.js';
import { createClock } from '../src/clock.js';
import { createRuntime } from '../src/runtime.js';
import { T0, freePort, request } from './helpers.js';

let lastDist = null;
async function boot(t, webDist, files = {}) {
  let dist = webDist;
  if (webDist === 'make') {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>ui</title>');
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dist, '.secret'), 'x');
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dist, f), c);
    t.after(() => { for (const f of Object.keys(files)) { try { fs.chmodSync(path.join(dist, f), 0o644); } catch { /* gone */ } } fs.rmSync(dist, { recursive: true, force: true }); });
  }
  lastDist = dist;
  const port = await freePort('spare');
  const server = createApp({ runtime: createRuntime({ clock: createClock({ fixed: T0 }) }), webDist: dist }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return port;
}

test('the built UI is served by the server itself with a same-origin CSP; the Host guard still applies', async (t) => {
  const port = await boot(t, 'make');
  const root = await request(port, 'GET', '/');
  assert.equal(root.status, 200);
  assert.match(root.headers['content-type'], /text\/html/);
  const csp = root.headers['content-security-policy'];
  assert.equal(csp, UI_CSP);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline|https?:|\*/);
  const dir = (n) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${n} `));
  assert.equal(dir('script-src'), "script-src 'self'");
  assert.equal(dir('connect-src'), "connect-src 'self'");
  assert.equal(dir('frame-ancestors'), "frame-ancestors 'none'");
  assert.equal(dir('object-src'), "object-src 'none'");
  assert.equal(dir('base-uri'), "base-uri 'none'");
  assert.equal(dir('form-action'), "form-action 'none'");
  assert.equal(root.headers['x-content-type-options'], 'nosniff');
  assert.equal(root.headers['cache-control'], 'no-store');
  assert.equal((await request(port, 'GET', '/assets/a.js')).status, 200);
  assert.equal((await request(port, 'GET', '/.secret')).status, 404);
  assert.equal((await request(port, 'GET', '/', { host: 'evil.example.com' })).status, 421);
  assert.equal((await request(port, 'GET', '/assets/a.js', { host: 'evil.example.com' })).status, 421);
  assert.ok((await request(port, 'GET', '/%ZZ')).status < 500);
  assert.equal((await request(port, 'GET', '/api/health')).headers['content-security-policy'], "default-src 'none'");
});

test('static serving opens no write path and takes no credentials', async (t) => {
  const port = await boot(t, 'make');
  assert.equal((await request(port, 'POST', '/', { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await request(port, 'POST', '/api/kill', { headers: { origin: 'http://evil.example' }, body: { scope: 'global' } })).status, 403);
  for (const headers of [{ authorization: 'x' }, { 'x-api-key': 'k' }]) {
    const res = await request(port, 'GET', '/', { headers });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'credentials_not_accepted');
  }
});

test('without a built UI, or with webDist null, GET / is a JSON 404', async (t) => {
  for (const dist of [path.join(os.tmpdir(), 'ks-no-such-dist'), null]) {
    const port = await boot(t, dist);
    const res = await request(port, 'GET', '/');
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'not_found');
  }
});

test('an error outside /api is a 500 that says nothing about the cause', async (t) => {
  if (process.getuid?.() === 0) return;
  const port = await boot(t, 'make', { 'locked.txt': 'x' });
  const dist = lastDist;
  fs.chmodSync(path.join(dist, 'locked.txt'), 0o000);
  const res = await request(port, 'GET', '/locked.txt');
  assert.equal(res.status, 500);
  assert.deepEqual(res.json, { error: 'server_error' });
  assert.ok(!/EACCES|locked|permission|ks-dist/i.test(res.raw), res.raw);
});
