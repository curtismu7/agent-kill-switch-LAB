// The diagram is diagram-studio/1 DATA (diagrams/fedid-revoke.json), loaded by name and checked with a copy of the studio's own validator
// (diagramStudioValidate.js, copied, never imported across repos). Nothing here builds nodes or edges by hand. Each step is one edge.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDiagram } from './diagramStudioValidate.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'diagrams');
export const DIAGRAM_NAMES = ['fedid-revoke'];

export function loadDiagram(name) {
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
  const problems = validateDiagram(doc);
  if (problems.length) throw new Error(`diagram ${name} is not valid diagram-studio/1: ${problems.join('; ')}`);
  return doc;
}
const DOCS = Object.fromEntries(DIAGRAM_NAMES.map((n) => [n, loadDiagram(n)]));

export function buildDiagram(name = DIAGRAM_NAMES[0]) {
  const d = DOCS[DIAGRAM_NAMES.includes(name) ? name : DIAGRAM_NAMES[0]];
  return {
    name: d.id, title: d.title, intro: d.lede,
    groups: d.groups,
    nodes: d.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.group, color: d.groups[n.group].color, x: n.x, y: n.y })),
    steps: d.steps.map((s) => { const e = d.edges[s.edges[0]]; return { from: e.source, to: e.target, label: s.title, say: s.what, edge: e.label || '', dashed: e.dashed === true }; }),
  };
}
