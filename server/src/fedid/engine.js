// The Federated Identity revoke engine: a workload's platform-issued token is checked on EVERY request at a mock gateway; an operator
// revokes the identity; the next request is refused although the token itself is still valid. One engine per workspace.
//
//  signing 'rsa'  (Live): the platform mints real RS256 tokens with a throwaway local key and the gateway verifies them for real.
//  signing 'mock' (Mock): same code, same checks, a fixed marker instead of a signature. The Mock table is generated from this engine
//                         (mock.js), and a test checks that the two modes make the same decisions (parity).
//
// Time is virtual: it moves only when advance() is called. Nothing here reads the wall clock after creation. Every function is
// synchronous, so a check-and-change (for example the revoke) cannot interleave with another request: there is no await in here.
// Strings the visitor types are masked (mask.js) before they are stored or returned; every error message below is a fixed string
// and never contains what was typed.
import { fingerprint, parseToken, signToken, signatureValid } from './jwt.js';
import { maskText } from '../mask.js';
import {
  ACCESS_KEYS, ALGS_ALLOWED, APPS, DEFAULT_LIFETIME_SEC, IDENTITIES, ISSUERS, KEYSET_REFRESH_SEC, LOG_KEEP, MAX_LIFETIME_SEC,
  ISSUER_CAP, REASON_STATUS, REQUEST_CAP, SERVICES, VIAS,
} from './tables.js';

export const MAX_ADVANCE_TOTAL_SEC = 30 * 24 * 3600; // lab-invented: the virtual clock may move at most 30 days between Resets
const iso = (ms) => new Date(ms).toISOString();
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const FIELD_ERROR = 'the request body is missing a field, has a field of the wrong type or value, or has a field this endpoint does not take';

// The order the gateway decides in (lab-invented order: the deck says the token is verified per request, not in which order).
const ORDER = ['alg', 'signature', 'lifetime', 'expiry', 'binding', 'identity_state', 'key_principal', 'scope'];
const REASON_OF = {
  alg: 'alg_not_allowed', signature: 'signature_invalid', lifetime: 'lifetime_exceeds_cap', expiry: 'token_expired', binding: 'no_matching_identity',
  identity_state: 'identity_revoked', key_principal: 'identity_revoked', scope: 'scope_missing',
};
// Where each check comes from, so the page can tag it.
const CHECK_TAG = {
  alg: 'deck claim', signature: 'deck claim', lifetime: 'deck claim', expiry: 'deck claim', binding: 'deck claim',
  identity_state: 'lab reading', key_principal: 'lab reading', scope: 'deck claim',
};

// ---- input parsing (pure) ------------------------------------------------------------------------------------------------
const onlyKeys = (b, allowed) => plain(b) && Object.keys(b).every((k) => allowed.includes(k));
const known = (table, v) => typeof v === 'string' && Object.hasOwn(table, v);

export function parseRequestBody(b) {
  if (!onlyKeys(b, ['workload', 'service', 'via', 'lifetimeSec'])) return { error: FIELD_ERROR };
  if (!known(IDENTITIES, b.workload) || !SERVICES.includes(b.service)) return { error: FIELD_ERROR };
  if (b.via !== undefined && !VIAS.includes(b.via)) return { error: FIELD_ERROR };
  if (b.lifetimeSec !== undefined && !isInt(b.lifetimeSec, 1, 86_400)) return { error: FIELD_ERROR };
  return { value: { workload: b.workload, service: b.service, via: b.via ?? 'token', lifetimeSec: b.lifetimeSec ?? DEFAULT_LIFETIME_SEC } };
}
export function parseRevokeBody(b) {
  if (!onlyKeys(b, ['workload', 'operator', 'reason']) || !known(IDENTITIES, b.workload)) return { error: FIELD_ERROR };
  if (typeof b.operator !== 'string' || b.operator.trim() === '' || b.operator.length > 40) return { error: FIELD_ERROR };
  if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 200)) return { error: FIELD_ERROR };
  return { value: { workload: b.workload, operator: b.operator, reason: b.reason ?? '' } };
}
export function parseIssuerBody(b) {
  if (!onlyKeys(b, ['outage']) || typeof b.outage !== 'boolean') return { error: FIELD_ERROR };
  return { value: { outage: b.outage } };
}
export function parseAdvanceBody(b) {
  if (!onlyKeys(b, ['seconds']) || !isInt(b.seconds, 1, 86_400)) return { error: FIELD_ERROR };
  return { value: { seconds: b.seconds } };
}

