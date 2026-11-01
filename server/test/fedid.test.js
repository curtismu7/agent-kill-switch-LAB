// The Federated Identity revoke engine, on a fixed virtual clock (no sleeps, no wall-clock assertions).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudit } from '../src/audit.js';
import { createFedId, parseAdvanceBody, parseIssuerBody, parseRequestBody, parseRevokeBody } from '../src/fedid/engine.js';
import { signToken } from '../src/fedid/jwt.js';
import { APPS, IDENTITIES, ISSUERS, KEYSET_REFRESH_SEC, MAX_LIFETIME_SEC, REQUEST_CAP } from '../src/fedid/tables.js';

const T = Date.UTC(2026, 10, 2, 9, 0, 0);
const B = 'fi-billing-agent';
const N = 'fi-nightly-job';
function make(signing = 'rsa') {
  const audit = createAudit({ now: () => new Date(T) });
  const e = createFedId({ audit, startMs: () => T, signing });
  const go = (workload, service = 'mcp', via = 'token', extra = {}) => e.request({ workload, service, via, ...extra });
  const revoke = (workload = B, operator = 'on-call', reason = 'test') => e.revoke({ workload, operator, reason });
  return { e, audit, go, revoke };
}
const craft = (header, claims, issuerId = 'k8s', signing = 'rsa') => signToken({ header, claims, issuerId, signing });
const goodClaims = (over = {}) => ({ iss: ISSUERS.k8s.iss, sub: IDENTITIES[B].subject, aud: IDENTITIES[B].audience, iat: T / 1000, exp: T / 1000 + 600, jti: 'x', ...over });
const goodHeader = { alg: 'RS256', typ: 'JWT', kid: ISSUERS.k8s.kid };

for (const signing of ['rsa', 'mock']) {
  test(`${signing}: a registered identity is allowed on every service it has scope for, and refused (403) on one it has not`, () => {
    const { go } = make(signing);
    for (const s of ['mcp', 'a2a', 'llm']) { const r = go(B, s); assert.equal(r.ok, true); assert.equal(r.result.decision, 'allowed', s); assert.equal(r.result.status, 200); }
    assert.equal(go(N, 'mcp').result.decision, 'allowed');
    const miss = go(N, 'a2a').result;
    assert.deepEqual([miss.decision, miss.reason, miss.status], ['refused', 'scope_missing', 403]);
  });

  test(`${signing}: after a revoke the very next request is refused 403 identity_revoked although the token still validates`, () => {
    const { go, revoke } = make(signing);
    assert.equal(go(B).result.decision, 'allowed');
    assert.equal(revoke().ok, true);
    const r = go(B).result;
    assert.deepEqual([r.decision, r.reason, r.status], ['refused', 'identity_revoked', 403]);
    assert.equal(r.tokenStillValid, true, 'signature, binding, lifetime and expiry all still pass');
    for (const id of ['alg', 'signature', 'lifetime', 'expiry', 'binding', 'scope']) assert.equal(r.checks.find((c) => c.id === id).ok, true, id);
    assert.equal(r.checks.find((c) => c.id === 'identity_state').ok, false);
    assert.deepEqual(r.deployment, { identity: B, subject: IDENTITIES[B].subject }, 'the refusal is attributed to the deployment');
  });

  test(`${signing}: a revoke cuts every service family and the key that names the identity, and leaves the other identity alone`, () => {
    const { e, go, revoke } = make(signing);
    revoke();
    for (const s of ['mcp', 'a2a', 'llm']) assert.equal(go(B, s).result.reason, 'identity_revoked', s);
    const k = go(B, 'mcp', 'key').result;
    assert.equal(k.reason, 'identity_revoked');
    assert.equal(k.checks.find((c) => c.id === 'key_principal').ok, false);
    assert.equal(go(N, 'mcp').result.decision, 'allowed');
    const sum = e.state().identities.find((i) => i.id === B).summary;
    assert.equal(sum.afterRevoke.requests, 4);
    assert.equal(sum.afterRevoke.refused, 4);
    assert.equal(sum.afterRevoke.allowed, 0);
    assert.equal(sum.afterRevoke.refusedAndAttributed, 4);
    assert.equal(e.state().identities.find((i) => i.id === N).summary.revoked, false);
    assert.deepEqual(e.state().identities.find((i) => i.id === N).summary.sinceFirstRevoke, { requests: 1, allowed: 1 }, 'the other identity carried on');
  });
}

