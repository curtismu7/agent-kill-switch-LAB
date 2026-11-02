// KS2 fix-pass pins for the web UI.
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../lib/api.js";
import App from "../App.jsx";
import Flow from "../components/Flow.jsx";
import { agent, ev, snapshot } from "./fixtures.js";

vi.mock("../lib/api.js");
const SCEN = [{ id: "normal", title: "Normal agent", summary: "s", teaches: "t", steps: 6, expect: [] }];
const doneRun = { id: "run-1", scenario: "normal", cursor: 6, total: 6, done: true, counts: {}, expectation: { ok: true, checks: [] }, transcript: [] };

function setup(state = snapshot(), events = []) {
  api.getHealth.mockResolvedValue({ schema: "demo-health/1", state: "ready" });
  api.getInfo.mockResolvedValue({ source: "mock", realAvailable: false, hosted: false, realReason: "Real mode is not available." });
  api.getScenarios.mockResolvedValue({ scenarios: SCEN });
  api.getState.mockResolvedValue(state);
  api.getEvents.mockImplementation(async (since) => { const out = events.filter((e) => e.seq > since); return { events: out, next: out.length ? out.at(-1).seq : since, head: events.length }; });
  api.getAudit.mockResolvedValue({ entries: [], size: 0 });
}
beforeEach(() => { vi.resetAllMocks(); });

test("Kill stays available while another request is in flight (the emergency control is never blocked by a slow Run)", async () => {
  setup();
  let release;
  api.runScenario.mockImplementation(() => new Promise((r) => { release = r; }));
  render(<App />);
  await screen.findByTestId("switch-agent-alpha");
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled(); // busy is really on
  expect(screen.getByRole("button", { name: "Kill agent-alpha" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Kill ALL agents" })).toBeEnabled();
  release({ run: { total: 6, expectation: { ok: true } } });
});

test("a skip link goes straight to the kill switch heading, which can take focus", async () => {
  setup();
  render(<App />);
  const link = await screen.findByRole("link", { name: "Skip to the kill switch" });
  expect(link).toHaveAttribute("href", "#kill-h");
  const target = document.getElementById("kill-h");
  expect(target).toHaveTextContent("Kill switch");
  expect(target).toHaveAttribute("tabindex", "-1");
});

test("diagram boxes are not tab stops", async () => {
  setup();
  const { container } = render(<App />);
  await screen.findByTestId("switch-agent-alpha");
  const nodes = container.querySelectorAll(".react-flow__node");
  expect(nodes.length).toBeGreaterThan(0);
  for (const n of nodes) expect(n.getAttribute("tabindex")).not.toBe("0");
});

test("Reset remounts the diagram so a dragged layout goes back", () => {
  const { container, rerender } = render(<Flow path={null} theme="light" resetKey={0} caption="c" />);
  const before = container.querySelector(".react-flow");
  rerender(<Flow path={null} theme="light" resetKey={1} caption="c" />);
  expect(container.querySelector(".react-flow")).not.toBe(before);
});

test("the activity feed is a labelled, keyboard-scrollable log containing a real list", async () => {
  setup(snapshot(), [ev("call_allowed", "agent-alpha", { callId: "call-0001", tool: "lookup", model: "demo-small", tokens: 700, costMicros: 195, budget: { tokensLeft: 1, microsLeft: 1 }, rate: { inWindow: 1, max: 5 } })]);
  render(<App />);
  const feed = await screen.findByTestId("feed");
  expect(feed.tagName).toBe("DIV");
  expect(feed).toHaveAttribute("role", "log");
  expect(feed).toHaveAttribute("tabindex", "0");
  expect(within(feed).getAllByRole("listitem").length).toBe(1);
  expect(feed.querySelector("ol > li")).not.toBeNull();
});

test("Run while an operator kill is in force shows the server's refusal and does not claim success", async () => {
  setup(snapshot({ operatorKills: ["agent-alpha"], agents: [agent({ state: "killed", reason: "manual", stoppedAt: "2026-01-01T12:00:05.000Z" }), agent({ id: "agent-beta" })] }));
  const err = Object.assign(new Error("an operator kill is in force: unrevoke it"), { status: 409, code: "kill_in_force" });
  api.runScenario.mockRejectedValue(err);
  api.stepScenario.mockRejectedValue(err);
  render(<App />);
  await screen.findByTestId("switch-agent-alpha");
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("an operator kill is in force: unrevoke it")).toBeInTheDocument();
  expect(screen.getByTestId("run-status")).not.toHaveTextContent(/Ran /);
  await userEvent.click(screen.getByRole("button", { name: "Step" }));
  await waitFor(() => expect(api.stepScenario).toHaveBeenCalled());
  expect(screen.getByText("an operator kill is in force: unrevoke it")).toBeInTheDocument();
  expect(screen.getByTestId("run-status")).not.toHaveTextContent(/finished/);
});

test("Simulate on a finished run does not Reset over an operator kill", async () => {
  setup(snapshot({ run: doneRun, operatorKills: ["agent-alpha"], agents: [agent({ state: "killed", reason: "manual", stoppedAt: "2026-01-01T12:00:05.000Z" }), agent({ id: "agent-beta" })] }));
  render(<App />);
  await screen.findByTestId("switch-agent-alpha");
  await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
  expect(api.postReset).not.toHaveBeenCalled();
  expect(api.stepScenario).not.toHaveBeenCalled();
  expect(screen.getByTestId("run-status")).toHaveTextContent(/operator kill is in force/);
});

test("Step on a finished run says so only for run_finished", async () => {
  setup(snapshot({ run: doneRun }));
  api.stepScenario.mockRejectedValue(Object.assign(new Error("x"), { status: 409, code: "run_finished" }));
  render(<App />);
  await screen.findByTestId("switch-agent-alpha");
  await userEvent.click(screen.getByRole("button", { name: "Step" }));
  await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent(/This run has finished/));
});

test("under prefers-reduced-motion the diagram edges stop animating", () => {
  const css = fs.readFileSync(path.resolve(process.cwd(), "src/app.css"), "utf8");
  const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
  expect(block).not.toBeNull();
  expect(block[1]).toMatch(/react-flow__edge[\s\S]*animation: none/);
});
