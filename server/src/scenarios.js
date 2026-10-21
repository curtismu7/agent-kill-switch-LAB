// Scripted scenarios. A scenario is data: gateway/limit overrides, a flat list of planner actions, and the end state it must reach.
// The planner is deterministic: no randomness, no real time. `after` is virtual milliseconds that pass before the action.
//   call      the agent makes one tool call (a runaway agent keeps calling after it is refused, on purpose)
//   wait      time passes
//   kill / unrevoke   what an operator would do, through the same code the HTTP endpoints use
const A = 'agent-alpha';
const B = 'agent-beta';
const call = (agent, o = {}) => ({ t: 'call', agent, tool: 'lookup', model: 'demo-small', tokensIn: 500, tokensOut: 200, after: 1000, ...o });
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const kill = (agent, o = {}) => ({ t: 'kill', agent, after: 0, ...o });
const unrevoke = (agent, o = {}) => ({ t: 'unrevoke', agent, after: 0, ...o });
const wait = (ms) => ({ t: 'wait', after: ms });
const big = { model: 'demo-large', tokensIn: 6000, tokensOut: 1500, tool: 'summarize', after: 500 };

export const SCENARIOS = Object.freeze([
  {
    id: 'normal', title: 'Normal agent', summary: 'Six calls, comfortably under every cap. Nothing trips.',
    teaches: 'Caps are invisible to a well-behaved agent: the gateway admits, charges the budget and moves on.',
    actions: many(6, () => call(A, { after: 3000 })),
    expect: [{ agent: A, state: 'armed', allowed: 6, denied: 0 }, { agent: B, state: 'armed', allowed: 0, denied: 0 }],
  },
  {
    id: 'rate-loop', title: 'Loop that blows the rate cap', summary: 'The agent loops, one call every half second. The sixth call in ten seconds trips it; it keeps looping and every later call is refused.',
    teaches: 'A rate cap trips by itself, with no human. After the trip the agent keeps calling (it is a runaway) and the gate does not move.',
    actions: many(10, () => call(A, { after: 500 })),
    expect: [{ agent: A, state: 'tripped', reason: 'rate_cap', allowed: 5, denied: 5 }, { agent: B, state: 'armed' }],
  },
  {
    id: 'cost-expensive', title: 'Expensive prompt blows the cost cap', summary: 'Two cheap calls, then two large-model calls with a huge prompt. The second large call would take the money budget past its limit, so it trips.',
    teaches: 'A cost cap counts tokens and money, not calls: the agent is well inside its rate cap and still stops. Watch the budget burn down.',
    actions: [call(A), call(A), call(A, big), call(A, big), call(A, { after: 500 }), call(A, { after: 500 })],
    expect: [{ agent: A, state: 'tripped', reason: 'cost_cap', allowed: 3, denied: 3 }, { agent: B, state: 'armed' }],
  },
  {
    id: 'manual-kill', title: 'Manual kill mid-run', summary: 'The agent is running normally. An operator pulls the kill switch after three calls. The very next call is refused.',
    teaches: 'The kill switch is checked on every call, so the stop takes effect on the next call, not at the next token refresh.',
    actions: [call(A), call(A), call(A), kill(A), call(A, { after: 500 }), call(A, { after: 500 }), call(A, { after: 500 })],
    expect: [{ agent: A, state: 'killed', reason: 'manual', allowed: 3, denied: 3, gapMs: 500, leaked: 0 }, { agent: B, state: 'armed' }],
  },
  {
    id: 'kill-unrevoke', title: 'Kill, then unrevoke', summary: 'Kill after two calls, two refused calls, then an operator unrevokes. The agent fetches a fresh token and carries on.',
    teaches: 'Coming back is a deliberate, audited operator action. The old token stays revoked; the agent needs a new one, and the token service only issues it after the unrevoke.',
    actions: [call(A), call(A), kill(A), call(A, { after: 500 }), call(A, { after: 500 }), unrevoke(A, { after: 1000 }), call(A), call(A)],
    expect: [{ agent: A, state: 'armed', allowed: 4, denied: 2 }, { agent: B, state: 'armed' }],
  },
  {
    id: 'in-flight', title: 'Kill lands on an in-flight call', summary: 'A slow export call is running when the kill lands. It is not interrupted and completes; the next call is refused.',
    teaches: 'Revoke does not reach into work already authorised. In-flight work finishes (and was already charged); only the next call is stopped. Use inFlight "cancel" to see the other policy.',
    actions: [call(A, { tool: 'bulk_export', after: 500 }), kill(A, { after: 500 }), call(A, { after: 500 }), wait(3000)],
    expect: [{ agent: A, state: 'killed', reason: 'manual', allowed: 1, denied: 1, completedAfterStop: 1 }, { agent: B, state: 'armed' }],
  },
  {
    id: 'blast-radius', title: 'Two agents, one killed', summary: 'Alpha and Beta run side by side. Alpha is killed; Beta carries on untouched.',
    teaches: 'A kill is scoped to one agent identity: its tokens, its budget, its window. A bystander sharing the gateway is unaffected. (The global switch is the opposite choice.)',
    actions: [...many(3, () => [call(A, { after: 2500 }), call(B, { after: 0 })]).flat(), kill(A), ...many(3, () => [call(A, { after: 2500 }), call(B, { after: 0 })]).flat()],
    expect: [{ agent: A, state: 'killed', allowed: 3, denied: 3 }, { agent: B, state: 'armed', allowed: 6, denied: 0 }],
  },
  {
    id: 'stale-token-gap', title: 'Revoked token, stale gateway', summary: 'The kill revokes the token at the token service, but this gateway validates tokens locally and only refreshes its revocation list every 30 seconds. The agent keeps getting through until the refresh.',
    teaches: 'Why short token lifetimes matter: with local validation, the gap between revoke and the first refused call is bounded by the revocation-list refresh or the token lifetime, whichever comes first. The per-call kill-switch flag is switched off here to show the gap.',
    config: { flagCheck: false, tokenValidation: 'local', tokenTtlMs: 60_000, revocationSyncMs: 30_000 },
    actions: [call(A, { after: 5000 }), kill(A, { after: 5000 }), call(A, { after: 5000 }), call(A, { after: 5000 }), call(A, { after: 5000 }), call(A, { after: 5000 }), call(A, { after: 5000 })],
    expect: [{ agent: A, state: 'killed', allowed: 4, denied: 2, leaked: 3, gapMs: 20_000 }, { agent: B, state: 'armed' }],
  },
  {
    id: 'auto-reset', title: 'Trip, cool down, auto-reset', summary: 'The agent breaches a three-calls-per-ten-seconds cap and trips. After the 30 second cooldown the gateway resets it by itself (audited) and the agent gets a fresh token.',
    teaches: 'Auto-reset is an option for rate trips only: waiting gives rate back, not money. It is audited as auto_reset, and a manual kill never comes back this way.',
    limits: { [A]: { rate: { max: 3, windowMs: 10_000 }, autoReset: true, cooldownMs: 30_000 } },
    actions: [...many(4, () => call(A, { after: 500 })), call(A, { after: 500 }), wait(30_000), call(A, { after: 0 }), call(A, { after: 1000 })],
    expect: [{ agent: A, state: 'armed', allowed: 5, denied: 2 }, { agent: B, state: 'armed' }],
  },
].map((s) => Object.freeze({ ...s, actions: Object.freeze(s.actions.map(Object.freeze)) })));

export const getScenario = (id) => SCENARIOS.find((s) => s.id === id) || null;
export const describeScenario = (s) => ({ id: s.id, title: s.title, summary: s.summary, teaches: s.teaches, steps: s.actions.length, expect: s.expect });
