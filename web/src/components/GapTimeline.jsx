import React from "react";
import { ModelNote } from "./Badges.jsx";
import { agentName, ms, plural } from "../lib/format.js";

// The gap between the moment access is revoked and the first refused call, drawn on a time axis.
export default function GapTimeline({ gap, tokens, config, nowMs }) {
  if (!gap) {
    return (
      <section className="panel" aria-labelledby="gap-h">
        <h2 id="gap-h">The gap: revoke to first refused call</h2>
        <p className="empty">Nothing has been stopped yet. Run &ldquo;Manual kill mid-run&rdquo; or &ldquo;Revoked token, stale gateway&rdquo; to see the gap.</p>
      </section>
    );
  }
  const end = gap.firstDeniedAt ?? Math.max(nowMs, gap.stopAt);
  const revoked = tokens.filter((k) => k.revokedAt === gap.stopAt && (gap.agentId === null || k.agentId === gap.agentId));
  const expiry = revoked.length ? Math.min(...revoked.map((k) => k.expiresAt)) : null;
  const marks = [gap.stopAt, end, ...gap.leaked.map((l) => l.at), ...(expiry && expiry < end + 60_000 ? [expiry] : [])];
  const lo = gap.stopAt; const hi = Math.max(...marks, lo + 1);
  const p = (t) => Math.max(0, Math.min(100, ((t - lo) / (hi - lo)) * 100));
  const x = (t) => `${p(t)}%`;
  const flip = (t) => (p(t) > 70 ? " flip" : ""); // labels near the right edge are drawn leftwards so they never overflow
  const gapMs = gap.firstDeniedAt === null ? null : gap.firstDeniedAt - gap.stopAt;
  const local = config.tokenValidation === "local";
  const instant = gap.kind === "trip";
  const target = gap.agentId ? agentName(gap.agentId) : "all agents";
  return (
    <section className="panel" aria-labelledby="gap-h">
      <h2 id="gap-h">The gap: revoke to first refused call</h2>
      <p className="gap-big" data-testid="gap-summary">
        <strong>{gapMs === null ? "no refused call yet" : ms(gapMs)}</strong>
        <span> between {instant ? "the trip" : "the revoke"} of {target} and the first refused call; {plural(gap.leaked.length, "call")} got through in between.</span>
      </p>
      <div className="timeline" role="img" aria-label={`Timeline: ${instant ? "trip" : "revoke"} at the start, ${plural(gap.leaked.length, "call")} still allowed, first refused call ${gapMs === null ? "not yet seen" : `after ${ms(gapMs)}`}.`}>
        <div className="axis" />
        <div className={`span ${gap.leaked.length ? "leak" : ""}`} style={{ left: 0, width: x(end) }} />
        <div className="mark m-stop" style={{ left: "0%" }}><i />{instant ? "tripped" : "revoked"}</div>
        {gap.leaked.map((l, i) => <div key={l.callId} className={`mark m-leak${flip(l.at)}`} style={{ left: x(l.at) }}><i />{i === 0 ? "still allowed" : ""}</div>)}
        {gap.firstDeniedAt !== null && <div className="mark m-deny" style={{ left: x(gap.firstDeniedAt) }}><i />first refusal</div>}
        {expiry !== null && expiry <= hi && <div className={`mark m-exp${flip(expiry)}`} style={{ left: x(expiry) }}><i />token would expire</div>}
      </div>
      <p className="lesson" data-testid="gap-lesson">
        {instant && "A cap trip refuses the very call that breached it, so there is no gap: the breach and the stop are the same call. The tokens are revoked at that moment as well."}
        {!instant && !local && config.flagCheck && "This gateway reads the kill state and asks the token service on every call, so the gap is only the time until the agent next calls. Revocation does not wait for the token to expire."}
        {!instant && local && !config.flagCheck && `This gateway validates tokens locally and only refreshes its revocation list every ${ms(config.revocationSyncMs)}. Until then a revoked token still works, so the worst case is the shorter of that refresh and the token's remaining lifetime (${ms(config.tokenTtlMs)} when issued). Shorter lifetimes cap the damage if revocation does not reach the gateway.`}
        {!instant && local && config.flagCheck && "Token validation is local, but the kill flag is read on every call, so the flag closes the gap before token revocation would."}
        {!instant && !local && !config.flagCheck && "The kill flag is not read per call; the token service is asked on every call, so a revoked token fails at once."}
      </p>
      <ModelNote>The gateway modes, the {ms(config.revocationSyncMs)} refresh and the token lifetime are demo settings. Real products may behave differently; nothing here is a claim about their latency.</ModelNote>
    </section>
  );
}
