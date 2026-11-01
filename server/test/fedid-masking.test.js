// MASKING. Credential-shaped values are typed into every field, query string, path segment, header and unknown key of every
// /api/fedid endpoint of a REAL server process (server/src/index.js, started by this test and killed by it). Not one of them may appear in any
// answer, in the state, audit or events read afterwards, or in the server's stdout and stderr. Masking is a heuristic: this test pins the
// shapes it knows, it does not prove that no other shape gets through.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MAX_RAW, maskText } from '../src/mask.js';
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
  // whitespace controls between the words (deleting them used to glue "password is" and the value together and hide the shape)
  { name: 'password-newline', typed: 'password is\nhunter2zzz', core: 'hunter2zzz' },
  { name: 'password-tabs', typed: 'password\tis\thunter2zzz', core: 'hunter2zzz' },
  { name: 'password-crlf', typed: 'my pw:\r\nhunter3zzz', core: 'hunter3zzz' },
  { name: 'bearer-tab', typed: 'Bearer\tabcdef123456', core: 'abcdef123456' },
  { name: 'token-is', typed: 'the token is hunter4zzz', core: 'hunter4zzz' },
  { name: 'quoted-passphrase', typed: 'password is "correct horse battery staple"', core: 'battery staple' },
  { name: 'single-quoted-passphrase', typed: "secret = 'violet zebra lantern quiet'", core: 'lantern quiet' },
  { name: 'double-percent-encoded', typed: '%2573k-live-DOUBLEPC1234abcd', core: 'DOUBLEPC1234abcd' },
  { name: 'unprefixed-blob', typed: ['Zm9vYmFy', 'YmF6cXV4', 'MTIzNDU2', 'Nzg5MGFi', 'Y2RlZg'].join(''), core: ['Zm9vYmFy', 'YmF6cXV4', 'MTIzNDU2'].join('') },
  { name: 'authorization-without-colon', typed: 'Authorization Digest realm=x nonce=zebra99', core: 'zebra99' },
  { name: 'secret-in-filler', typed: `${'filler '.repeat(120)}sk-live-AFTERFILLER99xx`, core: 'AFTERFILLER99xx' },
];
// The sweep classes of 2026-11-01 (probe secrets hunter2xyz and abcdefghijklmnop1234): the control characters are written as escapes on purpose.
const H = 'hunter2xyz'; const K = 'abcdefghijklmnop1234';
SECRETS.push(
  { name: 'A: C0 controls between every letter', typed: 'p\u0001a\u0001s\u0001s\u0001w\u0001o\u0001r\u0001d: hunter2xyz', core: H },
  { name: 'A: NUL inside the keyword', typed: 'pass\u0000word=hunter2xyz', core: H },
  { name: 'A: NEL (C1) inside the keyword', typed: 'pass\u0085word=hunter2xyz', core: H },
  { name: 'A: DEL inside the keyword', typed: 'pass\u007fword=hunter2xyz', core: H },
  { name: 'A: controls inside "my password is"', typed: 'my pa\u0000ss\u0000word is hunter2xyz', core: H },
  { name: 'A: controls inside token', typed: 'tok\u0001en hunter2xyz', core: H },
  { name: 'A: controls inside Bearer', typed: 'Bea\u0001rer hunter2xyz', core: H },
  { name: 'A: controls inside sk-', typed: 's\u0001k-abcdefghijklmnop1234', core: K },
  { name: 'B: password + space', typed: 'password hunter2xyz', core: H },
  { name: 'B: pw + space', typed: 'pw hunter2xyz', core: H },
  { name: 'B: token + space', typed: 'token hunter2xyz', core: H },
  { name: 'B: secret + space', typed: 'secret hunter2xyz', core: H },
  { name: 'B: api key + space', typed: 'api key hunter2xyz', core: H },
  { name: 'B: the key is', typed: 'the key is hunter2xyz', core: H },
  { name: 'C: userinfo without a scheme', typed: 'bob:hunter2xyz@host.example', core: H },
  { name: 'C: userinfo behind //', typed: '//bob:hunter2xyz@host.example', core: H },
  { name: 'C: userinfo with a scheme', typed: 'https://bob:hunter2xyz@host.example', core: H },
  { name: 'D: JSON-quoted assignment', typed: '{"password":"hunter2xyz"}', core: H },
);
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
  const B = 'fi-billing-agent'; const A0 = 'agent-alpha';
  await call('GET', '/api/fedid/state');

  for (const s of SECRETS) {
    const q = encodeURIComponent(s.typed);
    await call('POST', '/api/reset', { body: {} });
    // accepted free text: the operator name and the reason on a revoke
    const op = s.typed.length <= 40 ? s.typed : 'ops'; const why = s.typed.length <= 200 ? s.typed : 'why';
    const rev = await call('POST', '/api/fedid/revoke', { body: { workload: B, operator: op, reason: why } });
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
    // the older Kill switch endpoints: the same text in every field, for both scopes, in every order (kill, unrevoke, a refused repeat), then wrong types and unknown keys
    for (const scope of [{ scope: 'agent', agentId: 'agent-alpha' }, { scope: 'global' }]) {
      const k1 = await call('POST', '/api/kill', { body: { ...scope, operator: op, reason: why } });
      assert.equal(k1.status, 200, `${s.name}: kill ${JSON.stringify(scope)} answered ${k1.status}`);
      assert.equal((await call('POST', '/api/kill', { body: { ...scope, operator: op, reason: why } })).status, 409);
      const u1 = await call('POST', '/api/unrevoke', { body: { ...scope, operator: op, reason: why, ...(scope.scope === 'agent' ? { resetBudget: true } : {}) } });
      assert.ok([200, 400].includes(u1.status), `${s.name}: unrevoke answered ${u1.status}`);
      await call('POST', '/api/unrevoke', { body: { ...scope, operator: op, reason: why } });
    }
    for (const body of [
      { scope: 'agent', agentId: A0, operator: s.typed.repeat(10).slice(0, 41), reason: 'x' }, { scope: 'agent', agentId: A0, operator: 'x', reason: `${s.typed.repeat(40)}`.slice(0, 201) },
      { scope: s.typed }, { scope: 'agent', agentId: s.typed, operator: 'x' }, { scope: 'agent', agentId: A0, operator: { a: s.typed } }, { scope: 'agent', agentId: A0, operator: 'x', reason: [s.typed] },
      { scope: 'agent', agentId: A0, operator: 'x', inFlight: s.typed }, { scope: 'agent', agentId: A0, operator: 'x', [s.typed]: 1 }, { scope: 'global', agentId: s.typed, operator: 'x' }, { [s.typed]: { deep: s.typed } },
      { scope: 'agent', agentId: A0, operator: 'x', resetBudget: s.typed }, { scope: 'global', operator: 'x', reason: { [s.typed]: s.typed } },
    ]) for (const p of ['/api/kill', '/api/unrevoke']) { const r = await call('POST', p, { body }); assert.ok(r.status >= 400 && r.status < 500, `${s.name} ${p}: ${r.status}`); }
    for (const [m, p] of [['GET', '/api/kill'], ['DELETE', '/api/state'], ['POST', '/api/state'], ['PUT', '/api/audit'], ['GET', '/api/reset'], ['GET', '/api/unrevoke'], ['POST', '/api/events'], ['GET', '/api/scenarios/rate-loop/run'], ['PATCH', '/api/agents']]) {
      const r = await call(m, `${p}?x=${q}`, { body: m === 'GET' ? undefined : {} }); assert.equal(r.status, 405, `${s.name} ${m} ${p}`);
    }
    await call('GET', `/api/events?since=${q}&limit=${q}`); await call('GET', `/api/audit?after=${q}&limit=${q}`); await call('GET', `/api/audit/${q}`); await call('GET', `/api/audit/verify/${q}`);
    await call('POST', `/api/scenarios/${q}/run`, { body: {} }); await call('POST', `/api/scenarios/${q}/step`, { body: { [s.typed]: 1 } }); await call('POST', `/api/scenarios/rate-loop/run?x=${q}`, { body: { [s.typed]: 1 } });
    await call('POST', `/api/kill/${q}`, { body: {} }); await call('POST', `/${q}`, { body: {} }); await call('DELETE', `/${q}`); await call('GET', `/assets/${q}.js`); await call('GET', `/${q}.map`);
    await call('POST', '/api/kill', { body: `{"scope":"agent","operator":"${s.typed.replace(/[\\"\u0000-\u001f]/g, '')}` }); // truncated JSON
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

test('maskText: each evasion is defeated, and the text is masked BEFORE anything is cut', () => {
  for (const s of SECRETS) {
    const m = maskText(s.typed);
    assert.equal(m.includes(s.core), false, `${s.name}: ${m}`);
  }
  // the secret sits after thousands of filler characters: it is masked, and the answer is never cut (no ellipsis, nothing dropped)
  const filler = 'fill '.repeat(3998); // 19,990 characters; a run of letters alone would be taken for a blob
  assert.equal(filler.length, 19_990);
  for (const [tail, core] of [[`${'sk'}-live-TAILSECRET1234`, 'TAILSECRET1234'], [' my password is topsecret99', 'topsecret99'], [` ${JWT}`, JWT], [' password hunter2xyz', 'hunter2xyz']]) {
    const m = maskText(`${filler}${tail}`);
    assert.equal(m.includes(core), false);
    assert.ok(m.startsWith(filler), 'the filler is kept whole: nothing is cut');
    assert.equal(m.includes('…'), false);
  }
  const straddle = maskText(`${'y'.repeat(193)} sk-live-STRADDLESECRET12345`);
  assert.equal(straddle.includes('STRADDLE'), false);
  assert.equal(straddle.includes('sk-liv'), false, straddle.slice(-30));
});

test('maskText: ordinary text is left alone, other types become the empty string, and nothing is cut', () => {
  assert.equal(maskText('suspected compromise of the billing agent'), 'suspected compromise of the billing agent');
  assert.equal(maskText('on-call-operator'), 'on-call-operator');
  assert.equal(maskText('the token was revoked at noon'), 'the token was revoked at noon', 'a sentence about tokens is not a token');
  for (const v of [undefined, null, 7, {}, [], true]) assert.equal(maskText(v), '');
  assert.equal(maskText('word '.repeat(1000).trim()).length, 4999, 'no silent cut');
  assert.equal(maskText(`${ZW}${ZW}`), '');
  assert.equal(maskText('line1\nline2\ttab'), 'line1 line2 tab', 'tab, LF and CR become a space');
});

test('class A: C0 and C1 controls are DELETED before matching, so a keyword cut up by them is whole again (literal expectations)', () => {
  const cases = [
    ['p\u0001a\u0001s\u0001s\u0001w\u0001o\u0001r\u0001d: hunter2xyz', 'password: [REDACTED]'],
    ['pass\u0000word=hunter2xyz', 'password=[REDACTED]'],
    ['pass\u0085word=hunter2xyz', 'password=[REDACTED]'],
    ['pass\u007fword=hunter2xyz', 'password=[REDACTED]'],
    ['my pa\u0000ss\u0000word is hunter2xyz', 'my password is [REDACTED]'],
    ['tok\u0001en hunter2xyz', 'token [REDACTED]'],
    ['Bea\u0001rer hunter2xyz', '[REDACTED]'],
    ['s\u0001k-abcdefghijklmnop1234', '[REDACTED]'],
  ];
  for (const [typed, want] of cases) assert.equal(maskText(typed), want, JSON.stringify(typed));
  // every C0 and C1 code point except tab, LF, CR, inside the keyword
  for (let c = 0; c <= 0x9f; c += 1) {
    if (c === 9 || c === 10 || c === 13 || (c > 0x1f && c < 0x7f)) continue;
    const ch = String.fromCharCode(c);
    assert.equal(maskText(`pass${ch}word=hunter2xyz`).includes('hunter2xyz'), false, `U+${c.toString(16)} in the keyword`);
    assert.equal(maskText(`Bearer${ch}abcdef123456`).includes('abcdef123456'), false, `U+${c.toString(16)} between Bearer and its value`);
  }
});

test('tab, LF and CR split a keyword and are separators; a plus sign is read as a space; the deleting reading wins ties; the result is trimmed', () => {
  for (const ws of ['\t', '\n', '\r']) assert.equal(maskText(`pass${ws}word=hunter2xyz`), 'password=[REDACTED]', JSON.stringify(ws));
  assert.equal(maskText('password+is+hunter2xyz').includes('hunter2xyz'), false);
  assert.equal(maskText('a\u0001b'), 'ab', 'a control inside an ordinary word is deleted, not turned into a space');
  assert.equal(maskText('  padded   text \n'), 'padded text');
});

test('class B: a strong keyword, a plain space and a value are masked; ordinary sentences stay readable (the false-positive tradeoff)', () => {
  for (const typed of ['password hunter2xyz', 'pw hunter2xyz', 'token hunter2xyz', 'secret hunter2xyz', 'api key hunter2xyz', 'the key is hunter2xyz', 'passphrase hunter2xyz', 'tokens hunter2xyz']) {
    const m = maskText(typed);
    assert.equal(m.includes('hunter2xyz'), false, `${typed} -> ${m}`);
    assert.match(m, /\[REDACTED\]/);
  }
  assert.equal(maskText('password hunter2xyz'), 'password [REDACTED]');
  assert.equal(maskText('password "two words here"'), 'password [REDACTED]', 'a quoted value after a keyword and a plain space');
  // the tradeoff: only a token of 6 or more characters that contains a digit follows a keyword and a plain space
  for (const sentence of [
    'password reset requested by the owner', 'the password policy was reviewed', 'token bucket refilled after the pause', 'secret santa lunch moved',
    'rotate the api key tomorrow', 'the key is stored in the vault', 'pw changed', 'revoked: token expired', 'secrets manager is down', 'the tokens are fine',
    'password abc12', 'token abcdefg', 'pw 12345',
  ]) assert.equal(maskText(sentence), sentence, `${sentence} must stay readable`);
  // and what the tradeoff costs: a digit-free password after a plain space gets through (documented), a date after "token" is masked (a false positive)
  assert.equal(maskText('password correcthorse'), 'password correcthorse', 'KNOWN MISS: no digit');
  assert.equal(maskText('token 2026-11-01'), 'token [REDACTED]', 'KNOWN FALSE POSITIVE');
  assert.equal(maskText('password abc1234'), 'password [REDACTED]', '7 characters with a digit are masked');
  assert.equal(maskText('pw abcde1'), 'pw [REDACTED]', 'exactly 6 characters with a digit are masked');
  assert.equal(maskText('pw abcd1'), 'pw abcd1', '5 characters are not');
});

test('class C: URL userinfo with or without a scheme, with or without a leading //', () => {
  assert.equal(maskText('bob:hunter2xyz@host.example'), '[REDACTED]@host.example');
  assert.equal(maskText('//bob:hunter2xyz@host.example'), '//[REDACTED]@host.example');
  assert.equal(maskText('https://bob:hunter2xyz@host.example'), 'https://host.example/', 'the older redactor drops the whole userinfo from a URL');
  assert.equal(maskText('ftp://bob:hunter2xyz@host.example/x'), 'ftp://[REDACTED]@host.example/x', 'a scheme the URL parser does not special-case keeps the marker');
  assert.equal(maskText('see bob:hunter2xyz@host.example now'), 'see [REDACTED]@host.example now');
  assert.equal(maskText('ftp://abc123@host.example/x'), 'ftp://[REDACTED]@host.example/x', 'a user name alone, behind a scheme, is masked too');
  assert.equal(maskText('mail alice@host.example and mailto:alice@host.example'), 'mail alice@host.example and mailto:alice@host.example', 'an address is not userinfo');
});

test('class D: a JSON-quoted assignment typed as text', () => {
  assert.equal(maskText('{"password":"hunter2xyz"}'), '{"password":[REDACTED]}');
  assert.equal(maskText(`{"user":"bob","apiKey": "${K}"}`), '{"user":"bob","apiKey": [REDACTED]}'); // K is assembled at run time (gitleaks)
  assert.equal(maskText("{'token': 'hunter2xyz'}"), "{'token': [REDACTED]}");
  for (const k of ['pw', 'pwd', 'passphrase', 'pass', 'secret', 'access_key', 'client_secret', 'session_id']) assert.equal(maskText(`{"${k}":"hunter2xyz"}`), `{"${k}":[REDACTED]}`, k);
  assert.equal(maskText('{"note":"fine"}'), '{"note":"fine"}');
});

test('maskText: percent-decoding runs three rounds and no more', () => {
  const enc = (s, n) => { let x = s; for (let i = 0; i < n; i += 1) x = encodeURIComponent(x); return x; };
  for (const n of [1, 2, 3]) assert.equal(maskText(enc('password=hunter2xyz', n)).includes('hunter2xyz'), false, `${n} rounds`);
});

test('maskText: every whitespace control between the words of a secret shape still lets the shape be seen', () => {
  for (const ws of ['\n', '\t', '\r\n', '\u000B', '\u000C', '\u0085', ' ', ' ', ' \n \t ']) {
    for (const [typed, core] of [[`password is${ws}hunter2zzz`, 'hunter2zzz'], [`my pw:${ws}hunter2zzz`, 'hunter2zzz'], [`Bearer${ws}abcdef123456`, 'abcdef123456'], [`token is${ws}hunter2zzz`, 'hunter2zzz'], [`password${ws}is${ws}"two words"`, 'two words'], [`password${ws}hunter2xyz`, 'hunter2xyz']]) {
      assert.equal(maskText(typed).includes(core), false, JSON.stringify(typed));
    }
  }
  assert.equal(maskText(`${ZW}pass${ZW}word${ZW} is${ZW}\n${ZW}hunter2zzz`).includes('hunter2zzz'), false, 'invisible characters and a newline together');
});

test('maskText: "token is X" and a quoted value up to its closing quote are masked; a sentence about a token that was revoked is not', () => {
  assert.equal(maskText('the token is hunter2zzz'), 'the token is [REDACTED]');
  assert.equal(maskText('password is "correct horse battery staple" ok'), 'password is [REDACTED] ok', 'the whole quoted passphrase, not just its first word');
  assert.equal(maskText("pw = 'a b c' z"), 'pw = [REDACTED] z');
  assert.equal(maskText('the token was revoked at noon'), 'the token was revoked at noon');
  assert.equal(maskText('the tokens are fine'), 'the tokens are fine');
  // an unclosed quote is bounded (it cannot make the pattern rescan the rest of the text from every start); the unquoted word is still masked
  assert.equal(maskText('password is "unclosed zebra').includes('unclosed'), false);
});

test('maskText: an input over 1,000,000 characters is not looked at and is never echoed; one of exactly 1,000,000 is masked normally', () => {
  const over = 'a '.repeat(500_001); const exactly = 'a '.repeat(500_000);
  assert.deepEqual([over.length, exactly.length], [1_000_002, 1_000_000]);
  assert.equal(maskText(over), '[REDACTED]', 'a text with no secret shape in it, one character too long, is not looked at and not echoed');
  assert.equal(maskText(`${exactly.slice(0, -1)}`).startsWith('a a a'), true, 'a text of 999,999 characters is masked normally');
  assert.equal(maskText(exactly).length, 999_999, 'exactly 1,000,000 characters is masked normally (and trimmed), not refused');
  assert.equal(maskText(`${'a '.repeat(499_990)}password hunter2xyz`).includes('hunter2xyz'), false);
  assert.equal(MAX_RAW, 1_000_000);
});

test('maskText: hostile input does not take long (no catastrophic backtracking)', () => {
  const t0 = Date.now();
  for (const bad of ['password '.repeat(5000), `password is "${'a '.repeat(5000)}`, 'a:'.repeat(20000), ':@'.repeat(20000), `${'x'.repeat(50000)}@`, '%'.repeat(50000), 'key is '.repeat(5000), `pw ${'a'.repeat(100000)}`, '\u0001'.repeat(100000)]) maskText(bad);
  assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
});

test('maskText: an Authorization header without a colon is masked to the end of its line', () => {
  const m = maskText('Authorization Digest realm=x nonce=zebra99');
  assert.equal(m.includes('zebra99'), false, m);
  assert.equal(maskText('Authorization=zebra99').includes('zebra99'), false);
});
