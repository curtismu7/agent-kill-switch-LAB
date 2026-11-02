#!/usr/bin/env node
// Rewrites the generated Federated Identity section of docs/talk-track.md from the engine data. Run:  npm run talk-track
import fs from 'node:fs';
import { withSection } from '../server/src/fedid/talk.js';

const file = new URL('../docs/talk-track.md', import.meta.url);
fs.writeFileSync(file, withSection(fs.readFileSync(file, 'utf8')));
console.log('wrote docs/talk-track.md');
