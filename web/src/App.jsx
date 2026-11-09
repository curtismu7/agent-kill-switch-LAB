import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAudit, getEvents, getHealth, getInfo, setMode, getScenarios, getState, postKill, postReset, postUnrevoke, runScenario, stepScenario, verifyAudit } from "./lib/api.js";
import { announce, deriveGaps, deriveTokens, pathFor } from "./lib/derive.js";
import { plural } from "./lib/format.js";
import AuditPanel from "./components/AuditPanel.jsx";
import BlastRadius from "./components/BlastRadius.jsx";
import Feed from "./components/Feed.jsx";
import Flow from "./components/Flow.jsx";
import GapTimeline from "./components/GapTimeline.jsx";
import Gauges from "./components/Gauges.jsx";
import KillPanel from "./components/KillPanel.jsx";
import { ModelBadge } from "./components/Badges.jsx";
import Story from "./components/Story.jsx";
import Tokens from "./components/Tokens.jsx";
import ModeToggle from "./components/ModeToggle.jsx";
import ShelfLink from "./components/ShelfLink.jsx";
import ReturnLink from "./return-link/ReturnLink.jsx";
import { readReturnContext } from "./return-link/returnTargets.js";
import { scenarioFor } from "./handoffMap.js";

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const initialTheme = () => {
  const t = safe(() => localStorage.getItem("ks-theme"), null);
  return ["auto", "light", "dark"].includes(t) ? t : "auto";
};
export const POLL_MS = 1500;
export const BASE_MS = 1400;
const SPEEDS = [["0.5", "0.5x"], ["1", "1x"], ["2", "2x"], ["4", "4x"]];
const EVENT_KEEP = 500;
const sleep = (n) => new Promise((r) => { setTimeout(r, n); });

