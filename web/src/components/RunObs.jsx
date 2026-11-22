// Rule 27: the shared run-observability panel under the run controls. This demo has no Real mode (no real server to call), so the page
// never asks the server for a Real record: in Real (a test seam only) it says so instead of showing a mock record under a Real label.
import React, { useEffect, useState } from "react";
import RunObservability from "../run-observability/RunObservability";
import { getRunObservability } from "../lib/api.js";

// Where this lab's own log line lives and where it can stream (the README says the same).
export const RUN_OBS_STREAMS = [
  { product: "Agent Kill Switch server (this lab)", lives: "the lab container's stdout: one line per gateway, token-service and operator event (actor, agent, result, cause, run; never a token), stamped with the scenario clock", streams: "nowhere today: the family log collector does not read this container, and its source list would need an entry for it. If it did, the SIEM time would be Docker's wall-clock time per line; the scenario time would stay inside the line" },
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
  const [answer, setAnswer] = useState(null); // the last answer's stdoutOnly: { count, steps }
  const hasRun = Boolean(run);
  const [state, setState] = useState(null); // null = nothing asked yet, { pending } = in flight, { record, message } = answered
  useEffect(() => {
    let live = true;
    if (!hasRun || source !== "mock") { setState(null); setAnswer(null); return undefined; }
    setState((s) => ({ ...(s || {}), pending: true }));
    getRunObservability().then(
      (b) => { if (live) { setState(b && "record" in b ? { record: b.record, message: b.message } : { record: b }); setAnswer(b?.stdoutOnly || null); } },
      (e) => { if (live) setState({ record: { error: e.code || "unreachable", message: e.message || "Could not reach the server." } }); },
    );
    return () => { live = false; };
  }, [hasRun, run?.id, run?.cursor, run?.done, tick, source]); // not `run` itself: every poll hands over a new object

  if (source !== "mock") {
    return <Note testId="ro-real-not-offered">Not offered in Real mode. This demo is mock only by design: it has no real server whose logs could be read, so nothing is shown rather than something made up. Switch to Mock to see the simulated record.</Note>;
  }
  if (run && (!state || (state.pending && !state.record))) return <Note testId="ro-loading">Collecting this run's logs...</Note>;
  return (
    <>
      <RunObservability record={run && state ? state.record : null} source="mock" streams={RUN_OBS_STREAMS} />
      <p className="ro-muted ro-lab-note" data-testid="ro-lab-note">
        Times are the scenario clock: it starts at the wall-clock time the demo opened and moves only when the script moves. Under Person is an operator name typed into a form (the lab has no sign-in). Under Agent is the stub token service. Under Agent gateway is the mock gateway, including its in-flight tracker: its row is stamped when the tracker ran, and says when the call was due to end. The Resource server has no log: the mock tools return nothing. Nothing here was read from a product log.
      </p>
      {answer?.count > 0 && (
        <p className="ro-muted" data-testid="ro-stdout-only">
          {answer.count} {answer.count === 1 ? "event" : "events"} since this run ended {answer.count === 1 ? "is" : "are"} on stdout only, in no record: {Object.keys(answer.steps).join(", ")}.
        </p>
      )}
    </>
  );
}
