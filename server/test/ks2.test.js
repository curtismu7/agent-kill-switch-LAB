// KS2 fix-pass pins. Each test here fails if the check it names is removed (see scripts/red-checks.mjs for the mutation list).
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { startHttpServer } from '../src/app.js';
import { createAudit } from '../src/audit.js';
import { createClock } from '../src/clock.js';
import { createEvents } from '../src/events.js';
import { deriveAgentKey } from '../src/policy.js';
import { redactText } from '../src/redaction.js';
import { createRuntime } from '../src/runtime.js';
import { revealText } from '../src/sanitize.js';
import { createTokenService } from '../src/tokens.js';
import { A, B, T0, freePort, makeWorld, request } from './helpers.js';

const OPS = { operator: 'ops', reason: 'test' };
const rt = (o = {}) => createRuntime({ clock: createClock({ fixed: T0 }), ...o });
async function boot(t) {
  const runtime = rt();
  const srv = await startHttpServer({ port: await freePort('ks2'), runtime });
  t.after(() => srv.close());
  return { srv, runtime, call: (m, p, o) => request(srv.port, m, p, o) };
}

// ---- an operator kill is not silently cleared by starting a scenario -------------------------------------------------------
test('a scenario will not start while an operator kill is in force; the kill and the audit are untouched', () => {
  for (const body of [{ scope: 'agent', agentId: A, ...OPS }, { scope: 'global', ...OPS }]) {
    const r = rt();
    assert.equal(r.kill(body).ok, true);
    const before = r.audit.list().map((e) => e.type).join(',');
    assert.equal(r.runScenario('normal').error, 'kill_in_force');
    assert.equal(r.stepScenario('normal').error, 'kill_in_force');
    assert.equal(r.audit.list().map((e) => e.type).join(','), before, 'no scenario_start, no silent unrevoke');
    if (body.scope === 'global') assert.equal(r.gateway.global().state, 'killed'); else assert.equal(r.gateway.agent(A).state, 'killed');
    assert.equal(r.unrevoke({ ...body, operator: 'alice' }).ok, true);
    assert.equal(r.runScenario('normal').error, undefined, 'after an audited unrevoke the scenario runs');
    assert.ok(r.audit.list().some((e) => e.type === 'unrevoke'));
  }
});

test('a kill performed by a scenario script does not block the next scenario; reset clears an operator kill block', () => {
  const r = rt();
  r.runScenario('manual-kill');
  assert.equal(r.gateway.agent(A).state, 'killed');
  assert.equal(r.runScenario('normal').error, undefined);
  r.kill({ scope: 'agent', agentId: A, ...OPS });
  assert.equal(r.runScenario('normal').error, 'kill_in_force');
  r.reset();
  assert.equal(r.runScenario('normal').error, undefined);
});

test('a mid-run operator kill does not stop the run being stepped, and an unrevoke done by the scenario itself releases the block', () => {
  const r = rt();
  r.stepScenario('kill-unrevoke');
  r.kill({ scope: 'agent', agentId: A, ...OPS });
  assert.equal(r.stepScenario('kill-unrevoke').error, undefined, 'same run continues');
  r.reset();
  const g = rt();
  g.stepScenario('kill-unrevoke'); g.stepScenario('kill-unrevoke');
  g.kill({ scope: 'agent', agentId: A, ...OPS });
  g.unrevoke({ scope: 'agent', agentId: A, operator: 'alice' });
  assert.equal(g.runScenario('normal').error, undefined);
});

test('HTTP: Run and Step answer 409 kill_in_force, not 200, while an operator kill holds', async (t) => {
  const { runtime, call } = await boot(t);
  assert.equal((await call('POST', '/api/kill', { body: { scope: 'agent', agentId: A, operator: 'alice' } })).status, 200);
  for (const p of ['/api/scenarios/normal/run', '/api/scenarios/normal/step']) {
    const r = await call('POST', p, { body: {} });
    assert.equal(r.status, 409, p);
    assert.equal(r.json.error, 'kill_in_force');
  }
  assert.equal(runtime.gateway.agent(A).state, 'killed');
  assert.ok(!runtime.audit.list().some((e) => e.type === 'scenario_start'));
});

// ---- audit timestamps are wall time ---------------------------------------------------------------------------------------
test('audit entries carry wall-clock time and, separately, the demo clock time', () => {
  let wall = Date.UTC(2030, 5, 1, 0, 0, 0);
  const r = rt({ wallNow: () => wall });
  r.kill({ scope: 'agent', agentId: A, ...OPS });
  wall += 1500;
  r.unrevoke({ scope: 'agent', agentId: A, operator: 'alice' });
  const [k, u] = r.audit.list();
  assert.equal(Date.parse(u.at) - Date.parse(k.at), 1500, 'a real gap between kill and unrevoke is visible');
  assert.equal(k.at, '2030-06-01T00:00:00.000Z');
  assert.equal(k.scenarioAt, new Date(T0).toISOString());
  assert.equal(r.audit.verify().ok, true);
});

