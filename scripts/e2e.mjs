#!/usr/bin/env node
// Real-browser run of the web UI against the real server, which serves the UI itself (server/src/index.js).
//
//   npm run build            (once; the server serves web/dist)
//   npm run e2e              starts the server on E2E_PORT (default 6570), drives it, stops it
//   E2E_SHOTS=/some/dir      where screenshots go (default .data/e2e-screenshots, git-ignored)
//
// Uses the Chromium the installed Playwright resolves (`npx playwright install chromium` if missing). The run makes no
// request to any other origin; that is one of the checks.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.E2E_SHOTS || path.join(root, '.data', 'e2e-screenshots');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures += 1; };

const port = Number(process.env.E2E_PORT) || 6570;
if (port < 6550 || port > 6599) { console.error('E2E_PORT must be inside 6550-6599'); process.exit(2); }
const base = `http://127.0.0.1:${port}`;
if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) { console.error('Run `npm run build` first.'); process.exit(2); }
const env = { ...process.env, KILL_SWITCH_PORT: String(port) };
delete env.KILL_SWITCH_BIND;
const server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
let up = false;
for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${base}/api/health`)).ok; } catch { await sleep(250); } }
if (!up) { server.kill(); console.error('server did not start'); process.exit(2); }
fs.mkdirSync(shots, { recursive: true });
const api = async (p, init) => (await fetch(`${base}${p}`, init)).json();

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined });
try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const external = []; const errors = [];
  page.on('request', (r) => { if (!r.url().startsWith(base) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
  const active = () => page.evaluate(() => `${document.activeElement?.tagName}|${document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim().slice(0, 40)}`);
  const statusText = () => page.getByTestId('run-status').innerText();
  const progress = () => page.getByTestId('progress').innerText();
  const waitStatus = (re) => page.waitForFunction((s) => new RegExp(s).test(document.querySelector('[data-testid="run-status"]').textContent), re.source, { timeout: 20000 });
  const pill = (agent) => page.locator(`[data-testid="switch-${agent}"] .pill`).innerText();
  const pick = (id) => page.selectOption('[data-testid="scenario-select"]', id);
  const reset = async () => { await page.getByRole('button', { name: 'Reset', exact: true }).click(); await waitStatus(/Everything reset/); };

  await page.goto(`${base}/`);
  await page.getByTestId('mode-badge').waitFor();
  await page.getByTestId('gauges-agent-alpha').waitFor();
  check((await page.getByTestId('mode-badge').innerText()).includes('DEMO'), 'header shows the DEMO badge');
  check((await page.getByText('MODEL, UNVERIFIED').count()) > 0, 'MODEL / UNVERIFIED badges are shown where product behaviour is described');
  const csp = (await (await fetch(`${base}/`)).headers.get('content-security-policy')) || '';
  check(/script-src 'self'/.test(csp) && /connect-src 'self'/.test(csp) && !/unsafe-eval/.test(csp), 'the page is served with a same-origin CSP');
  check((await page.locator('.react-flow__node').count()) === 8, 'the diagram shows eight boxes');

  // Keyboard only: skip link, then Tab to Run and press Enter on the default scenario.
  await page.keyboard.press('Tab');
  check((await active()).includes('Skip to content'), 'first Tab stop is the skip link');
  let reached = false;
  for (let i = 0; i < 20 && !reached; i++) { await page.keyboard.press('Tab'); reached = (await active()).endsWith('|Run'); }
  check(reached, 'Tab reaches the Run button');
  await page.keyboard.press('Enter');
  await waitStatus(/Ran "Normal agent"/);
  check(/Reached the expected end state/.test(await statusText()), `keyboard Run: "${await statusText()}"`);
  check((await page.getByTestId('run-status').getAttribute('aria-live')) === 'polite', 'run status region is aria-live');

  // Keyboard only: Tab on to the Kill button of agent alpha and press Enter. Normal run leaves alpha armed.
  let onKill = false;
  for (let i = 0; i < 90 && !onKill; i++) { await page.keyboard.press('Tab'); onKill = (await active()).endsWith('|Kill agent-alpha'); }
  check(onKill, 'Tab reaches the Kill button for alpha');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Killed/.test(document.querySelector('[data-testid="switch-agent-alpha"] .pill').textContent));
  check(/Killed/.test(await pill('agent-alpha')), 'keyboard Kill: alpha is Killed');
  check((await page.getByTestId('stop-alert').getAttribute('role')) === 'alert' && /agent-alpha killed by on-call-operator/.test(await page.getByTestId('stop-alert').innerText()), 'the kill is announced in an alert region');
  check(/armed|Armed/.test(await pill('agent-beta')), 'blast radius: beta is still armed');
  check(/alpha stopped; beta keeps working/.test(await page.getByTestId('blast-verdict').innerText()), 'blast-radius verdict names the one stopped agent');

  // Unrevoke needs a confirm step and is audited.
  const sw = page.getByTestId('switch-agent-alpha');
  await sw.getByRole('button', { name: 'Unrevoke' }).click();
  check((await sw.getByRole('alertdialog').count()) === 1, 'Unrevoke asks for confirmation first');
  check(/Killed/.test(await pill('agent-alpha')), 'still killed before the confirm');
  await sw.getByRole('button', { name: 'Cancel' }).click();
  check(/Killed/.test(await pill('agent-alpha')), 'Cancel changes nothing');
  await sw.getByRole('button', { name: 'Unrevoke' }).click();
  await sw.getByRole('button', { name: 'Confirm unrevoke' }).click();
  await page.waitForFunction(() => /Reset/.test(document.querySelector('[data-testid="switch-agent-alpha"] .pill').textContent));
  check(/Reset/.test(await pill('agent-alpha')), 'after the confirm alpha is Reset');
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await page.waitForFunction(() => /Chain intact/.test(document.querySelector('[data-testid="verify-result"]').textContent));
  check((await page.locator('[data-testid="audit-list"] li[data-type="unrevoke"]').count()) >= 1, 'the unrevoke is in the audit trail');
  check(/Chain intact/.test(await page.getByTestId('verify-result').innerText()), 'Verify reports an intact chain');

  // Every scenario, run from the UI.
  const ids = await page.$$eval('[data-testid="scenario-select"] option', (o) => o.map((x) => x.value));
  check(ids.length === 9, `nine scenarios are offered (${ids.length})`);
  for (const id of ids) {
    await reset();
    await pick(id);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await waitStatus(/^Ran /);
    const sum = await page.getByTestId('expect-summary').innerText();
    check(/Expected end state reached/.test(sum), `scenario ${id}: ${sum}`);
    if (id === 'rate-loop') { check(/Tripped/.test(await pill('agent-alpha')), 'rate-loop: alpha Tripped'); await shot('rate-loop-light'); }
    if (id === 'cost-expensive') check(/cost cap/.test(await pill('agent-alpha')), 'cost-expensive: tripped by the cost cap');
    if (id === 'manual-kill') { check(/Killed/.test(await pill('agent-alpha')), 'manual-kill: alpha Killed'); check(/500 ms/.test(await page.getByTestId('gap-summary').innerText()), 'manual-kill: gap of 500 ms drawn'); }
    if (id === 'stale-token-gap') {
      check(/20 s[\s\S]*3 calls got through/.test(await page.getByTestId('gap-summary').innerText()), 'stale-token-gap: 20 s gap, 3 calls leaked');
      check((await page.locator('[data-testid="tokens"] li.revoked').count()) >= 1, 'stale-token-gap: a revoked token is marked in the token list');
      await shot('stale-token-gap-light');
    }
    if (id === 'blast-radius') { check(/Killed/.test(await pill('agent-alpha')) && /Armed/.test(await pill('agent-beta')), 'blast-radius: alpha Killed, beta Armed'); await shot('blast-radius-light'); }
    if (id === 'in-flight') check(/AFTER the stop/.test(await page.getByTestId('feed').innerText()), 'in-flight: the call that finished after the stop is shown');
  }

  // Step, then Simulate with a kill pulled part-way.
  await reset();
  await pick('normal');
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await page.waitForFunction(() => /step 1 of 6/.test(document.querySelector('[data-testid="progress"]')?.textContent || ''));
  check(/step 1 of 6/.test(await progress()), 'Step performs one action');
  await page.getByLabel('Speed').selectOption('4');
  await page.getByRole('button', { name: 'Simulate' }).click();
  await page.waitForFunction(() => /step [3-5] of 6/.test(document.querySelector('[data-testid="progress"]')?.textContent || ''));
  await page.getByRole('button', { name: 'Kill agent-alpha' }).click();
  await page.waitForFunction(() => /finished/.test(document.querySelector('[data-testid="progress"]')?.textContent || ''), null, { timeout: 20000 });
  check(/Killed/.test(await pill('agent-alpha')), 'kill pulled during Simulate: alpha Killed');
  check((await page.locator('[data-testid="feed"] li.call_denied').count()) >= 1, 'the calls after the kill are refused in the live feed');
  check(/you intervened/.test(await page.getByTestId('expect-summary').innerText()), 'the end-state check says the operator intervened');
  await shot('manual-kill-simulate-light');

  // Global kill and unrevoke.
  await reset();
  await page.getByRole('button', { name: 'Kill ALL agents' }).click();
  await page.waitForFunction(() => /ALL AGENTS/.test(document.querySelector('[data-testid="feed"]')?.textContent || ''));
  check(/global switch is on/.test(await page.getByTestId('blast-verdict').innerText()), 'global kill: the wide blast radius is explained');
  await page.getByRole('button', { name: 'Unrevoke all' }).click();
  await page.getByTestId('global-switch').getByRole('button', { name: 'Confirm unrevoke' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="global-switch"] .s-killed'));
  check(true, 'global unrevoke (after confirm) clears the global switch');

  // Dark theme and the final state, screenshots.
  await reset(); await pick('stale-token-gap');
  await page.getByRole('button', { name: 'Run', exact: true }).click(); await waitStatus(/^Ran /);
  await page.getByRole('button', { name: /theme/ }).click();
  check((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'theme toggle switches to dark');
  await shot('stale-token-gap-dark');
  await pick('rate-loop'); await page.getByRole('button', { name: 'Run', exact: true }).click(); await waitStatus(/Ran "Loop/);
  await shot('rate-loop-dark');

  // Mobile width: no horizontal scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const sw390 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(sw390.sw <= sw390.iw, `no horizontal scroll at 390px (scrollWidth ${sw390.sw}, innerWidth ${sw390.iw})`);
  await shot('mobile-390-dark');
  await page.getByRole('button', { name: /theme/ }).click();
  await sleep(200);
  const sw390l = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(sw390l.sw <= sw390l.iw, `no horizontal scroll at 390px, light (scrollWidth ${sw390l.sw})`);
  await shot('mobile-390-light');

  check(external.length === 0, `no request left ${base} (${external.length}${external.length ? `: ${external.slice(0, 3).join(', ')}` : ''})`);
  check(errors.length === 0, `no console errors or warnings (${errors.length}${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''})`);

  // A page on another origin cannot kill: a simple cross-origin POST is refused and changes nothing.
  await reset();
  const other = await ctx.newPage();
  await other.goto('about:blank');
  const sent = await other.evaluate(async (b) => {
    const out = [];
    for (const [url, init] of [['/api/kill', { scope: 'global' }], ['/api/unrevoke', { scope: 'global', operator: 'x' }]]) {
      try { const r = await fetch(b + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init) }); out.push(r.status); } catch { out.push('blocked'); }
      try { await fetch(b + url, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(init) }); out.push('sent'); } catch { out.push('blocked'); }
    }
    return out;
  }, base);
  const st = await api('/api/state');
  check(st.global.state === 'armed' && st.agents.every((a) => a.state === 'armed'), `a page on another origin could not kill (${sent.join(',')}); everything is still armed`);
  await other.close();
} catch (e) {
  failures += 1; console.error('FAIL  e2e crashed:', e.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