test('the revoke target field decides who is cut: revoking the nightly job leaves the billing agent working', () => {
  const { e, go, revoke } = make();
  assert.equal(revoke(N).ok, true);
  assert.equal(go(N).result.reason, 'identity_revoked');
  assert.equal(go(B).result.decision, 'allowed');
  const st = e.state().identities;
  assert.deepEqual(st.map((i) => [i.id, i.state]), [[B, 'active'], [N, 'revoked']]);
});

test('the platform keeps minting valid tokens after a revoke; the gateway still refuses the identity', () => {
  const { e, go, revoke } = make();
  const first = go(B).result;
  assert.equal(first.minted, true);
  assert.equal(go(B).result.minted, false, 'the same unexpired token is reused');
  revoke();
  e.advance({ seconds: 601 });
  const r = go(B).result;
  assert.equal(r.minted, true, 'the old token expired, the platform issued a new one');
  assert.notEqual(r.token.claims.jti, first.token.claims.jti);
  assert.equal(r.tokenStillValid, true);
  assert.equal(r.reason, 'identity_revoked');
  assert.equal(e.state().identities.find((i) => i.id === B).summary.afterRevoke.reminted, 1);
});

test('revoke: second revoke is 409, unknown or mistyped identity and a missing operator are 400, nothing changes on refusal', () => {
  const { e, revoke } = make();
  assert.equal(revoke().ok, true);
  const again = revoke();
  assert.deepEqual([again.ok, again.status, again.error], [false, 409, 'already_revoked']);
  for (const bad of [{ workload: 'nobody', operator: 'x' }, { workload: B }, { workload: B, operator: '' }, { workload: B, operator: '   ' }, { workload: B, operator: 7 }, { workload: B, operator: 'x', reason: 5 }, { workload: B, operator: 'x', extra: 1 }, { workload: ['fi-billing-agent'], operator: 'x' }, null, [], 'text']) {
    const r = e.revoke(bad);
    assert.equal(r.ok, false); assert.equal(r.status, 400);
  }
  assert.equal(e.state().identities.find((i) => i.id === N).state, 'active');
});

test('key set: refreshed when 15 minutes old and the issuer answers; kept (last known good) through an outage', () => {
  const { e, go } = make();
  assert.equal(go(N).result.keySet.source, 'cache');
  e.advance({ seconds: KEYSET_REFRESH_SEC });
  const refreshed = go(N).result.keySet;
  assert.deepEqual([refreshed.source, refreshed.ageSec], ['refreshed', 0]);
  e.setIssuer({ outage: true });
  e.advance({ seconds: 2 * KEYSET_REFRESH_SEC });
  const out = go(N).result;
  assert.equal(out.decision, 'allowed', 'the last known good key set is used');
  assert.deepEqual([out.keySet.source, out.keySet.issuerReachable], ['cache', false]);
  assert.ok(out.keySet.ageSec >= 2 * KEYSET_REFRESH_SEC);
  e.setIssuer({ outage: false });
  assert.equal(go(N).result.keySet.source, 'refreshed');
});

test('an outage does not bring a revoked identity back', () => {
  const { e, go, revoke } = make();
  revoke();
  e.setIssuer({ outage: true });
  e.advance({ seconds: 5000 });
  assert.equal(go(B).result.reason, 'identity_revoked');
});

test('lifetime: the field decides the token lifetime; one hour is the cap (boundary), one second over is refused 401', () => {
  const { go } = make();
  const ok = go(B, 'mcp', 'token', { lifetimeSec: MAX_LIFETIME_SEC }).result;
  assert.equal(ok.token.claims.exp - ok.token.claims.iat, MAX_LIFETIME_SEC);
  assert.equal(ok.decision, 'allowed');
  const over = go(B, 'mcp', 'token', { lifetimeSec: MAX_LIFETIME_SEC + 1 }).result;
  assert.deepEqual([over.decision, over.reason, over.status, over.minted], ['refused', 'lifetime_exceeds_cap', 401, true]);
  const short = go(B, 'mcp', 'token', { lifetimeSec: 30 }).result;
  assert.equal(short.token.claims.exp - short.token.claims.iat, 30);
  assert.equal(short.minted, true, 'a different lifetime asks the platform for a new token');
  assert.equal(go(B, 'mcp', 'token', { lifetimeSec: 30 }).result.minted, false, 'the same lifetime reuses it');
});

