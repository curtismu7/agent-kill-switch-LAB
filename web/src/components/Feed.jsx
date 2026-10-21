import React from "react";
import { clock } from "../lib/format.js";
import { describeEvent } from "../lib/derive.js";

const TONE = { ok: ["ok", "✓"], bad: ["bad", "✕"], warn: ["warn", "▲"], info: ["info", "·"] };
const SHOWN = ["call_allowed", "call_denied", "call_completed", "call_cancelled", "token_issued", "token_refused", "trip", "kill", "unrevoke", "auto_reset", "scenario_start", "scenario_end", "reset"];

export default function Feed({ events }) {
  const rows = events.filter((e) => SHOWN.includes(e.type)).slice(-60).reverse();
  return (
    <section className="panel" aria-labelledby="feed-h">
      <h2 id="feed-h">Live activity</h2>
      {rows.length === 0 ? <p className="empty">No activity yet. Pick a scenario and press Run, Step or Simulate.</p> : (
        <ol className="feed" role="log" aria-label="Agent and gateway activity, newest first" data-testid="feed">
          {rows.map((e) => {
            const d = describeEvent(e);
            const [cls, glyph] = TONE[d.tone] || TONE.info;
            return (
              <li key={e.seq} className={`row ${cls} ${e.type}`} data-type={e.type}>
                <span className="glyph" aria-hidden="true">{glyph}</span>
                <time>{clock(e.at)}</time>
                <span className="txt">{d.text}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
