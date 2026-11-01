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
  ['unrevoke does not need an operator name', 'app.js', "kind === 'unrevoke' && (typeof body.operator !== 'string' || maskText(body.operator) === '')", 'false'],
  ['Origin check removed (cross-origin kill and unrevoke accepted)', 'safety.js', 'if (origin !== undefined) {', 'if (false) {'],
  ['Sec-Fetch-Site cross-site check removed', 'safety.js', "=== 'cross-site') return refuse", "=== 'never') return refuse"],
  ['JSON-only body check removed', 'safety.js', 'if (hasBody && !/^application', 'if (false && !/^application'],
  ['Host guard accepts any host', 'safety.js', '!parseHost(req.headers.host, publicHost)', 'false'],
  ['credential headers accepted', 'safety.js', 'CREDENTIAL_HEADERS.some(', 'CREDENTIAL_HEADERS.every('],
  ['audit entry hashes not verified (edited entries pass)', 'audit.js', 'if (a.length !== b.length || !crypto.timingSafeEqual(a, b))', 'if (false)'],
  ['UI is served without the same-origin CSP', 'app.js', "'Content-Security-Policy': UI_CSP", "'X-Foo': UI_CSP"],
  ['live clock lets real time flow into a run', 'clock.js', 'now: () => t,', "now: () => (fake ? t : t + (Date.now() - (globalThis.__ksStart ??= Date.now()))),"],
  ['access token value leaks into events', 'runtime.js', "tokenId: t.tokenId, ttlMs", 'tokenId: t.token, ttlMs'],
  // ---- KS2 ----
  ['a scenario may start over an operator kill (silent unrevoke)', 'runtime.js', "const blocked = killInForce();\n      if (blocked) return blocked;\n      startRun(s);\n      while", "startRun(s);\n      while"],
  ['stepping may start a scenario over an operator kill', 'runtime.js', "        const blocked = killInForce();\n        if (blocked) return blocked;\n        startRun(s);", "        startRun(s);"],
  ['audit stamped with scenario time instead of wall time', 'runtime.js', 'now: () => new Date(wallNow())', 'now: () => new Date(clock.now())'],
  ['model lookup via in (prototype names admitted)', 'gateway.js', "typeof model !== 'string' || !Object.hasOwn(MODELS, model)", '!(model in MODELS)'],
  ['tool lookup via in (prototype names admitted)', 'gateway.js', "typeof input.tool !== 'string' || !Object.hasOwn(TOOLS, input.tool)", '!(input.tool in TOOLS)'],
  ['model not required to be a string', 'gateway.js', "typeof model !== 'string' || !Object.hasOwn(MODELS, model)", '!Object.hasOwn(MODELS, model)'],
  ['auto-reset re-opens issuance during a global kill', 'gateway.js', "if (global.state !== 'killed') tokens.enable(a.id);", 'tokens.enable(a.id);'],
  ['token budget allows one token over', 'gateway.js', 'a.usage.tokens + tokenCount > budget.maxTokens', 'a.usage.tokens + tokenCount > budget.maxTokens + 1'],
  ['trip counter not incremented', 'gateway.js', 'a.trips += 1;', ''],
  ['a killed agent can be downgraded to tripped', 'gateway.js', "if (a.state === 'tripped' || a.state === 'killed') return; // already", 'if (false) return; // already'],
  ['global kill revokes only alpha\'s tokens', 'gateway.js', 'const revoked = tokens.revoke(null);', "const revoked = tokens.revoke('agent-alpha');"],
  ['token store cap removed', 'tokens.js', '      trim();', '      void 0;'],
  ['audit eviction not counted', 'audit.js', 'evicted += 1;', ''],
  ['audit list ignores after', 'audit.js', 'e.seq > after', 'true'],
  ['audit sequence check removed', 'audit.js', 'if (e.seq !== expectSeq) return', 'if (false) return'],
  ['audit anchor check removed', 'audit.js', 'if (store.length && store[0].seq !== anchor.seq + 1) return', 'if (false) return'],
  ['agent id not NFKC-folded', 'policy.js', ".normalize('NFKC')", ''],
  ['agent id length bound removed', 'policy.js', 'input.length > 64', 'input.length > 640'],
  ['clock accepts negative time', 'clock.js', '|| ms < 0', ''],
  ['clock accepts NaN', 'clock.js', '!Number.isFinite(ms) ||', ''],
  ['the first token refusal does not stand', 'runtime.js', ': { ...r, refusedBy: again.reason }', ': { ...again }'],
  ['Host guard without the loopback check', 'safety.js', 'if (!m || !isLoopbackHost(m[1])) return null;', 'if (!m) return null;'],
  ['PUT is treated as a read method', 'safety.js', "new Set(['GET', 'HEAD', 'OPTIONS'])", "new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'])"],
  ['chunked body not detected', 'safety.js', " || req.headers['transfer-encoding'] !== undefined", ''],
  ['JSON content type loosened', 'safety.js', '/^application\\/json\\s*(;|$)/i', '/json/i'],
  ['cross-site reads of the API allowed', 'safety.js', "if (site && site !== 'same-origin'", "if (false && site !== 'same-origin'"],
  ['x-powered-by re-enabled', 'app.js', "app.disable('x-powered-by');", ''],
  ['inFlight unchecked at the edge', 'app.js', "kind === 'kill' && body.inFlight !== undefined && body.inFlight !== 'finish' && body.inFlight !== 'cancel'", 'false'],
  ['events: strings not redacted', 'events.js', 'revealText(redactText(v), 300)', 'revealText(v, 300)'],
  ['events: strings not made inert or bounded', 'events.js', 'revealText(redactText(v), 300)', 'redactText(v)'],
  ['events: string bound removed', 'events.js', 'revealText(redactText(v), 300)', 'revealText(redactText(v), 3000000)'],
  ['sanitize: length bound removed', 'sanitize.js', 's.length > max ?', 'false ?'],
  ['redaction: JWT pattern removed', 'redaction.js', 'LINE:eyJ[A-Za-z0-9_-]{5,}', ''],
  ['redaction: AWS key pattern removed', 'redaction.js', 'LINE:(?:AKIA|ASIA)', ''],
  ['redaction: PEM pattern removed', 'redaction.js', 'LINE:-----BEGIN (', ''],
  ['redaction: sk-/ghp-/xox pattern removed', 'redaction.js', 'LINE:(?:sk|pk|ghp|gho|xox', '    .replace(/(?!)/g, MARK);'],
  ['redaction: URL query secret kept', 'redaction.js', 'if (SECRET_KEY.test(key)) url.searchParams.delete(key);', 'void key;'],
  ['redaction: URL userinfo kept', 'redaction.js', "url.username = '';", ''],
];

