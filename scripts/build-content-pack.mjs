#!/usr/bin/env node
/**
 * Generates content-pack.json (repo root). Format: docs/content-pack.schema.json (a copy of the Learning Hub's
 * server/schema/content-pack.schema.json, which is itself a copy of the ID-JAG kit schema).
 * Glossary from content/terms.json, stories from content/stories.json (same text as web/src/components/Story.jsx; a test checks that),
 * cards for the UI sections. Deterministic: lists sorted by id, 2-space JSON, no timestamps. The git commit is recorded only when
 * passed (--commit=<sha>), so a plain run is reproducible.
 *
 * Sources: none. No public documentation URL is cited in this repo that was verified, so the pack lists none.
 *
 *   node scripts/build-content-pack.mjs [--commit=<sha>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACK_PATH = path.join(ROOT, 'content-pack.json');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The kill-switch cards open the app root; the Federated Identity cards open its tab (#federated-identity).
const CARDS = [
  { id: 'rate-loop', label: 'A loop blows the rate cap', description: 'Run the rate-loop scenario and watch the sixth call in ten seconds trip the agent, then every later call get refused.', group: 'try-it', href: '/', terms: ['rate-cap', 'sliding-window', 'trip', 'agent-state'], story: 'S02' },
  { id: 'cost-expensive', label: 'An expensive prompt blows the cost cap', description: 'Run cost-expensive and watch the money budget burn down until a call would cross it.', group: 'try-it', href: '/', terms: ['cost-cap', 'trip'], story: 'S02' },
  { id: 'manual-kill', label: 'Pull the kill switch mid-run', description: 'Run manual-kill, or press Kill yourself, and see the very next call refused.', group: 'try-it', href: '/', terms: ['kill-switch', 'revoke', 'csrf-guard'], story: 'S04' },
  { id: 'unrevoke', label: 'Kill, then unrevoke', description: 'Run kill-unrevoke: the operator unrevokes with a name, an audit entry is written, and the agent gets a fresh token.', group: 'try-it', href: '/', terms: ['unrevoke', 'auto-reset', 'audit-trail'], story: 'S03' },
  { id: 'in-flight', label: 'The kill lands on a running call', description: 'Run in-flight and see what happens to a call already admitted when the stop lands.', group: 'try-it', href: '/', terms: ['in-flight'], story: 'S04' },
  { id: 'gap', label: 'Why short token lifetimes matter', description: 'Run stale-token-gap and read the timeline from the revoke to the first refused call.', group: 'try-it', href: '/', terms: ['revocation-gap', 'short-lived-token'], story: 'S03' },
  { id: 'blast-radius', label: 'Two agents, one killed', description: 'Run blast-radius: only alpha stops, beta carries on.', group: 'try-it', href: '/', terms: ['blast-radius', 'agent-state'], story: 'S02' },
  { id: 'fedid-revoke', label: 'Revoke a Federated Identity (H2 2026 update)', description: 'Mock table or Live engine: revoke the billing identity and watch its very next request be refused although its platform token is still valid. Ping release claim, UNVERIFIED on our tenant; every claim is tagged.', group: 'try-it', href: '/#federated-identity', terms: ['federated-identity', 'platform-issued-token', 'identity-revoke', 'exact-binding', 'key-set-refresh'], story: 'S04' },
  { id: 'fedid-why', label: 'Why Federated Identity matters (Ping claims)', description: 'Challenge: stored API keys outlive workloads and stay valid if they leak, so standing-secret findings block agent rollout. Technical: secretless, exactly bound, short-lived tokens verified per request and instantly revocable. Business: standing-secret audit findings close and unattended agents can be approved. From slide 40 of the H2 2026 deck, UNVERIFIED on our tenant.', group: 'reference', href: '/#federated-identity', terms: ['federated-identity', 'claim-tags'], story: 'S03' },
  { id: 'flow', label: 'Where each call goes', description: 'Agent, revocation check, rate cap, cost cap and tools as a movable diagram with Simulate, plus the token service and the kill switch.', group: 'concept', href: '/', terms: ['kill-switch', 'demo-mode', 'inert-text'], story: 'S01' },
];

export function buildPack({ commit } = {}) {
  const pkg = readJson('package.json');
  const stories = readJson('content/stories.json').sort(byId);
  const ids = new Set(stories.map((s) => s.id));
  const pack = {
    schema: 'demo-content-pack/1',
    id: 'agent-kill-switch',
    title: 'Agent Kill Switch',
    version: pkg.version,
    ...(commit ? { source: { repo: 'agent-kill-switch', commit } } : {}),
    demo: { id: 'agent-kill-switch', name: 'Agent Kill Switch', catalog: 'D14', baseUrl: 'http://localhost:6550', doctor: '/api/health', tags: ['kill-switch', 'rate-cap', 'cost-cap', 'revoke', 'audit', 'federated-identity'] },
    glossary: readJson('content/terms.json').sort(byId),
    sources: [],
    cards: CARDS.map(({ href, ...c }) => ({ ...c, action: { type: 'route', href } })).sort(byId),
    diagrams: [{ id: 'flow', label: 'Where each call goes', href: '/' }, { id: 'fedid-revoke', label: 'Revoking a Federated Identity cuts the workload off', href: '/#federated-identity' }],
    stories,
  };
  for (const c of pack.cards) if (c.story && !ids.has(c.story)) throw new Error(`card ${c.id} names unknown story ${c.story}`);
  return pack;
}

export const serialize = (pack) => `${JSON.stringify(pack, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commit = process.argv.find((a) => a.startsWith('--commit='))?.slice(9);
  fs.writeFileSync(PACK_PATH, serialize(buildPack({ commit })));
  console.log(`wrote ${path.relative(process.cwd(), PACK_PATH) || PACK_PATH}`);
}
