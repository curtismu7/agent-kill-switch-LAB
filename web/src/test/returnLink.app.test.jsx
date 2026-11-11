// Opened from Customer Agent LAB: the strip (after the hosted-banner slot and the skip links), Back in the header tools, the mapped
// scenario preselected.
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "../lib/api.js";
import App from "../App.jsx";
import ReturnLink from "../return-link/ReturnLink.jsx";
import { UC_SCENARIO, scenarioFor } from "../handoffMap.js";
import { SCENARIOS } from "../../../server/src/scenarios.js";
import { snapshot } from "./fixtures.js";

vi.mock("../lib/api.js");
const SCEN = SCENARIOS.map((s) => ({ id: s.id, title: s.title, summary: s.summary, teaches: s.teaches, steps: 1, expect: [] }));
const NOTE = { name: "Opened from Customer Agent LAB" };

function setup(state = snapshot()) {
  api.getHealth.mockResolvedValue({ schema: "demo-health/1", state: "ready" });
  api.getInfo.mockResolvedValue({ source: "mock", realAvailable: false });
  api.getScenarios.mockResolvedValue({ scenarios: SCEN });
  api.getState.mockResolvedValue(state);
  api.getEvents.mockResolvedValue({ events: [], next: 0, head: 0 });
  api.getAudit.mockResolvedValue({ entries: [], size: 0 });
}
beforeEach(() => { vi.resetAllMocks(); setup(); });
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

describe("return link", () => {
  it("the vendored files match return-link.sha256, which names the parent commit", () => {
    const dir = path.join(process.cwd(), "src", "return-link"); // vitest runs in web/
    const text = fs.readFileSync(path.join(dir, "return-link.sha256"), "utf8");
    expect(text.split("\n")[0]).toMatch(/^# vendored byte for byte from curtismu7\/AI-DEMO-Standalone shared\/return-link at [0-9a-f]{7,40}/);
    const pins = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    expect(pins.map(([, f]) => f).sort()).toEqual(["ReturnLink.jsx", "ReturnLink.test.jsx", "returnTargets.js"]);
    for (const [h, f] of pins) expect(createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex"), f).toBe(h);
  });

  it("every mapped use case names a real scenario", () => {
    for (const s of Object.values(UC_SCENARIO)) expect(SCENARIOS.map((x) => x.id)).toContain(s);
    expect(scenarioFor({ uc: "UC1" })).toBeNull();
    expect(scenarioFor({ uc: "toString" })).toBeNull();
  });

  it("UC18: strip and header Back, the rate-cap loop preselected", async () => {
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC18&vertical=banking");
    render(<App />);
    expect(screen.getByRole("note", NOTE).textContent).toContain("UC18");
    expect(screen.getAllByRole("button", { name: /Back to Customer Agent LAB/ })).toHaveLength(2);
    expect(document.querySelector("header.top .top-right button.return-link--header")).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId("scenario-select")).toHaveValue("rate-loop"));
  });

  it("hosted: the banner stays first and the strip comes right after it (skip links between are visually hidden)", async () => {
    setup(snapshot({ hosted: true }));
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC39");
    render(<App />);
    const banner = await screen.findByTestId("hosted-banner");
    const strip = screen.getByRole("note", NOTE);
    expect(banner.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.nextElementSibling.tagName).toBe("HEADER");
    await waitFor(() => expect(screen.getByTestId("scenario-select")).toHaveValue("manual-kill"));
  });

  it("an unmapped use case: strip only, the first scenario kept", async () => {
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC9");
    render(<App />);
    expect(screen.getByRole("note", NOTE)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("scenario-select")).toHaveValue(SCEN[0].id));
  });

  it("no from, an unknown from or a bad id: no strip, no button, first scenario", async () => {
    for (const q of ["/", "/?from=elsewhere&uc=UC18", "/?from=customer-agent&uc=%3Cb%3E", "/?from=customer-agent&uc=UC18&uc=UC39"]) {
      window.history.replaceState(null, "", q);
      render(<App />);
      expect(screen.queryByRole("note", NOTE)).toBeNull();
      expect(screen.queryByRole("button", { name: /Back to/ })).toBeNull();
      await waitFor(() => expect(screen.getByTestId("scenario-select")).toHaveValue(SCEN[0].id));
      cleanup();
    }
  });

  it("Back goes to the proxy path under /agent-kill-switch/, the direct URL at the root", () => {
    const navigate = vi.fn();
    const search = "?from=customer-agent&uc=UC18";
    render(<ReturnLink app="agent-kill-switch" navigate={navigate} location={{ pathname: "/agent-kill-switch/", search }} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to/ }));
    expect(navigate).toHaveBeenLastCalledWith("/customer-agent/?returned=agent-kill-switch&uc=UC18");
    cleanup();
    render(<ReturnLink app="agent-kill-switch" navigate={navigate} location={{ pathname: "/", search }} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to/ }));
    expect(navigate).toHaveBeenLastCalledWith("http://127.0.0.1:5603/?returned=agent-kill-switch&uc=UC18");
  });
});

  it("?from=ai-demo-standalone: strip names AI Demo Standalone, Back goes to its proxy path", () => {
    const navigate = vi.fn();
    const search = "?from=ai-demo-standalone&uc=UC12";
    render(<ReturnLink app="agent-kill-switch" navigate={navigate} location={{ pathname: "/agent-kill-switch/", search }} />);
    const note = screen.getByRole("note", { name: "Opened from AI Demo Standalone" });
    expect(note.textContent).toContain("UC12");
    fireEvent.click(screen.getByRole("button", { name: /Back to AI Demo Standalone/ }));
    expect(navigate).toHaveBeenLastCalledWith("/ai-demo-standalone/?returned=agent-kill-switch&uc=UC12");
    cleanup();
    render(<ReturnLink app="agent-kill-switch" navigate={navigate} location={{ pathname: "/", search }} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to AI Demo Standalone/ }));
    expect(navigate).toHaveBeenLastCalledWith("http://127.0.0.1:7810/?returned=agent-kill-switch&uc=UC12");
  });
