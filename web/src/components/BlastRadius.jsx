import React from "react";
import { StatePill } from "./Badges.jsx";
import { agentName } from "../lib/format.js";

export default function BlastRadius({ agents, global }) {
  const stopped = agents.filter((a) => a.state === "tripped" || a.state === "killed");
  const ok = agents.filter((a) => a.state === "armed" || a.state === "reset");
  let verdict = "Both agents are running. Kill one and watch only that one stop.";
  if (global.state === "killed") verdict = "The global switch is on: every agent is stopped. That is the wide blast radius, used when you cannot tell which agent is at fault.";
  else if (stopped.length && ok.length) verdict = `${stopped.map((a) => agentName(a.id)).join(", ")} stopped; ${ok.map((a) => agentName(a.id)).join(", ")} keeps working. Tokens, budget and rate window belong to one identity, so the stop stays with it.`;
  else if (stopped.length === agents.length) verdict = "Both agents are stopped.";
  return (
    <section className="panel" aria-labelledby="blast-h">
      <h2 id="blast-h">Blast radius</h2>
      <p className="lesson" data-testid="blast-verdict" role="status">{verdict}</p>
      <div className="blast">
        {agents.map((a) => (
          <div key={a.id} className={`blast-card s-${a.state}`} data-testid={`blast-${a.id}`}>
            <strong>{agentName(a.id)}</strong>
            <StatePill state={a.state} />
            <dl>
              <dt>allowed</dt><dd>{a.usage.calls}</dd>
              <dt>refused</dt><dd>{a.usage.denied}</dd>
              <dt>live tokens</dt><dd>{a.liveTokens}</dd>
              <dt>can get a new token</dt><dd>{a.issuanceDisabled ? "no" : "yes"}</dd>
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
