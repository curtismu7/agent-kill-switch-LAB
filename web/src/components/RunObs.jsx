// Rule 27: the shared run-observability panel under the run controls. This demo has no Real mode (no real server to call), so the page
// never asks the server for a Real record: in Real (a test seam only) it says so instead of showing a mock record under a Real label.
import React, { useEffect, useState } from "react";
import RunObservability from "../run-observability/RunObservability";
import { getRunObservability } from "../lib/api.js";

// Where this lab's own log line lives and where it can stream (the README says the same).
export const RUN_OBS_STREAMS = [
  { product: "Agent Kill Switch server (this lab)", lives: "the lab container's stdout: one timestamped line per gateway, token-service, tool and operator event (actor, agent, result, cause, run; never a token)", streams: "the family log collector to demo-logs-agent-kill-switch, then a SIEM, when the collector is set to watch this container (the lab does not ship them itself)" },
  { product: "PingOne Authorize, Privilege, the agent gateway", lives: "not run by this lab: its gateway, token service and tools are mocks in one process", streams: "nothing to stream" },
];

const TITLE = "What each layer logged for this run";
const Note = ({ testId, children }) => (
  <section className="ro" data-testid={testId} aria-label={TITLE}>
    <h2>{TITLE}</h2>
    <p className="ro-muted">{children}</p>
  </section>
);

// `tick` changes whenever the lab stored a new event, so the record is read again; the previous record stays on screen while that happens.
export default function RunObs({ run, tick, source }) {
  const [state, setState] = useState(null); // null = nothing asked yet, { pending } = in flight, { record, message } = answered
  useEffect(() => {
    let live = true;
    if (!run || source !== "mock") { setState(null); return undefined; }
    setState((s) => ({ ...(s || {}), pending: true }));
    getRunObservability().then(
      (b) => { if (live) setState(b && "record" in b ? { record: b.record, message: b.message } : { record: b }); },
      (e) => { if (live) setState({ record: { error: e.code || "unreachable", message: e.message || "Could not reach the server." } }); },
    );
    return () => { live = false; };
  }, [run, tick, source]);

  if (source !== "mock") {
    return <Note testId="ro-real-not-offered">Not offered in Real mode. This demo is mock only by design: it has no real server whose logs could be read, so nothing is shown rather than something made up. Switch to Mock to see the simulated record.</Note>;
  }
  if (run && (!state || (state.pending && !state.record))) return <Note testId="ro-loading">Collecting this run's logs...</Note>;
  return (
    <>
      <RunObservability record={run && state ? state.record : null} source="mock" streams={RUN_OBS_STREAMS} />
      <p className="ro-muted ro-lab-note" data-testid="ro-lab-note">
        Times are the scenario clock: it starts at the wall-clock time the demo opened and moves only when the script moves. Under Person is an operator name typed into a form (the lab has no sign-in). Under Agent is the stub token service. Under Resource server is a mock tool timer: the mock tools return nothing. Nothing here was read from a product log.
      </p>
    </>
  );
}
