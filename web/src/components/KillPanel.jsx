import React, { useState } from "react";
import { ModelNote, StatePill } from "./Badges.jsx";
import { agentName, clock, reasonText } from "../lib/format.js";

function Confirm({ what, operator, onYes, onNo, busy }) {
  return (
    <div className="confirm" role="alertdialog" aria-label={`Confirm unrevoke ${what}`}>
      <p>Bring <strong>{what}</strong> back? This is an audited action under the name <strong>{operator || "(no name yet)"}</strong>. The agent needs a fresh token.</p>
      <button type="button" className="btn good" onClick={onYes} disabled={busy || !operator.trim()} autoFocus>Confirm unrevoke</button>
      <button type="button" className="btn" onClick={onNo}>Cancel</button>
    </div>
  );
}

function AgentSwitch({ a, operator, reason, inFlight, resetBudget, busy, onKill, onUnrevoke }) {
  const [asking, setAsking] = useState(false);
  const stopped = a.state === "tripped" || a.state === "killed";
  return (
    <article className={`card switch s-${a.state}`} aria-label={`Kill switch for ${a.id}`} data-testid={`switch-${a.id}`}>
      <header>
        <h3>{agentName(a.id)}</h3>
        <StatePill state={a.state} reason={a.reason && a.reason !== "manual" ? reasonText(a.reason) : null} />
      </header>
      <p className="hint">
        {a.state === "armed" && "Running. Checked on every call."}
        {a.state === "reset" && "Brought back; the next allowed call re-arms it."}
        {a.state === "tripped" && `Stopped by a cap${a.autoResetAt ? `; auto-reset due ${clock(a.autoResetAt)}` : "; needs an operator to unrevoke"}.`}
        {a.state === "killed" && `Revoked by an operator at ${clock(a.stoppedAt)}. Stays killed until an operator unrevokes.`}
        {a.stop?.gapMs != null && ` Gap to first refusal: ${a.stop.gapMs} ms.`}
      </p>
      <div className="switch-actions">
        <button type="button" className="btn kill" onClick={onKill} disabled={busy || a.state === "killed"} aria-label={`Kill ${a.id}`}>
          KILL<span>revoke {agentName(a.id)}</span>
        </button>
        {!asking && <button type="button" className="btn" onClick={() => setAsking(true)} disabled={busy || !stopped}>Unrevoke</button>}
      </div>
      {asking && stopped && <Confirm what={a.id} operator={operator} busy={busy} onNo={() => setAsking(false)} onYes={async () => { await onUnrevoke(); setAsking(false); }} />}
    </article>
  );
}

export default function KillPanel({ agents, global, operator, setOperator, reason, setReason, inFlight, setInFlight, resetBudget, setResetBudget, busy, onKill, onUnrevoke }) {
  const [askGlobal, setAskGlobal] = useState(false);
  return (
    <section className="panel hazard" aria-labelledby="kill-h">
      <h2 id="kill-h">Kill switch</h2>
      <ModelNote>Kill, trip, unrevoke and auto-reset are reproduced from the AI-DEMO2 demo environment. How a real PingOne product implements revoke is unverified here.</ModelNote>
      <div className="op-form">
        <label>Operator name<input value={operator} maxLength={40} onChange={(e) => setOperator(e.target.value)} autoComplete="off" /></label>
        <label>Reason (optional)<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoComplete="off" /></label>
        <label>Work already in flight
          <select value={inFlight} onChange={(e) => setInFlight(e.target.value)}>
            <option value="finish">finishes (default)</option>
            <option value="cancel">is cancelled</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={resetBudget} onChange={(e) => setResetBudget(e.target.checked)} /> Unrevoke also resets the spent budget</label>
      </div>
      <div className="switch-grid">
        {agents.map((a) => (
          <AgentSwitch key={a.id} a={a} operator={operator} reason={reason} inFlight={inFlight} resetBudget={resetBudget} busy={busy}
            onKill={() => onKill({ scope: "agent", agentId: a.id })} onUnrevoke={() => onUnrevoke({ scope: "agent", agentId: a.id })} />
        ))}
      </div>
      <div className="global-row" data-testid="global-switch">
        <strong>Global switch</strong>
        <StatePill state={global.state === "killed" ? "killed" : "armed"} />
        <button type="button" className="btn kill small" onClick={() => onKill({ scope: "global" })} disabled={busy || global.state === "killed"}>Kill ALL agents</button>
        {global.state === "killed" && !askGlobal && <button type="button" className="btn" onClick={() => setAskGlobal(true)} disabled={busy}>Unrevoke all</button>}
        {askGlobal && global.state === "killed" && <Confirm what="all agents" operator={operator} busy={busy} onNo={() => setAskGlobal(false)} onYes={async () => { await onUnrevoke({ scope: "global" }); setAskGlobal(false); }} />}
        {global.state === "killed" && global.gapMs != null && <span className="hint">gap to first refusal {global.gapMs} ms, {global.leakedCalls} leaked</span>}
      </div>
    </section>
  );
}
