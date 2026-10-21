import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('safety.md and the README carry the UNVERIFIED provenance statement and make no claim about real product limits', () => {
  for (const f of ['docs/safety.md', 'README.md']) {
    assert.match(read(f), /UNVERIFIED against product documentation/, f);
    assert.match(read(f), /no claim about (how any real|real product defaults)/i, f);
  }
});

test('safety.md states the in-flight semantics', () => {
  const s = read('docs/safety.md');
  assert.match(s, /In-flight semantics/);
  assert.match(s, /does not interrupt it/);
  assert.match(s, /completedAfterStop/);
  assert.match(s, /stays charged/);
});

test('every npm script the README tells you to run exists', () => {
  const readme = read('README.md');
  for (const m of readme.matchAll(/^npm (?:run )?([a-z-]+)/gm)) {
    if (m[1] === 'install') continue;
    assert.ok(pkg.scripts[m[1]], `README runs "npm ${m[1]}" which is not in package.json`);
  }
});

test('every scenario is described in the README and every endpoint it lists exists in the code', () => {
  const readme = read('README.md');
  const app = read('server/src/app.js');
  for (const m of read('server/src/scenarios.js').matchAll(/id: '([a-z-]+)'/g)) assert.ok(readme.includes(`\`${m[1]}\``), `scenario ${m[1]} missing from the README`);
  for (const route of ['/scenarios', '/agents', '/state', '/kill', '/unrevoke', '/events', '/audit', '/audit/verify', '/reset', '/health']) assert.ok(app.includes(`'${route}`) || app.includes(`${route}'`) || app.includes(`${route}\``), route);
});

test('the README only names ports inside 6550-6599', () => {
  for (const m of read('README.md').matchAll(/127\.0\.0\.1:(\d{4})/g)) assert.ok(Number(m[1]) >= 6550 && Number(m[1]) <= 6599, m[0]);
});
