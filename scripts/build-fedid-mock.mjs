#!/usr/bin/env node
// Writes server/src/fedid/mockTable.json from the engine. Run after any change to the engine, tables or story:  npm run fedid-mock
import fs from 'node:fs';
import { MOCK_PATH, generateMock, serializeMock } from '../server/src/fedid/mock.js';

fs.writeFileSync(MOCK_PATH, serializeMock(generateMock()));
console.log(`wrote ${MOCK_PATH}`);
