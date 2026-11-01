// Test helpers. Every test file owns a distinct slice of 6580-6599 so files running in parallel never collide.
import http from 'node:http';
import net from 'node:net';
import { createAudit } from '../src/audit.js';
import { createClock } from '../src/clock.js';
import { createEvents } from '../src/events.js';
import { createGateway } from '../src/gateway.js';
import { createTokenService } from '../src/tokens.js';

export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
export const A = 'agent-alpha';
export const B = 'agent-beta';

// A gateway on a fake clock. No sleeps anywhere: tests move time with clock.advance().
export function makeWorld({ limits = {}, config = {} } = {}) {
  const clock = createClock({ fixed: T0 });
  const tokens = createTokenService({ clock, ttlMs: config.tokenTtlMs ?? 60_000 });
  const audit = createAudit({ now: () => new Date(clock.now()) });
  const events = createEvents({ clock });
  const gateway = createGateway({ clock, tokens, audit, events, limits, config });
  const held = {};
  const heldExp = {};
  // One call with the agent's own token (fetched on first use). `o` overrides the call fields.
  const go = (agentId = A, o = {}) => {
    if (!held[agentId] || clock.now() >= heldExp[agentId]) { const t = tokens.issue(agentId); if (!t.ok) return { allowed: false, reason: t.reason, stage: 'token_service' }; held[agentId] = t.token; heldExp[agentId] = t.expiresAt; }
    return gateway.call({ agentId, token: held[agentId], tool: 'lookup', model: 'demo-small', tokensIn: 500, tokensOut: 200, ...o });
  };
  return { clock, tokens, audit, events, gateway, go, held };
}

export const BASES = { api: 6580, guards: 6585, safety: 6590, spare: 6595, ws: 6597, ks2: 6598, fedid: 6572, fedidmask: 6575 };
const SLICE_END = { api: 6584, guards: 6589, safety: 6594, spare: 6596, ws: 6597, ks2: 6599, fedid: 6574, fedidmask: 6576 };

const isFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

// A free loopback port inside a file's own slice. Ports stay in 6580-6599.
const cursor = {};
export async function freePort(slice) {
  const first = BASES[slice]; const last = SLICE_END[slice];
  const start = cursor[slice] ?? first;
  const order = [];
  for (let p = start; p <= last; p += 1) order.push(p);
  for (let p = first; p < start; p += 1) order.push(p);
  for (const p of order) if (await isFree(p)) { cursor[slice] = p + 1; return p; }
  throw new Error(`no free port in ${first}-${last}`);
}

// Like fetch, but lets a test set the Host header. Resolves { status, headers, json, raw }.
export function request(port, method, path, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(host ? { host } : {}), ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, raw }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
