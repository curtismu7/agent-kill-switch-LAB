// {{cast}} tokens in the Federated Identity story: three vertical packs, no undefined token, customer.config overrides that stay inside bounds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CAST, DEFAULT_VERTICAL, VERTICALS, fill, fillDeep, loadCast, unfilled, verticalFrom } from '../src/cast.js';
import { loadMock } from '../src/fedid/mock.js';
import { STORY, storyFor } from '../src/fedid/story.js';

process.env.CUSTOMER_CONFIG = path.join(os.tmpdir(), 'ks-no-such-customer-config.json'); // a developer's own customer.config.json must not change what these tests see
const { startHttpServer } = await import('../src/app.js');
const { createRuntime } = await import('../src/runtime.js');
const { freePort, request } = await import('./helpers.js');

const tmp = (obj) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cast-')), 'customer.config.json'); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };

test('three vertical packs define the same keys, and every {{token}} in the story and the Mock table is defined by every pack', () => {
  const names = Object.keys(VERTICALS);
  assert.deepEqual(names.sort(), ['finance', 'health', 'retail']);
  const keys = Object.keys(DEFAULT_CAST).sort();
  for (const n of names) assert.deepEqual(Object.keys(VERTICALS[n]).sort(), keys, n);
  const text = JSON.stringify([STORY, loadMock()]);
  const used = new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  assert.ok(used.size >= 3, 'the story really uses tokens');
  for (const n of names) {
    assert.deepEqual(unfilled(text, VERTICALS[n]), [], `${n}: an undefined token`);
    assert.equal(/\{\{/.test(JSON.stringify(storyFor(VERTICALS[n]))), false, `${n}: a token is left in the filled story`);
  }
  assert.deepEqual(unfilled('{{castBrand}} and {{nobody}}', DEFAULT_CAST), ['nobody'], 'an undefined token is reported');
  assert.equal(fill('{{nobody}}', DEFAULT_CAST), '{{nobody}}', 'and left visible, never silently dropped');
  for (const k of keys) assert.ok(used.has(k), `${k} is used by the story`);
});

test('each vertical fills different words, and the packs hold only synthetic names (.example hosts, no dots in a host label)', () => {
  const said = (n) => storyFor(VERTICALS[n]).map((s) => s.say).join('|');
  assert.notEqual(said('finance'), said('health'));
  assert.notEqual(said('health'), said('retail'));
  for (const p of Object.values(VERTICALS)) { assert.match(p.castHost, /^[a-z]+$/); assert.match(p.castOperator, /^[a-z-]+$/); }
});

test('fillDeep is iterative (a deep structure does not overflow the stack) and does not touch non-strings', () => {
  let deep = '{{castBrand}}';
  for (let i = 0; i < 50_000; i += 1) deep = [deep];
  const out = fillDeep(deep, DEFAULT_CAST);
  let x = out; let n = 0; while (Array.isArray(x)) { x = x[0]; n += 1; }
  assert.deepEqual([x, n], [DEFAULT_CAST.castBrand, 50_000]);
  assert.deepEqual(fillDeep({ a: 1, b: null, c: true, d: ['{{castHost}}'] }, DEFAULT_CAST), { a: 1, b: null, c: true, d: [DEFAULT_CAST.castHost] });
});

test('verticalFrom accepts only a defined pack; anything else is the default and is never echoed', () => {
  assert.equal(verticalFrom('health'), 'health');
  for (const v of ['__proto__', 'constructor', 'toString', 'x'.repeat(5000), ['health'], { a: 1 }, null, undefined, 7]) assert.equal(verticalFrom(v), DEFAULT_VERTICAL);
});

test('customer.config.json overrides brand, host and operator; values that look like URLs, addresses or hosts, wrong types and junk are ignored', () => {
  const ok = loadCast(tmp({ cast: { brand: 'Acme Test Co', host: 'acme', operator: 'Duty.Officer' } }));
  assert.deepEqual([ok.castBrand, ok.castHost, ok.castOperator, ok.castTeam], ['Acme Test Co', 'acme', 'duty.officer', DEFAULT_CAST.castTeam]);
  for (const bad of [{ brand: 'https://evil.example/x' }, { brand: 'a@b' }, { brand: 'shop.com' }, { host: 'a.b' }, { host: 'UPPER space' }, { operator: 'has space' }, { brand: 7 }, { brand: '   ' }, { host: ['x'] }]) {
    assert.deepEqual(loadCast(tmp({ cast: bad })), DEFAULT_CAST, JSON.stringify(bad));
  }
  assert.deepEqual(loadCast(tmp('not json')), DEFAULT_CAST);
  assert.deepEqual(loadCast(tmp({ cast: { brand: 'Zed' }, extra: { castTeam: 'x' } })).castTeam, DEFAULT_CAST.castTeam, 'other keys are ignored');
  assert.deepEqual(loadCast('/no/such/file'), DEFAULT_CAST);
  assert.equal(loadCast(tmp({ cast: { brand: 'Zed' } }), 'retail').castTeam, VERTICALS.retail.castTeam, 'the override sits on the chosen pack');
  const long = loadCast(tmp({ cast: { brand: `${'B'.repeat(60)}` } }));
  assert.equal(long.castBrand.length, 40, 'cut at 40 characters');
  assert.equal(loadCast(tmp({ cast: { operator: 'x'.repeat(60) } })).castOperator.length, 40);
  assert.equal(loadCast(tmp({ cast: { brand: 'A​B\u0007C' } })).castBrand, 'A B C', 'control and invisible characters become spaces');
});

test('HTTP: ?vertical= picks the pack for the catalogue and the Mock table; a bad vertical is the default and is not echoed', async (t) => {
  const srv = await startHttpServer({ port: await freePort('cast'), runtime: createRuntime(), webDist: null });
  t.after(() => srv.close());
  const get = (q) => request(srv.port, 'GET', `/api/fedid${q}`);
  const fin = (await get('')).json;
  const health = (await get('?vertical=health')).json;
  assert.deepEqual([fin.vertical, health.vertical, health.verticals], ['finance', 'health', ['finance', 'health', 'retail']]);
  assert.deepEqual(health.cast, VERTICALS.health);
  assert.match(health.story[0].say, /clinical-platform/);
  assert.equal(health.story.find((s) => s.t === 'revoke').operator, VERTICALS.health.castOperator, 'the operator the Live story posts is the pack\'s');
  assert.equal(JSON.stringify(health).includes('{{'), false);
  const m = (await get('/mock?vertical=retail')).json.table;
  assert.equal(JSON.stringify(m).includes('{{'), false, 'no token is left in the Mock table');
  assert.equal(m.final.identities.find((i) => i.state === 'revoked').revokedBy, VERTICALS.retail.castOperator);
  const secret = ['sk', 'live', 'ZEBRAQUILT4455xx'].join('-');
  const bad = await get(`?vertical=${encodeURIComponent(secret)}`);
  assert.equal(bad.json.vertical, 'finance');
  assert.equal(bad.raw.includes('ZEBRAQUILT'), false);
  assert.equal((await get('?vertical[]=health&vertical[]=retail')).json.vertical, 'finance');
});
