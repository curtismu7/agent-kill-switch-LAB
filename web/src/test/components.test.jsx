import React from "react";
import { render, screen } from "@testing-library/react";
import Flow from "../components/Flow.jsx";
import Gauges from "../components/Gauges.jsx";
import GapTimeline from "../components/GapTimeline.jsx";
import BlastRadius from "../components/BlastRadius.jsx";
import { agent } from "./fixtures.js";

test("rate gauge shows the window count with the cap, and the cell count is the cap", () => {
  render(<Gauges agents={[agent({ rate: { inWindow: 4, max: 5, windowMs: 10000 } })]} />);
  const m = screen.getByRole("meter", { name: "Calls in the rate window" });
  expect(m).toHaveAttribute("aria-valuenow", "4");
  expect(m).toHaveAttribute("aria-valuemax", "5");
  expect(m.querySelectorAll(".cell")).toHaveLength(5);
  expect(m.querySelectorAll(".cell.on")).toHaveLength(4);
  expect(screen.getByText(/cap 5/)).toBeInTheDocument();
});

test("money gauge burns down: remaining shrinks as spend grows, cap line at the empty end", () => {
  const spent = agent({ usage: { calls: 3, denied: 0, tokens: 2100, tokensIn: 1500, tokensOut: 600, micros: 40000 }, budget: { tokensLeft: 17900, microsLeft: 10000 } });
  render(<Gauges agents={[spent]} />);
  const m = screen.getByRole("meter", { name: "Money budget left" });
  expect(m).toHaveAttribute("aria-valuenow", "10000");
  expect(m.querySelector(".fill").style.width).toBe("20%");
  expect(m.className).toMatch(/hot/);
  expect(m.querySelector(".capline")).toBeTruthy();
  expect(screen.getByText(/\$0\.0100 left of \$0\.0500/)).toBeInTheDocument();
});

test("the diagram has the eight boxes and highlights where the last call stopped", () => {
  render(<Flow path={{ nodes: ["agent", "revoke", "rate"], edges: ["e-call"], bad: "rate" }} counts={{ agent: 6 }} theme="light" caption="c" />);
  expect(document.querySelectorAll(".react-flow__node")).toHaveLength(8);
  for (const t of ["Token service", "Kill switch", "Audit trail", "Agent", "1 Revocation check", "2 Rate cap", "3 Cost cap", "Tools"]) expect(screen.getByText(t)).toBeInTheDocument();
  expect(document.querySelector('[data-node="rate"]').className).toMatch(/\bbad\b/);
  expect(document.querySelector('[data-node="tools"]').className).toMatch(/\bdim\b/);
  expect(screen.getByText("c")).toBeInTheDocument();
});

test("gap timeline reports the gap, the leaked calls and the lesson for local validation", () => {
  const T = Date.parse("2026-01-01T12:00:00.000Z");
  const gap = { agentId: "agent-alpha", kind: "kill", stopAt: T, leaked: [{ at: T + 5000, callId: "c1" }, { at: T + 10000, callId: "c2" }], firstDeniedAt: T + 20000, cause: "token_revoked" };
  render(<GapTimeline gap={gap} tokens={[]} config={{ tokenValidation: "local", flagCheck: false, revocationSyncMs: 30000, tokenTtlMs: 60000 }} nowMs={T + 30000} />);
  expect(screen.getByTestId("gap-summary")).toHaveTextContent(/20 s.*2 calls got through/);
  expect(screen.getByTestId("gap-lesson")).toHaveTextContent(/Shorter lifetimes/);
  expect(screen.getByText(/nothing here is a claim about their latency/)).toBeInTheDocument();
});

test("gap timeline with nothing stopped says so, and a trip has no gap", () => {
  const { rerender } = render(<GapTimeline gap={null} tokens={[]} config={{}} nowMs={0} />);
  expect(screen.getByText(/Nothing has been stopped yet/)).toBeInTheDocument();
  const T = Date.parse("2026-01-01T12:00:00.000Z");
  rerender(<GapTimeline gap={{ agentId: "agent-alpha", kind: "trip", stopAt: T, leaked: [], firstDeniedAt: T, reason: "rate_cap" }} tokens={[]} config={{ tokenValidation: "introspect", flagCheck: true, revocationSyncMs: 1, tokenTtlMs: 1 }} nowMs={T} />);
  expect(screen.getByTestId("gap-lesson")).toHaveTextContent(/no gap/);
});

test("blast radius: one stopped, one still running", () => {
  render(<BlastRadius agents={[agent({ state: "killed" }), agent({ id: "agent-beta" })]} global={{ state: "armed" }} />);
  expect(screen.getByTestId("blast-verdict")).toHaveTextContent(/alpha stopped; beta keeps working/);
  render(<BlastRadius agents={[agent(), agent({ id: "agent-beta" })]} global={{ state: "killed" }} />);
  expect(screen.getAllByTestId("blast-verdict")[1]).toHaveTextContent(/global switch is on/);
});