export default function App() {
  // Opened from Customer Agent LAB: preselect the matching scenario (handoffMap.js), once, on load.
  const [handoffScenario] = useState(() => scenarioFor(readReturnContext(window.location.search)));
  const [theme, setTheme] = useState(initialTheme);
  const [health, setHealth] = useState(null);
  const [scenarios, setScenarios] = useState([]);
  const [scenarioId, setScenarioId] = useState("");
  const [snap, setSnap] = useState(null);
  const [events, setEvents] = useState([]);
  const [audit, setAudit] = useState({ entries: [], size: 0 });
  const [verify, setVerify] = useState(null);
  const [speed, setSpeed] = useState("1");
  const [simulating, setSimulating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [alertText, setAlertText] = useState("");
  const [error, setError] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [info, setInfo] = useState(null);
  const [reloadKey, setReloadKey] = useState(0); // bumped after a mode switch: the load effect below runs again
  const [intervened, setIntervened] = useState(false);
  const [override, setOverride] = useState(null);
  const [operator, setOperator] = useState("on-call-operator");
  const [reason, setReason] = useState("");
  const [inFlight, setInFlight] = useState("finish");
  const [resetBudget, setResetBudget] = useState(false);
  const cursor = useRef(0);
  const first = useRef(true);
  const simId = useRef(0);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    safe(() => localStorage.setItem("ks-theme", theme));
  }, [theme]);

  const setThemePersist = (t) => { setTheme(t); safe(() => localStorage.setItem("ks-theme", t)); };
  const refresh = useCallback(async () => {
    try {
      const [s, ev, a] = await Promise.all([getState(), getEvents(cursor.current), getAudit()]);
      setSnap(s);
      setAudit({ entries: a.entries, size: a.size });
      cursor.current = ev.next;
      if (ev.events.length) {
        setEvents((old) => {
          const lastReset = ev.events.map((e) => e.type).lastIndexOf("reset");
          const merged = lastReset >= 0 ? ev.events.slice(lastReset) : [...old, ...ev.events];
          return merged.slice(-EVENT_KEEP);
        });
        if (!first.current) {
          const say = ev.events.map(announce).filter(Boolean);
          if (say.length) setAlertText(say.join(" "));
        }
      }
      first.current = false;
      setError("");
      return s;
    } catch (e) { setError(`Could not reach the server: ${e.message}`); return null; }
  }, []);

  useEffect(() => {
    getHealth().then(setHealth, () => setHealth({ unreachable: true }));
    getInfo().then(setInfo, () => setInfo(null));
    getScenarios().then((r) => { setScenarios(r.scenarios); setScenarioId((id) => id || (r.scenarios.some((s) => s.id === handoffScenario) ? handoffScenario : r.scenarios[0]?.id) || ""); }, (e) => setError(`Could not load scenarios: ${e.message}`));
    refresh();
    const poll = setInterval(refresh, POLL_MS);
    return () => { clearInterval(poll); simId.current += 1; };
  }, [refresh, reloadKey, handoffScenario]);

  const scenario = scenarios.find((s) => s.id === scenarioId) || null;
  const run = snap?.run || null;
  // Scenario time: it moves when the script moves (see server/src/clock.js), so there is nothing to extrapolate between polls.
  const nowMs = snap ? Date.parse(snap.now) : 0;
  const tokens = useMemo(() => deriveTokens(events), [events]);
  const gaps = useMemo(() => deriveGaps(events), [events]);
  const agents = snap?.agents || [];
  const global = snap?.global || { state: "armed", gapMs: null, leakedCalls: 0 };
  const config = snap?.gateway || { tokenValidation: "introspect", flagCheck: true, revocationSyncMs: 30000, tokenTtlMs: 60000 };
  const lastEntry = run?.transcript?.at(-1) || null;
  const path = override || pathFor(lastEntry);

  const stopped = global.state === "killed" || agents.some((a) => a.state === "tripped" || a.state === "killed");
  const refused = stopped && gaps.length > 0 && gaps[gaps.length - 1].firstDeniedAt !== null;
  const stage = stopped ? (refused ? 3 : 2) : 0;

  const counts = useMemo(() => ({
    agent: agents.reduce((n, a) => n + a.usage.calls + a.usage.denied, 0),
    tools: agents.reduce((n, a) => n + a.usage.calls, 0),
    revoke: agents.reduce((n, a) => n + a.usage.denied, 0),
    token: tokens.length,
    kill: agents.reduce((n, a) => n + a.trips, 0) + gaps.filter((g) => g.kind === "kill").length,
    audit: audit.size,
  }), [agents, tokens, gaps, audit.size]);

  const guard = async (fn) => {
    setBusy(true); setError("");
    try { return await fn(); } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  };

  const onRun = () => guard(async () => {
    simId.current += 1; setSimulating(false); setOverride(null); setIntervened(false);
    const r = await runScenario(scenarioId);
    await refresh();
    const ok = r.run.expectation?.ok;
    setStatus(`Ran "${scenario?.title}": ${plural(r.run.total, "step")}. ${ok ? "Reached the expected end state." : "End state differs from the script."}`);
  });

  const onStep = () => guard(async () => {
    simId.current += 1; setSimulating(false); setOverride(null);
    try {
      const r = await stepScenario(scenarioId);
      if (r.run.cursor === 1) setIntervened(false);
      await refresh();
      setStatus(`Step ${r.run.cursor} of ${r.run.total}${r.run.done ? " (finished)" : ""}.`);
    } catch (e) {
      if (e.code === "run_finished") setStatus("This run has finished. Press Run to play it again, or Reset.");
      else throw e;
    }
  });

  const onSimulate = async () => {
    if (simulating) { simId.current += 1; setSimulating(false); setStatus("Simulation paused."); return; }
    if (run && run.scenario === scenarioId && run.done && (snap?.operatorKills?.length ?? 0) > 0) {
      setStatus("An operator kill is in force. Unrevoke it (an audited action) or press Reset before simulating again.");
      return;
    }
    const my = ++simId.current;
    setSimulating(true); setOverride(null); setError("");
    try {
      if (run && run.scenario === scenarioId && run.done) { await postReset(); first.current = true; setVerify(null); setResetKey((k) => k + 1); }
      setIntervened(false);
      while (simId.current === my) {
        const r = await stepScenario(scenarioId);
        await refresh();
        setOverride(null);
        setStatus(`Simulating "${scenario?.title}": step ${r.run.cursor} of ${r.run.total}${r.run.done ? ", finished" : ""}.`);
        if (r.run.done) break;
        await sleep(BASE_MS / Number(speedRef.current));
      }
    } catch (e) { setError(e.message); }
    if (simId.current === my) setSimulating(false);
  };

  const onReset = () => guard(async () => {
    simId.current += 1; setSimulating(false);
    await postReset();
    first.current = true;
    setVerify(null); setOverride(null); setIntervened(false); setResetKey((k) => k + 1);
    await refresh();
    setStatus("Everything reset. The audit trail records the reset.");
  });

  const onKill = (target) => guard(async () => {
    await postKill({ ...target, operator: operator.trim() || "operator", reason: reason || undefined, inFlight });
    setIntervened(true);
    setOverride({ nodes: ["kill", "token", "revoke", "audit"], edges: ["e-kill-token", "e-kill-rev", "e-kill-audit"], bad: "kill" });
    await refresh();
    setStatus(`Kill sent for ${target.agentId || "all agents"}. The next call should be refused.`);
  });

  const onUnrevoke = (target) => guard(async () => {
    await postUnrevoke({ ...target, operator: operator.trim(), reason: reason || undefined, ...(target.scope === "agent" ? { resetBudget } : {}) });
    setIntervened(true);
    setOverride({ nodes: ["kill", "token", "audit"], edges: ["e-kill-token", "e-kill-audit"], bad: null });
    await refresh();
    setStatus(`Unrevoked ${target.agentId || "all agents"} by ${operator.trim()}. The agent needs a fresh token.`);
  });

  // Switch Mock/Real on the server, then load everything the page shows again. A refused switch keeps the old mode.
  const onSelectMode = (source) => guard(async () => {
    simId.current += 1; setSimulating(false);
    try { setInfo(await setMode(source)); setReloadKey((k) => k + 1); } catch (e) { getInfo().then(setInfo, () => {}); throw e; }
  });

  const onVerify = () => guard(async () => { setVerify(await verifyAudit()); });

  const caption = lastEntry
    ? `Last step: ${lastEntry.action === "call" ? `${lastEntry.agent} called ${lastEntry.tool}: ${lastEntry.allowed ? "allowed" : `refused at ${lastEntry.stage} (${lastEntry.reason})`}` : lastEntry.action}.`
    : "Run, Step or Simulate and the diagram follows each real step. Drag any box to rearrange.";

  return (
    <>
      {snap?.hosted && (
        <p className="hosted-banner" role="status" data-testid="hosted-banner">
          HOSTED SIMULATION. This is a mock on a shared demo host. No tenant, no real model and no real agent is involved, and every number is invented.
        </p>
      )}
      <a className="skip" href="#main">Skip to content</a>
      <a className="skip skip-kill" href="#kill-h">Skip to the kill switch</a>
      <ReturnLink app="agent-kill-switch" />
      <header className="top">
        <div>
          <h1>Agent Kill Switch</h1>
          <p className="tag">Stop a runaway AI agent: caps trip, an operator revokes, the next call fails.</p>
        </div>
        <div className="top-right">
          <ReturnLink app="agent-kill-switch" variant="header" />
          <ShelfLink />
          <span className="badge demo" data-testid="mode-badge" title="Everything here is a mock: no tenant, no real model, nothing leaves 127.0.0.1.">DEMO</span>
          <ModelBadge />
          <ModeToggle info={info} onSelect={onSelectMode} />
          <label className="inline">Theme
            <select value={theme} onChange={(e) => setThemePersist(e.target.value)} data-testid="theme">
              <option value="auto">Auto</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        {error && <p className="banner" role="alert">{error}</p>}
        {health?.unreachable && <p className="banner" role="alert">The health endpoint did not answer.</p>}
        <div className="sr-only" role="alert" data-testid="stop-alert">{alertText}</div>

        <Story stage={stage} scenario={scenario} />

        <section className="panel controls" aria-labelledby="ctl-h">
          <h2 id="ctl-h">Run it</h2>
          <div className="ctl-row">
            <label>Scenario
              <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} data-testid="scenario-select">
                {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </label>
            <button type="button" className="btn primary" onClick={onRun} disabled={busy || !scenarioId}>Run</button>
            <button type="button" className="btn" onClick={onStep} disabled={busy || !scenarioId}>Step</button>
            <button type="button" className="btn" onClick={onSimulate} disabled={!scenarioId} aria-pressed={simulating}>{simulating ? "Pause" : "Simulate"}</button>
            <button type="button" className="btn" onClick={onReset} disabled={busy}>Reset</button>
            <label>Speed
              <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
                {SPEEDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
          </div>
          <p className="hint">Run plays the whole script at once. Step does one action. Simulate steps for real at the chosen speed, so you can pull the kill switch part-way. Reset clears everything, including the diagram layout. A scenario will not start while an operator kill is in force: unrevoke it first, or Reset.</p>
          <p className="status" role="status" aria-live="polite" data-testid="run-status">{status}</p>
          {run && <p className="progress" data-testid="progress">Run {run.id}: step {run.cursor} of {run.total}{run.done ? ", finished" : ""}.</p>}
          {run?.done && run.expectation && (
            <details className="expect" open={!run.expectation.ok}>
              <summary data-testid="expect-summary">{run.expectation.ok ? "✓ Expected end state reached" : "▲ End state differs from the script"} ({run.expectation.checks.filter((c) => c.pass).length} of {run.expectation.checks.length} checks){intervened ? " - you intervened, so differences are expected" : ""}</summary>
              <ul>{run.expectation.checks.map((c, i) => <li key={i} className={c.pass ? "v-ok" : "v-bad"}>{c.pass ? "✓" : "✕"} {c.agent} {c.field}: expected {String(c.expected)}, got {String(c.actual)}</li>)}</ul>
            </details>
          )}
        </section>

        <section className="panel" aria-labelledby="flow-h">
          <h2 id="flow-h">Where each call goes</h2>
          <Flow path={path} counts={counts} theme={theme} resetKey={resetKey} caption={caption} />
        </section>

        {agents.length > 0 && (
          <div className="cols">
            <section className="panel" aria-labelledby="caps-h">
              <h2 id="caps-h">Caps</h2>
              <Gauges agents={agents} />
            </section>
            <KillPanel agents={agents} global={global} operator={operator} setOperator={setOperator} reason={reason} setReason={setReason}
              inFlight={inFlight} setInFlight={setInFlight} resetBudget={resetBudget} setResetBudget={setResetBudget} busy={busy} onKill={onKill} onUnrevoke={onUnrevoke} />
            <Feed events={events} />
            <GapTimeline gap={gaps.at(-1) || null} tokens={tokens} config={config} nowMs={nowMs} />
            <Tokens tokens={tokens} nowMs={nowMs} ttlMs={config.tokenTtlMs} />
            <BlastRadius agents={agents} global={global} />
            <AuditPanel audit={audit} verify={verify} onVerify={onVerify} busy={busy} />
          </div>
        )}

        <footer className="prov">
          <h2>What is real here, and what is not</h2>
          <p><ModelBadge /> Every number (windows, budgets, prices, token lifetimes, cooldowns) is invented for this demo. Prices are illustrative, not any vendor&apos;s.</p>
          <p>The kill, trip, unrevoke, auto-reset and per-call enforcement behaviour is reproduced from the AI-DEMO2 demo environment. <strong>How real PingOne products implement revoke and caps is as modelled in the demo environment, UNVERIFIED against product documentation.</strong> This app makes no claim about real product defaults, limits or latency. The repository&apos;s docs/safety.md lists what is sourced and what is invented.</p>
        </footer>
      </main>
    </>
  );
}
