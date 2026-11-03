// The Mock table: the story (story.js) run through the engine with signing "mock" on a fixed clock, so it is the same on every machine.
// It is GENERATED, not typed: scripts/build-fedid-mock.mjs writes mockTable.json from this function and a test fails if the file is stale
// (drift test). Another test runs the same story with real RS256 signing and requires the same decisions (parity test).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudit } from '../audit.js';
import { createFedId } from './engine.js';
import { STORY, runStory } from './story.js';
import { STORY_START_MS } from './tables.js';

export const MOCK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mockTable.json');

export function generateMock() {
  const audit = createAudit({ now: () => new Date(STORY_START_MS) });
  const engine = createFedId({ audit, startMs: () => STORY_START_MS, signing: 'mock' });
  const steps = runStory(engine);
  const state = engine.state();
  return {
    schema: 'fedid-mock/1',
    note: 'Generated from the engine (signing: mock) by scripts/build-fedid-mock.mjs. Do not edit by hand: a test regenerates it and compares.',
    storyLength: STORY.length,
    steps,
    final: { now: state.now, identities: state.identities, forwardedTokens: state.forwardedTokens, keySets: state.keySets, issuerOutage: state.issuerOutage },
  };
}

export const serializeMock = (m) => `${JSON.stringify(m, null, 2)}\n`;
// Path-based read (not new URL) so it also loads under the web tests' jsdom.
export const loadMock = () => JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
