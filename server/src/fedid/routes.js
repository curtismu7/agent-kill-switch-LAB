// /api/fedid/*  (mounted by app.js, one router per workspace runtime)
//   GET  /                catalogue: banner, claims with their tags, the story, the limits
//   GET  /diagram         the diagram-studio/1 diagram, by name
//   GET  /mock            the generated Mock table (read-only; the same for everybody)
//   GET  /state           the Live engine's state
//   POST /request         one workload request through the gateway (Live)  -> 200 allowed, 401 token not acceptable, 403 refused
//   POST /revoke          revoke a Federated Identity (Live)               -> 200, 409 already revoked
//   POST /issuer          issuer outage on or off (Live)
//   POST /advance         move the virtual clock (Live)
// A refused request is answered with the real refusal status, not 200 with a flag: the browser logs those 4xx as console messages.
// Every message is a fixed string; nothing the caller typed is echoed. The Live endpoints are refused in the hosted mock build.
import express from 'express';
import { DIAGRAM_NAMES, buildDiagram } from './diagram.js';
import {
  ALL_CLAIMS, BANNER, BANNER_DETAIL, DECK, FACTS, INVENTED, LEDE, NOT_SAID, READINGS, ROADMAP, SWAGGER, TAGS, WHY,
} from './facts.js';
import { loadMock } from './mock.js';
import { STORY } from './story.js';
import { ACCESS_KEYS, APPS, DEFAULT_LIFETIME_SEC, IDENTITIES, ISSUER_CAP, ISSUERS, KEYSET_REFRESH_SEC, MAX_LIFETIME_SEC, REQUEST_CAP, SERVICES, VIAS } from './tables.js';
import { MAX_ADVANCE_TOTAL_SEC } from './engine.js';

const MOCK = loadMock();
const methods = (allow) => (_req, res) => res.set('Allow', allow).status(405).json({ error: 'method_not_allowed' });

export const catalogue = () => ({
  deck: DECK, banner: BANNER, bannerDetail: BANNER_DETAIL, lede: LEDE, tags: TAGS,
  facts: FACTS, swagger: SWAGGER, readings: READINGS, invented: INVENTED, notSaid: NOT_SAID, roadmap: ROADMAP, why: WHY, claimCount: ALL_CLAIMS.length,
  story: STORY.map((s, i) => ({ step: i + 1, ...s })),
  services: SERVICES, vias: VIAS, apps: Object.values(APPS), accessKeys: Object.values(ACCESS_KEYS),
  identities: Object.values(IDENTITIES).map((i) => ({ id: i.id, label: i.label, platform: i.platform, issuer: ISSUERS[i.issuer].iss, subject: i.subject, audience: i.audience, scopes: i.scopes })),
  limits: { defaultLifetimeSec: DEFAULT_LIFETIME_SEC, maxLifetimeSec: MAX_LIFETIME_SEC, keySetRefreshSec: KEYSET_REFRESH_SEC, requestCap: REQUEST_CAP, issuerCap: ISSUER_CAP, maxAdvanceTotalSec: MAX_ADVANCE_TOTAL_SEC, maxAdvanceSec: 86_400 },
});

export function fedidRoutes(runtime) {
  const r = express.Router();
  const e = () => runtime.fedid;
  const hostedRefusal = (res) => res.status(403).json({ error: 'live_not_available_in_hosted_mock', message: 'the hosted mock build has no Live mode: use the Mock table' });
  const live = (handler) => (req, res) => (runtime.hosted ? hostedRefusal(res) : handler(req, res));
  const fail = (res, out) => res.status(out.status).json({ error: out.error, message: out.message });

  r.route('/').get((_req, res) => res.json(catalogue())).all(methods('GET'));
  r.route('/diagram').get((_req, res) => res.json(buildDiagram(DIAGRAM_NAMES[0]))).all(methods('GET'));
  r.route('/mock').get((_req, res) => res.json({ mode: 'mock', source: 'generated table', table: MOCK })).all(methods('GET'));
  r.route('/state').get(live((_req, res) => res.json({ mode: 'live', state: e().state() }))).all(methods('GET'));

  r.route('/request').post(live((req, res) => {
    const out = e().request(req.body);
    if (!out.ok) return fail(res, out);
    // The raw token is mock-issued, signed with a throwaway local key, and appears only in this one answer (never in the state, log or audit).
    res.status(out.result.status).json({ mode: 'live', result: { ...out.result, token: { ...out.result.token, raw: out.raw, rawLabel: 'mock-issued: valid only inside this demo' } }, state: e().state() });
  })).all(methods('POST'));

  r.route('/revoke').post(live((req, res) => {
    const out = e().revoke(req.body);
    if (!out.ok) return fail(res, out);
    res.json({ mode: 'live', ok: true, identity: out.identity, state: e().state() });
  })).all(methods('POST'));

  r.route('/issuer').post(live((req, res) => {
    const out = e().setIssuer(req.body);
    if (!out.ok) return fail(res, out);
    res.json({ mode: 'live', ok: true, state: e().state() });
  })).all(methods('POST'));

  r.route('/advance').post(live((req, res) => {
    const out = e().advance(req.body);
    if (!out.ok) return fail(res, out);
    res.json({ mode: 'live', ok: true, state: e().state() });
  })).all(methods('POST'));

  return r;
}
