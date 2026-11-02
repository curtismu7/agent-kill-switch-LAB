// The Federated Identity revoke engine, on a fixed virtual clock (no sleeps, no wall-clock assertions).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudit } from '../src/audit.js';
import { createFedId, parseAdvanceBody, parseIssuerBody, parseRequestBody, parseRevokeBody } from '../src/fedid/engine.js';
import { signToken } from '../src/fedid/jwt.js';
import { APPS, IDENTITIES, ISSUERS, ISSUER_CAP, KEYSET_REFRESH_SEC, MAX_LIFETIME_SEC, REQUEST_CAP, REASON_STATUS } from '../src/fedid/tables.js';

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
  assert.ok(parseRevokeBody({ workload: B, operator: 'x'.repeat(41) }).error);
  assert.ok(parseRevokeBody({ workload: B, operator: 'x', reason: 'y'.repeat(201) }).error);
  assert.ok(parseRevokeBody({ workload: B, operator: 'x'.repeat(40), reason: 'y'.repeat(200) }).value);
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

// ---- findings of the 2026-11-01 review: each test below was proven by a mutant (scripts/red-checks-fedid.mjs) ----------------------------------

test('a revoke is judged on the masked operator: a name made only of invisible characters is refused 400 and nothing changes', () => {
  const { e, audit, revoke } = make();
  for (const op of ['\u200b\u200b', '\u200b \u2060', '\u0007\u0001', '\ufeff']) {
    const r = revoke(B, op);
    assert.deepEqual([r.ok, r.status, r.error], [false, 400, 'bad_request'], JSON.stringify(op));
  }
  assert.equal(e.state().identities.find((i) => i.id === B).state, 'active', 'still active');
  assert.equal(audit.list().some((x) => x.type === 'fedid_revoke'), false, 'nothing audited');
  assert.equal(revoke(B, '\u200bops').ok, true, 'a name with real characters is accepted, and stored without the invisible ones');
  assert.equal(e.state().identities.find((i) => i.id === B).revokedBy, 'ops');
});

test('an operator of 40 characters and a reason of 200 are accepted whole; one more is refused whole, and nothing is ever cut', () => {
  const { e, audit, revoke } = make();
  const op = 'ab '.repeat(13).trim().padEnd(40, 'z'); const why = 'cd '.repeat(66).trim().padEnd(200, 'z');
  assert.deepEqual([op.length, why.length], [40, 200]);
  assert.deepEqual([revoke(B, `${op}z`, why).status, revoke(B, op, `${why}z`).status], [400, 400], '41 and 201 are refused');
  assert.equal(e.state().identities.find((i) => i.id === B).state, 'active', 'a refused revoke changes nothing');
  assert.equal(revoke(B, op, why).ok, true);
  const id = e.state().identities.find((i) => i.id === B);
  assert.deepEqual([id.revokedBy, id.note], [op, why], 'stored exactly as typed: no ellipsis, no cut');
  const a = audit.list().find((x) => x.type === 'fedid_revoke');
  assert.deepEqual([a.data.operator, a.data.note], [op, why]);
});

test('issuer outage: a real change is audited once; setting the state it already has is accepted and audited NOT at all, and does not count', () => {
  const { e, audit } = make();
  const count = () => audit.list().filter((x) => x.type === 'fedid_issuer').length;
  for (let i = 0; i < 5; i += 1) assert.equal(e.setIssuer({ outage: false }).ok, true);
  assert.equal(count(), 0, 'already false: nothing to audit');
  assert.equal(e.setIssuer({ outage: true }).ok, true);
  for (let i = 0; i < 5; i += 1) assert.equal(e.setIssuer({ outage: true }).ok, true);
  assert.equal(count(), 1, 'one change, one entry');
  assert.equal(e.state().issuerChanges, 1);
});

test('ISSUER CAP: the ISSUER_CAP-th change is allowed, the next is refused 429 whole; a repeat of the current state is still accepted; Reset restores it', () => {
  const { e, audit } = make();
  let outage = false;
  for (let i = 0; i < ISSUER_CAP; i += 1) { outage = !outage; assert.equal(e.setIssuer({ outage }).ok, true, `change ${i + 1}`); }
  assert.equal(e.state().issuerChanges, ISSUER_CAP);
  const refused = e.setIssuer({ outage: !outage });
  assert.deepEqual([refused.ok, refused.status, refused.error], [false, 429, 'issuer_cap']);
  assert.equal(e.state().issuerOutage, outage, 'a refused change changes nothing');
  assert.equal(audit.list({ limit: 500 }).filter((x) => x.type === 'fedid_issuer').length, ISSUER_CAP, 'and writes nothing');
  assert.equal(e.setIssuer({ outage }).ok, true, 'saying the state it already has is not a change');
  e.reset();
  assert.equal(e.setIssuer({ outage: true }).ok, true);
  assert.equal(e.state().issuerChanges, 1);
});

