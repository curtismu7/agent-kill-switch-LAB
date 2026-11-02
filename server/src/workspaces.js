// Per-visitor workspaces. Each browser gets its own random workspace id in an HttpOnly cookie, and its own runtime: its own
// clock, token service, caps, gateway state, event buffer and audit trail. Nothing mutable is shared between workspaces, so
// one visitor's run, kill or Reset never touches another's. Only the health probe is shared (it reads no workspace state).
//  - The id is 128 random bits. Holding the cookie is what selects the workspace; it is not a credential and nothing outside
//    the browser sees it. A well-formed id this process has not seen starts a fresh workspace under that id.
//  - At most `cap` workspaces are held in memory. A NEW workspace is REFUSED at the cap (503): an old one is never evicted to make room,
//    because eviction would silently undo a visitor's revoke or kill (a flood of cookie-less requests could do it on purpose). A workspace is
//    dropped only when it has been idle for the whole cookie lifetime, after which no browser can still hold its id. Memory is bounded by `cap`.
import crypto from 'node:crypto';
import { createRuntime } from './runtime.js';

export const COOKIE = 'ks_ws';
export const WORKSPACE_CAP = 200;
const MAX_AGE_S = 8 * 60 * 60;
const ID_RE = /^[a-f0-9]{32}$/;

function cookieValue(header) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

export const IDLE_MS = MAX_AGE_S * 1000;

export function createWorkspaces({ hosted = false, cap = WORKSPACE_CAP, make = (opts) => createRuntime(opts), now = Date.now, idleMs = IDLE_MS } = {}) {
  const live = new Map(); // id -> { rt, at }; Map order is recency (a touch moves the id to the end)

  function sweep() {
    const t = now();
    for (const [id, v] of live) { if (t - v.at > idleMs) live.delete(id); else break; }
  }

  // The runtime for this id, or null when the id is new and the registry is full.
  function runtimeFor(id) {
    sweep();
    const v = live.get(id);
    if (v) { live.delete(id); v.at = now(); live.set(id, v); return v.rt; }
    if (live.size >= cap) return null;
    const fresh = make({ hosted });
    live.set(id, { rt: fresh, at: now() });
    return fresh;
  }

  return {
    cap,
    get size() { return live.size; },
    // Resolve the caller's workspace. A missing or malformed cookie gets a new id, and the response sets it. Returns null when the registry is full.
    resolve(req, res) {
      const given = cookieValue(req.headers.cookie);
      const id = given && ID_RE.test(given) ? given : crypto.randomBytes(16).toString('hex');
      const rt = runtimeFor(id);
      if (rt === null) return null; // no cookie is set for a workspace that was not created
      if (id !== given) {
        const parts = [`${COOKIE}=${id}`, 'Path=/', `Max-Age=${MAX_AGE_S}`, 'HttpOnly', 'SameSite=Strict'];
        if (hosted) parts.push('Secure');
        res.append('Set-Cookie', parts.join('; '));
      }
      return rt;
    },
  };
}
