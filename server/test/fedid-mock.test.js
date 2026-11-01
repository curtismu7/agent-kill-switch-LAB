// Mock/Live parity and the generated Mock table (drift test), the claim tags, the roadmap rule and the diagram data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createAudit } from '../src/audit.js';
import { DIAGRAM_NAMES, buildDiagram, loadDiagram } from '../src/fedid/diagram.js';
import { validateDiagram } from '../src/fedid/diagramStudioValidate.js';
import { createFedId } from '../src/fedid/engine.js';
import { ALL_CLAIMS, BANNER, FACTS, INVENTED, NOT_SAID, READINGS, ROADMAP, SWAGGER, TAGS, WHY } from '../src/fedid/facts.js';
import { MOCK_PATH, generateMock, loadMock, serializeMock } from '../src/fedid/mock.js';
import { STORY, runStory } from '../src/fedid/story.js';
import { STORY_START_MS } from '../src/fedid/tables.js';

const engineFor = (signing) => createFedId({ audit: createAudit({ now: () => new Date(STORY_START_MS) }), startMs: () => STORY_START_MS, signing });

test('DRIFT: mockTable.json is exactly what the engine generates (run: npm run fedid-mock)', () => {
  assert.equal(fs.readFileSync(MOCK_PATH, 'utf8'), serializeMock(generateMock()), 'mockTable.json is stale; regenerate it and commit the result');
});

test('the generator is deterministic and the Mock table holds no token and no signature', () => {
  assert.equal(serializeMock(generateMock()), serializeMock(generateMock()));
  const text = fs.readFileSync(MOCK_PATH, 'utf8');
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{8,}/);
  assert.doesNotMatch(text, /sig-not-real/);
});

// What a decision looks like once the parts that legitimately differ between the two signers are removed.
const project = (steps) => steps.map((s) => (s.result
  ? { step: s.step, d: s.result.decision, r: s.result.reason, st: s.result.status, dep: s.result.deployment, minted: s.result.minted, valid: s.result.tokenStillValid, ks: s.result.keySet, checks: s.result.checks, backend: s.result.backend, claims: s.result.token.claims, header: s.result.token.header }
  : { step: s.step, t: s.t, ok: s.ok }));

test('PARITY: the story makes the same decisions with real RS256 signing as with the mock marker', () => {
  const real = project(runStory(engineFor('rsa')));
  const mock = project(runStory(engineFor('mock')));
  assert.equal(real.length, STORY.length);
  assert.deepEqual(real, mock);
  assert.deepEqual(real, project(loadMock().steps), 'and the committed Mock table agrees with both');
});

test('PARITY: a parity check that could pass for the wrong reason would fail: the two engines really differ in what they sign', () => {
  const a = engineFor('rsa').request({ workload: 'fi-billing-agent', service: 'mcp' });
  const b = engineFor('mock').request({ workload: 'fi-billing-agent', service: 'mcp' });
  assert.notEqual(a.raw.split('.')[2], b.raw.split('.')[2]);
  assert.equal(b.raw.split('.')[2], 'sig-not-real');
  assert.match(a.raw.split('.')[2], /^[A-Za-z0-9_-]{300,}$/, 'a 2048-bit RSA signature');
});

test('the Mock table says what the story says: first request after the revoke refused, none allowed, all attributed', () => {
  const m = loadMock();
  const b = m.final.identities.find((i) => i.id === 'fi-billing-agent');
  assert.equal(b.state, 'revoked');
  assert.deepEqual([b.summary.afterRevoke.requests, b.summary.afterRevoke.allowed, b.summary.afterRevoke.refused, b.summary.afterRevoke.refusedAndAttributed], [6, 0, 6, 6]);
  assert.deepEqual([b.summary.afterRevoke.firstDecision.decision, b.summary.afterRevoke.firstDecision.reason], ['refused', 'identity_revoked']);
  const revokeIdx = m.steps.findIndex((s) => s.t === 'revoke');
  const next = m.steps.slice(revokeIdx + 1).find((s) => s.result && s.result.workload === 'fi-billing-agent');
  assert.equal(next.result.decision, 'refused', 'the very next billing request after the revoke');
  assert.equal(m.final.forwardedTokens, 0);
});

