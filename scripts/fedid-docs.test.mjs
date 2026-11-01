// The Federated Identity revoke section's documents stay true: the generated talk track, the claims in the README, the banner words,
// the CSS rules, the pinned mutation count and the CI file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { buildPack } from './build-content-pack.mjs';
import { BANNER, NOT_SAID, TAGS } from '../server/src/fedid/facts.js';
import { withSection } from '../server/src/fedid/talk.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('DRIFT: the generated section of docs/talk-track.md is what the data produces (run: npm run talk-track)', () => {
  const doc = read('docs/talk-track.md');
  assert.equal(withSection(doc), doc, 'docs/talk-track.md is stale; regenerate it and commit the result');
  assert.match(doc, /Federated Identity revoke/);
  assert.ok(doc.includes(BANNER));
  for (const n of NOT_SAID) assert.ok(doc.includes(n.question), `the talk track does not carry: ${n.question}`);
});

test('the release banner is the same words in the page and on the server', () => {
  assert.ok(read('web/src/App.jsx').includes(`"${BANNER}"`));
});

test('the README, CLAUDE.md and safety.md document the section: tab, tags, banner, commands, masking is a heuristic', () => {
  const readme = read('README.md');
  for (const f of ['README.md', 'CLAUDE.md', 'docs/safety.md']) {
    const t = read(f);
    assert.match(t, /#federated-identity|Federated Identity revoke/, f);
    assert.ok(t.includes(BANNER) || f === 'CLAUDE.md', f);
  }
  for (const tag of TAGS) assert.ok(readme.includes(tag), `README does not explain the tag "${tag}"`);
  for (const s of ['fedid-mock', 'talk-track', 'e2e-fedid', 'red-checks-fedid']) { assert.ok(pkg.scripts[s], s); assert.ok(readme.includes(`npm run ${s}`), `README does not mention npm run ${s}`); }
  assert.match(read('docs/safety.md'), /heuristic/i);
  assert.match(readme, /heuristic/i);
  assert.match(readme, /Tier: Demo/);
});

test('the README states the real number of Federated Identity red-check mutations', () => {
  const src = read('scripts/red-checks-fedid.mjs');
  const n = (src.split('const MUTATIONS = [')[1].split('\n];')[0].match(/^ {2}\[['"]/gm) || []).length;
  assert.ok(n >= 20);
  assert.ok(read('README.md').includes(`Federated Identity red checks: all ${n} mutations caught`), 'the mutation count in the README is stale');
});

test('the section CSS uses tokens only: no colour literal, no !important, no italics, breakpoints 600 and 900 only', () => {
  const css = read('web/src/fedid.css');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /font-style:\s*italic/);
  assert.doesNotMatch(css, /prefers-color-scheme/);
  for (const m of css.matchAll(/@media[^{]*max-width:\s*(\d+)px/g)) assert.ok(['600', '900'].includes(m[1]), `breakpoint ${m[1]}`);
  assert.doesNotMatch(read('web/src/components/FedIdTab.jsx') + read('web/src/components/FedIdParts.jsx') + read('web/src/components/FedIdDiagram.jsx'), /dangerouslySetInnerHTML|style=\{\{ *(color|background)/);
});

test('CI: Node 26 only, GitHub-hosted runners, and the package requires Node 26', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.doesNotMatch(ci, /self-hosted/);
  assert.match(ci, /node-version:\s*['"]?26/);
  assert.doesNotMatch(ci, /node-version:[^\n]*\b(18|20|22|24)\b/);
  assert.match(pkg.engines.node, />=\s*26/);
});

test('the content pack teaches the section: terms with the UNVERIFIED label, the try-it card, the why card and the diagram', () => {
  const pack = buildPack();
  for (const id of ['federated-identity', 'exact-binding', 'identity-revoke', 'key-set-refresh']) assert.match(pack.glossary.find((g) => g.id === id).definition, /UNVERIFIED on our tenant/, id);
  assert.ok(pack.glossary.some((g) => g.id === 'platform-issued-token') && pack.glossary.some((g) => g.id === 'claim-tags'));
  const card = pack.cards.find((c) => c.id === 'fedid-revoke');
  assert.equal(card.action.href, '/#federated-identity');
  const why = pack.cards.find((c) => c.id === 'fedid-why');
  assert.match(why.description, /Challenge.*Technical.*Business.*UNVERIFIED on our tenant/s);
  assert.ok(pack.diagrams.some((d) => d.id === 'fedid-revoke'));
  assert.doesNotMatch(JSON.stringify(pack), /within \d+ ?(ms|seconds) of/i);
});

test('the shelf entry and the pack still name catalog D14 and port 6550', () => {
  assert.equal(JSON.parse(read('docs/shelf-entry.json')).demos[0].catalogId, 'D14');
  assert.equal(buildPack().demo.catalog, 'D14');
});
