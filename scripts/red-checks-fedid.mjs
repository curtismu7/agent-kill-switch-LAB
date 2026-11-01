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
const M = 'server/src/fedid/mask.js';
const CORE = ['test/fedid.test.js', 'test/fedid-mock.test.js', 'test/fedid-api.test.js'];
const MASK = ['test/fedid-masking.test.js', '--test-name-pattern=maskText'];
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
  ['the operator is stored unmasked', E, 'const operator = maskText(p.value.operator, 40);', 'const operator = String(p.value.operator).slice(0, 40);', ['test/fedid-api.test.js', 'test/fedid.test.js']],
  ['the reason is stored unmasked', E, 'const note = maskText(p.value.reason, 200);', 'const note = String(p.value.reason).slice(0, 200);', ['test/fedid-api.test.js', 'test/fedid.test.js']],
  ['a second revoke succeeds', E, "if (records[workload].state !== 'active') return {", 'if (false) return {', CORE],
  ['the outage field is ignored', E, 'outage = p.value.outage;', 'outage = false;', CORE],
  ['the advance seconds field is ignored', E, 'nowMs += p.value.seconds * 1000;', 'nowMs += 1000;', CORE],
  ['the virtual clock has no total limit', E, 'advancedSec + p.value.seconds > MAX_ADVANCE_TOTAL_SEC', 'false', CORE],
  ['the refused status is answered 200 by the engine', E, "status: decision === 'allowed' ? 200 : REASON_STATUS[reason],", 'status: 200,', CORE],
  ['Reset does not reset the Federated Identity engine', 'server/src/runtime.js', '      fedid.reset();\n', '', CORE],
  ['the HTTP answer is always 200', 'server/src/fedid/routes.js', 'res.status(out.result.status).json({ mode', 'res.status(200).json({ mode', CORE],
  ['the hosted build serves Live', 'server/src/fedid/routes.js', '(runtime.hosted ? hostedRefusal(res) : handler(req, res))', 'handler(req, res)', CORE],
  ['the story timing changed (Mock table drift)', 'server/src/fedid/story.js', "const req = (workload, service, via, say, afterSec = 2) =>", "const req = (workload, service, via, say, afterSec = 3) =>", CORE],
  ['masking: NFKC fold removed', M, ".normalize('NFKC')", '', MASK],
  ['masking: invisible characters kept', M, "unseen.replace(STRIP, '')", 'unseen', MASK],
  ['masking: percent-decoding removed', M, 'let s = percentDecode(', 'let s = (', MASK],
  ['masking: plain-language secrets not caught', M, '    .replace(SAID, MARK)\n', '', MASK],
  ['masking: URL userinfo kept', M, '    .replace(USERINFO, `://${MARK}@`)\n', '', MASK],
  ['masking: truncates before it masks', M, 'const unseen = value.length > HARD_LIMIT ? value.slice(0, HARD_LIMIT) : value;', 'const unseen = value.slice(0, max);', MASK],
  ['masking: short prefixed tokens kept', M, '    .replace(PREFIXED, MARK)\n', '', MASK],
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
