import { announce, deriveGaps, deriveTokens, describeEvent, pathFor } from "../lib/derive.js";
import { tokenStatus } from "../lib/derive.js";
import { ev } from "./fixtures.js";

const T = (s) => `2026-01-01T12:00:${String(s).padStart(2, "0")}.000Z`;
const issued = (id, agent, at, ttl = 60000) => ev("token_issued", agent, { tokenId: id, ttlMs: ttl, expiresAt: new Date(Date.parse(T(at)) + ttl).toISOString() }, T(at));

test("a kill revokes the live tokens of that agent only, not expired ones and not the other agent's", () => {
  const events = [issued("tok-1", "agent-alpha", 0, 5000), issued("tok-2", "agent-alpha", 10), issued("tok-3", "agent-beta", 10), ev("kill", "agent-alpha", { operator: "x" }, T(20))];
  const [a1, a2, b] = deriveTokens(events);
  expect(a1.revokedAt).toBeNull(); // expired at :05, before the kill
  expect(a2.revokedAt).toBe(Date.parse(T(20)));
  expect(b.revokedAt).toBeNull();
  expect(tokenStatus(a2, Date.parse(T(21)))).toBe("revoked");
  expect(tokenStatus(a1, Date.parse(T(21)))).toBe("expired");
  expect(tokenStatus(b, Date.parse(T(21)))).toBe("live");
});

test("a global kill revokes everyone; a reset clears the list; a trip revokes too", () => {
  const events = [issued("tok-1", "agent-alpha", 0), issued("tok-2", "agent-beta", 0), ev("kill", null, { scope: "global" }, T(5))];
  expect(deriveTokens(events).every((k) => k.revokedAt !== null)).toBe(true);
  expect(deriveTokens([...events, ev("reset", null, {}, T(6))])).toEqual([]);
  const trip = deriveTokens([issued("tok-1", "agent-alpha", 0), ev("trip", "agent-alpha", { reason: "rate_cap" }, T(3))]);
  expect(trip[0].revokedAt).toBe(Date.parse(T(3)));
});

test("a token is never un-revoked by an unrevoke", () => {
  const k = deriveTokens([issued("tok-1", "agent-alpha", 0), ev("kill", "agent-alpha", {}, T(2)), ev("unrevoke", "agent-alpha", {}, T(3))]);
  expect(k[0].revokedAt).not.toBeNull();
});

test("gap: calls allowed after the kill are leaked, the first denial closes the gap", () => {
  const gaps = deriveGaps([
    ev("kill", "agent-alpha", { operator: "x" }, T(10)),
    ev("call_allowed", "agent-alpha", { callId: "c1" }, T(15)),
    ev("call_allowed", "agent-beta", { callId: "c2" }, T(16)),
    ev("call_allowed", "agent-alpha", { callId: "c3" }, T(20)),
    ev("call_denied", "agent-alpha", { reason: "token_revoked" }, T(30)),
    ev("call_allowed", "agent-alpha", { callId: "c4" }, T(31)),
  ]);
  expect(gaps).toHaveLength(1);
  expect(gaps[0].leaked.map((l) => l.callId)).toEqual(["c1", "c3"]);
  expect(gaps[0].firstDeniedAt - gaps[0].stopAt).toBe(20000);
  expect(gaps[0].cause).toBe("token_revoked");
});

test("gap: a trip has no gap, a global kill watches every agent, an unrevoke closes the watch", () => {
  const trip = deriveGaps([ev("trip", "agent-alpha", { reason: "rate_cap" }, T(1))]);
  expect(trip[0].firstDeniedAt).toBe(trip[0].stopAt);
  const g = deriveGaps([ev("kill", null, { scope: "global" }, T(1)), ev("call_allowed", "agent-beta", { callId: "c1" }, T(2)), ev("call_denied", "agent-alpha", { reason: "global_kill" }, T(3))]);
  expect(g[0].leaked).toHaveLength(1);
  expect(g[0].firstDeniedAt).toBe(Date.parse(T(3)));
  const u = deriveGaps([ev("kill", "agent-alpha", {}, T(1)), ev("unrevoke", "agent-alpha", {}, T(2)), ev("call_allowed", "agent-alpha", { callId: "c1" }, T(3))]);
  expect(u[0].leaked).toEqual([]);
  expect(u[0].firstDeniedAt).toBeNull();
});

test("pathFor says where a call stopped", () => {
  expect(pathFor(null).nodes).toEqual([]);
  const ok = pathFor({ action: "call", allowed: true });
  expect(ok.nodes).toContain("tools"); expect(ok.bad).toBeNull();
  expect(pathFor({ action: "call", allowed: false, stage: "cap", reason: "rate_cap" })).toMatchObject({ bad: "rate" });
  expect(pathFor({ action: "call", allowed: false, stage: "cap", reason: "cost_cap" })).toMatchObject({ bad: "cost" });
  expect(pathFor({ action: "call", allowed: false, stage: "state", reason: "agent_killed" })).toMatchObject({ bad: "revoke" });
  expect(pathFor({ action: "call", allowed: false, stage: "token", reason: "token_revoked" }).nodes).not.toContain("tools");
  expect(pathFor({ action: "call", allowed: false, stage: "token_service" })).toMatchObject({ bad: "token" });
  expect(pathFor({ action: "kill" }).nodes).toContain("kill");
});

test("announcements exist for stops and starts, not for ordinary calls", () => {
  expect(announce(ev("trip", "agent-alpha", { reason: "rate_cap" }))).toMatch(/tripped.*rate_cap/);
  expect(announce(ev("kill", "agent-alpha", { operator: "ann" }))).toMatch(/killed by ann/);
  expect(announce(ev("unrevoke", "agent-alpha", { operator: "ann" }))).toMatch(/unrevoked/);
  expect(announce(ev("call_allowed", "agent-alpha", {}))).toBe("");
});

test("event text keeps hostile strings as plain text and survives missing data", () => {
  const d = describeEvent(ev("call_denied", "agent-alpha", { tool: "<img src=x onerror=alert(1)>", stage: "state", reason: "agent_killed" }));
  expect(d.text).toContain("<img src=x onerror=alert(1)>");
  expect(describeEvent({ seq: 1, at: "", type: "weird", agentId: null }).text).toMatch(/weird/);
});

test("a new scenario run starts a new world: earlier tokens and gaps are dropped", () => {
  const events = [issued("tok-0001", "agent-alpha", 0), ev("kill", "agent-alpha", {}, T(2)), ev("scenario_start", null, {}, T(3)), issued("tok-0001", "agent-alpha", 4)];
  const k = deriveTokens(events);
  expect(k).toHaveLength(1);
  expect(k[0].revokedAt).toBeNull();
  expect(deriveGaps(events)).toEqual([]);
});
