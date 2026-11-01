// Red checks for the Federated Identity revoke section: change one behaviour at a time in a COPY of the repo and require the tests
// that pin it to fail. Every editable field has at least one mutant (workload, service, presents, lifetime, revoke target, operator,
// reason, outage, seconds), on the server and in the page.
// Usage: npm run red-checks-fedid   (ONLY=regex runs a subset by name). A crash or a hang counts as "caught"; the report says which tests failed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = 'server/src/fedid/engine.js';
const M = 'server/src/mask.js';
const APP = 'server/src/app.js';
const GW = 'server/src/gateway.js';
const API = ['test/masking-api.test.js'];
const J = 'server/src/fedid/jwt.js';
const T = 'server/src/fedid/tables.js';
const W = 'server/src/workspaces.js';
const WS = ['test/workspaces.test.js'];
const CAST = 'server/src/cast.js';
const CT = ['test/cast.test.js'];
const CORE = ['test/fedid.test.js', 'test/fedid-mock.test.js', 'test/fedid-api.test.js'];
const MASK = ['test/fedid-masking.test.js', '--test-name-pattern=maskText|class [ABCD]|tab, LF and CR'];
// [name, file (from the repo root), from, to, tests]. A server mutant runs `node --test` on its tests, a web mutant runs vitest on the page tests.
const MUTATIONS = [
  ['revoke does not change the identity state', E, "Object.assign(records[workload], { state: 'revoked',", "Object.assign(records[workload], { state: 'active',", CORE],
  ['identity state is not checked', E, "c.identity_state = identity ? rec.state === 'active' : null;", 'c.identity_state = identity ? true : null;', CORE],
  ['the key principal is not checked', E, "(identity && key ? rec.state === 'active' : false)", '(identity && key ? true : false)', CORE],
  ['scope is not checked', E, 'identity.scopes.includes(service)', 'true', CORE],
  ['the signature is not checked', E, 'header.kid === issuer.kid && signatureValid({ parsed, issuerId: issuer.id, signing });', 'header.kid === issuer.kid;', CORE],
  ['any algorithm is accepted', E, 'ALGS_ALLOWED.includes(header.alg)', 'true', CORE],
  ['lifetime cap off by one (< instead of <=)', E, 'claims.exp - claims.iat <= cap', 'claims.exp - claims.iat < cap', CORE],
  ['lifetime cap ignored', E, 'claims.exp - claims.iat <= cap', 'claims.exp - claims.iat <= cap * 1000', CORE],
  ['expiry is not checked', E, 'claims.exp * 1000 > nowMs', 'true', CORE],
  ['subject is matched by prefix, not exactly', E, 'i.subject === claims.sub', 'String(claims.sub).startsWith(i.subject)', CORE],
  ['audience is matched by substring, not exactly', E, 'i.audience === claims.aud', 'String(claims.aud).includes(i.audience)', CORE],
  ['issuer is not part of the binding', E, '&& issuer && i.issuer === issuer.id', '&& issuer', CORE],
  ['key set refresh boundary moved (> instead of >=)', E, '>= KEYSET_REFRESH_SEC * 1000', '> KEYSET_REFRESH_SEC * 1000', CORE],
  ['an issuer outage is ignored (the set is refreshed anyway)', E, 'if (!outage && nowMs - fetchedAt', 'if (nowMs - fetchedAt', CORE],
  ['a refusal with a bad signature is still attributed', E, 'c.signature && identity ? {', 'identity ? {', CORE],
  ['the workload token is forwarded to the backend', E, 'const toBackend = { credential: app.credentialId,', 'const toBackend = { token: raw, credential: app.credentialId,', CORE],
  ['the raw token is kept in the log', E, 'fingerprint: fingerprint(raw) }', 'fingerprint: raw }', CORE],
  ['request cap off by one (> instead of >=)', E, 'if (n >= REQUEST_CAP)', 'if (n > REQUEST_CAP)', CORE],
  ['a held token is reused although the lifetime field changed', E, 'h.lifetimeSec === lifetimeSec', 'true', CORE],
  ['the lifetime field is ignored', E, 'lifetimeSec: b.lifetimeSec ?? DEFAULT_LIFETIME_SEC', 'lifetimeSec: DEFAULT_LIFETIME_SEC', CORE],
  ['the service field is ignored', E, "const g = gateway(raw, { service, via });\n      const result", "const g = gateway(raw, { service: 'mcp', via });\n      const result", CORE],
  ['the presents field is ignored', E, "const g = gateway(raw, { service, via });\n      const result", "const g = gateway(raw, { service, via: 'token' });\n      const result", CORE],
  ['the workload field is ignored', E, 'const identity = IDENTITIES[workload];', "const identity = IDENTITIES['fi-billing-agent'];", CORE],
  ['the revoke target field is ignored', E, 'const { workload } = p.value;', "const workload = 'fi-billing-agent';", CORE],
  ['a second revoke succeeds', E, "if (records[workload].state !== 'active') return {", 'if (false) return {', CORE],
  ['the outage field is ignored', E, 'outage = p.value.outage;', 'outage = false;', CORE],
  ['the advance seconds field is ignored', E, 'nowMs += p.value.seconds * 1000;', 'nowMs += 1000;', CORE],
  ['the virtual clock has no total limit', E, 'advancedSec + p.value.seconds > MAX_ADVANCE_TOTAL_SEC', 'false', CORE],
  ['the refused status is answered 200 by the engine', E, "status: decision === 'allowed' ? 200 : REASON_STATUS[reason],", 'status: 200,', CORE],
  ['Reset does not reset the Federated Identity engine', 'server/src/runtime.js', '      fedid.reset();\n', '', CORE],
  ['the HTTP answer is always 200', 'server/src/fedid/routes.js', 'res.status(out.result.status).json({ mode', 'res.status(200).json({ mode', CORE],
  ['the hosted build serves Live', 'server/src/fedid/routes.js', '(runtime.hosted ? hostedRefusal(res) : handler(req, res))', 'handler(req, res)', CORE],
  ['the story timing changed (Mock table drift)', 'server/src/fedid/story.js', "const req = (workload, service, via, say, afterSec = 2) =>", "const req = (workload, service, via, say, afterSec = 3) =>", CORE],
  // ---- the review of 2026-11-01: the mutants that survived, and the fixes ----
  ['summary: the last request before the revoke is counted as after it', E, 'mine.filter((r) => r.n > rec.n)', 'mine.filter((r) => r.n >= rec.n)', CORE],
  ["tokenStillValid ignores the binding check", E, "['alg', 'signature', 'lifetime', 'expiry', 'binding'].every", "['alg', 'signature', 'lifetime', 'expiry'].every", CORE],
  ['an expired token is answered 403, not 401', T, 'token_expired: 401,', 'token_expired: 403,', CORE],
  ['the audit is written on every redundant issuer toggle', E, "audit.append('fedid_issuer', null, { outage });\n      }", "audit.append('fedid_issuer', null, { outage });\n      } else audit.append('fedid_issuer', null, { outage });", CORE],
  ['lifetime: exp before iat is accepted', E, 'claims.exp > claims.iat && ', '', CORE],
  ['parseToken: the part length bound is removed', J, 'p.length > MAX_PART || ', '', CORE],
  ['parseToken: the part count is not checked', J, 'parts.length !== 3 || ', '', CORE],
  ['the key principal ignores whether the key exists', E, "(identity && key ? rec.state === 'active' : false)", "(identity ? rec.state === 'active' : false)", CORE],
  ['issuer cap removed', E, 'if (issuerChanges >= ISSUER_CAP)', 'if (false)', CORE],
  ['issuer cap off by one', E, 'issuerChanges >= ISSUER_CAP', 'issuerChanges > ISSUER_CAP', CORE],
  ['the operator is judged before masking only (an invisible-only name is accepted)', E, "if (operator.trim() === '') return", 'if (false) return', CORE],
  ['workspaces: the oldest workspace is evicted at the cap', W, 'if (live.size >= cap) return null;', 'if (live.size >= cap) live.delete(live.keys().next().value);', WS],
  ['workspaces: an idle workspace is never dropped', W, 't - v.at > idleMs', 'false', WS],
  ['workspaces: a recently used workspace is dropped', W, 't - v.at > idleMs', 't - v.at >= 0', WS],
  // ---- the masking sweep of 2026-11-01 (classes A-F): the masker, the older endpoints and the HTTP edges ----
  ['the operator is stored unmasked', E, 'const operator = maskText(p.value.operator);', 'const operator = String(p.value.operator);', ['test/fedid-api.test.js', 'test/fedid.test.js', ...API]],
  ['the reason is stored unmasked', E, 'const note = maskText(p.value.reason);', 'const note = String(p.value.reason);', ['test/fedid-api.test.js', 'test/fedid.test.js', ...API]],
  ['masking: NFKC fold removed', M, ".normalize('NFKC')", '', MASK],
  ['masking: invisible characters kept', M, ".replace(STRIP, '')", '', MASK],
  ['masking: C0 controls NUL to BS not deleted', M, 'const CONTROL = /[\\u0000-\\u0008\\u000B', 'const CONTROL = /[\\u0009-\\u0008\\u000B', MASK],
  ['masking: the C1 range is not deleted (U+0085 survives)', M, '\\u007F-\\u009F]/g; // C0 and C1', '\\u007F-\\u0084]/g; // C0 and C1', MASK],
  ['masking: DEL is not deleted', M, '\\u000E-\\u001F\\u007F-\\u009F]/g; // C0 and C1', '\\u000E-\\u001F\\u0080-\\u009F]/g; // C0 and C1', MASK],
  ['masking: U+2028/2029 are deleted, not read as separators', M, ".replace(/[\\u2028\\u2029]/g, ctl)", ".replace(/[\\u2028\\u2029]/g, '')", MASK],
  ['masking: the deleting reading is dropped (controls always become a space)', M, "const deleted = look(prepare(input, ''));", "const deleted = look(prepare(input, ' '));", MASK],
  ['masking: the spacing reading is dropped', M, "const spaced = look(prepare(input, ' '));", "const spaced = look(prepare(input, ''));", MASK],
  ['masking: the spacing reading wins ties', M, 'marks(spaced) > marks(deleted)', 'marks(spaced) >= marks(deleted)', MASK],
  ['masking: the less-masked reading wins', M, 'marks(spaced) > marks(deleted)', 'marks(spaced) < marks(deleted)', MASK],
  ['masking: percent-decoding removed', M, 'for (let i = 0; i < 3; i += 1) { const d', 'for (let i = 0; i < 0; i += 1) { const d', MASK],
  ['masking: percent-decoding twice, not three times', M, 'for (let i = 0; i < 3; i += 1) { const d', 'for (let i = 0; i < 2; i += 1) { const d', MASK],
  ['masking: tab, LF and CR are not deleted in the second look', M, "[[/[\\t\\n\\r]/g, ''],", "[[/(?!)/g, ''],", MASK],
  ['masking: a plus sign is not read as a space', M, ", [/\\+/g, ' ']];", ', [/(?!)/g, " "]];', MASK],
  ['masking: whitespace is not collapsed', M, ".replace(/\\s+/g, ' ').trim()", '.trim()', MASK],
  ['masking: the result is not trimmed', M, ".replace(/\\s+/g, ' ').trim()", ".replace(/\\s+/g, ' ')", MASK],
  ['masking: other types are echoed as text', M, "if (typeof input !== 'string') return '';", 'input = String(input);', MASK],
  ['masking: an input over the raw limit is looked at', M, 'if (input.length > MAX_RAW) return MARK;', '', MASK],
  ['masking: the raw limit moved by one', M, 'input.length > MAX_RAW', 'input.length >= MAX_RAW', MASK],
  ['masking: the older redactor net removed', M, 'const detect = (text) => redactText(DETECTORS', 'const detect = (text) => (DETECTORS', MASK],
  ['masking (B): the keyword + plain space rule needs no digit', M, '(?=[^\\\\s,;&}\\\\])]{0,300}\\\\d)', '', MASK],
  ['masking (B): the plain-space value may be 5 characters', M, '[^\\\\s,;&}\\\\])]{6,300}`;', '[^\\\\s,;&}\\\\])]{5,300}`;', MASK],
  ['masking (B): the plain-space value must be 7 characters', M, '[^\\\\s,;&}\\\\])]{6,300}`;', '[^\\\\s,;&}\\\\])]{7,300}`;', MASK],
  ['masking (B): "api key" is not a strong keyword', M, "const STRONG = 'passphrase|password|passwd|pwd|pw|secret|token|api[-_ ]?key|apikey|", "const STRONG = 'passphrase|password|passwd|pwd|pw|secret|token|apikey|", MASK],
  ['masking (B): "pw" is not a strong keyword', M, "const STRONG = 'passphrase|password|passwd|pwd|pw|secret|", "const STRONG = 'passphrase|password|passwd|pwd|secret|", MASK],
  ['masking (B): "secret" is not a strong keyword', M, "pwd|pw|secret|token|api[-_ ]?key|apikey|credential|private[-_ ]?key|access[-_ ]?key|session[-_ ]?id';\nconst QUOTED", "pwd|pw|token|api[-_ ]?key|apikey|credential|private[-_ ]?key|access[-_ ]?key|session[-_ ]?id';\nconst QUOTED", MASK],
  ['masking (B): the bare "key is" rule removed', M, '(?<![A-Za-z])(keys?)(\\\\s{1,20}is', '(?<![A-Za-z])(keyzz)(\\\\s{1,20}is', MASK],
  ['masking (B): "token was" is masked like "token is"', M, "(tokens?|private[-_ ]?key|access[-_ ]?key|session[-_ ]?id)(\\\\s{1,20}is\\\\s{1,20})", "(tokens?|private[-_ ]?key|access[-_ ]?key|session[-_ ]?id)(\\\\s{1,20}(?:is|was)\\\\s{1,20})", MASK],
  ['masking (B): "password is" not caught', M, '(?:is|was|are)\\\\s{1,20})(?:${VALUE})', '(?:iz|waz|arz)\\\\s{1,20})(?:${VALUE})', MASK],
  ['masking (B): a quoted value is cut at its first word', M, "const QUOTED = '\"[^\"]{0,300}\"|", "const QUOTED = '(?!)|", MASK],
  ['masking (C): URL userinfo with a scheme kept', M, '  [/(:\\/\\/)[^\\s/?#@]{1,200}@/g, (m, a) => `${a}${MARK}@`],\n', '', MASK],
  ['masking (C): userinfo without a scheme kept', M, "  [/(?<![\\w.%+-])(?!mailto:)[\\w.%+-]{1,200}:[^\\s/?#@:]{1,200}@(?=[A-Za-z0-9[])/gi, () => `${MARK}@`],\n", '', MASK],
  ['masking (C): an e-mail address after mailto: is masked', M, '(?!mailto:)', '', MASK],
  ['masking (D): a JSON-quoted key is not followed', M, '([\\\\w-]{0,30}["\']?\\\\s{0,20}(?:=>|->|[:=])\\\\s{0,20})(?:${VALUE})`, \'gi\'), (m, k, sep) => `${k}${sep}${MARK}`],\n  // plain language', '([\\\\w-]{0,30}\\\\s{0,20}(?:=>|->|[:=])\\\\s{0,20})(?:${VALUE})`, \'gi\'), (m, k, sep) => `${k}${sep}${MARK}`],\n  // plain language', MASK],
  ['masking: the Authorization rule without a colon removed', M, "  [/\\b(?:proxy-)?authorization\\b[^\\r\\n]{1,300}/gi, (m0) => `${m0.match(/^[A-Za-z-]+/)[0]} ${MARK}`],\n", '', MASK],
  ['masking: the long-blob rule removed', M, '  [/[A-Za-z0-9+/_=-]{32,}/g, () => MARK],\n', '', MASK],
  ['masking: the short-prefix rule removed', M, "  [/\\b(?:sk|pk|rk|tok|token|key|secret|pat|ghp|gho|ghu|ghs|github_pat|glpat|xox[a-z]|npm|pypi|hf|api|bearer)[-_][A-Za-z0-9_-]{6,}/gi, () => MARK],\n", '', MASK],
  ['the gateway stores the operator name unmasked', GW, "const who = (operator) => maskText(operator) || 'operator';", "const who = (operator) => String(operator || 'operator');", API],
  ['the gateway stores the reason unmasked', GW, 'const note = (n) => maskText(n);', 'const note = (n) => String(n ?? \'\');', API],
  ['unrevoke judges the name before masking', APP, "maskText(body.operator) === ''", "body.operator.trim() === ''", API],
  ['kill/unrevoke: the name limit is 41', APP, 'optString(body.operator, 40)', 'optString(body.operator, 41)', API],
  ['kill/unrevoke: the name limit is 39', APP, 'optString(body.operator, 40)', 'optString(body.operator, 39)', API],
  ['kill/unrevoke: the reason limit is 201', APP, 'optString(body.reason, 200)', 'optString(body.reason, 201)', API],
  ['kill/unrevoke: the reason limit is 199', APP, 'optString(body.reason, 200)', 'optString(body.reason, 199)', API],
  ['fedid revoke: the name limit is 41', E, 'b.operator.length > 40) return', 'b.operator.length > 41) return', [...CORE, ...API]],
  ['fedid revoke: the reason limit is 201', E, 'b.reason.length > 200)', 'b.reason.length > 201)', [...CORE, ...API]],
  ['E: GET /api/state answers 404, not 405', APP, "api.route('/state').get((_req, res) => res.json(runtime.snapshot())).all(methods('GET'));", "api.route('/state').get((_req, res) => res.json(runtime.snapshot()));", API],
  ['E: /api/kill answers 404, not 405, to GET', APP, "res.json({ mode: runtime.mode, ...r, state: runtime.snapshot() });\n    }).all(methods('POST'));\n    api.route('/unrevoke')", "res.json({ mode: runtime.mode, ...r, state: runtime.snapshot() });\n    });\n    api.route('/unrevoke')", API],
  ['E: /api/unrevoke answers 404, not 405, to GET', APP, "res.json({ mode: runtime.mode, ...r, state: runtime.snapshot() });\n    }).all(methods('POST'));\n\n    api.route('/events')", "res.json({ mode: runtime.mode, ...r, state: runtime.snapshot() });\n    });\n\n    api.route('/events')", API],
  ['E: /api/reset answers 404, not 405', APP, "res.json({ ok: true, mode: runtime.mode });\n    }).all(methods('POST'));", "res.json({ ok: true, mode: runtime.mode });\n    });", API],
  ['E: /api/events answers 404, not 405', APP, "res.json({ mode: runtime.mode, ...runtime.events.list({ since, limit }) });\n    }).all(methods('GET'));", "res.json({ mode: runtime.mode, ...runtime.events.list({ since, limit }) });\n    });", API],
  ['E: /api/agents answers 404, not 405', APP, "models: MODELS, tools: TOOLS })).all(methods('GET'));", 'models: MODELS, tools: TOOLS }));', API],
  ['E: /api/scenarios answers 404, not 405', APP, "scenarios: runtime.scenarios.map(describeScenario) })).all(methods('GET'));", 'scenarios: runtime.scenarios.map(describeScenario) }));', API],
  ['E: the 405 carries no Allow header', APP, "res.set('Allow', allow).status(405)", 'res.status(405)', API],
  ['E: the final JSON 404 is removed (Express HTML 404 echoes the path)', APP, "  app.use((_req, res) => bad(res, 'no such endpoint', 404));\n  app.use((err,", '  app.use((err,', API],
  ['E: the catch-all error handler is removed', APP, "  app.use((err, _req, res, _next) => (err instanceof URIError || err.status === 400 ? bad(res, 'malformed request') : res.status(500).json({ error: 'server_error' })));\n", '', API],
  ['E: a body that is not JSON echoes it', APP, "if (err.type === 'entity.parse.failed') return bad(res, 'request body is not valid JSON');", "if (err.type === 'entity.parse.failed') return bad(res, `request body is not valid JSON: ${err.body}`);", API],
  ['E: static dotfiles are served', APP, "dotfiles: 'ignore'", "dotfiles: 'allow'", ['test/static.test.js']],
  // ---- {{cast}} tokens and the vertical packs (rules 10 and 12) ----
  ['cast: any string is accepted as a vertical (a prototype name gets through)', CAST, 'Object.hasOwn(VERTICALS, id) ? id', 'id in VERTICALS ? id', CT],
  ['cast: the Mock table is served with its tokens left in', 'server/src/fedid/routes.js', 'table: fillDeep(MOCK, castFor(req).cast)', 'table: MOCK', CT],
  ['cast: customer.config values are not cut at 40 characters', CAST, '.trim().slice(0, MAX_CAST)', '.trim()', CT],
  ['cast: a host label with a dot is accepted from customer.config', CAST, "if (short === 'host' && clean.includes('.')) continue;", '', CT],
  ['cast: a URL-looking value is accepted from customer.config', CAST, String.raw`if (/:\/\/|@|`, 'if (/(?!)|@|', CT],
  ['cast: the story ignores the chosen pack', 'server/src/fedid/routes.js', 'story: storyFor(cast).map', 'story: storyFor(VERTICALS.finance).map', CT],
  // ---- the page (vitest on web/src/test/fedid.test.jsx) ----
  ['page: workload field not sent', 'web/src/components/FedIdTab.jsx', 'workload: form.workload, service: form.service, via: form.via,', 'workload: "fi-billing-agent", service: form.service, via: form.via,', 'web'],
  ['page: service field not sent', 'web/src/components/FedIdTab.jsx', 'service: form.service, via: form.via, lifetimeSec: form.lifetime', 'service: "mcp", via: form.via, lifetimeSec: form.lifetime', 'web'],
  ['page: presents field not sent', 'web/src/components/FedIdTab.jsx', 'via: form.via, lifetimeSec: form.lifetime', 'via: "token", lifetimeSec: form.lifetime', 'web'],
  ['page: lifetime field not sent', 'web/src/components/FedIdTab.jsx', 'lifetimeSec: form.lifetime === "" ? undefined : Number(form.lifetime)', 'lifetimeSec: undefined', 'web'],
  ['page: revoke target not sent', 'web/src/components/FedIdTab.jsx', 'workload: form.target, operator: form.operator', 'workload: "fi-billing-agent", operator: form.operator', 'web'],
  ['page: operator not sent', 'web/src/components/FedIdTab.jsx', 'operator: form.operator, reason: form.reason', 'operator: "x", reason: form.reason', 'web'],
  ['page: reason not sent', 'web/src/components/FedIdTab.jsx', 'operator: form.operator, reason: form.reason', 'operator: form.operator, reason: ""', 'web'],
  ['page: outage checkbox not sent', 'web/src/components/FedIdTab.jsx', 'postFedidIssuer({ outage })', 'postFedidIssuer({ outage: true })', 'web'],
  ['page: seconds field not sent', 'web/src/components/FedIdTab.jsx', 'seconds: Number(form.seconds)', 'seconds: 1', 'web'],
  ['page: a late state read overwrites a newer result (stale guard removed)', 'web/src/components/FedIdTab.jsx', 'if (my === seq.current) { setLive(r.state); setLast(null); }', 'if (true) { setLive(r.state); setLast(null); }', 'web'],
  ['page: presenter key fires while typing in a field', 'web/src/App.jsx', 'if (/^(input|textarea|select)$/i.test(', 'if (false && /^(input|textarea|select)$/i.test(', 'web'],
  ['page: the banner words differ from the server\'s', 'web/src/App.jsx', 'export const RELEASE_BANNER = "Ping release claim, UNVERIFIED on our tenant";', 'export const RELEASE_BANNER = "Simulated";', 'web'],
  ['page: Live is selectable in the hosted build', 'web/src/components/FedIdTab.jsx', 'disabled={hosted} data-testid="fedid-mode-live"', 'data-testid="fedid-mode-live"', 'web'],
  ['page: Reset does not call the page-wide reset', 'web/src/components/FedIdTab.jsx', 'await onReset(); setStatus', 'setStatus', 'web'],
  ['page: the cut panel counts allowed instead of refused', 'web/src/components/FedIdParts.jsx', '{a.refused} of {a.requests} requests from this identity were refused', '{a.allowed} of {a.requests} requests from this identity were refused', 'web'],
  ['page: a late answer for an older vertical wins (stale guard removed)', 'web/src/components/FedIdTab.jsx', 'if (!alive) return;\n      setCat(c); setMock(m.table);', 'setCat(c); setMock(m.table);', 'web'],
  ['page: the chosen vertical is not sent', 'web/src/components/FedIdTab.jsx', 'Promise.all([getFedid(vertical), getFedidMock(vertical)])', 'Promise.all([getFedid("finance"), getFedidMock("finance")])', 'web'],
  ['page: a name the visitor typed is overwritten when the pack changes', 'web/src/components/FedIdTab.jsx', 'f.operator === before ? {', 'true ? {', 'web'],
  ['page: the claims table leaves out the roadmap rows', 'web/src/components/FedIdTab.jsx', '    ...cat.roadmap.map((r) => ({ id: r.id,', '    ...[].map((r) => ({ id: r.id,', 'web'],
];

