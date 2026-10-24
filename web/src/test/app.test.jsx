import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../lib/api.js";
import App from "../App.jsx";
import { agent, ev, snapshot } from "./fixtures.js";

vi.mock("../lib/api.js");
const SCEN = [{ id: "normal", title: "Normal agent", summary: "s", teaches: "t", steps: 6, expect: [] }, { id: "manual-kill", title: "Manual kill mid-run", summary: "s2", teaches: "t2", steps: 7, expect: [] }];

function setup({ state = snapshot(), events = [] } = {}) {
  let current = state; let evs = events; let head = events.length;
  api.getHealth.mockResolvedValue({ schema: "demo-health/1", state: "ready" });
  api.getScenarios.mockResolvedValue({ scenarios: SCEN });
  api.getState.mockImplementation(async () => current);
  api.getEvents.mockImplementation(async (since) => { const out = evs.filter((e) => e.seq > since); return { events: out, next: out.length ? out.at(-1).seq : since, head }; });
  api.getAudit.mockResolvedValue({ entries: [], size: 0 });
  return { set(s, e = []) { current = s; evs = [...evs, ...e]; head = evs.length; } };
}
beforeEach(() => { vi.resetAllMocks(); });

test("it shows the DEMO and UNVERIFIED badges, the four-step story and both agents", async () => {
  setup();
  render(<App />);
  expect(await screen.findByTestId("mode-badge")).toHaveTextContent("DEMO");
  expect(screen.getAllByText(/MODEL, UNVERIFIED/).length).toBeGreaterThan(0);
  expect(screen.getByText("The next call fails")).toBeInTheDocument();
  expect(await screen.findByTestId("gauges-agent-alpha")).toBeInTheDocument();
  expect(screen.getByTestId("gauges-agent-beta")).toBeInTheDocument();
  expect(screen.getByText(/UNVERIFIED against product documentation/)).toBeInTheDocument();
});

test("Run asks the server to run the selected scenario and announces the result", async () => {
  setup();
  api.runScenario.mockResolvedValue({ run: { total: 6, expectation: { ok: true } } });
  render(<App />);
  await screen.findByTestId("gauges-agent-alpha");
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(api.runScenario).toHaveBeenCalledWith("normal");
  await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent(/Reached the expected end state/));
  expect(screen.getByTestId("run-status")).toHaveAttribute("aria-live", "polite");
});

test("Kill sends the operator name and scope, and the stop is announced in an alert region", async () => {
  const h = setup();
  api.postKill.mockImplementation(async () => {
    h.set(snapshot({ agents: [agent({ state: "killed", reason: "manual", stoppedAt: "2026-01-01T12:00:10.000Z" }), agent({ id: "agent-beta" })] }), [ev("kill", "agent-alpha", { operator: "ann", tokensRevoked: 1, inFlightCount: 0, inFlightMode: "finish" })]);
    return { ok: true };
  });
  render(<App />);
  await screen.findByTestId("switch-agent-alpha");
  await userEvent.clear(screen.getByLabelText("Operator name"));
  await userEvent.type(screen.getByLabelText("Operator name"), "ann");
  await userEvent.click(screen.getByRole("button", { name: "Kill agent-alpha" }));
  expect(api.postKill).toHaveBeenCalledWith(expect.objectContaining({ scope: "agent", agentId: "agent-alpha", operator: "ann", inFlight: "finish" }));
  await waitFor(() => expect(screen.getByTestId("stop-alert")).toHaveTextContent(/agent-alpha killed by ann/));
  expect(screen.getByTestId("stop-alert")).toHaveAttribute("role", "alert");
  expect(within(screen.getByTestId("switch-agent-alpha")).getByRole("button", { name: "Kill agent-alpha" })).toBeDisabled();
});

