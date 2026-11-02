import React from "react";

// Everything the Federated Identity section shows is built from server data and rendered as React text: nothing here builds HTML.
export const REASON_TEXT = {
  identity_revoked: "identity revoked", scope_missing: "scope missing", lifetime_exceeds_cap: "lifetime over the cap", token_expired: "token expired",
  no_matching_identity: "no matching identity", signature_invalid: "signature invalid", alg_not_allowed: "algorithm not allowed", token_malformed: "token malformed",
};
export const CHECK_TEXT = {
  alg: "algorithm is asymmetric", signature: "signature verifies", lifetime: "lifetime within the cap", expiry: "not expired", binding: "issuer, subject, audience match exactly",
  identity_state: "identity is active", key_principal: "key's principal identity is active", scope: "scope covers this service",
};

export function ClaimTag({ tag }) {
  return <span className="claim-tag" data-tag={tag}>{tag}</span>;
}

export function Answer({ decision, status }) {
  const ok = decision === "allowed";
  return <span className="fedid-answer" data-decision={decision}><span aria-hidden="true">{ok ? "✓" : "✕"}</span> {ok ? "allowed" : "refused"} {status}</span>;
}

const who = (r) => (r.workload ? r.workload.replace(/^fi-/, "") : "unknown");
const viaText = (v) => (v === "key" ? "access key" : "token");

// One row per request result. Used by the Live log; the Mock table adds the story text.
export function ResultRows({ rows }) {
  return rows.map((r) => (
    <tr key={r.n} data-testid="fedid-row" data-decision={r.decision} data-reason={r.reason || ""}>
      <td>{r.n}</td><td>{who(r)}</td><td>{r.service}</td><td>{viaText(r.via)}</td>
      <td><Answer decision={r.decision} status={r.status} /></td>
      <td>{r.reason ? REASON_TEXT[r.reason] || r.reason : ""}</td>
      <td>{r.deployment ? r.deployment.subject : "not attributed"}</td>
      <td>{r.tokenStillValid ? "yes" : "no"}</td>
      <td>{r.keySet ? `${r.keySet.source}, ${r.keySet.ageSec} s` : ""}</td>
    </tr>
  ));
}

export function ResultTable({ rows, empty = "No requests yet." }) {
  if (rows.length === 0) return <p className="empty">{empty}</p>;
  return (
    <div className="fedid-scroll">
      <table className="fedid-table" data-testid="fedid-log">
        <thead><tr><th>#</th><th>Workload</th><th>Service</th><th>Presented</th><th>Answer</th><th>Why</th><th>Attributed to</th><th>Token still valid</th><th>Key set</th></tr></thead>
        <tbody><ResultRows rows={rows} /></tbody>
      </table>
    </div>
  );
}

// The Mock table: the generated story, one row per step.
export function MockTable({ steps }) {
  return (
    <div className="fedid-scroll">
      <table className="fedid-table" data-testid="fedid-mock-table">
        <thead><tr><th>Step</th><th>What happens</th><th>Workload</th><th>Service</th><th>Presented</th><th>Answer</th><th>Why</th><th>Attributed to</th><th>Token still valid</th></tr></thead>
        <tbody>
          {steps.map((s) => (s.result ? (
            <tr key={s.step} data-testid="fedid-mock-row" data-decision={s.result.decision} data-reason={s.result.reason || ""}>
              <td>{s.step}</td><td>{s.say}</td><td>{who(s.result)}</td><td>{s.result.service}</td><td>{viaText(s.result.via)}</td>
              <td><Answer decision={s.result.decision} status={s.result.status} /></td>
              <td>{s.result.reason ? REASON_TEXT[s.result.reason] || s.result.reason : ""}</td>
              <td>{s.result.deployment ? s.result.deployment.subject : "not attributed"}</td>
              <td>{s.result.tokenStillValid ? "yes" : "no"}</td>
            </tr>
          ) : (
            <tr key={s.step} className="fedid-table__event" data-testid="fedid-mock-row" data-event={s.t}>
              <td>{s.step}</td><td colSpan={8}><strong>{s.t === "revoke" ? `REVOKE ${s.workload}. ` : s.t === "issuer" ? `ISSUER ${s.outage ? "DOWN" : "UP"}. ` : `TIME +${s.seconds} s. `}</strong>{s.say}</td>
            </tr>
          )))}
        </tbody>
      </table>
    </div>
  );
}

