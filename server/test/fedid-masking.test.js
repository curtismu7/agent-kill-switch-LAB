// MASKING. Credential-shaped values are typed into every field, query string, path segment, header and unknown key of every
// /api/fedid endpoint of a REAL server process (server/src/index.js, started by this test and killed by it). Not one of them may appear in any
// answer, in the state, audit or events read afterwards, or in the server's stdout and stderr. Masking is a heuristic: this test pins the
// shapes it knows, it does not prove that no other shape gets through.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { maskText } from '../src/fedid/mask.js';
import { freePort, request } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Secret-shaped fixtures are assembled at run time so the repository never contains a token-shaped literal (gitleaks).
const JWT = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJ4eHh4eCJ9', 'c2lnbmF0dXJlLXBhcnQtMTIzNDU'].join('.');
const ZW = '​';
// typed: what the visitor types. core: the part that must never come back out, in any form.
const SECRETS = [
  { name: 'jwt', typed: `my token ${JWT}`, core: JWT },
  { name: 'sk-prefixed', typed: 'sk-live-ABCDEF1234567890abcd', core: 'ABCDEF1234567890abcd' },
  { name: 'ghp', typed: 'ghp_ABCDEFGHIJKLMNOPQRSTUV123456', core: 'ABCDEFGHIJKLMNOPQRSTUV123456' },
  { name: 'aws', typed: 'AKIAIOSFODNN7EXAMPLE', core: 'AKIAIOSFODNN7EXAMPLE' },
  { name: 'pem', typed: '-----BEGIN PRIVATE KEY-----MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj-----END PRIVATE KEY-----', core: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' },
  { name: 'plain-language', typed: 'my password is hunter2-xyz987', core: 'hunter2-xyz987' },
  { name: 'pw-colon', typed: 'pw: correct-horse-battery', core: 'correct-horse-battery' },
  { name: 'userinfo-other-scheme', typed: 'postgres://svc:Pg-Pass-9981@db.example/x', core: 'Pg-Pass-9981' },
  { name: 'url-userinfo', typed: 'https://alice:S3cr3tPassw0rd@host.example/x', core: 'S3cr3tPassw0rd' },
  { name: 'authorization-token', typed: 'Authorization: token abcDEF123456xyz', core: 'abcDEF123456xyz' },
  { name: 'bearer', typed: 'Bearer abcdef1234567890QQ', core: 'abcdef1234567890QQ' },
  { name: 'short-prefixed', typed: 'tok_a1b2c3d4e5', core: 'a1b2c3d4e5' },
  { name: 'zero-width-interleaved', typed: `s${ZW}k${ZW}-${ZW}live-${ZW}QWERTY7890asdf`, core: 'QWERTY7890asdf' },
  { name: 'fullwidth-NFKC', typed: 'ｓｋ－live-ZXCVBN4567poiu', core: 'ZXCVBN4567poiu' },
  { name: 'percent-encoded', typed: '%73k-live-PERCNT1234abcd', core: 'PERCNT1234abcd' },
  { name: 'percent-encoded-assignment', typed: 'password%3Dhunter9zzz', core: 'hunter9zzz' },
  { name: 'secret-in-filler', typed: `${'filler '.repeat(120)}sk-live-AFTERFILLER99xx`, core: 'AFTERFILLER99xx' },
];
const ascii = (s) => s.replace(/[^\x20-\x7e]/g, '');

async function startServer() {
  const port = await freePort('fedidmask');
  const env = { ...process.env, KILL_SWITCH_PORT: String(port) };
  delete env.KILL_SWITCH_BIND; delete env.MODE;
  const child = spawn(process.execPath, ['server/src/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 1200 && !up; i += 1) { // up to two minutes: the machine is shared and may be heavily loaded
    try { up = (await request(port, 'GET', '/api/health')).status === 200; } catch { await new Promise((r) => { setTimeout(r, 100); }); }
  }
  assert.ok(up, 'the server process did not start');
  return { port, child, output: () => out };
}

test('MASKING: credential-shaped values typed into every field of every /api/fedid endpoint never come back out', { timeout: 900_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.child.kill());
  const seen = [];
  let cookie = null;
  const call = async (method, p, { body, headers = {}, host } = {}) => {
    const res = await request(srv.port, method, p, { body, headers: { ...(cookie ? { cookie } : {}), ...headers }, host });
    const sc = [].concat(res.headers['set-cookie'] || [])[0];
    if (sc && !cookie) cookie = sc.split(';')[0];
    seen.push(`${res.status} ${JSON.stringify(res.headers)} ${res.raw}`);
    return res;
  };
  const B = 'fi-billing-agent';
  await call('GET', '/api/fedid/state');

  for (const s of SECRETS) {
    const q = encodeURIComponent(s.typed);
    await call('POST', '/api/reset', { body: {} });
    // accepted free text: the operator name and the reason on a revoke
    const rev = await call('POST', '/api/fedid/revoke', { body: { workload: B, operator: s.typed.slice(0, 200), reason: s.typed } });
    assert.ok([200, 400].includes(rev.status), `${s.name}: revoke answered ${rev.status}`);
    // the same text where only a fixed value is allowed, and as an unknown key, in a nested value and as a wrong type
    for (const [p, body] of [
      ['/api/fedid/request', { workload: s.typed, service: 'mcp' }], ['/api/fedid/request', { workload: B, service: s.typed }], ['/api/fedid/request', { workload: B, service: 'mcp', via: s.typed }],
      ['/api/fedid/request', { workload: B, service: 'mcp', lifetimeSec: s.typed }], ['/api/fedid/request', { [s.typed]: 1 }], ['/api/fedid/request', { workload: B, service: 'mcp', extra: { deep: [s.typed] } }],
      ['/api/fedid/revoke', { workload: s.typed, operator: 'x' }], ['/api/fedid/revoke', { workload: B, operator: 'x', [s.typed]: 1 }], ['/api/fedid/revoke', { workload: B, operator: { a: s.typed } }],
      ['/api/fedid/issuer', { outage: s.typed }], ['/api/fedid/issuer', { [s.typed]: true }], ['/api/fedid/advance', { seconds: s.typed }], ['/api/fedid/advance', { [s.typed]: 5 }],
      ['/api/scenarios/rate-loop/run', { [s.typed]: 1 }], ['/api/kill', { scope: 'agent', agentId: s.typed, operator: 'x' }],
    ]) {
      const r = await call('POST', p, { body });
      assert.ok(r.status >= 400 && r.status < 500, `${s.name} ${p}: ${r.status}`);
    }
    // query strings, path segments, headers, Host, content type
    for (const p of ['/api/fedid', '/api/fedid/state', '/api/fedid/mock', '/api/state', '/api/audit']) await call('GET', `${p}?x=${q}&${q}=1`);
    for (const p of ['/api/fedid/request', '/api/fedid/revoke', '/api/fedid/advance']) await call('POST', `${p}?x=${q}`, { body: {} });
    await call('GET', `/api/fedid/${q}`); await call('GET', `/api/fedid/request/${q}`); await call('POST', `/api/fedid/state/${q}`, { body: {} }); await call('GET', `/${q}`);
    const h = ascii(s.typed);
    await call('GET', '/api/fedid/state', { headers: { 'x-test': h, referer: `http://127.0.0.1/${h}`, 'user-agent': h, 'accept-language': h } });
    await call('POST', '/api/fedid/revoke', { body: { workload: B, operator: 'x' }, headers: { origin: `http://${h}.example`, 'x-test': h } });
    await call('POST', '/api/fedid/revoke', { body: { workload: B, operator: 'x' }, headers: { authorization: h, cookie: `other=${h}` } });
    await call('POST', '/api/fedid/revoke', { body: 'x', headers: { 'content-type': `text/plain; charset=${h}` } });
    await call('GET', '/api/fedid/state', { host: `${h.replace(/[^A-Za-z0-9-]/g, '')}.example` });
    // what was stored: the identity record, the audit trail and the events, read back
    seen.push(JSON.stringify((await call('GET', '/api/fedid/state')).json));
    seen.push(JSON.stringify((await call('GET', '/api/audit?limit=500')).json));
    seen.push(JSON.stringify((await call('GET', '/api/events')).json));
    const joined = seen.join('\n');
    for (const needle of [s.core, s.typed, ascii(s.typed), encodeURIComponent(s.typed)]) assert.equal(joined.includes(needle), false, `${s.name}: "${needle.slice(0, 40)}" came back`);
    const id = (await call('GET', '/api/fedid/state')).json.state.identities.find((i) => i.id === B);
    if (rev.status === 200) { assert.ok(typeof id.note === 'string' && id.revokedBy !== null, `${s.name}: the revoke was recorded`); assert.notEqual(id.note, s.typed, `${s.name}: the stored reason was changed by masking`); }
  }
  srv.child.kill();
  await new Promise((r) => { srv.child.once('exit', r); });
  const out = srv.output();
  for (const s of SECRETS) for (const needle of [s.core, s.typed]) assert.equal(out.includes(needle), false, `${s.name}: reached stdout or stderr`);
  assert.doesNotMatch(out, /\n\s+at [A-Za-z<]/, 'no stack trace was printed');
});

test('maskText: each evasion is defeated, and the text is masked BEFORE it is truncated', () => {
  for (const s of SECRETS) {
    const m = maskText(s.typed, 200);
    assert.equal(m.includes(s.core), false, `${s.name}: ${m}`);
  }
  const filler = 'x'.repeat(19_990);
  for (const [tail, core] of [[`${'sk'}-live-TAILSECRET1234`, 'TAILSECRET1234'], [' my password is topsecret99', 'topsecret99'], [` ${JWT}`, JWT]]) {
    const m = maskText(`${filler}${tail}`, 60);
    assert.equal(m.includes(core), false);
    assert.ok(m.length <= 61);
  }
  // a secret that straddles the cut is masked whole, never cut in half: cutting first would leave the fragment "sk-liv" behind
  const straddle = maskText(`${'y'.repeat(193)} sk-live-STRADDLESECRET12345`, 200);
  assert.equal(straddle.includes('STRADDLE'), false);
  assert.equal(straddle.includes('sk-liv'), false, straddle.slice(-30));
});

test('maskText: ordinary text is left alone, other types become the empty string, and the result is bounded', () => {
  assert.equal(maskText('suspected compromise of the billing agent', 200), 'suspected compromise of the billing agent');
  assert.equal(maskText('on-call-operator', 40), 'on-call-operator');
  assert.equal(maskText('the token was revoked at noon', 200), 'the token was revoked at noon', 'a sentence about tokens is not a token');
  for (const v of [undefined, null, 7, {}, [], true]) assert.equal(maskText(v), '');
  assert.ok(maskText('a'.repeat(5000), 40).length <= 41);
  assert.equal(maskText(`${ZW}${ZW}`, 40), '');
  assert.equal(maskText('line1\nline2\ttab', 40), 'line1line2tab');
});