test("Unrevoke needs a confirm step and an operator name", async () => {
  setup({ state: snapshot({ agents: [agent({ state: "killed", reason: "manual", stoppedAt: "2026-01-01T12:00:05.000Z" }), agent({ id: "agent-beta" })] }) });
  api.postUnrevoke.mockResolvedValue({ ok: true });
  render(<App />);
  const sw = await screen.findByTestId("switch-agent-alpha");
  await userEvent.click(within(sw).getByRole("button", { name: "Unrevoke" }));
  expect(api.postUnrevoke).not.toHaveBeenCalled();
  expect(within(sw).getByRole("alertdialog")).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText("Operator name"));
  expect(within(sw).getByRole("button", { name: "Confirm unrevoke" })).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Operator name"), "bo");
  await userEvent.click(within(sw).getByRole("button", { name: "Confirm unrevoke" }));
  expect(api.postUnrevoke).toHaveBeenCalledTimes(1);
  expect(api.postUnrevoke).toHaveBeenCalledWith(expect.objectContaining({ scope: "agent", agentId: "agent-alpha", operator: "bo" }));
});

test("Unrevoke is disabled for an agent that is running, and Cancel backs out without a request", async () => {
  setup({ state: snapshot({ agents: [agent({ state: "tripped", reason: "rate_cap" }), agent({ id: "agent-beta" })] }) });
  render(<App />);
  expect(within(await screen.findByTestId("switch-agent-beta")).getByRole("button", { name: "Unrevoke" })).toBeDisabled();
  const sw = screen.getByTestId("switch-agent-alpha");
  await userEvent.click(within(sw).getByRole("button", { name: "Unrevoke" }));
  await userEvent.click(within(sw).getByRole("button", { name: "Cancel" }));
  expect(api.postUnrevoke).not.toHaveBeenCalled();
});

test("hostile strings from the server are shown as text, never as markup", async () => {
  const evil = '<img src=x onerror="window.pwned=1">';
  setup({ events: [ev("call_denied", "agent-alpha", { tool: evil, stage: "state", reason: "agent_killed" })] });
  render(<App />);
  const feed = await screen.findByTestId("feed");
  expect(feed).toHaveTextContent(evil);
  expect(feed.querySelector("img")).toBeNull();
  expect(window.pwned).toBeUndefined();
});

test("a reset event empties the feed and the token list", async () => {
  const h = setup({ events: [ev("token_issued", "agent-alpha", { tokenId: "tok-0001", ttlMs: 60000, expiresAt: "2026-01-01T12:01:00.000Z" })] });
  render(<App />);
  expect(await screen.findByTestId("tokens")).toHaveTextContent("tok-0001");
  await act(async () => { h.set(snapshot(), [ev("reset", null, {})]); await new Promise((r) => setTimeout(r, 1700)); });
  await waitFor(() => expect(screen.queryByTestId("tokens")).toBeNull());
}, 10000);

test("Verify shows the server's answer, and a broken chain is called broken", async () => {
  setup();
  api.verifyAudit.mockResolvedValueOnce({ ok: true, length: 3, headHash: "abcdef0123456789" }).mockResolvedValueOnce({ ok: false, firstBadSeq: 2, reason: "hash_mismatch" });
  render(<App />);
  await screen.findByTestId("verify-result");
  await userEvent.click(screen.getByRole("button", { name: "Verify chain" }));
  await waitFor(() => expect(screen.getByTestId("verify-result")).toHaveTextContent(/Chain intact: 3 entries/));
  await userEvent.click(screen.getByRole("button", { name: "Verify chain" }));
  await waitFor(() => expect(screen.getByTestId("verify-result")).toHaveTextContent(/BROKEN at entry 2: hash_mismatch/));
});

test("the theme toggle flips data-theme", async () => {
  setup();
  render(<App />);
  await screen.findByTestId("mode-badge");
  const before = document.documentElement.getAttribute("data-theme");
  await userEvent.click(screen.getByRole("button", { name: /theme/ }));
  expect(document.documentElement.getAttribute("data-theme")).not.toBe(before);
});

test("a hosted build shows the HOSTED SIMULATION banner on the page; a local build does not", async () => {
  setup({ state: snapshot({ hosted: true }) });
  render(<App />);
  expect(await screen.findByTestId("hosted-banner")).toHaveTextContent("HOSTED SIMULATION");
});

test("a local build shows no hosted banner", async () => {
  setup({ state: snapshot({ hosted: false }) });
  render(<App />);
  await screen.findByTestId("mode-badge");
  expect(screen.queryByTestId("hosted-banner")).toBeNull();
});
