// Red checks for the web UI: break one behaviour at a time in a COPY of web/ and require vitest to fail.
// Usage: npm run red-checks-web
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUTATIONS = [
  ['Unrevoke skips the confirm step', 'components/KillPanel.jsx', 'onClick={() => setAsking(true)} disabled={busy || !stopped}', 'onClick={() => onUnrevoke()} disabled={busy || !stopped}'],
  ['Confirm works without an operator name', 'components/KillPanel.jsx', 'disabled={busy || !operator.trim()} autoFocus', 'disabled={busy} autoFocus'],
  ['Unrevoke is offered for a running agent', 'components/KillPanel.jsx', 'disabled={busy || !stopped}', 'disabled={busy}'],
  ['Kill drops the operator name', 'App.jsx', 'operator: operator.trim() || "operator", reason: reason || undefined, inFlight', 'reason: reason || undefined, inFlight'],
  ['money gauge shows spend instead of what is left', 'components/Gauges.jsx', 'const fill = burn ? pct(left, max) : pct(now, max);', 'const fill = pct(now, max);'],
  ['rate gauge cell count ignores the cap', 'components/Gauges.jsx', 'Array.from({ length: max }', 'Array.from({ length: max + 1 }'],
  ['a kill revokes every agent\'s tokens in the token list', 'lib/derive.js', '(e.agentId === null || k.agentId === e.agentId)', '(true)'],
  ['an unrevoke un-revokes tokens', 'lib/derive.js', 'else if (e.type === "trip" || e.type === "kill") {', 'else if (e.type === "unrevoke") { for (const k of tokens) k.revokedAt = null; } else if (e.type === "trip" || e.type === "kill") {'],
  ['a trip is not announced', 'lib/derive.js', 'if (e.type === "trip") return', 'if (false) return'],
  ['gap ignores the first refusal', 'lib/derive.js', 'g.firstDeniedAt = t(e.at); g.cause = e.data.reason; open.delete(key);', 'g.cause = e.data.reason;'],
  ['hostile text is injected as HTML', 'components/Feed.jsx', '<span className="txt">{d.text}</span>', '<span className="txt" dangerouslySetInnerHTML={{ __html: d.text }} />'],
  ['revoked token not marked revoked', 'lib/derive.js', 'k.revokedAt !== null ? "revoked"', 'false ? "revoked"'],
  ['the diagram does not show where a call stopped', 'components/Flow.jsx', 'bad: !!active && path.bad === n.id', 'bad: false'],
  // ---- KS2 ----
  ['Kill is disabled while a request is in flight', 'components/KillPanel.jsx', 'onClick={onKill} disabled={a.state === "killed"}', 'onClick={onKill} disabled={busy || a.state === "killed"}'],
  ['Kill ALL is disabled while a request is in flight', 'components/KillPanel.jsx', 'disabled={global.state === "killed"}>Kill ALL', 'disabled={busy || global.state === "killed"}>Kill ALL'],
  ['skip link to the kill switch points nowhere', 'App.jsx', 'href="#kill-h"', 'href="#nowhere"'],
  ['the kill heading cannot take focus', 'components/KillPanel.jsx', '<h2 id="kill-h" tabIndex={-1}>', '<h2 id="kill-h">'],
  ['diagram boxes are tab stops again', 'components/Flow.jsx', 'nodesFocusable={false} ', ''],
  ['Reset does not remount the diagram', 'components/Flow.jsx', '<ReactFlow key={resetKey} ', '<ReactFlow '],
  ['Simulate resets over an operator kill', 'App.jsx', '(snap?.operatorKills?.length ?? 0) > 0', 'false'],
  ['any 409 on Step is reported as a finished run', 'App.jsx', 'e.code === "run_finished"', 'e.status === 409'],
  ['the feed is an ordered list with role=log again', 'components/Feed.jsx', '<div className="feed" role="log" tabIndex={0}', '<div className="feed" role="log"'],
  ['edges keep animating under reduced motion', 'app.css', 'animation: none; }', 'animation: dashdraw 1s infinite; }'],
];
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-redweb-'));
const web = path.join(copy, 'web');
const run = () => spawnSync(path.join(root, 'node_modules/.bin/vitest'), ['run'], { cwd: web, encoding: 'utf8' });
let bad = 0;
try {
  fs.cpSync(path.join(root, 'web'), web, { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes('/dist') });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(web, 'node_modules'));
  const base = run();
  console.log(`${base.status === 0 ? 'PASS' : 'FAIL'}  baseline vitest (unmutated) exits ${base.status}`);
  if (base.status !== 0) process.exit(1);
  for (const [name, file, from, to] of MUTATIONS) {
    const p = path.join(web, 'src', file);
    const orig = fs.readFileSync(p, 'utf8');
    const n = orig.split(from).length - 1;
    if (n !== 1) { console.log(`FAIL  ${name}: pattern found ${n} times in ${file}, expected exactly 1`); bad++; continue; }
    fs.writeFileSync(p, orig.replace(from, () => to));
    const r = run();
    fs.writeFileSync(p, orig);
    const caught = r.status !== 0;
    if (!caught) bad++;
    console.log(`${caught ? 'PASS' : 'FAIL'}  ${name}: ${caught ? 'vitest failed' : 'VITEST STILL PASSED, no test pins this'}`);
  }
} finally { fs.rmSync(copy, { recursive: true, force: true }); }
console.log(bad ? `${bad} mutation(s) not caught` : `all ${MUTATIONS.length} UI mutations caught`);
process.exit(bad ? 1 : 0);
