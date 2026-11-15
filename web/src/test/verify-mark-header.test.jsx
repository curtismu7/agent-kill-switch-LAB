import React from "react";
import { render, screen, within } from "@testing-library/react";
import * as api from "../lib/api.js";
import App from "../App.jsx";
import { snapshot } from "./fixtures.js";

// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy that
// call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
vi.mock("../lib/api.js");
const SCEN = [{ id: "normal", title: "Normal agent", summary: "s", teaches: "t", steps: 6, expect: [] }];

beforeEach(() => {
  vi.resetAllMocks();
  api.getHealth.mockResolvedValue({ schema: "demo-health/1", state: "ready" });
  api.getInfo.mockResolvedValue({ source: "mock", realAvailable: false, realReason: "mock only" });
  api.getScenarios.mockResolvedValue({ scenarios: SCEN });
  api.getState.mockResolvedValue(snapshot());
  api.getEvents.mockResolvedValue({ events: [], next: 0, head: 0 });
  api.getAudit.mockResolvedValue({ entries: [], size: 0 });
});

const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
function withShelf(payload) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => (url === "/api/shelf" ? Promise.resolve(new Response(JSON.stringify(payload))) : real(url, init));
  return () => { globalThis.fetch = real; };
}

describe("verification mark in the header", () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
    const restore = withShelf({ shelfUrl: "http://shelf.example", demos: [
      { id: "other-lab", verification: mark("in-progress", "In progress") },
      { id: "agent-kill-switch", verification: mark("verified", "Verified", { note: "Every scenario run on the mock" }) },
    ] });
    try {
      render(<App />);
      await screen.findByTestId("gauges-agent-alpha");
      const bar = within(screen.getByTestId("top-menu"));
      expect(await bar.findByText("Verified")).toBeInTheDocument();
      expect(bar.getByRole("link", { name: "Shelf" })).toBeInTheDocument();
      expect(bar.queryByText("In progress")).toBeNull();
      expect(document.querySelectorAll(".verify")).toHaveLength(1);
      expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every scenario run on the mock"));
    } finally { restore(); }
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it", async () => {
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "agent-kill-switch", verification: null }] }]) {
      const restore = withShelf(payload);
      try {
        const { unmount } = render(<App />);
        await screen.findByTestId("gauges-agent-alpha");
        const bar = within(screen.getByTestId("top-menu"));
        expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument(); // the shelf answered, and still no badge
        expect(document.querySelector(".verify")).toBeNull();
        unmount();
      } finally { restore(); }
    }
  });
});
