import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { PACK_PATH, buildPack, serialize } from './build-content-pack.mjs';
import { validatePack } from './validate-content-pack.mjs';

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

test('content-pack.json is exactly what the generator produces (run: npm run content-pack)', () => {
  assert.equal(fs.readFileSync(PACK_PATH, 'utf8'), serialize(buildPack()), 'content-pack.json is stale; regenerate it and commit the result');
});

test('the generator is deterministic', () => assert.equal(serialize(buildPack()), serialize(buildPack())));

test('content-pack.json validates against docs/content-pack.schema.json', () => {
  assert.deepEqual(validatePack(JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'))), []);
});

test('the validator rejects a broken pack', () => {
  const pack = buildPack();
  pack.cards[0].terms = ['no-such-term'];
  delete pack.title;
  assert.ok(validatePack(pack).length >= 2);
});

test('the schema copy is the Learning Hub schema, byte for byte, when that repo is beside this one', (t) => {
  const hub = new URL('../../learning-hub/server/schema/content-pack.schema.json', import.meta.url);
  if (!fs.existsSync(hub)) return t.skip('learning-hub not present');
  assert.equal(read('../docs/content-pack.schema.json'), fs.readFileSync(hub, 'utf8'));
});

test('the pack covers the app: caps, kill, revoke, trip, gap, in-flight, blast radius, unrevoke, CSRF, audit, inert text, demo mode', () => {
  const pack = buildPack();
  for (const id of ['kill-switch', 'revoke', 'rate-cap', 'cost-cap', 'sliding-window', 'trip', 'agent-state', 'short-lived-token', 'revocation-gap', 'in-flight', 'blast-radius', 'unrevoke', 'auto-reset', 'csrf-guard', 'audit-trail', 'inert-text', 'demo-mode']) assert.ok(pack.glossary.some((g) => g.id === id), id);
  assert.deepEqual(pack.sources, []);
  assert.equal(pack.demo.baseUrl, 'http://localhost:6550');
  assert.equal(pack.demo.catalog, 'D14');
});

test('every scenario in the app has a card that teaches it', () => {
  const ids = [...read('../server/src/scenarios.js').matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1]);
  const text = JSON.stringify(buildPack().cards);
  for (const id of ids) if (id !== 'normal' && id !== 'auto-reset') assert.ok(text.includes(id), `no card mentions scenario ${id}`);
});

test('content claims about product behaviour are labelled: no claim about real defaults, limits or latency; UNVERIFIED stated', () => {
  const pack = buildPack();
  const text = JSON.stringify(pack);
  assert.match(pack.glossary.find((g) => g.id === 'demo-mode').definition, /UNVERIFIED against product documentation/);
  assert.match(pack.glossary.find((g) => g.id === 'kill-switch').definition, /UNVERIFIED against product documentation/);
  assert.match(pack.glossary.find((g) => g.id === 'demo-mode').definition, /no claim about real product defaults, limits or latency/);
  assert.doesNotMatch(text, /PingOne (?:always|guarantees|defaults to)|within \d+ ?(?:ms|seconds) of/i);
});

test('every story says exactly what the UI story strip says', () => {
  const jsx = read('../web/src/components/Story.jsx');
  for (const s of buildPack().stories) assert.ok(jsx.includes(`["${s.title}", "${s.say}"]`), `Story.jsx does not carry the text of ${s.id}`);
});

test('a commit is recorded only when passed', () => {
  assert.equal(buildPack().source, undefined);
  assert.equal(buildPack({ commit: 'abc1234' }).source.commit, 'abc1234');
});
