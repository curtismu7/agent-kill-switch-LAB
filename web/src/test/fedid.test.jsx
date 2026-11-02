import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../lib/api.js";
import App, { RELEASE_BANNER } from "../App.jsx";
import FedIdTab from "../components/FedIdTab.jsx";
import { catalogue } from "../../../server/src/fedid/routes.js";
import { DEFAULT_CAST, VERTICALS, fillDeep } from "../../../server/src/cast.js";
import { buildDiagram } from "../../../server/src/fedid/diagram.js";
import { BANNER } from "../../../server/src/fedid/facts.js";
import { loadMock } from "../../../server/src/fedid/mock.js";
import { createAudit } from "../../../server/src/audit.js";
import { createFedId } from "../../../server/src/fedid/engine.js";
import { snapshot } from "./fixtures.js";

vi.mock("../lib/api.js");
const MOCK = loadMock();
const T = Date.UTC(2026, 10, 2, 9, 0, 0);
// A real engine behind the mocked API, so the page is driven by real answers.
function engineApi() {
  const e = createFedId({ audit: createAudit({ now: () => new Date(T) }), startMs: () => T, signing: "mock" });
  const state = () => structuredClone(e.state());
  api.getFedid.mockImplementation(async (v) => JSON.parse(JSON.stringify(catalogue(VERTICALS[v] || DEFAULT_CAST, VERTICALS[v] ? v : "finance"))));
  api.getFedidDiagram.mockResolvedValue(buildDiagram());
  api.getFedidMock.mockImplementation(async (v) => ({ mode: "mock", table: fillDeep(MOCK, VERTICALS[v] || DEFAULT_CAST) }));
  api.getFedidState.mockImplementation(async () => ({ state: state() }));
  api.postFedidRequest.mockImplementation(async (body) => {
    const r = e.request(body);
    if (!r.ok) { const err = new Error(r.message); err.status = r.status; throw err; }
    return { status: r.result.status, data: { result: { ...r.result, token: { ...r.result.token, raw: r.raw, rawLabel: "mock-issued" } }, state: state() } };
  });
  api.postFedidRevoke.mockImplementation(async (body) => { const r = e.revoke(body); if (!r.ok) throw new Error(r.message); return { state: state() }; });
  api.postFedidIssuer.mockImplementation(async (body) => { e.setIssuer(body); return { state: state() }; });
  api.postFedidAdvance.mockImplementation(async (body) => { const r = e.advance(body); if (!r.ok) throw new Error(r.message); return { state: state() }; });
  return e;
}
const props = (over = {}) => ({ mode: "live", setMode: vi.fn(), hosted: false, presenter: false, setPresenter: vi.fn(), theme: "light", resetSignal: 0, onReset: vi.fn(async () => {}), ...over });
beforeEach(() => { vi.resetAllMocks(); });

test("the banner words are the server's, and the Mock table shows the generated story", async () => {
  expect(RELEASE_BANNER).toBe(BANNER);
  engineApi();
  render(<FedIdTab {...props({ mode: "mock" })} />);
  expect(await screen.findByTestId("fedid-mock-table")).toBeInTheDocument();
  expect(screen.getAllByTestId("fedid-mock-row")).toHaveLength(18);
  expect(screen.getByTestId("fedid-mode-note")).toHaveTextContent(/Mock: a table generated from the engine/);
  expect(within(screen.getByTestId("fedid-cut")).getByTestId("fedid-measured")).toHaveTextContent(/6 of 6 requests from this identity were refused and 0 were allowed/);
  expect(screen.queryByTestId("fedid-controls")).toBeNull();
  expect(api.getFedidState).not.toHaveBeenCalled();
});

test("every claim row carries a tag from the list, and the roadmap item says no behaviour is built", async () => {
  engineApi();
  render(<FedIdTab {...props({ mode: "mock" })} />);
  await screen.findByTestId("fedid-mock-table");
  const tags = new Set(catalogue(DEFAULT_CAST, "finance").tags);
  document.querySelectorAll("[data-tag]").forEach((el) => expect(tags.has(el.getAttribute("data-tag"))).toBe(true));
  expect(screen.getByTestId("fedid-roadmap")).toHaveTextContent(/Agent Lifecycle Management.*Q4 2026.*No behaviour is claimed or modelled/);
});