// The last answer in full: every check, the key set, what the backend would get, and the decoded token.
export function ResultCard({ result }) {
  if (!result) return <p className="empty">Send a request to see the gateway's checks.</p>;
  const t = result.token;
  return (
    <div className="fedid-result" data-testid="fedid-result" data-decision={result.decision} data-reason={result.reason || ""}>
      <p className="fedid-result__head"><Answer decision={result.decision} status={result.status} /> <strong>{result.reason ? REASON_TEXT[result.reason] || result.reason : "every check passed"}</strong>
        {result.minted ? " (the platform minted a new token for this request)" : " (the held token was reused)"}</p>
      <ul className="fedid-checks">
        {result.checks.map((c) => (
          <li key={c.id} data-ok={String(c.ok)} data-testid={`fedid-check-${c.id}`}>
            <span aria-hidden="true">{c.ok ? "✓" : "✕"}</span> {CHECK_TEXT[c.id] || c.id}: <strong>{c.ok ? "pass" : "FAIL"}</strong> <ClaimTag tag={c.tag} />
          </li>
        ))}
      </ul>
      <p data-testid="fedid-token-valid">The token itself is <strong>{result.tokenStillValid ? "still valid" : "not valid"}</strong> (algorithm, signature, lifetime, expiry and binding). {result.reason === "identity_revoked" ? "It is the identity, not the token, that is refused." : ""}</p>
      {result.keySet && <p>Key set for the issuer: <strong>{result.keySet.source}</strong>, {result.keySet.ageSec} s old, issuer {result.keySet.issuerReachable ? "reachable" : "NOT reachable (last known good set used)"}.</p>}
      {result.deployment ? <p>Attributed in audit to deployment <code>{result.deployment.subject}</code> (identity <code>{result.deployment.identity}</code>).</p> : <p>Not attributed to a deployment (the signature or the binding did not verify).</p>}
      {result.backend && <p data-testid="fedid-backend">Backend gets the application's own credential <code>{result.backend.credentialId}</code> ({result.backend.kind}). Workload token forwarded: <strong>{result.backend.workloadTokenForwarded ? "YES" : "no"}</strong> (computed from what the gateway built).</p>}
      {t && (
        <details className="fedid-token">
          <summary>Decoded token (mock-issued) <ClaimTag tag="lab-invented" /></summary>
          <pre data-testid="fedid-claims">{JSON.stringify({ header: t.header, claims: t.claims }, null, 2)}</pre>
          {t.raw && <><p className="hint">{t.rawLabel}. Signed with a throwaway key made in this process. Shown here only; it is in no other response.</p><pre className="fedid-raw" data-testid="fedid-raw">{t.raw}</pre></>}
        </details>
      )}
    </div>
  );
}

const find = (identities, state) => identities.find((i) => i.state === state) || null;

// What is cut, what stays valid, and what the deck does not say. Every number here is computed from the results the page is showing.
export function CutStaysSaid({ identities, forwardedTokens, keySets, outage, notSaid, source }) {
  const revoked = find(identities, "revoked");
  const other = identities.filter((i) => i.state !== "revoked");
  const a = revoked?.summary.afterRevoke || null;
  const rows = revoked ? revoked.summary.matrix : [];
  return (
    <div className="fedid-trio" data-testid="fedid-trio">
      <section className="panel fedid-card" aria-labelledby="fedid-cut-h" data-testid="fedid-cut">
        <h3 id="fedid-cut-h">What is cut</h3>
        {!revoked ? <p className="empty">Nothing yet. {source === "mock" ? "The Mock table has no revoke." : "Revoke the billing identity in Live, or Run the story."}</p> : (
          <>
            <p><strong>{revoked.id}</strong> was revoked by {revoked.revokedBy}. <ClaimTag tag="deck claim" /> Deck: revoking the identity cuts the workload off <strong>immediately</strong>; it gives no number.</p>
            <div className="fedid-scroll">
              <table className="fedid-table fedid-table--small" data-testid="fedid-matrix">
                <thead><tr><th>Service</th><th>Presented</th><th>Last answer after the revoke</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.service}-${r.via}`} data-decision={r.decision || "none"}>
                      <td>{r.service}</td><td>{viaText(r.via)}</td>
                      <td>{r.decision ? <><Answer decision={r.decision} status={r.status} /> {REASON_TEXT[r.reason] || ""}</> : "not tried yet"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="fedid-measured" data-testid="fedid-measured"><ClaimTag tag="measured (our note)" /> After the revoke, {a.refused} of {a.requests} requests from this identity were refused and {a.allowed} were allowed;{" "}
              {a.firstDecision ? <>the first one after the revoke was <strong>{a.firstDecision.decision}</strong> ({REASON_TEXT[a.firstDecision.reason] || a.firstDecision.reason}).</> : "none was tried yet."} This counts requests in this lab's model; it says nothing about Ping's timing. <ClaimTag tag="lab reading" /></p>
          </>
        )}
      </section>

      <section className="panel fedid-card" aria-labelledby="fedid-stays-h" data-testid="fedid-stays">
        <h3 id="fedid-stays-h">What stays valid</h3>
        <ul className="fedid-list">
          <li><ClaimTag tag="lab reading" /> The platform's token itself: {revoked && a && a.requests > 0 ? <><strong>{a.tokenStillValid} of {a.requests}</strong> post-revoke requests carried a token whose signature, binding, lifetime and expiry all still passed.</> : "after a revoke its signature, binding, lifetime and expiry still pass; only the identity is refused."}{revoked && a && a.requests > 0 ? <> <ClaimTag tag="measured (our note)" /></> : null}</li>
          <li><ClaimTag tag="lab reading" /> The platform keeps issuing tokens: {revoked && a ? <><strong>{a.reminted}</strong> new token(s) were minted after the revoke and the gateway refused them all. </> : null}The platform does not know about the revoke.</li>
          <li><ClaimTag tag="lab reading" /> Other identities: {other.map((i) => `${i.id} is ${i.state}${i.summary.sinceFirstRevoke ? ` (${i.summary.sinceFirstRevoke.allowed} of ${i.summary.sinceFirstRevoke.requests} requests since the revoke allowed)` : ""}`).join("; ")}.</li>
          <li><ClaimTag tag="deck claim" /> Backend credentials: the application's own configured credential is what a backend sees, never the workload's token (workload token forwarded: <strong data-testid="fedid-forwarded">{forwardedTokens}</strong> times, computed). <ClaimTag tag="lab reading" /> A revoke does not touch them.</li>
          <li><ClaimTag tag="deck claim" /> The issuer's key set is cached and refreshed every fifteen minutes; the last known good set is kept through an outage. Now: {Object.entries(keySets).map(([k, v]) => `${k} ${v.ageSec} s old`).join(", ")}; issuer {outage ? "DOWN" : "up"}.</li>
        </ul>
      </section>

      <section className="panel fedid-card" aria-labelledby="fedid-said-h" data-testid="fedid-said">
        <h3 id="fedid-said-h">What the deck does not say</h3>
        <ul className="fedid-list">
          {notSaid.map((n) => (
            <li key={n.id} data-testid="fedid-notsaid"><strong>{n.question}</strong> {n.deck} Lab: {n.lab} <ClaimTag tag={n.tag} /></li>
          ))}
        </ul>
      </section>
    </div>
  );
}