test('the gateway refuses tokens the platform would never mint', () => {
  const { e } = make();
  const v = (raw) => e.verifyRaw(raw);
  assert.equal(v(craft({ ...goodHeader, alg: 'none' }, goodClaims())).reason, 'alg_not_allowed');
  assert.equal(v(craft({ ...goodHeader, alg: 'HS256' }, goodClaims())).reason, 'alg_not_allowed');
  assert.equal(v(craft(goodHeader, goodClaims())).decision, 'allowed', 'the control: a well-formed token passes');
  const good = craft(goodHeader, goodClaims());
  const [h, p, s] = good.split('.');
  const tampered = v(`${h}.${p}.${s.slice(0, -4)}AAAA`);
  assert.equal(tampered.reason, 'signature_invalid');
  assert.equal(tampered.deployment, null, 'a request whose signature does not verify is not attributed to any deployment');
  assert.equal(v(craft(goodHeader, goodClaims(), 'ci')).reason, 'signature_invalid', 'signed by the other issuer');
  assert.equal(v(craft({ ...goodHeader, kid: 'unknown-key' }, goodClaims())).reason, 'signature_invalid');
  assert.equal(v(craft(goodHeader, goodClaims({ exp: T / 1000 - 1, iat: T / 1000 - 601 }))).reason, 'token_expired');
  assert.equal(v(craft(goodHeader, goodClaims({ aud: 'https://other.example' }))).reason, 'no_matching_identity');
  assert.equal(v(craft(goodHeader, goodClaims({ sub: `${IDENTITIES[B].subject}x` }))).reason, 'no_matching_identity', 'subject is matched exactly');
  assert.equal(v(craft(goodHeader, goodClaims({ aud: [IDENTITIES[B].audience] }))).reason, 'no_matching_identity', 'audience must be the one string');
  assert.equal(v(craft(goodHeader, goodClaims({ iss: `${ISSUERS.k8s.iss}/` }))).reason, 'signature_invalid', 'an issuer the gateway holds no key set for cannot be verified');
  assert.equal(v(craft({ ...goodHeader, kid: ISSUERS.ci.kid }, goodClaims({ iss: ISSUERS.ci.iss }), 'ci')).reason, 'no_matching_identity', 'a valid token from the other issuer with this subject is not this identity: issuer is matched exactly');
  assert.equal(v(craft(goodHeader, goodClaims({ exp: T / 1000 + MAX_LIFETIME_SEC + 1 }))).reason, 'lifetime_exceeds_cap');
  assert.equal(v('not-a-token').reason, 'token_malformed');
  assert.equal(v('a.b.c').reason, 'token_malformed');
  assert.equal(v('x'.repeat(5000)).reason, 'token_malformed');
  assert.equal(v(undefined).reason, 'token_malformed');
});

test('the token stops at the gateway: the backend gets the application\'s own credential, and the check is computed', () => {
  const { e, go } = make();
  for (const s of ['mcp', 'a2a', 'llm']) {
    const r = go(B, s); const b = r.result.backend;
    assert.equal(b.credentialId, APPS[s].credentialId);
    assert.equal(b.workloadTokenForwarded, false);
    assert.equal(JSON.stringify(e.state()).includes(r.raw), false, 'the raw token is never in the state');
    assert.equal(JSON.stringify(r.result).includes(r.raw), false, 'nor in the result record');
  }
  assert.equal(e.state().forwardedTokens, 0);
  assert.equal(go(N, 'a2a').result.backend, null, 'a refused request reaches no backend');
});

test('every request and every revoke is in the audit trail, attributed, and the chain verifies', () => {
  const { audit, go, revoke } = make();
  go(B); revoke(B, 'on-call', 'why'); go(B); go(N, 'a2a');
  const types = audit.list().map((x) => x.type);
  assert.deepEqual(types, ['fedid_decision', 'fedid_revoke', 'fedid_decision', 'fedid_decision']);
  const [, , refused] = audit.list();
  assert.deepEqual([refused.agentId, refused.data.reason, refused.data.subject, refused.data.attributed], [B, 'identity_revoked', IDENTITIES[B].subject, true]);
  assert.equal(audit.verify().ok, true);
});

test('the request cap refuses the whole request and nothing is evicted', () => {
  const { e, go } = make();
  for (let i = 0; i < REQUEST_CAP; i += 1) assert.equal(go(N).ok, true);
  const over = go(N);
  assert.deepEqual([over.ok, over.status, over.error], [false, 429, 'request_cap']);
  const st = e.state();
  assert.equal(st.requests, REQUEST_CAP);
  assert.equal(st.log[0].n, REQUEST_CAP - 49, 'the state shows the newest 50');
  assert.equal(e.results().length, REQUEST_CAP, 'nothing was dropped from the log');
});