// ---- summary of a log (pure; used by the Live state and by the Mock table, so both show the same computed rows) -------------------
// `log` is the list of request results in order; `revokes` is { identityId: { n } } where n is how many requests had been made at the revoke.
export function summarize(log, revokes) {
  const out = {};
  const firstRevokeN = Object.values(revokes).reduce((m, r) => Math.min(m, r.n), Infinity);
  for (const id of Object.keys(IDENTITIES)) {
    const rec = Object.hasOwn(revokes, id) ? revokes[id] : null;
    const mine = log.filter((r) => r.workload === id);
    const after = rec ? mine.filter((r) => r.n > rec.n) : [];
    const matrix = [];
    for (const service of SERVICES) {
      for (const via of VIAS) {
        if (via === 'key' && !Object.values(ACCESS_KEYS).some((k) => k.principal === id)) continue;
        const last = after.filter((r) => r.service === service && r.via === via).at(-1) ?? null;
        matrix.push({ service, via, decision: last ? last.decision : null, reason: last ? last.reason : null, status: last ? last.status : null });
      }
    }
    out[id] = {
      revoked: rec !== null,
      afterRevoke: rec ? {
        requests: after.length,
        allowed: after.filter((r) => r.decision === 'allowed').length,
        refused: after.filter((r) => r.decision === 'refused').length,
        refusedAndAttributed: after.filter((r) => r.decision === 'refused' && r.deployment !== null).length,
        tokenStillValid: after.filter((r) => r.tokenStillValid).length,
        reminted: after.filter((r) => r.minted).length,
        firstDecision: after[0] ? { decision: after[0].decision, reason: after[0].reason, n: after[0].n } : null,
      } : null,
      // What happened to this identity's requests since the first revoke of anyone (for the identity that was not revoked: did it carry on?).
      sinceFirstRevoke: Number.isFinite(firstRevokeN) ? {
        requests: mine.filter((r) => r.n > firstRevokeN).length,
        allowed: mine.filter((r) => r.n > firstRevokeN && r.decision === 'allowed').length,
      } : null,
      matrix,
    };
  }
  return { byIdentity: out, forwardedTokens: log.filter((r) => r.backend && r.backend.workloadTokenForwarded).length };
}