test("Live: every field reaches the API exactly as typed (workload, service, presents, lifetime, revoke target, operator, reason, outage, seconds)", async () => {
  engineApi();
  const user = userEvent.setup();
  render(<FedIdTab {...props()} />);
  const send = await screen.findByTestId("fedid-send");
  await waitFor(() => expect(send).toBeEnabled());
  await user.selectOptions(screen.getByTestId("fedid-workload"), "fi-nightly-job");
  await user.selectOptions(screen.getByTestId("fedid-service"), "llm");
  await user.clear(screen.getByTestId("fedid-lifetime")); await user.type(screen.getByTestId("fedid-lifetime"), "90");
  await user.click(send);
  await waitFor(() => expect(api.postFedidRequest).toHaveBeenCalledWith({ workload: "fi-nightly-job", service: "llm", via: "token", lifetimeSec: 90 }));
  await user.selectOptions(screen.getByTestId("fedid-workload"), "fi-billing-agent");
  await user.selectOptions(screen.getByTestId("fedid-via"), "key");
  await user.click(screen.getByTestId("fedid-send"));
  await waitFor(() => expect(api.postFedidRequest).toHaveBeenLastCalledWith({ workload: "fi-billing-agent", service: "llm", via: "key", lifetimeSec: 90 }));
  await user.selectOptions(screen.getByTestId("fedid-target"), "fi-nightly-job");
  await user.clear(screen.getByTestId("fedid-operator")); await user.type(screen.getByTestId("fedid-operator"), "alex");
  await user.clear(screen.getByTestId("fedid-reason")); await user.type(screen.getByTestId("fedid-reason"), "because");
  await user.click(screen.getByTestId("fedid-revoke"));
  await waitFor(() => expect(api.postFedidRevoke).toHaveBeenCalledWith({ workload: "fi-nightly-job", operator: "alex", reason: "because" }));
  await user.click(screen.getByTestId("fedid-outage"));
  await waitFor(() => expect(api.postFedidIssuer).toHaveBeenCalledWith({ outage: true }));
  await waitFor(() => expect(screen.getByTestId("fedid-outage")).toBeChecked());
  await user.click(screen.getByTestId("fedid-outage"));
  await waitFor(() => expect(api.postFedidIssuer).toHaveBeenLastCalledWith({ outage: false }));
  await user.clear(screen.getByTestId("fedid-seconds")); await user.type(screen.getByTestId("fedid-seconds"), "45");
  await user.click(screen.getByTestId("fedid-advance"));
  await waitFor(() => expect(api.postFedidAdvance).toHaveBeenCalledWith({ seconds: 45 }));
});

test("Live: a revoke turns the next answer into a refusal that says the token is still valid; the cut panel is computed from the answers", async () => {
  engineApi();
  const user = userEvent.setup();
  render(<FedIdTab {...props()} />);
  await waitFor(() => expect(screen.getByTestId("fedid-send")).toBeEnabled());
  await user.click(screen.getByTestId("fedid-send"));
  await waitFor(() => expect(screen.getByTestId("fedid-result")).toHaveAttribute("data-decision", "allowed"));
  expect(screen.getByTestId("fedid-cut")).toHaveTextContent(/Nothing yet/);
  await user.click(screen.getByTestId("fedid-revoke"));
  await waitFor(() => expect(screen.getByTestId("fedid-status")).toHaveTextContent(/revoked/));
  await user.click(screen.getByTestId("fedid-send"));
  await waitFor(() => expect(screen.getByTestId("fedid-result")).toHaveAttribute("data-reason", "identity_revoked"));
  expect(screen.getByTestId("fedid-token-valid")).toHaveTextContent(/still valid/);
  expect(screen.getByTestId("fedid-check-identity_state")).toHaveAttribute("data-ok", "false");
  expect(screen.getByTestId("fedid-check-signature")).toHaveAttribute("data-ok", "true");
  expect(screen.getByTestId("fedid-measured")).toHaveTextContent(/1 of 1 requests from this identity were refused and 0 were allowed/);
  expect(screen.getByTestId("fedid-forwarded")).toHaveTextContent("0");
});

test("Live: a 400 from the server is shown as an error and changes nothing", async () => {
  engineApi();
  const user = userEvent.setup();
  render(<FedIdTab {...props()} />);
  await waitFor(() => expect(screen.getByTestId("fedid-send")).toBeEnabled());
  await user.clear(screen.getByTestId("fedid-lifetime")); await user.type(screen.getByTestId("fedid-lifetime"), "0");
  await user.click(screen.getByTestId("fedid-send"));
  expect(await screen.findByRole("alert")).toHaveTextContent(/wrong type or value/);
  expect(screen.queryAllByTestId("fedid-row")).toHaveLength(0);
});

