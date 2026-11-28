// What the Help dialog says. Plain, and as hedged as the rest of the lab (rule 2): what was measured, what is simulated, what is UNVERIFIED.
export const HELP_SECTIONS = [
  {
    heading: "What this lab is",
    body: [
      "Stop a runaway AI agent: caps trip on their own, an operator revokes, the next call fails. A scripted agent calls mock tools through a mock gateway; nothing leaves this machine.",
      "The DEMO badge in the header means everything here is a mock: no tenant, no real model. On a shared host a banner adds: HOSTED SIMULATION — every number is invented."
    ]
  },
  {
    heading: "What was measured, and what was not",
    body: [
      "The kill, trip, unrevoke, auto-reset and per-call enforcement behaviour is reproduced from the AI-DEMO2 demo environment.",
      "UNVERIFIED: how real PingOne products implement revoke and caps. This app makes no claim about real product defaults, limits or latency; docs/safety.md lists what is sourced and what is invented.",
      "Simulated: the agent, gateway, token service, tools, clock, prices. Time is scenario time — token countdowns move as the script moves, not with your wall clock."
    ]
  },
  {
    heading: "How to use the page",
    body: [
      "1. In \"Run it\", pick a Scenario and press Run (whole script), Step (one action) or Simulate (steps at the chosen Speed: 0.5x–4x) so you can pull the kill part-way.",
      "2. \"Where each call goes\" follows every call; a refused call stops at the box that refused it.",
      "3. \"Caps\": rate cells and budgets trip without a human.",
      "4. \"Kill switch\": type an operator name, optionally a reason, choose what \"Work already in flight\" does (finish is default; cancel is this demo's choice, not a product behaviour), then KILL — one agent or \"Kill ALL agents\" in Blast radius. In-flight calls finish and stay charged by default.",
      "5. \"The gap: revoke to first refused call\": with a stale gateway, calls get through until the revocation list refreshes.",
      "6. \"Unrevoke\" (with \"Confirm unrevoke\") is a deliberate, audited act. \"Audit trail\" → \"Verify chain\" proves the chain inside this process.",
      "7. Run and Step refuse while an operator kill is in force: unrevoke or Reset first."
    ]
  },
  {
    heading: "Mode honesty",
    body: [
      "Mock by default; the mode menu may offer Real and is refused with the server's reason when there is no real source. There is no login: the operator name is a label, and anyone who can reach the page can pull the switch. Cross-origin writes are refused."
    ]
  },
  {
    heading: "The one real step (optional, outside this lab)",
    body: [
      "Quarantining a real agent in the PingOne Privilege console was observed once (one tenant, one agent, one region, 2026-11-18): quarantine added a deny policy on invoking that agent's runtime, release removed it. That is an observation, not a documented guarantee, and this lab neither runs nor tests it. Do not equate it with this kill switch, and never run it against a live agent."
    ]
  }
];
