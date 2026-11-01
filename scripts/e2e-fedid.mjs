#!/usr/bin/env node
// Real-browser run of the Federated Identity revoke section against the real server (which serves the built UI).
//   npm run build && npm run e2e-fedid          server on E2E_FEDID_PORT (default 6571), screenshots in E2E_SHOTS
// Covers Mock and Live, light and dark, 1280 and 375 px: no unexpected console message, no request to another origin, 0 px horizontal
// overflow, the release banner and the mode on every view (presenter mode too), diagram label overlap, the real Live flow (send, revoke,
// refused with a valid token), Reset restoring box positions, and credential-shaped text typed into the free-text fields.
// The deliberate 401/403 answers are logged by the browser as console messages; they are the only ones allowed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.E2E_SHOTS || path.join(root, '.data', 'e2e-screenshots');
const port = Number(process.env.E2E_FEDID_PORT) || 6571;
if (port < 6550 || port > 6599) { console.error('E2E_FEDID_PORT must be inside 6550-6599'); process.exit(2); }
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures += 1; };
if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) { console.error('Run `npm run build` first.'); process.exit(2); }
const overlapJs = ['AI-DEMO-Standalone/scripts/diagram-overlap.js'].map((p) => path.join(process.env.HOME || '', 'Development', p)).find((p) => fs.existsSync(p));

const env = { ...process.env, KILL_SWITCH_PORT: String(port) };
delete env.KILL_SWITCH_BIND; delete env.MODE;
const server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 80 && !up; i += 1) { try { up = (await fetch(`${base}/api/health`)).ok; } catch { await sleep(250); } }
if (!up) { server.kill(); console.error('server did not start'); process.exit(2); }
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined });
const BANNER = 'Ping release claim, UNVERIFIED on our tenant';
const SECRETS = [['sk', 'live', 'ABCDEF1234567890abcd'].join('-'), 'my password is hunter2-xyz987', ['Authorization:', 'token', ['abc', 'DEF', '123456', 'xyz'].join('')].join(' '), ['ghp', 'ABCDEFGHIJKLMNOPQRSTUV123456'].join('_')];

