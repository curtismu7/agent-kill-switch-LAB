// Red checks: remove or invert one safety check at a time in a COPY of the server and require the test suite to fail.
// Usage: npm run red-checks   (slow: it runs the server suite once per mutation; wait for a quiet machine)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUTATIONS = [
  ['rate cap compares > instead of >=', 'gateway.js', 'if (a.window.length >= rate.max) {', 'if (a.window.length > rate.max) {'],
  ['rate window keeps a call exactly windowMs old', 'gateway.js', 'a.window = a.window.filter((t) => t > now - rate.windowMs);', 'a.window = a.window.filter((t) => t >= now - rate.windowMs);'],
  ['money cap allows going over by one unit (>=)', 'gateway.js', 'a.usage.micros + cost > budget.maxMicros', 'a.usage.micros + cost >= budget.maxMicros'],
  ['token cap trips one early (>=)', 'gateway.js', 'a.usage.tokens + tokenCount > budget.maxTokens', 'a.usage.tokens + tokenCount >= budget.maxTokens'],
  ['kill-switch state is not checked per call', 'gateway.js', 'if (cfg.flagCheck) {', 'if (false) {'],
  ['revoked token is accepted (introspect)', 'gateway.js', ": token.revokedAt !== null;", ': false;'],
  ['local mode never refreshes its revocation list', 'gateway.js', 'now - lastSync >= cfg.revocationSyncMs', 'false'],
  ['token expiry boundary moved by one ms', 'gateway.js', 'now >= token.expiresAt', 'now > token.expiresAt'],
  ['unrevoke is not audited', 'gateway.js', "audit.append('unrevoke', a.id, data);", 'void data;'],
  ['kill is not audited', 'gateway.js', "audit.append('kill', a.id, data);", 'void data;'],
  ['every trip auto-resets, cost trips included', 'gateway.js', "a.limits.autoReset && reason === 'rate_cap'", 'a.limits.autoReset'],
  ['stopping one agent revokes everyone\'s tokens (blast radius)', 'gateway.js', 'const revoked = tokens.revoke(a.id);', 'const revoked = tokens.revoke(null);'],
  ['stopping an agent leaves token issuance open', 'gateway.js', '    tokens.disable(a.id);\n    return { from', '    return { from'],
  ['a refused call is still charged', 'gateway.js', "if (a.state === 'reset') { a.state = 'armed'; a.reason = null; }", "a.usage.micros += cost; if (a.state === 'reset') { a.state = 'armed'; a.reason = null; }"],
  ['kill id is not resolved like the gate id', 'policy.js', 'if (k === PLACEHOLDER_AGENT) return Object.keys(AGENTS)[0];', ''],
  ['unrevoke does not need an operator name', 'app.js', "kind === 'unrevoke' && (typeof body.operator !== 'string' || body.operator.trim() === '')", 'false'],
  ['Origin check removed (cross-origin kill and unrevoke accepted)', 'safety.js', 'if (origin !== undefined) {', 'if (false) {'],
  ['Sec-Fetch-Site cross-site check removed', 'safety.js', "=== 'cross-site') return refuse", "=== 'never') return refuse"],
  ['JSON-only body check removed', 'safety.js', 'if (hasBody && !/^application', 'if (false && !/^application'],
  ['Host guard accepts any host', 'safety.js', '!parseHost(req.headers.host)', 'false'],
  ['credential headers accepted', 'safety.js', 'CREDENTIAL_HEADERS.some(', 'CREDENTIAL_HEADERS.every('],
  ['audit hash chain not verified', 'audit.js', 'if (e.prevHash !== prev)', 'if (false)'],
  ['access token value leaks into events', 'runtime.js', "tokenId: t.tokenId, ttlMs", 'tokenId: t.token, ttlMs'],
];

const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-red-'));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'));
const run = () => spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(copy, 'server/test')).filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`)], { cwd: path.join(copy, 'server'), encoding: 'utf8' });
let bad = 0;
try {
  fs.cpSync(path.join(root, 'server'), path.join(copy, 'server'), { recursive: true, filter: (s) => !s.includes('node_modules') });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
  const base = run();
  console.log(`${base.status === 0 ? 'PASS' : 'FAIL'}  baseline suite (unmutated) exits ${base.status}`);
  if (base.status !== 0) process.exit(1);
  for (const [name, file, from, to] of MUTATIONS) {
    const p = path.join(copy, 'server/src', file);
    const orig = fs.readFileSync(p, 'utf8');
    const n = orig.split(from).length - 1;
    if (n !== 1) { console.log(`FAIL  ${name}: pattern found ${n} times in ${file}, expected exactly 1`); bad++; continue; }
    fs.writeFileSync(p, orig.replace(from, () => to));
    const r = run();
    fs.writeFileSync(p, orig);
    const caught = r.status !== 0;
    if (!caught) bad++;
    const failing = (r.stdout.match(/^✖ .+? \(/gm) || []).filter((l, i, a) => a.indexOf(l) === i).length;
    console.log(`${caught ? 'PASS' : 'FAIL'}  ${name}: ${caught ? `suite failed (${failing} distinct failing tests)` : 'SUITE STILL PASSED, no test pins this'}`);
  }
} finally { fs.rmSync(copy, { recursive: true, force: true }); }
console.log(bad ? `${bad} mutation(s) not caught` : `all ${MUTATIONS.length} mutations caught`);
process.exit(bad ? 1 : 0);