// ---- the engine ----------------------------------------------------------------------------------------------------------------
export function createFedId({ audit, startMs = () => Date.now(), signing = 'rsa' } = {}) {
  if (signing !== 'rsa' && signing !== 'mock') throw new RangeError('signing must be "rsa" or "mock"');
  let t0; let nowMs; let advancedSec; let n; let jtiN; let outage; let issuerChanges; let log; let revokes; let records; let held; let fetchedAt;

  function init() {
    t0 = startMs(); nowMs = t0; advancedSec = 0; n = 0; jtiN = 0; outage = false; issuerChanges = 0; log = []; revokes = {}; held = new Map();
    records = Object.fromEntries(Object.keys(IDENTITIES).map((id) => [id, { state: 'active', revokedAt: null, revokedBy: null, note: null }]));
    // Deck: "The issuer's key set is validated when the access key is created": the gateway starts with a fetched, known-good set per issuer.
    fetchedAt = Object.fromEntries(Object.keys(ISSUERS).map((id) => [id, nowMs]));
  }
  init();

  // The gateway's key set for an issuer. Refreshed when it is 15 minutes old and the issuer answers; during an outage the last known
  // good set is kept and used (deck: "the last known good set is kept through issuer outages").
  function keySet(issuerId) {
    if (issuerId === null) return null;
    let source = 'cache';
    if (!outage && nowMs - fetchedAt[issuerId] >= KEYSET_REFRESH_SEC * 1000) { fetchedAt[issuerId] = nowMs; source = 'refreshed'; }
    return { issuer: issuerId, source, ageSec: Math.floor((nowMs - fetchedAt[issuerId]) / 1000), issuerReachable: !outage };
  }

  // What the platform does: mint a token for the workload's identity. The platform knows nothing about Privilege's revoke.
  function platformToken(identity, lifetimeSec) {
    const h = held.get(identity.id);
    if (h && h.expMs > nowMs && h.lifetimeSec === lifetimeSec) return { raw: h.raw, minted: false };
    jtiN += 1;
    const iat = Math.floor(nowMs / 1000);
    const claims = { iss: ISSUERS[identity.issuer].iss, sub: identity.subject, aud: identity.audience, iat, exp: iat + lifetimeSec, jti: `jti-${String(jtiN).padStart(4, '0')}` };
    const raw = signToken({ header: { alg: 'RS256', typ: 'JWT', kid: ISSUERS[identity.issuer].kid }, claims, issuerId: identity.issuer, signing });
    held.set(identity.id, { raw, expMs: claims.exp * 1000, lifetimeSec });
    return { raw, minted: true };
  }

  // The gateway: every check is evaluated (so the page can show that the token still validates), the decision is the first failure in ORDER.
  function gateway(raw, { service, via }) {
    const parsed = parseToken(raw);
    if (!parsed.ok) return { checks: [], decision: 'refused', reason: 'token_malformed', status: 401, deployment: null, tokenStillValid: false, keySet: null, token: null, backend: null };
    const { header, claims } = parsed;
    const issuer = typeof claims.iss === 'string' ? Object.values(ISSUERS).find((i) => i.iss === claims.iss) ?? null : null;
    const ks = keySet(issuer ? issuer.id : null);
    const identity = Object.values(IDENTITIES).find((i) => i.subject === claims.sub && i.audience === claims.aud && issuer && i.issuer === issuer.id) ?? null;
    const rec = identity ? records[identity.id] : null;
    const key = via === 'key' && identity ? Object.values(ACCESS_KEYS).find((k) => k.principal === identity.id) ?? null : null;
    const c = {};
    c.alg = ALGS_ALLOWED.includes(header.alg);
    c.signature = c.alg && issuer !== null && header.kid === issuer.kid && signatureValid({ parsed, issuerId: issuer.id, signing });
    const cap = identity ? identity.maxLifetimeSec : MAX_LIFETIME_SEC;
    c.lifetime = isInt(claims.iat, 0, 4e9) && isInt(claims.exp, 0, 4e9) && claims.exp > claims.iat && claims.exp - claims.iat <= cap;
    c.expiry = isInt(claims.exp, 0, 4e9) && claims.exp * 1000 > nowMs;
    c.binding = identity !== null;
    c.identity_state = identity ? rec.state === 'active' : null;
    c.key_principal = via === 'key' ? (identity && key ? rec.state === 'active' : false) : null;
    c.scope = identity ? identity.scopes.includes(service) : null;
    const checks = ORDER.filter((id) => c[id] !== null).map((id) => ({ id, ok: c[id], tag: CHECK_TAG[id] }));
    const failed = checks.find((x) => !x.ok);
    const decision = failed ? 'refused' : 'allowed';
    const reason = failed ? REASON_OF[failed.id] : null;
    const tokenStillValid = ['alg', 'signature', 'lifetime', 'expiry', 'binding'].every((id) => c[id] === true);
    // Attribution to a deployment needs a verified signature and a matching identity (deck: "every request is attributed to a specific deployment").
    const deployment = c.signature && identity ? { identity: identity.id, subject: identity.subject } : null;
    let backend = null;
    if (decision === 'allowed') {
      const app = APPS[service];
      // What the gateway sends to the backend: the application's own configured credential. The workload token is not part of it.
      const toBackend = { credential: app.credentialId, kind: app.kind, headers: { 'x-gateway-credential': app.credentialId } };
      backend = { credentialId: app.credentialId, kind: app.kind, workloadTokenForwarded: JSON.stringify(toBackend).includes(parsed.signingInput) };
    }
    return {
      checks, decision, reason, status: decision === 'allowed' ? 200 : REASON_STATUS[reason], deployment, tokenStillValid, keySet: ks, backend,
      token: { header, claims, remainingSec: isInt(claims.exp, 0, 4e9) ? Math.floor(claims.exp - nowMs / 1000) : null, fingerprint: fingerprint(raw) },
    };
  }

  function record(raw, { workload, service, via, minted }, g) {
    n += 1;
    const result = {
      n, at: iso(nowMs), workload, service, via, minted, decision: g.decision, reason: g.reason, status: g.status, deployment: g.deployment,
      tokenStillValid: g.tokenStillValid, checks: g.checks, keySet: g.keySet, backend: g.backend, token: g.token,
    };
    log.push(result);
    audit.append('fedid_decision', g.deployment ? g.deployment.identity : null, {
      service, via, decision: g.decision, reason: g.reason, status: g.status, minted, subject: g.deployment ? g.deployment.subject : null, attributed: g.deployment !== null,
    });
    return result;
  }

  function stateOf() {
    const sum = summarize(log, revokes);
    return {
      now: iso(nowMs), startedAt: iso(t0), advancedSec, signing, requests: n, requestCap: REQUEST_CAP, issuerOutage: outage, issuerChanges, issuerCap: ISSUER_CAP,
      keySets: Object.fromEntries(Object.keys(ISSUERS).map((id) => [id, { ageSec: Math.floor((nowMs - fetchedAt[id]) / 1000), refreshEverySec: KEYSET_REFRESH_SEC }])),
      identities: Object.values(IDENTITIES).map((i) => ({
        id: i.id, label: i.label, platform: i.platform, issuer: ISSUERS[i.issuer].iss, subject: i.subject, audience: i.audience, scopes: [...i.scopes], maxLifetimeSec: i.maxLifetimeSec,
        state: records[i.id].state, revokedAt: records[i.id].revokedAt === null ? null : iso(records[i.id].revokedAt), revokedBy: records[i.id].revokedBy, note: records[i.id].note,
        key: Object.values(ACCESS_KEYS).find((k) => k.principal === i.id)?.id ?? null,
        summary: sum.byIdentity[i.id],
      })),
      forwardedTokens: sum.forwardedTokens,
      log: log.slice(-LOG_KEEP).map((r) => structuredClone(r)),
    };
  }

  return {
    signing,
    // One request from one workload through the gateway. Returns { ok:true, result, raw } or { ok:false, status, error }.
    request(body) {
      const p = parseRequestBody(body);
      if (p.error) return { ok: false, status: 400, error: 'bad_request', message: p.error };
      if (n >= REQUEST_CAP) return { ok: false, status: 429, error: 'request_cap', message: `this session has sent ${REQUEST_CAP} requests: Reset to start again` };
      const { workload, service, via, lifetimeSec } = p.value;
      const identity = IDENTITIES[workload];
      if (via === 'key' && !Object.values(ACCESS_KEYS).some((k) => k.principal === identity.id)) return { ok: false, status: 400, error: 'bad_request', message: 'that workload has no agent access key' };
      const { raw, minted } = platformToken(identity, lifetimeSec);
      const g = gateway(raw, { service, via });
      const result = record(raw, { workload, service, via, minted }, g);
      return { ok: true, result: structuredClone(result), raw };
    },
    // Hand a token to the gateway directly. Used by tests to present tokens the platform would never mint (tampered, expired, other algorithm).
    verifyRaw(raw, { service = 'mcp', via = 'token' } = {}) {
      const g = gateway(raw, { service, via });
      return record(raw, { workload: g.deployment ? g.deployment.identity : null, service, via, minted: false }, g);
    },
    revoke(body) {
      const p = parseRevokeBody(body);
      if (p.error) return { ok: false, status: 400, error: 'bad_request', message: p.error };
      const { workload } = p.value;
      // The operator name is judged AFTER masking: a name made only of invisible characters is empty.
      const operator = maskText(p.value.operator);
      if (operator.trim() === '') return { ok: false, status: 400, error: 'bad_request', message: FIELD_ERROR };
      if (records[workload].state !== 'active') return { ok: false, status: 409, error: 'already_revoked', message: 'that identity is already revoked' };
      const note = maskText(p.value.reason);
      Object.assign(records[workload], { state: 'revoked', revokedAt: nowMs, revokedBy: operator, note });
      revokes[workload] = { n };
      audit.append('fedid_revoke', workload, { operator, note });
      return { ok: true, identity: workload };
    },
    setIssuer(body) {
      const p = parseIssuerBody(body);
      if (p.error) return { ok: false, status: 400, error: 'bad_request', message: p.error };
      // Only a real change counts and is audited. Changes are capped per session (the whole request is refused, like the request cap), so a loop of
      // toggles cannot fill the audit trail and push the revoke entry out of it.
      if (outage !== p.value.outage) {
        if (issuerChanges >= ISSUER_CAP) return { ok: false, status: 429, error: 'issuer_cap', message: `this session has changed the issuer ${ISSUER_CAP} times: Reset to start again` };
        issuerChanges += 1; outage = p.value.outage; audit.append('fedid_issuer', null, { outage });
      }
      return { ok: true };
    },
    advance(body) {
      const p = parseAdvanceBody(body);
      if (p.error) return { ok: false, status: 400, error: 'bad_request', message: p.error };
      if (advancedSec + p.value.seconds > MAX_ADVANCE_TOTAL_SEC) return { ok: false, status: 429, error: 'time_cap', message: 'the virtual clock has moved as far as it may: Reset to start again' };
      advancedSec += p.value.seconds; nowMs += p.value.seconds * 1000;
      return { ok: true };
    },
    reset: init,
    state: stateOf,
    // The same list the Mock table is built from: every result in order (raw tokens are never kept).
    results: () => log.map((r) => structuredClone(r)),
    revokeMap: () => structuredClone(revokes),
  };
}