test('virtual time: advance is bounded per call and in total, and only advance moves it', () => {
  const { e } = make();
  const t0 = e.state().now;
  for (const bad of [{ seconds: 0 }, { seconds: -1 }, { seconds: 86_401 }, { seconds: 1.5 }, { seconds: '5' }, { seconds: Number.NaN }, { seconds: null }, {}, { seconds: 5, x: 1 }, [], null]) assert.equal(e.advance(bad).status, 400);
  assert.equal(e.state().now, t0);
  assert.equal(e.advance({ seconds: 86_400 }).ok, true);
  assert.equal(e.state().advancedSec, 86_400);
  let last = null;
  for (let i = 0; i < 40; i += 1) { last = e.advance({ seconds: 86_400 }); if (!last.ok) break; }
  assert.deepEqual([last.status, last.error], [429, 'time_cap']);
  assert.equal(e.state().advancedSec <= 30 * 86_400, true);
});

test('input types: every field is checked by type and by table lookup; hostile names never reach a table', () => {
  const ok = { workload: B, service: 'mcp' };
  assert.equal(parseRequestBody(ok).value.via, 'token');
  assert.equal(parseRequestBody(ok).value.lifetimeSec, 600);
  for (const bad of [
    null, [], 'x', 7, { ...ok, workload: '__proto__' }, { ...ok, workload: 'constructor' }, { ...ok, workload: 'toString' }, { ...ok, workload: 7 }, { ...ok, workload: [B] }, { ...ok, workload: undefined },
    { ...ok, service: 'constructor' }, { ...ok, service: 'MCP' }, { ...ok, service: undefined }, { ...ok, via: 'KEY' }, { ...ok, via: 1 }, { ...ok, via: null },
    { ...ok, lifetimeSec: 0 }, { ...ok, lifetimeSec: -1 }, { ...ok, lifetimeSec: 1.5 }, { ...ok, lifetimeSec: '600' }, { ...ok, lifetimeSec: 86_401 }, { ...ok, lifetimeSec: null }, { ...ok, extra: 1 },
    JSON.parse('{"workload":"fi-billing-agent","service":"mcp","__proto__":{"x":1}}'),
  ]) assert.ok(parseRequestBody(bad).error, JSON.stringify(bad));
  for (const bad of [null, {}, { outage: 'true' }, { outage: 1 }, { outage: true, x: 1 }, []]) assert.ok(parseIssuerBody(bad).error);
  assert.ok(parseAdvanceBody({ seconds: 'x' }).error);
  assert.ok(parseRevokeBody({ workload: B, operator: 'x'.repeat(201) }).error);
  assert.ok(parseRevokeBody({ workload: B, operator: 'x', reason: 'y'.repeat(1001) }).error);
  assert.ok(parseRevokeBody({ workload: B, operator: 'x'.repeat(200), reason: 'y'.repeat(1000) }).value);
  const { e } = make();
  assert.equal(e.request({ workload: N, service: 'mcp', via: 'key' }).status, 400, 'the nightly job has no access key');
});

test('reset restores the first state: identities active, log empty, time back, key sets fresh, outage off', () => {
  const { e, go, revoke } = make();
  go(B); revoke(); e.setIssuer({ outage: true }); e.advance({ seconds: 5000 });
  e.reset();
  const s = e.state();
  assert.deepEqual([s.requests, s.advancedSec, s.issuerOutage, s.log.length, s.now], [0, 0, false, 0, new Date(T).toISOString()]);
  assert.ok(s.identities.every((i) => i.state === 'active' && i.revokedBy === null));
  assert.equal(go(B).result.decision, 'allowed');
  assert.equal(go(B).result.minted, false);
});

test('the revoke record keeps the operator and reason, masked', () => {
  const { e, revoke } = make();
  revoke(B, 'ops-1', 'my password is hunter2-xyz987 sorry');
  const id = e.state().identities.find((i) => i.id === B);
  assert.equal(id.revokedBy, 'ops-1');
  assert.ok(!id.note.includes('hunter2-xyz987'));
  assert.match(id.note, /\[REDACTED\]/);
  const other = make();
  other.revoke(N, 'sk-live-OPERATORSECRET99 ok', 'fine');
  const op = other.e.state().identities.find((i) => i.id === N).revokedBy;
  assert.ok(!op.includes('OPERATORSECRET99'), op);
  assert.ok(!JSON.stringify(other.audit.list()).includes('OPERATORSECRET99'), 'nor in the audit trail');
});
