// Per-visitor workspaces. Each browser gets its own random workspace id in an HttpOnly cookie, and its own runtime: its own
// clock, token service, caps, gateway state, event buffer and audit trail. Nothing mutable is shared between workspaces, so
// one visitor's run, kill or Reset never touches another's. Only the health probe is shared (it reads no workspace state).
//  - The id is 128 random bits. Holding the cookie is what selects the workspace; it is not a credential and nothing outside
//    the browser sees it. A well-formed id this process has not seen starts a fresh workspace under that id.
//  - At most `cap` workspaces are held in memory. The least recently used one is dropped (a visitor who comes back after that
//    finds a fresh demo). Memory is bounded by `cap`, not by the number of visitors.
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

export function createWorkspaces({ hosted = false, cap = WORKSPACE_CAP, make = (opts) => createRuntime(opts) } = {}) {
  const live = new Map(); // id -> runtime; Map order is recency (a touch moves the id to the end)

  function runtimeFor(id) {
    const rt = live.get(id);
    if (rt) { live.delete(id); live.set(id, rt); return rt; }
    const fresh = make({ hosted });
    live.set(id, fresh);
    while (live.size > cap) live.delete(live.keys().next().value);
    return fresh;
  }

  return {
    cap,
    get size() { return live.size; },
    // Resolve the caller's workspace. A missing or malformed cookie gets a new id, and the response sets it.
    resolve(req, res) {
      const given = cookieValue(req.headers.cookie);
      const id = given && ID_RE.test(given) ? given : crypto.randomBytes(16).toString('hex');
      if (id !== given) {
        const parts = [`${COOKIE}=${id}`, 'Path=/', `Max-Age=${MAX_AGE_S}`, 'HttpOnly', 'SameSite=Strict'];
        if (hosted) parts.push('Secure');
        res.append('Set-Cookie', parts.join('; '));
      }
      return runtimeFor(id);
    },
  };
}