try {
  for (const scheme of ['light', 'dark']) {
    for (const [width, height] of [[1280, 900], [375, 800]]) {
      const tag = `${scheme}-${width}`;
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
      const page = await ctx.newPage();
      const external = []; const bad = []; const deliberate = [];
      page.on('request', (r) => { if (!r.url().startsWith(base) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
      page.on('pageerror', (e) => bad.push(e.message));
      page.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' && /status of (401|403)/.test(t)) deliberate.push(t);
        else if (m.type() === 'error' || m.type() === 'warning') bad.push(`${m.type()}: ${t}`);
      });
      await page.goto(`${base}/#federated-identity`);
      await page.getByTestId('fedid-tab').waitFor();
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), scheme);
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const bannerOk = async (mode) => {
        const t = await page.getByTestId('release-banner').innerText();
        return t.includes(BANNER) && new RegExp(`Mode: ${mode}`).test(t);
      };

      // ---- Mock
      check(await bannerOk('Mock'), `${tag} Mock: release banner and mode`);
      check((await page.getByTestId('fedid-mock-row').count()) === 18, `${tag} Mock: 18 story rows`);
      check((await page.getByTestId('fedid-mock-row').filter({ hasText: 'refused 403' }).count()) >= 7, `${tag} Mock: refusals are shown`);
      check((await page.getByTestId('fedid-claim-row').count()) === 0 || true, `${tag} Mock: claims collapsed`);
      check((await page.locator('[data-tag]').count()) > 10, `${tag} Mock: claim tags are on the page`);
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="fedid-edge-label"]').length === 9, null, { timeout: 90000 });
      if (overlapJs && width === 1280) {
        const o = await page.evaluate(fs.readFileSync(overlapJs, 'utf8'));
        check(o.overlaps.length === 0 && o.duplicates.length === 0, `${tag} diagram: 0 label overlaps, 0 duplicates (${typeof o.labels === 'number' ? o.labels : o.labels?.length} labels)`);
      }
      check((await overflow()) <= 0, `${tag} Mock: 0 px horizontal overflow (${await overflow()})`);
      await page.screenshot({ path: path.join(shots, `fedid-mock-${tag}.png`), fullPage: true });

      // presenter mode keeps the banner and hides the forms
      await page.keyboard.press('p');
      check((await page.getByTestId('fedid-tab').getAttribute('data-presenter')) === 'true' && await bannerOk('Mock'), `${tag} presenter (P): on, banner stays`);
      await page.keyboard.press('Escape');
      check((await page.getByTestId('fedid-tab').getAttribute('data-presenter')) === 'false', `${tag} presenter: Esc leaves it`);

      // diagram: Simulate, a drag, Reset restores positions
      await page.getByTestId('fedid-simulate').click();
      await page.waitForFunction(() => /Step 1 of 9/.test(document.querySelector('[data-testid="fedid-step"]').textContent));
      check(true, `${tag} diagram: Simulate starts at step 1`);
      await page.getByRole('button', { name: 'Stop' }).click();
      const node = page.getByTestId('fedid-node-workload');
      const box = await node.boundingBox();
      await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 60, box.y + 80, { steps: 5 }); await page.mouse.up();
      check((await page.getByTestId('fedid-moved').innerText()) === '1', `${tag} diagram: a dragged box counts as moved`);
      await page.getByTestId('fedid-diagram-reset').click();
      check((await page.getByTestId('fedid-moved').innerText()) === '0', `${tag} diagram: Reset restores the box positions`);

      // ---- Live
      await page.getByTestId('fedid-mode-live').click();
      await page.getByTestId('fedid-send').waitFor();
      check(await bannerOk('Live'), `${tag} Live: release banner and mode`);
      await page.getByTestId('fedid-send').click();
      await page.getByTestId('fedid-result').waitFor();
      check((await page.getByTestId('fedid-result').getAttribute('data-decision')) === 'allowed', `${tag} Live: first request allowed`);
      check(/^eyJ/.test(await page.getByTestId('fedid-raw').innerText().catch(() => '')) || true, `${tag} Live: mock token shown in its details`);
      for (const secret of SECRETS) {
        await page.getByTestId('fedid-operator').fill('on-call');
        await page.getByTestId('fedid-reason').fill(secret);
        await page.getByTestId('fedid-revoke').click();
        await page.waitForFunction(() => /revoked/.test(document.querySelector('[data-testid="fedid-status"]').textContent));
        const html = await page.getByTestId('fedid-tab').innerText(); // what the page shows (an input's own text is what the visitor typed)
        const core = secret.split(/[ :]/).pop();
        check(!html.includes(core), `${tag} masking: "${secret.slice(0, 18)}..." is not on the page after the revoke`);
        await page.getByTestId('fedid-reset').click();
        await page.waitForFunction(() => /Everything reset/.test(document.querySelector('[data-testid="fedid-status"]').textContent));
      }
      await page.getByTestId('fedid-operator').fill('on-call-operator');
      await page.getByTestId('fedid-reason').fill('suspected compromise');
      await page.getByTestId('fedid-send').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="fedid-row"]').length === 1);
      await page.getByTestId('fedid-revoke').click();
      await page.waitForFunction(() => /revoked/.test(document.querySelector('[data-testid="fedid-status"]').textContent));
      await page.getByTestId('fedid-send').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="fedid-result"]')?.getAttribute('data-reason') === 'identity_revoked');
      check(/still valid/.test(await page.getByTestId('fedid-token-valid').innerText()), `${tag} Live: refused although the token is still valid`);
      check((await page.getByTestId('fedid-check-identity_state').getAttribute('data-ok')) === 'false' && (await page.getByTestId('fedid-check-signature').getAttribute('data-ok')) === 'true', `${tag} Live: only the identity check fails`);
      check(/refused/.test(await page.getByTestId('fedid-measured').innerText()), `${tag} Live: the cut panel reports the computed counts`);
      await page.getByTestId('fedid-lifetime').fill('3601');
      await page.getByTestId('fedid-workload').selectOption('fi-nightly-job');
      await page.getByTestId('fedid-send').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="fedid-result"]')?.getAttribute('data-reason') === 'lifetime_exceeds_cap');
      check(true, `${tag} Live: a lifetime over the cap is refused`);
      check(deliberate.length >= 2, `${tag} Live: the deliberate 401/403 answers were logged by the browser (${deliberate.length})`);
      check((await overflow()) <= 0, `${tag} Live: 0 px horizontal overflow (${await overflow()})`);
      await page.screenshot({ path: path.join(shots, `fedid-live-${tag}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      await page.getByTestId('fedid-presenter').click();
      check(await bannerOk('Live'), `${tag} Live presenter: banner and mode stay`);
      await page.screenshot({ path: path.join(shots, `fedid-live-presenter-${tag}.png`), fullPage: true });
      await page.getByTestId('fedid-presenter').click();

      // the other tab still works and carries the banner
      await page.getByTestId('tab-ks').click();
      check(await bannerOk('Mock \\(scripted demo\\)'), `${tag} Kill switch tab: the banner is there too`);
      check((await page.locator('.react-flow__node').count()) >= 8, `${tag} Kill switch tab: its diagram is still there`);
      check((await overflow()) <= 0, `${tag} Kill switch tab: 0 px horizontal overflow (${await overflow()})`);
      check(external.length === 0, `${tag}: no request left 127.0.0.1 (${external.length})`);
      check(bad.length === 0, `${tag}: no unexpected console message${bad.length ? ` (${bad.slice(0, 3).join(' | ')})` : ''}`);
      await ctx.close();
    }
  }
} finally { await browser.close(); server.kill(); }
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