const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-redfed-'));
const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
const runServer = (tests) => spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...tests], { cwd: path.join(copy, 'server'), encoding: 'utf8' });
const runWeb = () => spawnSync(path.join(root, 'node_modules/.bin/vitest'), ['run', 'src/test/fedid.test.jsx'], { cwd: path.join(copy, 'web'), encoding: 'utf8' });
let bad = 0;
try {
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'));
  for (const d of ['server', 'web']) fs.cpSync(path.join(root, d), path.join(copy, d), { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes('/dist') });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'web/node_modules'));
  const base = runServer(CORE);
  console.log(`${base.status === 0 ? 'PASS' : 'FAIL'}  baseline server tests (unmutated) exit ${base.status}`);
  const baseWeb = runWeb();
  console.log(`${baseWeb.status === 0 ? 'PASS' : 'FAIL'}  baseline page tests (unmutated) exit ${baseWeb.status}`);
  if (base.status !== 0 || baseWeb.status !== 0) process.exit(1);
  for (const [name, file, from, to, tests] of MUTATIONS.filter((m) => !only || only.test(m[0]))) {
    const p = path.join(copy, file);
    const orig = fs.readFileSync(p, 'utf8');
    const n = orig.split(from).length - 1;
    if (n !== 1) { console.log(`FAIL  ${name}: pattern found ${n} times in ${file}, expected exactly 1`); bad++; continue; }
    fs.writeFileSync(p, orig.replace(from, () => to));
    const r = tests === 'web' ? runWeb() : runServer(tests);
    fs.writeFileSync(p, orig);
    const caught = r.status !== 0;
    if (!caught) bad++;
    const failing = [...new Set((r.stdout.match(/^ *[✖×] .+?(?= \(|$)/gm) || []).map((l) => l.trim()))].length;
    console.log(`${caught ? 'PASS' : 'FAIL'}  ${name}: ${caught ? `tests failed (${failing} distinct failing)` : 'TESTS STILL PASSED, nothing pins this'}`);
  }
} finally { fs.rmSync(copy, { recursive: true, force: true }); }
console.log(bad ? `${bad} mutation(s) not caught` : `all ${MUTATIONS.filter((m) => !only || only.test(m[0])).length} mutations caught`);
process.exit(bad ? 1 : 0);
