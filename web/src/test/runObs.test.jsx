// Rule 27 on this lab's page: the shared panel under the run controls. Mock only (this demo has no Real mode); empty, pending, answered, error.
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import * as api from "../lib/api.js";
import RunObs, { RUN_OBS_STREAMS } from "../components/RunObs.jsx";
import { setJsonView } from "../components/JsonPane.jsx";
import { mockRecord, realRecord } from "../run-observability/fixtures.js";

vi.mock("../lib/api.js");
const RUN = { id: "run-1", scenario: "manual-kill", cursor: 3, total: 7, done: false };
beforeEach(() => { vi.resetAllMocks(); setJsonView("form"); });

test("before a run it shows the empty state and does not ask the server", () => {
  render(<RunObs run={null} tick={0} source="mock" />);
  expect(screen.getByTestId("ro-empty").textContent).toMatch(/Run the demo/);
  expect(api.getRunObservability).not.toHaveBeenCalled();
});

test("while the answer is pending it says so, and a no-record answer is shown, not dropped", async () => {
  let release;
  api.getRunObservability.mockReturnValue(new Promise((r) => { release = r; }));
  render(<RunObs run={RUN} tick={0} source="mock" />);
  expect(screen.getByTestId("ro-loading")).toBeTruthy();
  expect(screen.queryByTestId("ro-empty")).toBeNull();
  release({ record: null, message: "No run yet in this workspace." });
  await waitFor(() => expect(screen.getByTestId("ro-empty")).toBeTruthy());
});

test("after a run: the mock record, every row simulated, the Mock wording, where the logs live, and what the times and lanes are", async () => {
  api.getRunObservability.mockResolvedValue({ record: mockRecord });
  render(<RunObs run={RUN} tick={0} source="mock" />);
  await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
  expect(screen.getByTestId("ro-basis").textContent).toMatch(/^Simulated/);
  expect(document.querySelector('tr[data-origin="logged"]')).toBeNull();
  expect(document.querySelectorAll('tr[data-origin="simulated"]').length).toBeGreaterThan(1);
  expect(screen.getByTestId("ro-streams").textContent).toMatch(/demo-logs-agent-kill-switch/);
  expect(RUN_OBS_STREAMS.length).toBe(2);
  expect(screen.getByTestId("ro-lab-note").textContent).toMatch(/scenario clock.*typed into a form.*stub token service.*mock tool timer/s);
});

test("a new event asks again, and the previous record stays on screen while that is pending", async () => {
  api.getRunObservability.mockResolvedValue({ record: mockRecord });
  const { rerender } = render(<RunObs run={RUN} tick={1} source="mock" />);
  await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
  api.getRunObservability.mockReturnValue(new Promise(() => {}));
  rerender(<RunObs run={{ ...RUN }} tick={2} source="mock" />);
  expect(api.getRunObservability).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("ro-table")).toBeTruthy();
  expect(screen.queryByTestId("ro-loading")).toBeNull();
});

test("long names stay inside the panel as text (no markup)", async () => {
  const LONG = "long-operator-name-".repeat(12);
  const long = { ...mockRecord, rows: mockRecord.rows.map((r, i) => (i === 0 ? { ...r, message: `Operator "${LONG}" <img src=x onerror=alert(1)>`, detail: { operator: LONG } } : r)) };
  api.getRunObservability.mockResolvedValue({ record: long });
  const { container } = render(<RunObs run={RUN} tick={0} source="mock" />);
  await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
  expect(container.querySelector("img, script")).toBeNull();
  expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
});

test("a record built in the other mode is refused on screen, not shown under the Mock label", async () => {
  api.getRunObservability.mockResolvedValue({ record: realRecord });
  render(<RunObs run={RUN} tick={0} source="mock" />);
  await waitFor(() => expect(screen.getByTestId("ro-mismatch")).toBeTruthy());
  expect(screen.queryByTestId("ro-table")).toBeNull();
});

test("a structured server error (Rule 23) and a network failure are shown, never blank", async () => {
  api.getRunObservability.mockResolvedValue({ error: "internal_error", message: "The run observability record could not be built." });
  const { unmount } = render(<RunObs run={RUN} tick={0} source="mock" />);
  await waitFor(() => expect(screen.getByTestId("ro-error").textContent).toMatch(/could not be built/));
  unmount();
  api.getRunObservability.mockRejectedValue(new Error("HTTP 500"));
  render(<RunObs run={RUN} tick={1} source="mock" />);
  await waitFor(() => expect(screen.getByTestId("ro-error").textContent).toMatch(/HTTP 500/));
});

test("in Real (a test seam only) it says Real is not offered and never asks the server or shows a mock record under a Real label", () => {
  render(<RunObs run={RUN} tick={0} source="real" />);
  expect(screen.getByTestId("ro-real-not-offered").textContent).toMatch(/mock only by design/);
  expect(api.getRunObservability).not.toHaveBeenCalled();
  expect(screen.queryByTestId("ro-table")).toBeNull();
});
