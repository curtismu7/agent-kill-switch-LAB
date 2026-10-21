import React from "react";
import { ModelNote } from "./Badges.jsx";
import { agentName, ms } from "../lib/format.js";
import { tokenStatus } from "../lib/derive.js";

export default function Tokens({ tokens, nowMs, ttlMs }) {
  const rows = [...tokens].reverse().slice(0, 10);
  return (
    <section className="panel" aria-labelledby="tok-h">
      <h2 id="tok-h">Access tokens</h2>
      <p className="hint">Opaque, short-lived, issued by a stub token service (lifetime here: {ttlMs / 1000} s, an invented number). Token values are never shown or sent to this page, only ids. Time here is the scenario's own clock: it moves when the script moves, not with your wall clock.</p>
      {rows.length === 0 ? <p className="empty">No token issued yet.</p> : (
        <ul className="tokens" data-testid="tokens">
          {rows.map((k) => {
            const s = tokenStatus(k, nowMs);
            const left = k.expiresAt - nowMs;
            return (
              <li key={k.id} className={`tok ${s}`} data-status={s}>
                <code>{k.id}</code>
                <span>{agentName(k.agentId)}</span>
                <span className="tok-ttl">
                  {s === "live" && <>TTL <strong>{ms(left)}</strong> left</>}
                  {s === "expired" && "expired by itself"}
                  {s === "revoked" && <>REVOKED <small>({k.expiresAt > nowMs ? `would have lived ${ms(left)} more` : "was already expiring"})</small></>}
                </span>
                <span className={`tag ${s}`}>{s === "revoked" ? "✕ revoked" : s === "live" ? "● live" : "— expired"}</span>
              </li>
            );
          })}
        </ul>
      )}
      <ModelNote>Revocation here marks every still-live token of the stopped agent. How and how fast a real token service propagates that is not stated by this demo.</ModelNote>
    </section>
  );
}
