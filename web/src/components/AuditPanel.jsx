import React from "react";
import { clock } from "../lib/format.js";

export default function AuditPanel({ audit, verify, onVerify, busy }) {
  const rows = [...audit.entries].reverse().slice(0, 30);
  return (
    <section className="panel" aria-labelledby="audit-h">
      <h2 id="audit-h">Audit trail</h2>
      <p className="hint">Append-only. Every entry carries a keyed hash of its content and of the entry before it, so an edit or a deletion breaks the chain. The key stays inside the server process.</p>
      <div className="audit-bar">
        <button type="button" className="btn" onClick={onVerify} disabled={busy}>Verify chain</button>
        <span role="status" aria-live="polite" data-testid="verify-result" className={verify ? (verify.ok ? "v-ok" : "v-bad") : ""}>
          {verify ? (verify.ok ? `✓ Chain intact: ${verify.length} entries, head ${String(verify.headHash).slice(0, 12)}` : `✕ Chain BROKEN at entry ${verify.firstBadSeq}: ${verify.reason}`) : `${audit.size} entries. Not verified yet.`}
        </span>
      </div>
      {rows.length === 0 ? <p className="empty">Nothing recorded yet.</p> : (
        <ol className="audit" data-testid="audit-list">
          {rows.map((e) => (
            <li key={e.seq} data-type={e.type}>
              <span className="seq">#{e.seq}</span>
              <time>{clock(e.at)}</time>
              <strong>{e.type}</strong>
              <span>{e.agentId || "all"}</span>
              <span className="det">{e.data?.operator ? `by ${e.data.operator}` : e.data?.reason || e.data?.scenario || ""}</span>
              <code title="entry hash">{String(e.hash).slice(0, 10)}</code>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
