# Talk track (4-6 minutes)

Setup: `npm run build && npm start`, open http://127.0.0.1:6550/. Press **Reset** first so the page is clean. Panel names below are the headings on the page.

## One-sentence pitch

"When an AI agent runs away, the organization needs a stop that works on the very next call, whatever the agent thinks it is doing. This shows caps that trip on their own, an operator kill, and exactly what happens to the work already in flight."

## Live steps

1. **Frame it (20 s).** Point at the DEMO badge and the story strip. Say: "Everything here is a simulation. A scripted agent calls mock tools through a mock gateway. Nothing leaves this machine."
2. **Normal agent (30 s).** In **Run it**, pick `Normal agent`, press **Run**. Say: "Six calls, all under the caps. The strip stays at step one: the agent works." Show **Caps**: the rate cells and the budgets.
3. **Rate cap trips (45 s).** Press **Reset**, pick `Loop that blows the rate cap`, press **Run**. Say: "The sixth call in ten seconds trips the cap by itself. No human involved. The loop keeps calling and every call is refused." Point at **Live activity** and **Where each call goes**, where the refused call shows the box it stopped at.
4. **Cost cap (30 s).** Reset, pick `Expensive prompt blows the cost cap`, **Run**. Say: "Different limit, same outcome: the money budget would be exceeded, so it trips."
5. **Manual kill, stepped (60 s).** Reset, pick `Manual kill mid-run`, press **Step** three times. In **Kill switch** press **KILL** (revoke alpha). Press **Step** again. Say: "The kill takes effect on the next call. The access token is revoked and the token service will not issue a new one." Show **Access tokens** (revoked mark).
6. **In-flight call (45 s).** Reset, pick `Kill lands on an in-flight call`, **Run**. Say: "A call already running is not interrupted by default; it finishes and is flagged. It stays charged. The next call is refused. The **Work already in flight** menu has a cancel option, which is a choice of this demo, not a product behaviour."
7. **The gap (45 s).** Reset, pick `Revoked token, stale gateway`, **Run**. Open **The gap: revoke to first refused call**. Say: "If a gateway validates tokens locally, calls can get through until its revocation list refreshes. Short token lifetimes shrink that window."
8. **Blast radius (30 s).** Reset, pick `Two agents, one killed`, **Run**. Show **Blast radius**. Say: "Alpha is stopped, beta carries on. The global switch, **Kill ALL agents**, is the only thing that stops both."
9. **Unrevoke and audit (45 s).** Pick `Manual kill mid-run`, Run, then in **Kill switch** type an operator name, press **Unrevoke**, then **Confirm unrevoke**. In **Audit trail** press **Verify chain**. Say: "Putting access back is a deliberate, audited act. The chain is tamper-evident inside this process."

## If asked: what is real and what is not

- Simulated: the agent, gateway, token service, tools, clock, prices. All numbers (windows, budgets, TTLs, cooldowns) are invented.
- UNVERIFIED: how any real product implements revoke, rate caps or cost caps. The behaviour is modelled on an internal demo environment and has not been checked against product documentation. This app makes no claim about real defaults, limits or latency.
- Does not prove: that a real gateway or token service behaves this way, that a real agent can be stopped in a given time, or who the operator is (there is no login; the operator name is a label). The audit chain does not prove integrity to a third party and is lost when the process exits.
- Time is scenario time: token countdowns move as the script moves, not with your wall clock.

## Likely questions

1. **Does the kill stop a call already running?** By default no: it finishes, is flagged and stays charged. The next call is refused.
2. **How fast does it take effect?** In this model, on the next call. With local token validation there is a measured gap until the revocation list refreshes (the stale-gateway scenario). Real timings are not claimed.
3. **Can one bad agent take down the others?** Not here: caps, tokens and state are per agent. Only the global kill stops all.
4. **Who can pull the switch, and can a web page do it?** Anyone who can reach the local page; there is no login. A page on another origin cannot: cross-origin writes are refused.
5. **Is this what the product does?** It is a model, UNVERIFIED against product documentation. Use it to discuss the pattern, not to quote limits.

## Reset before the next demo

Press **Reset** in **Run it** (or `curl -s -X POST http://127.0.0.1:6550/api/reset -H 'content-type: application/json' -d '{}'`). It clears scenario state and opens a new audit epoch. If an operator kill is in force, Run and Step refuse until you unrevoke or Reset. Check `npm run doctor` if the port is busy.