test('every claim row has a known tag; every deck claim names a slide; the banner is the required words', () => {
  assert.equal(BANNER, 'Ping release claim, UNVERIFIED on our tenant');
  assert.deepEqual([...TAGS], ['deck claim', 'console swagger name (schema only)', 'lab reading', 'lab-invented', 'measured (our note)', 'roadmap']);
  for (const c of ALL_CLAIMS) assert.ok(TAGS.includes(c.tag), `${c.id} has tag ${c.tag}`);
  for (const f of FACTS) { assert.equal(f.tag, 'deck claim', f.id); assert.ok(Number.isInteger(f.slide) && f.slide >= 1 && f.slide <= 58, f.id); }
  for (const s of SWAGGER) assert.equal(s.tag, 'console swagger name (schema only)');
  for (const r of READINGS) assert.equal(r.tag, 'lab reading');
  for (const i of INVENTED) assert.equal(i.tag, 'lab-invented');
  assert.equal(new Set(ALL_CLAIMS.map((c) => c.id)).size, ALL_CLAIMS.length, 'claim ids are unique');
  assert.equal(WHY.tag, 'deck claim');
});

test("Ping's numbers (15 minutes, one hour) appear as deck claims, and nowhere does the lab call its own number a measurement of Ping", () => {
  const withPingNumbers = FACTS.filter((f) => /fifteen|one hour/i.test(f.text));
  assert.ok(withPingNumbers.length >= 2);
  for (const f of ALL_CLAIMS.filter((c) => /fifteen minutes|default one hour/i.test(c.text))) assert.equal(f.tag, 'deck claim', f.id);
  for (const c of ALL_CLAIMS) assert.doesNotMatch(c.text, /Ping measured|we measured Ping/i, c.id);
});

test('ROADMAP: the Q4 2026 and Planned items are labelled roadmap and no behaviour exists for them', async () => {
  assert.ok(ROADMAP.length >= 1);
  for (const r of ROADMAP) { assert.equal(r.tag, 'roadmap'); assert.match(r.availability, /Q4 2026|Planned/); assert.match(r.note, /No behaviour is claimed/); }
  const e = engineFor('mock');
  for (const fn of Object.keys(e)) assert.doesNotMatch(fn, /lifecycle|disable|decommission|restore|unrevoke|classif|risk/i, `engine.${fn}`);
  const { fedidRoutes } = await import('../src/fedid/routes.js');
  const paths = fedidRoutes({ fedid: e, hosted: false }).stack.map((l) => l.route?.path).filter(Boolean);
  assert.deepEqual(paths.sort(), ['/', '/advance', '/diagram', '/issuer', '/mock', '/request', '/revoke', '/state']);
  assert.ok(NOT_SAID.some((n) => n.tag === 'roadmap'), 'the restore question points at the roadmap');
});

test('the lab does not state a number for how fast: the revoke is counted in requests', () => {
  const text = JSON.stringify([...FACTS, ...READINGS, ...NOT_SAID]);
  assert.doesNotMatch(text, /within \d+ ?(ms|milliseconds|seconds)|\d+ ?ms (after|of) the revoke/i);
});

test('the diagram is diagram-studio/1 data, loaded by name, valid, with one edge per step and no hand-built nodes', () => {
  assert.deepEqual(DIAGRAM_NAMES, ['fedid-revoke']);
  const doc = loadDiagram('fedid-revoke');
  assert.deepEqual(validateDiagram(doc), []);
  const d = buildDiagram('fedid-revoke');
  assert.equal(d.nodes.length, doc.nodes.length);
  assert.equal(d.steps.length, doc.steps.length);
  for (const s of d.steps) { assert.ok(d.nodes.some((n) => n.id === s.from)); assert.ok(d.nodes.some((n) => n.id === s.to)); }
  assert.equal(buildDiagram('nope').name, 'fedid-revoke', 'an unknown name falls back, never reaches the file system');
  assert.deepEqual(validateDiagram({ ...doc, nodes: [] }).length > 0, true);
});