const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-red-'));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'));
const run = () => spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...fs.readdirSync(path.join(copy, 'server/test')).filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`)], { cwd: path.join(copy, 'server'), encoding: 'utf8' });
let bad = 0;
try {
  fs.cpSync(path.join(root, 'server'), path.join(copy, 'server'), { recursive: true, filter: (s) => !s.includes('node_modules') });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
  const base = run();
  console.log(`${base.status === 0 ? 'PASS' : 'FAIL'}  baseline suite (unmutated) exits ${base.status}`);
  if (base.status !== 0) process.exit(1);
  const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null; // e.g. ONLY=KS2|redaction to run a subset
  for (const [name, file, from, to] of MUTATIONS.filter((m) => !only || only.test(m[0]))) {
    const p = path.join(copy, 'server/src', file);
    const orig = fs.readFileSync(p, 'utf8');
    let mutated;
    let n;
    if (from.startsWith('LINE:')) { // replace the one whole line that contains the text after LINE:
      const needle = from.slice(5);
      const lines = orig.split('\n');
      const hits = lines.map((l, i) => (l.includes(needle) ? i : -1)).filter((i) => i >= 0);
      n = hits.length;
      if (n === 1) { lines[hits[0]] = to; mutated = lines.join('\n'); }
    } else { n = orig.split(from).length - 1; if (n === 1) mutated = orig.replace(from, () => to); }
    if (n !== 1) { console.log(`FAIL  ${name}: pattern found ${n} times in ${file}, expected exactly 1`); bad++; continue; }
    fs.writeFileSync(p, mutated);
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
