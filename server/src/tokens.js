// Stub token service: issues short-lived opaque access tokens, keeps a revocation list, and can refuse to issue new tokens to
// an agent ("disabled application"). Time comes from the injected clock. Token values never leave this module except to the
// caller of issue(); every other record, event and audit entry carries only the token id.
import crypto from 'node:crypto';

export const TOKEN_CAP = 500;

export function createTokenService({ clock, ttlMs = 60_000, cap = TOKEN_CAP } = {}) {
  const byValue = new Map();        // token value -> record (insertion order = age)
  const disabled = new Set();       // agents the token service refuses to issue to
  let n = 0;

  function trim() {
    while (byValue.size > cap) byValue.delete(byValue.keys().next().value); // oldest first; a trimmed token is simply unknown
  }

  return {
    ttlMs,
    issue(agentId) {
      if (disabled.has(agentId)) return { ok: false, reason: 'issuance_disabled' };
      n += 1;
      const token = `kst_${crypto.randomBytes(24).toString('hex')}`;
      const issuedAt = clock.now();
      const rec = { id: `tok-${String(n).padStart(4, '0')}`, agentId, issuedAt, expiresAt: issuedAt + ttlMs, revokedAt: null };
      byValue.set(token, rec);
      trim();
      return { ok: true, token, tokenId: rec.id, issuedAt, expiresAt: rec.expiresAt, ttlMs };
    },
    // The record behind a token value, or null. A copy, never the live object.
    lookup(token) {
      const r = typeof token === 'string' ? byValue.get(token) : undefined;
      return r ? { ...r } : null;
    },
    // Revoke every live token issued to the agent (or to all agents when agentId is null). Returns the ids revoked.
    revoke(agentId = null) {
      const at = clock.now();
      const ids = [];
      for (const r of byValue.values()) {
        if ((agentId === null || r.agentId === agentId) && r.revokedAt === null && r.expiresAt > at) { r.revokedAt = at; ids.push(r.id); }
      }
      return ids;
    },
    // Ids of every revoked token, for the gateway's cached revocation list.
    revokedIds() { return [...byValue.values()].filter((r) => r.revokedAt !== null).map((r) => r.id); },
    disable(agentId) { disabled.add(agentId); },
    enable(agentId) { disabled.delete(agentId); },
    isDisabled: (agentId) => disabled.has(agentId),
    liveCount: (agentId) => [...byValue.values()].filter((r) => r.agentId === agentId && r.revokedAt === null && r.expiresAt > clock.now()).length,
  };
}