test('AUDIT: a flood of issuer toggles cannot push the revoke entry out of the trail (the default 2000-entry cap)', () => {
  const audit = createAudit({ now: () => new Date(T) });
  const e = createFedId({ audit, startMs: () => T, signing: 'mock' });
  assert.equal(e.revoke({ workload: B, operator: 'ops', reason: 'x' }).ok, true);
  let refused = 0;
  for (let i = 0; i < 2100; i += 1) { if (!e.setIssuer({ outage: !e.state().issuerOutage }).ok) refused += 1; } // every call asks for a real change
  assert.equal(refused, 2100 - ISSUER_CAP);
  const v = audit.verify();
  assert.equal(v.evicted, 0, 'nothing was evicted');
  assert.equal(audit.list({ limit: 500 }).some((x) => x.type === 'fedid_revoke'), true, 'the revoke entry is still in the trail');
});

test('summary: only requests made AFTER the revoke are counted as after it (the last request before it is not)', () => {
  const { e, go, revoke } = make();
  assert.equal(go(B).result.decision, 'allowed'); // n = 1, before the revoke
  assert.equal(revoke().ok, true);
  assert.equal(go(B).result.decision, 'refused'); // n = 2
  const a = e.state().identities.find((i) => i.id === B).summary.afterRevoke;
  assert.deepEqual([a.requests, a.allowed, a.refused, a.tokenStillValid, a.firstDecision.n], [1, 0, 1, 1, 2]);
  assert.equal(e.state().identities.find((i) => i.id === B).summary.matrix.find((m) => m.service === 'mcp' && m.via === 'token').status, 403);
});

test('a token that the gateway cannot bind to an identity is not "still valid"; an expired one is 401; a negative lifetime is refused', () => {
  const { e } = make();
  const unbound = e.verifyRaw(craft(goodHeader, goodClaims({ sub: 'someone-else' })));
  assert.deepEqual([unbound.reason, unbound.status, unbound.tokenStillValid], ['no_matching_identity', 401, false], 'binding is part of "still valid"');
  const expired = e.verifyRaw(craft(goodHeader, goodClaims({ exp: T / 1000 - 1, iat: T / 1000 - 601 })));
  assert.deepEqual([expired.reason, expired.status, expired.tokenStillValid], ['token_expired', 401, false]);
  const backwards = e.verifyRaw(craft(goodHeader, goodClaims({ iat: T / 1000 + 100, exp: T / 1000 + 50 })));
  assert.deepEqual([backwards.reason, backwards.status], ['lifetime_exceeds_cap', 401], 'exp before iat is not a short lifetime');
  const same = e.verifyRaw(craft(goodHeader, goodClaims({ iat: T / 1000 + 50, exp: T / 1000 + 50 })));
  assert.equal(same.reason, 'lifetime_exceeds_cap', 'exp equal to iat is not a lifetime either');
});

test('every refusal reason has the status its kind deserves: 401 for the token, 403 for the identity and the scope', () => {
  assert.deepEqual({ ...REASON_STATUS }, {
    token_malformed: 401, alg_not_allowed: 401, signature_invalid: 401, lifetime_exceeds_cap: 401, token_expired: 401, no_matching_identity: 401, identity_revoked: 403, scope_missing: 403,
  });
});

test('presenting by key: a workload with no agent access key is refused on the key route (the check is on the key, not just the identity)', () => {
  const { e } = make();
  const noKey = e.verifyRaw(craft({ ...goodHeader, kid: ISSUERS.ci.kid }, goodClaims({ iss: ISSUERS.ci.iss, sub: IDENTITIES[N].subject, aud: IDENTITIES[N].audience }), 'ci'), { via: 'key' });
  assert.equal(noKey.decision, 'refused');
  assert.equal(noKey.checks.find((c) => c.id === 'key_principal').ok, false);
  const viaToken = e.verifyRaw(craft({ ...goodHeader, kid: ISSUERS.ci.kid }, goodClaims({ iss: ISSUERS.ci.iss, sub: IDENTITIES[N].subject, aud: IDENTITIES[N].audience }), 'ci'), { via: 'token' });
  assert.equal(viaToken.decision, 'allowed', 'the control: the same token presented as a token is fine');
});

test('token parsing is bounded: exactly three non-empty parts of at most MAX_PART characters each', async () => {
  const { parseToken, MAX_PART } = await import('../src/fedid/jwt.js');
  const ok = craft(goodHeader, goodClaims());
  const [h, p, s] = ok.split('.');
  assert.equal(parseToken(ok).ok, true);
  assert.equal(parseToken(`${h}.${p}`).ok, false, 'two parts');
  assert.equal(parseToken(`${h}.${p}.${s}.${s}`).ok, false, 'four parts');
  assert.equal(parseToken(`${h}.${p}.`).ok, false, 'an empty part');
  assert.equal(parseToken(`${h}.${p}.${'A'.repeat(MAX_PART)}`).ok, true, 'a part of exactly MAX_PART characters is fine');
  assert.equal(parseToken(`${h}.${p}.${'A'.repeat(MAX_PART + 1)}`).ok, false, 'one character over');
  assert.equal(parseToken(`${h}.${p}.${s}`.replace(/.$/, '+')).ok, false, 'not base64url');
});