test("STALE GUARD: a slow answer for an older state read never overwrites a newer result", async () => {
  engineApi();
  const user = userEvent.setup();
  const { rerender } = render(<FedIdTab {...props()} />);
  await waitFor(() => expect(screen.getByTestId("fedid-send")).toBeEnabled());
  let release; const slow = new Promise((r) => { release = r; });
  api.getFedidState.mockImplementationOnce(async () => { await slow; return { state: { ...(await api.getFedidState.getMockImplementation()?.call(null)).state, requests: 0, log: [], identities: [], keySets: {}, issuerOutage: false } }; });
  rerender(<FedIdTab {...props({ resetSignal: 1 })} />); // starts a state read that will be slow
  await user.click(screen.getByTestId("fedid-send"));
  await waitFor(() => expect(screen.getAllByTestId("fedid-row")).toHaveLength(1));
  await act(async () => { release(); await Promise.resolve(); });
  expect(screen.getAllByTestId("fedid-row")).toHaveLength(1);
  expect(screen.getByTestId("fedid-result")).toBeInTheDocument();
});

test("hosted: Live is disabled and the Mock table is shown", async () => {
  engineApi();
  render(<FedIdTab {...props({ hosted: true })} />);
  expect(await screen.findByTestId("fedid-mock-table")).toBeInTheDocument();
  expect(screen.getByTestId("fedid-mode-live")).toBeDisabled();
  expect(api.getFedidState).not.toHaveBeenCalled();
});

// ---- the whole page ----
function appSetup() {
  engineApi();
  api.getHealth.mockResolvedValue({ schema: "demo-health/1", state: "ready" });
  api.getScenarios.mockResolvedValue({ scenarios: [{ id: "normal", title: "Normal agent", summary: "s", teaches: "t", steps: 6, expect: [] }] });
  api.getState.mockResolvedValue(snapshot());
  api.getEvents.mockResolvedValue({ events: [], next: 0, head: 0 });
  api.getAudit.mockResolvedValue({ entries: [], size: 0 });
}

test("the banner is on both tabs and shows the mode; presenter mode (P, Esc) keeps it and ignores typing in a field", async () => {
  appSetup();
  const user = userEvent.setup();
  render(<App />);
  const banner = await screen.findByTestId("release-banner");
  expect(banner).toHaveTextContent(BANNER);
  expect(screen.getByTestId("release-banner-mode")).toHaveTextContent("Mock (scripted demo)");
  await user.click(screen.getByTestId("tab-fedid"));
  expect(await screen.findByTestId("fedid-tab")).toHaveAttribute("data-presenter", "false");
  expect(screen.getByTestId("release-banner-mode")).toHaveTextContent("Mock (generated table)");
  await user.click(screen.getByTestId("fedid-mode-live"));
  await waitFor(() => expect(screen.getByTestId("release-banner-mode")).toHaveTextContent("Live (local engine"));
  fireEvent.keyDown(window, { key: "p" });
  await waitFor(() => expect(screen.getByTestId("fedid-tab")).toHaveAttribute("data-presenter", "true"));
  expect(screen.getByTestId("release-banner")).toHaveTextContent(BANNER);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.getByTestId("fedid-tab")).toHaveAttribute("data-presenter", "false"));
  await user.type(screen.getByTestId("fedid-operator"), "ppp");
  expect(screen.getByTestId("fedid-tab")).toHaveAttribute("data-presenter", "false");
  await user.click(screen.getByTestId("tab-ks"));
  expect(screen.getByTestId("release-banner")).toHaveTextContent(BANNER);
  fireEvent.keyDown(window, { key: "p" });
  expect(screen.queryByTestId("fedid-tab")).toBeNull();
});

test("Reset on the Federated Identity tab calls the page-wide reset and the diagram boxes come back", async () => {
  appSetup();
  const onReset = vi.fn(async () => {});
  engineApi();
  const user = userEvent.setup();
  render(<FedIdTab {...props({ onReset })} />);
  await waitFor(() => expect(screen.getByTestId("fedid-reset")).toBeEnabled());
  await user.click(screen.getByTestId("fedid-reset"));
  expect(onReset).toHaveBeenCalledTimes(1);
  expect(await screen.findByTestId("fedid-status")).toHaveTextContent(/Everything reset, including the diagram boxes/);
  expect(screen.getByTestId("fedid-moved")).toHaveTextContent("0");
});

test("the diagram comes from the server's diagram data: nine arrows, Simulate walks them, nothing is drawn by hand", async () => {
  engineApi();
  const user = userEvent.setup();
  render(<FedIdTab {...props({ mode: "mock" })} />);
  await screen.findByTestId("fedid-diagram");
  expect(screen.getByTestId("fedid-step")).toHaveTextContent(/Simulate walks the 9 arrows/);
  await user.click(screen.getByTestId("fedid-simulate"));
  await waitFor(() => expect(screen.getByTestId("fedid-step")).toHaveTextContent(/Step 1 of 9/));
});