test('the demo-clock time in an audit entry is covered by the hash', () => {
  const store = [];
  const a = createAudit({ store, scenarioNow: () => 'S1' });
  a.append('kill', A, {});
  store[0] = { ...store[0], scenarioAt: 'S2' };
  assert.equal(a.verify().reason, 'hash_mismatch');
});

// ---- model and tool lookups ------------------------------------------------------------------------------------------------
test('prototype names and non-strings are not models or tools, and never poison the budget with NaN', () => {
  const w = makeWorld();
  for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty', ['demo-small'], { toString: () => 'demo-small' }, 7]) {
    assert.equal(w.go(A, { model: bad }).reason, 'unknown_model', String(bad));
    assert.equal(w.go(A, { tool: bad }).reason, 'unknown_tool', String(bad));
  }
  const u = w.gateway.agent(A).usage;
  assert.equal(u.micros, 0); assert.equal(u.calls, 0);
  assert.equal(w.go().allowed, true);
  assert.ok(Number.isFinite(w.gateway.agent(A).budget.microsLeft));
});

// ---- redaction -------------------------------------------------------------------------------------------------------------
test('redactText removes each secret shape (fixtures are assembled here, none is a real secret)', () => {
  const jwt = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiJ4In0', 'sig' + '123abc'].join('.');
  const cases = {
    jwt: [`token was ${jwt} ok`, jwt],
    aws: [`key ${'AK' + 'IA'}ABCDEFGHIJKLMNOP end`, 'ABCDEFGHIJKLMNOP'],
    aws2: [`key ${'AS' + 'IA'}ABCDEFGHIJKLMNOP end`, 'ABCDEFGHIJKLMNOP'],
    pem: ['-----BEGIN PRIVATE KEY-----\nQUJDREVGRw==\n-----END PRIVATE KEY-----', 'QUJDREVGRw'],
    sk: [`use ${'sk' + '-'}${'a1B2'.repeat(6)}`, 'a1B2a1B2'],
    ghp: [`use ${'gh' + 'p_'}${'Z9y8'.repeat(6)}`, 'Z9y8Z9y8'],
    xox: [`use ${'xo' + 'xb-'}${'Q1w2'.repeat(6)}`, 'Q1w2Q1w2'],
    bearer: ['Authorization: Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
    password: ['password=hunter22hunter', 'hunter22hunter'],
    userinfo: ['see https://bob:pw9hunter@host.example/path now', 'pw9hunter'],
    query: ['see https://host.example/p?signature=ZZsecretZZ&keep=1 now', 'ZZsecretZZ'],
    fragment: ['see https://host.example/p#signature=ZZsecretZZ&keep=1 now', 'ZZsecretZZ'],
  };
  for (const [name, [input, secret]] of Object.entries(cases)) {
    const out = redactText(input);
    assert.ok(!out.includes(secret), `${name}: ${out}`);
  }
  assert.equal(redactText('see https://host.example/p?signature=ZZsecretZZ&keep=1 now'), 'see https://host.example/p?keep=1 now', 'only the secret pair goes');
  assert.ok(!redactText('https://bob:pw9hunter@host.example/').includes('bob'), 'userinfo is dropped, not just the password');
  assert.equal(redactText('plain note'), 'plain note');
});

test('events: strings are redacted, made inert and bounded when stored', () => {
  const ev = createEvents({ clock: createClock({ fixed: T0 }) });
  ev.emit('note', 'agent-alpha', { text: 'Bearer abcdefghijklmnop', rtl: 'a‮b', long: 'x'.repeat(1000), nested: { list: ['Bearer qrstuvwxyz0123'] }, 'k‮y': 1 });
  const { data } = ev.list().events[0];
  assert.ok(!data.text.includes('abcdefghijklmnop'));
  assert.ok(data.rtl.includes('[U+202E]') && !data.rtl.includes('‮'));
  assert.ok(data.long.length <= 301, `long string is bounded (${data.long.length})`);
  assert.ok(!JSON.stringify(data.nested).includes('qrstuvwxyz0123'));
  assert.ok(Object.keys(data).some((k) => k.includes('[U+202E]')), 'keys are made inert too');
});

test('revealText bounds length and shows invisible characters', () => {
  assert.equal(revealText('x'.repeat(5000), 100).length, 101);
  assert.equal(revealText('a​b'), 'a[U+200B]b');
});

// ---- global kill / auto-reset ----------------------------------------------------------------------------------------------
test('an auto-reset that falls due during a global kill leaves token issuance shut and admits nothing', () => {
  const w = makeWorld({ limits: { [A]: { rate: { max: 1, windowMs: 10_000 }, autoReset: true, cooldownMs: 5000 } }, config: { flagCheck: false } });
  w.go(); w.go();
  assert.equal(w.gateway.agent(A).state, 'tripped');
  w.gateway.killGlobal(OPS);
  w.clock.advance(6000);
  const ag = w.gateway.agent(A);
  assert.equal(ag.state, 'reset');
  assert.equal(ag.issuanceDisabled, true);
  assert.equal(w.tokens.issue(A).ok, false);
  assert.equal(w.go().allowed, false);
  assert.equal(w.gateway.global().leakedCalls, 0);
  w.gateway.unrevokeGlobal({ operator: 'alice' });
  assert.equal(w.gateway.agent(A).issuanceDisabled, false, 'lifting the global switch re-opens issuance for an agent that is clear');
});

test('the global kill revokes every agent\'s tokens, not just the first', () => {
  const w = makeWorld({ config: { flagCheck: false } });
  w.go(A); w.go(B);
  assert.equal(w.gateway.killGlobal(OPS).tokensRevoked, 2);
  assert.equal(w.go(B).reason, 'token_revoked');
  assert.equal(w.go(A).reason, 'token_revoked');
});

// ---- budget accounting -----------------------------------------------------------------------------------------------------
test('token budget: exactly max is allowed, one more token is refused (upper boundary)', () => {
  const w = makeWorld({ limits: { [A]: { cost: { maxTokens: 100, maxMicros: 1e9 } } } });
  assert.equal(w.go(A, { tokensIn: 60, tokensOut: 0 }).allowed, true);
  assert.equal(w.go(A, { tokensIn: 40, tokensOut: 0 }).allowed, true);
  assert.equal(w.gateway.agent(A).usage.tokens, 100);
  const r = w.go(A, { tokensIn: 1, tokensOut: 0 });
  assert.equal(r.reason, 'cost_cap');
  assert.equal(w.gateway.agent(A).usage.tokens, 100, 'a refused call is not charged');
});

test('a trip is counted once; a killed agent that breaches a cap stays killed (no downgrade to tripped)', () => {
  const w = makeWorld({ limits: { [A]: { rate: { max: 1, windowMs: 10_000 } } } });
  for (let i = 0; i < 4; i++) w.go();
  assert.equal(w.gateway.agent(A).trips, 1);

  const v = makeWorld({ limits: { [A]: { rate: { max: 1, windowMs: 10_000 } } }, config: { flagCheck: false, tokenValidation: 'local', revocationSyncMs: 1e9 } });
  assert.equal(v.go().allowed, true);
  v.gateway.kill({ agentId: A, ...OPS });
  const r = v.go();
  assert.equal(r.reason, 'rate_cap', 'the stale revocation list let the call reach the cap');
  const ag = v.gateway.agent(A);
  assert.equal(ag.state, 'killed');
  assert.equal(ag.reason, 'manual');
  assert.equal(ag.trips, 0);
});

// ---- token store -----------------------------------------------------------------------------------------------------------
test('the token store is capped: the oldest token becomes unknown', () => {
  const clock = createClock({ fixed: T0 });
  const ts = createTokenService({ clock, cap: 3 });
  const issued = Array.from({ length: 5 }, () => ts.issue(A));
  assert.equal(ts.lookup(issued[0].token), null);
  assert.equal(ts.lookup(issued[1].token), null);
  assert.ok(ts.lookup(issued[4].token));
  assert.equal(ts.liveCount(A), 3);
});

// ---- audit -----------------------------------------------------------------------------------------------------------------
test('audit: verify reports how many entries the cap evicted; list honours after', () => {
  const a = createAudit({ cap: 3 });
  for (let i = 0; i < 5; i++) a.append('kill', A, { i });
  const v = a.verify();
  assert.equal(v.ok, true);
  assert.equal(v.evicted, 2);
  assert.deepEqual(a.list({ after: 3 }).map((e) => e.seq), [4, 5]);
  assert.deepEqual(a.list().map((e) => e.seq), [3, 4, 5]);
});

test('audit flood: scenario runs cannot push an operator kill out unnoticed', () => {
  const r = rt({ auditCap: 10 });
  r.kill({ scope: 'agent', agentId: A, operator: 'ops', reason: 'KEEP-ME' });
  r.unrevoke({ scope: 'agent', agentId: A, operator: 'ops' });
  for (let i = 0; i < 20; i++) r.runScenario('normal');
  assert.ok(!r.audit.list().some((e) => e.type === 'kill'), 'the kill entry was evicted by the cap');
  assert.ok(r.audit.verify().evicted >= 12, 'and verify says history was dropped');
});

test('audit: a deleted entry is a sequence gap, and so is a dropped first entry', () => {
  const store = [];
  const a = createAudit({ store });
  for (let i = 0; i < 5; i++) a.append('kill', A, { i });
  const removed = store.splice(2, 1);
  assert.equal(a.verify().reason, 'sequence_gap');
  store.splice(2, 0, ...removed);
  assert.equal(a.verify().ok, true);
  store.shift();
  assert.equal(a.verify().reason, 'sequence_gap');
});

// ---- identity, clock -------------------------------------------------------------------------------------------------------
test('agent id derivation: compatibility forms fold (NFKC) and the 64-character bound holds', () => {
  assert.equal(deriveAgentKey('ａgent-alpha'), A, 'a fullwidth letter folds to the ASCII id');
  assert.equal(deriveAgentKey(`${A}${' '.repeat(64 - A.length)}`), A, '64 characters is accepted');
  assert.equal(deriveAgentKey(`${A}${' '.repeat(65 - A.length)}`), null, '65 is not');
  assert.equal(deriveAgentKey('toString'), null);
  assert.equal(deriveAgentKey('constructor'), null);
});

test('the clock cannot move backwards or by a non-number', () => {
  const c = createClock({ fixed: T0 });
  for (const bad of [-1, NaN, Infinity, 'x', undefined]) assert.throws(() => c.advance(bad), RangeError, String(bad));
  c.advance(0); c.advance(5);
  assert.equal(c.now(), T0 + 5);
});

// ---- scripted agent --------------------------------------------------------------------------------------------------------
test('the scripted agent retries once after a token refusal, and the first refusal stands when the retry is refused too', () => {
  const r = rt();
  const run = r.runScenario('stale-token-gap');
  const denied = run.transcript.filter((e) => e.action === 'call' && !e.allowed);
  assert.ok(denied.length >= 1);
  assert.equal(denied[0].reason, 'token_revoked', 'the gateway refusal stands, not issuance_disabled from the retry');
});

// ---- HTTP guards -----------------------------------------------------------------------------------------------------------
test('Host guard: 127.999.0.1 is not loopback', async (t) => {
  const { srv } = await boot(t);
  assert.equal((await request(srv.port, 'GET', '/api/state', { host: `127.999.0.1:${srv.port}` })).status, 421);
  assert.equal((await request(srv.port, 'GET', '/api/state', { host: `127.0.0.2:${srv.port}` })).status, 200);
});

test('CSRF: PUT, DELETE and PATCH from another origin are refused like POST, and x-powered-by is off', async (t) => {
  const { call } = await boot(t);
  for (const m of ['PUT', 'DELETE', 'PATCH']) {
    const r = await call(m, '/api/state', { headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403, m);
    assert.equal(r.json.error, 'bad_origin');
  }
  assert.equal((await call('GET', '/api/state')).headers['x-powered-by'], undefined);
});

test('CSRF: a chunked (no content-length) body that is not JSON is refused with 415', async (t) => {
  const { srv } = await boot(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/api/kill', agent: false, headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('{"scope":"global"}');
    req.end();
  });
  assert.equal(status, 415);
});

test('CSRF: the JSON content type is exact (text/json and application/jsonx are refused)', async (t) => {
  const { runtime, call } = await boot(t);
  for (const type of ['text/json', 'application/jsonx', 'application/x-json']) {
    const r = await call('POST', '/api/kill', { body: JSON.stringify({ scope: 'global', operator: 'x' }), headers: { 'content-type': type } });
    assert.equal(r.status, 415, type);
  }
  assert.equal(runtime.gateway.global().state, 'armed');
  assert.equal((await call('POST', '/api/kill', { body: { scope: 'global', operator: 'x' }, headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 200);
});

test('kill: inFlight must be finish or cancel, refused at the edge', async (t) => {
  const { call } = await boot(t);
  const r = await call('POST', '/api/kill', { body: { scope: 'agent', agentId: A, inFlight: 'bogus' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'bad_request');
  assert.equal((await call('POST', '/api/kill', { body: { scope: 'agent', agentId: A, inFlight: 5 } })).json.error, 'bad_request');
});

test('a cross-site or cross-port page cannot even read the API (a read can apply a due auto-reset); health stays readable', async (t) => {
  const { call } = await boot(t);
  for (const site of ['cross-site', 'same-site']) {
    for (const p of ['/api/state', '/api/agents', '/api/audit', '/api/events']) {
      const r = await call('GET', p, { headers: { 'sec-fetch-site': site } });
      assert.equal(r.status, 403, `${p} ${site}`);
      assert.equal(r.json.error, 'cross_site_refused');
    }
    assert.equal((await call('GET', '/api/health', { headers: { 'sec-fetch-site': site } })).status, 200);
  }
  for (const site of ['same-origin', 'none']) assert.equal((await call('GET', '/api/state', { headers: { 'sec-fetch-site': site } })).status, 200);
});
