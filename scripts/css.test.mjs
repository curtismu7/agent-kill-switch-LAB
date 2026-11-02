// The CSS standard (STANDALONE-CSS-STANDARD.md) and the dark-mode control contrast rule, pinned: the shared stylesheet is vendored byte-for-byte and loaded
// first, the app stylesheets write no colour and do not restyle the shared controls, and the contrast of the shared tokens the controls use is computed, not assumed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SHARED = read('web/src/styles/standalone-ui.css');
const APP = read('web/src/app.css');
const FEDID = read('web/src/fedid.css');

const lum = (hex) => { const n = hex.replace('#', ''); const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// The token values of one theme block of the shared stylesheet.
const block = (start) => { const i = SHARED.indexOf(start); assert.ok(i >= 0, start); return SHARED.slice(i, SHARED.indexOf('\n}', i)); };
const tokens = (text) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
const LIGHT = tokens(block(':root {'));
const DARK = { ...LIGHT, ...tokens(block(':root[data-theme="dark"] {')) };

test('the shared stylesheet is vendored, and loads before the app stylesheets', () => {
  const canon = new URL('../../AI-DEMO-Standalone/shared/standalone-ui.css', import.meta.url);
  if (fs.existsSync(canon)) assert.equal(SHARED, fs.readFileSync(canon, 'utf8'), 'the vendored copy drifted from AI-DEMO-Standalone/shared/standalone-ui.css');
  const main = read('web/src/main.jsx');
  assert.ok(main.indexOf('standalone-ui.css') >= 0 && main.indexOf('standalone-ui.css') < main.indexOf('app.css') && main.indexOf('app.css') < main.indexOf('fedid.css'), 'order: shared, app, section');
});

test('controls: the border the shared stylesheet gives every input, select and button is 3:1 or more against the surface and the page, in light and dark', () => {
  for (const [name, t] of [['light', LIGHT], ['dark', DARK]]) {
    assert.ok(ratio(t.border, t.surface) >= 3, `${name}: border on surface ${ratio(t.border, t.surface).toFixed(2)}`);
    assert.ok(ratio(t.border, t.bg) >= 3, `${name}: border on page ${ratio(t.border, t.bg).toFixed(2)}`);
    assert.ok(ratio(t['on-accent'], t.accent) >= 4.5, `${name}: text on the accent`);
    assert.ok(ratio(t['on-accent'], t['accent-deep']) >= 4.5, `${name}: text on the deep accent (the kill button)`);
  }
  assert.match(SHARED, /input,\s*textarea,\s*select,\s*button\s*\{[^}]*border:\s*1px solid var\(--border\)/);
});

test('the app stylesheets do not restyle the shared controls: no border, background or colour on a bare input, select, textarea or button selector', () => {
  for (const [name, css] of [['app.css', APP], ['fedid.css', FEDID]]) {
    for (const m of css.matchAll(/(^|\})\s*([^{}@]+)\{([^}]*)\}/g)) {
      const sel = m[2].trim();
      if (!/(^|[\s,>+~])(input|select|textarea|button)(\[[^\]]*\])?\s*(,|$)/.test(sel)) continue;
      assert.doesNotMatch(m[3], /(^|[;\s])(border|border-color|background|background-color|color)\s*:/, `${name}: "${sel}" restyles a shared control`);
    }
  }
  assert.doesNotMatch(APP, /^\.btn\s*\{[^}]*(border|background|color)\s*:/m, '.btn is size only; the shared button supplies the border and colours');
  assert.doesNotMatch(APP, /^\.banner\s*\{/m, 'the shared .banner is not redefined');
  assert.doesNotMatch(APP + FEDID, /:focus-visible/, 'the shared focus ring is not replaced');
});

test('the line colour every panel, input and table uses IS the shared border token, so the new section\'s fields get the same 3:1 border', () => {
  assert.match(APP, /--line:\s*var\(--border\)/);
  assert.match(APP, /--ink:\s*var\(--text\)/);
});

test('no colour literal, no !important, no italics, no prefers-color-scheme in either app stylesheet; empty states are plain text', () => {
  for (const css of [APP, FEDID]) {
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    assert.doesNotMatch(css, /!important/);
    assert.doesNotMatch(css, /font-style:\s*italic/);
    assert.doesNotMatch(css, /prefers-color-scheme/);
  }
  assert.match(APP, /^\.empty\s*\{[^}]*\}/m);
});