test("VERTICAL: choosing a pack refetches the story and the Mock table with its names; the operator field follows the pack until the visitor types their own", async () => {
  engineApi();
  const user = userEvent.setup();
  render(<FedIdTab {...props({ mode: "mock" })} />);
  expect(await screen.findByTestId("fedid-mock-table")).toBeInTheDocument();
  expect(within(screen.getByTestId("fedid-cut")).getByText(/was revoked by/)).toHaveTextContent(`revoked by ${VERTICALS.finance.castOperator}`);
  expect(screen.getAllByTestId("fedid-mock-row")[0]).toHaveTextContent("payments-platform");
  await user.selectOptions(screen.getByTestId("fedid-vertical"), "health");
  await waitFor(() => expect(screen.getAllByTestId("fedid-mock-row")[0]).toHaveTextContent("clinical-platform"));
  expect(within(screen.getByTestId("fedid-cut")).getByText(/was revoked by/)).toHaveTextContent(`revoked by ${VERTICALS.health.castOperator}`);
  expect(api.getFedid).toHaveBeenLastCalledWith("health");
  expect(api.getFedidMock).toHaveBeenLastCalledWith("health");
  expect(document.body.textContent).not.toMatch(/\{\{/);
});

test("VERTICAL: the operator field follows the pack, but a name the visitor typed is kept", async () => {
  engineApi();
  const user = userEvent.setup();
  render(<FedIdTab {...props()} />);
  await waitFor(() => expect(screen.getByTestId("fedid-send")).toBeEnabled());
  expect(screen.getByTestId("fedid-operator")).toHaveValue(VERTICALS.finance.castOperator);
  await user.selectOptions(screen.getByTestId("fedid-vertical"), "retail");
  await waitFor(() => expect(screen.getByTestId("fedid-operator")).toHaveValue(VERTICALS.retail.castOperator));
  await user.clear(screen.getByTestId("fedid-operator")); await user.type(screen.getByTestId("fedid-operator"), "my-own-name");
  await user.selectOptions(screen.getByTestId("fedid-vertical"), "health");
  await waitFor(() => expect(api.getFedid).toHaveBeenLastCalledWith("health"));
  await waitFor(() => expect(screen.getByTestId("fedid-vertical")).toBeEnabled());
  expect(screen.getByTestId("fedid-operator")).toHaveValue("my-own-name");
});

test("STALE GUARD: a slow answer for an older vertical never replaces the newer choice", async () => {
  engineApi();
  const user = userEvent.setup();
  render(<FedIdTab {...props({ mode: "mock" })} />);
  await screen.findByTestId("fedid-mock-table");
  const real = api.getFedid.getMockImplementation();
  let release; const slow = new Promise((r) => { release = r; });
  api.getFedid.mockImplementation(async (v) => { if (v === "health") await slow; return real(v); });
  await user.selectOptions(screen.getByTestId("fedid-vertical"), "health"); // slow
  await user.selectOptions(screen.getByTestId("fedid-vertical"), "retail"); // fast, newer
  await waitFor(() => expect(screen.getAllByTestId("fedid-mock-row")[0]).toHaveTextContent("commerce-platform"));
  release();
  await act(async () => { await slow; await Promise.resolve(); });
  expect(screen.getAllByTestId("fedid-mock-row")[0]).toHaveTextContent("commerce-platform");
  expect(screen.getByTestId("fedid-vertical")).toHaveValue("retail");
});

test("the claims table lists every claim: its row count is the number in its heading and the server's claim count", async () => {
  engineApi();
  render(<FedIdTab {...props({ mode: "mock" })} />);
  await screen.findByTestId("fedid-mock-table");
  const rows = screen.getAllByTestId("fedid-claim-row");
  const n = catalogue(DEFAULT_CAST, "finance").claimCount;
  expect(rows).toHaveLength(n);
  expect(n).toBeGreaterThan(23);
  expect(within(screen.getByTestId("fedid-claims")).getByText(/Every claim on this page/)).toHaveTextContent(`(${n})`);
  const ids = rows.map((r) => r.textContent);
  expect(new Set(ids).size).toBe(ids.length);
});

test("the operator field takes at most 40 characters and the reason at most 200, the same numbers the server enforces (it refuses more, whole)", async () => {
  engineApi();
  const user = userEvent.setup();
  render(<FedIdTab {...props()} />);
  await screen.findByTestId("fedid-send");
  expect(screen.getByTestId("fedid-operator")).toHaveAttribute("maxlength", "40");
  expect(screen.getByTestId("fedid-reason")).toHaveAttribute("maxlength", "200");
  await user.clear(screen.getByTestId("fedid-operator")); await user.type(screen.getByTestId("fedid-operator"), "o".repeat(41));
  expect(screen.getByTestId("fedid-operator")).toHaveValue("o".repeat(40));
  await user.clear(screen.getByTestId("fedid-reason")); await user.type(screen.getByTestId("fedid-reason"), "r".repeat(201));
  expect(screen.getByTestId("fedid-reason")).toHaveValue("r".repeat(200));
});
