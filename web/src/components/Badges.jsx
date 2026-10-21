import React from "react";
import { STATE_GLYPH, STATE_TEXT } from "../lib/format.js";

export function StatePill({ state, reason }) {
  return (
    <span className={`pill s-${state}`} data-state={state}>
      <span aria-hidden="true">{STATE_GLYPH[state] || "?"}</span> {STATE_TEXT[state] || state}
      {reason && state !== "armed" ? <span className="pill-reason"> / {reason}</span> : null}
    </span>
  );
}

// Marks text that describes how a real product might behave. It is a model from the demo environment, nothing more.
export function ModelBadge({ children = "MODEL, UNVERIFIED" }) {
  return (
    <span className="badge model" title="As modelled in the demo environment, UNVERIFIED against product documentation. No claim about real product defaults, limits or latency.">
      {children}
    </span>
  );
}

export function ModelNote({ children }) {
  return (
    <p className="model-note"><ModelBadge /> <span>{children}</span></p>
  );
}
