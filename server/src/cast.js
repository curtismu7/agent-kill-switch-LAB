// {{token}} templating for the Federated Identity story. Stories are data: the words that name a company, a host, a team or an operator are
// {{cast}} tokens (for example {{castBrand}}), filled from one of three vertical packs when the story is served. A test fails on any token a pack does not define.
// customer.config.json (optional, git-ignored; see customer.config.example.json) may override the brand, the host label and the operator name.
// Every name below is synthetic: no real company, person, tenant or host. Hosts are .example only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = /\{\{(\w+)\}\}/g;
const MAX_CAST = 40;
const ID = /^[a-z0-9.-]{1,40}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const VERTICALS = Object.freeze({
  finance: Object.freeze({ castBrand: 'Fabrikam Bank', castHost: 'fabrikam', castOperator: 'on-call-operator', castTeam: 'payments-platform' }),
  health: Object.freeze({ castBrand: 'Contoso Health', castHost: 'contoso', castOperator: 'on-call-clinical-ops', castTeam: 'clinical-platform' }),
  retail: Object.freeze({ castBrand: 'Northwind Retail', castHost: 'northwind', castOperator: 'on-call-store-ops', castTeam: 'commerce-platform' }),
});
export const DEFAULT_VERTICAL = 'finance';
export const DEFAULT_CAST = VERTICALS[DEFAULT_VERTICAL];

export const unfilled = (text, cast) => [...String(text).matchAll(TOKEN)].map((m) => m[1]).filter((k) => !Object.hasOwn(cast, k));
export const fill = (text, cast) => String(text).replace(TOKEN, (m, k) => (Object.hasOwn(cast, k) ? cast[k] : m));

// Iterative, so a deep structure cannot overflow the stack.
export function fillDeep(value, cast) {
  const clone = (x) => (Array.isArray(x) ? [] : x && typeof x === 'object' ? {} : x);
  const root = { v: clone(value) };
  const work = [[value, root, 'v']];
  while (work.length) {
    const [src, dst, key] = work.pop();
    if (typeof src === 'string') { dst[key] = fill(src, cast); continue; }
    if (src === null || typeof src !== 'object') { dst[key] = src; continue; }
    const copy = clone(src);
    dst[key] = copy;
    for (const k of Object.keys(src).reverse()) work.push([src[k], copy, k]);
  }
  return root.v;
}

// Only a vertical this file defines is accepted; anything else (including a typed secret) is the default and is never echoed.
export const verticalFrom = (id) => (typeof id === 'string' && Object.hasOwn(VERTICALS, id) ? id : DEFAULT_VERTICAL);

export const configFile = (env = process.env) => env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');

// Brand, host and operator only, as short plain strings; anything else in the file is ignored. A value that looks like a URL, an address or a host name is ignored.
export function loadCast(file, vertical = DEFAULT_VERTICAL) {
  const cast = { ...VERTICALS[verticalFrom(vertical)] };
  if (!file) return cast;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [short, key] of [['brand', 'castBrand'], ['operator', 'castOperator'], ['host', 'castHost']]) {
      const v = cfg?.cast?.[short];
      if (typeof v !== 'string' || !v.trim()) continue;
      const clean = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, ' ').trim().slice(0, MAX_CAST);
      if (/:\/\/|@|\b[\w-]+\.(?:com|net|org|io|dev|app|cloud)\b/i.test(clean)) continue;
      if (short !== 'brand' && !ID.test(clean.toLowerCase())) continue;
      if (short === 'host' && clean.includes('.')) continue;
      cast[key] = short === 'brand' ? clean : clean.toLowerCase();
    }
  } catch { /* no file, or not JSON: the defaults */ }
  return cast;
}
