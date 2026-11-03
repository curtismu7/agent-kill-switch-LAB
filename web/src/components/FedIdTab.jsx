import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFedid, getFedidDiagram, getFedidMock, getFedidState, postFedidAdvance, postFedidIssuer, postFedidRequest, postFedidRevoke } from "../lib/api.js";
import FedIdDiagram from "./FedIdDiagram.jsx";
import { ClaimTag, CutStaysSaid, MockTable, ResultCard, ResultTable } from "./FedIdParts.jsx";

const BASE_MS = 1100;
const SPEEDS = [["0.5", "0.5x"], ["1", "1x"], ["2", "2x"], ["4", "4x"]];
const sleep = (n) => new Promise((r) => { setTimeout(r, n); });
const VIA_TEXT = { token: "its platform token", key: "an agent access key that names it" };

// The Federated Identity revoke section (H2 2026 update). Mock: the generated table. Live: the real local engine, driven by the visitor.
export default function FedIdTab({ mode, setMode, hosted, presenter, setPresenter, theme, resetSignal, onReset }) {
  const [cat, setCat] = useState(null);
  const [vertical, setVertical] = useState("finance");
  const lastOperator = useRef("on-call-operator");
  const [pattern, setPattern] = useState(null);
  const [mock, setMock] = useState(null);
  const [live, setLive] = useState(null);
  const [last, setLast] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("1");
  const [form, setForm] = useState({ workload: "fi-billing-agent", service: "mcp", via: "token", lifetime: "600", target: "fi-billing-agent", operator: "on-call-operator", reason: "suspected compromise", seconds: "120" });
  const seq = useRef(0);
  const playId = useRef(0);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // The story, the Mock table and the names in them depend on the chosen vertical pack; the diagram does not. A late answer for an older choice is dropped.
  useEffect(() => {
    let alive = true;
    Promise.all([getFedid(vertical), getFedidMock(vertical)]).then(([c, m]) => {
      if (!alive) return;
      setCat(c); setMock(m.table);
      // the operator field follows the pack's operator name until the visitor has typed their own
      const before = lastOperator.current;
      lastOperator.current = c.cast.castOperator;
      setForm((f) => (f.operator === before ? { ...f, operator: c.cast.castOperator } : f));
    }, (e) => { if (alive) setError(`Could not load the Federated Identity section: ${e.message}`); });
    return () => { alive = false; };
  }, [vertical]);
  useEffect(() => {
    let alive = true;
    getFedidDiagram().then((d) => { if (alive) setPattern(d); }, (e) => { if (alive) setError(`Could not load the Federated Identity section: ${e.message}`); });
    return () => { alive = false; playId.current += 1; };
  }, []);

  // Live state is read when Live is shown and again after a Reset anywhere on the page. A late answer for an older call is dropped.
  const refreshLive = useCallback(async () => {
    const my = ++seq.current;
    try { const r = await getFedidState(); if (my === seq.current) { setLive(r.state); setLast(null); } } catch (e) { if (my === seq.current) setError(e.message); }
  }, []);
  useEffect(() => { if (mode === "live" && !hosted) refreshLive(); }, [mode, hosted, refreshLive, resetSignal]);

  const guard = async (fn) => {
    setBusy(true); setError("");
    try { return await fn(); } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  };
  const apply = (my, state, result) => { if (my !== seq.current) return false; setLive(state); if (result !== undefined) setLast(result); return true; };

  const onSend = () => guard(async () => {
    const my = ++seq.current;
    const r = await postFedidRequest({ workload: form.workload, service: form.service, via: form.via, lifetimeSec: form.lifetime === "" ? undefined : Number(form.lifetime) });
    if (apply(my, r.data.state, r.data.result)) setStatus(`Request ${r.data.result.n}: ${r.data.result.decision} (${r.status}).`);
  });
  const onRevoke = () => guard(async () => {
    const my = ++seq.current;
    const r = await postFedidRevoke({ workload: form.target, operator: form.operator, reason: form.reason });
    if (apply(my, r.state)) setStatus(`${form.target} revoked. The next request from it is refused.`);
  });
  const onOutage = (outage) => guard(async () => {
    const my = ++seq.current;
    const r = await postFedidIssuer({ outage });
    if (apply(my, r.state)) setStatus(`Issuer ${outage ? "DOWN: the gateway keeps its last known good key set" : "up"}.`);
  });
  const onAdvance = () => guard(async () => {
    const my = ++seq.current;
    const r = await postFedidAdvance({ seconds: Number(form.seconds) });
    if (apply(my, r.state)) setStatus(`Virtual time moved by ${form.seconds} s.`);
  });
  const doReset = async () => { playId.current += 1; setPlaying(false); await onReset(); setStatus("Everything reset, including the diagram boxes."); };
  const onResetClick = () => guard(doReset);

  // Run the story against the real engine, one call at a time, at the chosen speed. Pause stops after the current call.
  const onStory = async () => {
    if (playing) { playId.current += 1; setPlaying(false); setStatus("Story paused."); return; }
    const my = ++playId.current;
    setPlaying(true); setError("");
    try {
      if (live && (live.requests > 0 || live.identities.some((i) => i.state === "revoked") || live.issuerOutage || live.advancedSec > 0)) await doReset();
      for (const s of cat.story) {
        if (playId.current !== my) return;
        const n = ++seq.current;
        let state; let result;
        if (s.afterSec > 0) await postFedidAdvance({ seconds: s.afterSec });
        if (s.t === "request") { const r = await postFedidRequest({ workload: s.workload, service: s.service, via: s.via, lifetimeSec: cat.limits.defaultLifetimeSec }); state = r.data.state; result = r.data.result; }
        else if (s.t === "revoke") state = (await postFedidRevoke({ workload: s.workload, operator: s.operator, reason: s.reason })).state;
        else if (s.t === "issuer") state = (await postFedidIssuer({ outage: s.outage })).state;
        else state = (await postFedidAdvance({ seconds: s.seconds })).state;
        if (playId.current !== my) return;
        apply(n, state, result);
        setStatus(`Story step ${s.step} of ${cat.story.length}: ${s.say}`);
        await sleep(BASE_MS / Number(speedRef.current));
      }
    } catch (e) { setError(e.message); }
    if (playId.current === my) setPlaying(false);
  };

  const view = mode === "mock" || hosted ? "mock" : "live";
  const data = useMemo(() => {
    if (view === "mock") return mock ? { identities: mock.final.identities, forwardedTokens: mock.final.forwardedTokens, keySets: mock.final.keySets, outage: mock.final.issuerOutage } : null;
    return live ? { identities: live.identities, forwardedTokens: live.forwardedTokens, keySets: live.keySets, outage: live.issuerOutage } : null;
  }, [view, mock, live]);
  const hasKey = (id) => (live?.identities.find((i) => i.id === id)?.key ?? (id === "fi-billing-agent" ? "key-billing" : null)) !== null;

  // Every claim, in the order the server counts them: the table has exactly claimCount rows (the "not said" and roadmap items are listed too).
  const claimRows = cat ? [
    ...cat.facts.map((f) => ({ id: f.id, tag: f.tag, text: `${f.text} (slide ${f.slide})` })), ...cat.swagger, ...cat.readings, ...cat.invented,
    ...cat.notSaid.map((n) => ({ id: n.id, tag: n.tag, text: `${n.question} ${n.deck} Lab: ${n.lab}` })),
    ...cat.roadmap.map((r) => ({ id: r.id, tag: r.tag, text: `${r.name} (${r.what}) is ${r.availability} on slide ${r.slide}. ${r.note}` })),
  ] : [];

  if (error && !cat) return <p className="banner" role="alert">{error}</p>;
  if (!cat) return <p className="empty">Loading the Federated Identity section...</p>;

  return (
    <section className="fedid" aria-labelledby="fedid-h" data-testid="fedid-tab" data-mode={view} data-presenter={presenter ? "true" : "false"}>
      <div className="panel fedid__head">
        <h2 id="fedid-h">Federated Identity revoke <ClaimTag tag="deck claim" /></h2>
        <p>{cat.lede}</p>
        <p className="hint">Deck: &quot;{cat.deck}&quot;, slide 40 (slides 39 and 41 for context). Every claim on this page carries a tag; the tags are listed at the bottom.</p>
        <div className="fedid__toolbar">
          <div className="fedid-seg" role="group" aria-label="Mode" data-testid="fedid-mode">
            <button type="button" className="btn" aria-pressed={view === "mock"} onClick={() => setMode("mock")} data-testid="fedid-mode-mock">Mock</button>
            <button type="button" className="btn" aria-pressed={view === "live"} onClick={() => setMode("live")} disabled={hosted} data-testid="fedid-mode-live">Live</button>
          </div>
          <label className="fedid__vertical">Story vertical
            <select value={vertical} onChange={(e) => setVertical(e.target.value)} disabled={busy || playing} data-testid="fedid-vertical">
              {cat.verticals.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <span className="fedid__mode-note" data-testid="fedid-mode-note">{view === "mock" ? "Mock: a table generated from the engine, the same on every machine." : "Live: the real local engine, real RS256 signing and verification with a throwaway key."}{hosted ? " (The hosted mock build has no Live mode.)" : ""}</span>
          <button type="button" className="btn" aria-pressed={presenter} onClick={() => setPresenter(!presenter)} data-testid="fedid-presenter">Presenter (P)</button>
        </div>
        {error && <p className="banner" role="alert">{error}</p>}
      </div>

      {pattern && <FedIdDiagram pattern={pattern} theme={theme} resetSignal={resetSignal} />}

      {view === "mock" && mock && (
        <section className="panel" aria-labelledby="fedid-mock-h" data-testid="fedid-mock">
          <h3 id="fedid-mock-h">Mock: the story as a table</h3>
          <p className="hint">Generated from the engine by <code>npm run fedid-mock</code>; a test fails if it drifts. Time is virtual: the story starts at the deck&apos;s release date. Names, subjects and hosts are invented <ClaimTag tag="lab-invented" /></p>
          <MockTable steps={mock.steps} />
        </section>
      )}

      {view === "live" && live && (
        <>
          <section className="panel no-present" aria-labelledby="fedid-ctl-h" data-testid="fedid-controls">
            <h3 id="fedid-ctl-h">Live: send requests, revoke, move time</h3>
            <div className="fedid-form">
              <label>Workload
                <select value={form.workload} onChange={(e) => setForm((f) => ({ ...f, workload: e.target.value, via: f.via === "key" && !hasKey(e.target.value) ? "token" : f.via }))} data-testid="fedid-workload">{cat.identities.map((i) => <option key={i.id} value={i.id}>{i.id}</option>)}</select>
              </label>
              <label>Service
                <select value={form.service} onChange={set("service")} data-testid="fedid-service">{cat.services.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              </label>
              <label>Presents
                <select value={form.via} onChange={set("via")} data-testid="fedid-via">
                  {cat.vias.map((v) => <option key={v} value={v} disabled={v === "key" && !hasKey(form.workload)}>{VIA_TEXT[v]}</option>)}
                </select>
              </label>
              <label>Token lifetime (s)
                <input type="number" inputMode="numeric" min="1" max="86400" step="1" value={form.lifetime} onChange={set("lifetime")} data-testid="fedid-lifetime" />
              </label>
              <button type="button" className="btn primary" onClick={onSend} disabled={busy || playing} data-testid="fedid-send">Send request</button>
            </div>
            <p className="hint">Lifetime is what the platform is asked for when it mints a token. The deck caps it (default one hour): try {cat.limits.maxLifetimeSec + 1}. A held token is reused while it is unexpired and the lifetime is unchanged.</p>
            <div className="fedid-form">
              <label>Identity to revoke
                <select value={form.target} onChange={set("target")} data-testid="fedid-target">{cat.identities.map((i) => <option key={i.id} value={i.id}>{i.id}</option>)}</select>
              </label>
              <label>Operator
                <input type="text" maxLength={40} value={form.operator} onChange={set("operator")} data-testid="fedid-operator" autoComplete="off" />
              </label>
              <label>Reason
                <input type="text" maxLength={200} value={form.reason} onChange={set("reason")} data-testid="fedid-reason" autoComplete="off" />
              </label>
              <button type="button" className="btn kill" onClick={onRevoke} disabled={busy || playing || form.operator.trim() === ""} data-testid="fedid-revoke">Revoke identity</button>
            </div>
            <p className="hint">The operator name (up to 40 characters) and reason (up to 200) are masked for secret shapes before they are stored (a heuristic: do not type real secrets).</p>
            <div className="fedid-form">
              <label className="check"><input type="checkbox" checked={live.issuerOutage} onChange={(e) => onOutage(e.target.checked)} disabled={busy || playing} data-testid="fedid-outage" /> Issuer outage (the gateway cannot refresh its key set)</label>
              <label>Move time by (s)
                <input type="number" inputMode="numeric" min="1" max="86400" step="1" value={form.seconds} onChange={set("seconds")} data-testid="fedid-seconds" />
              </label>
              <button type="button" className="btn" onClick={onAdvance} disabled={busy || playing} data-testid="fedid-advance">Move time</button>
            </div>
            <div className="fedid-form">
              <button type="button" className="btn" onClick={onStory} aria-pressed={playing} data-testid="fedid-story">{playing ? "Pause story" : "Run the story"}</button>
              <label>Speed
                <select value={speed} onChange={(e) => setSpeed(e.target.value)} data-testid="fedid-story-speed">{SPEEDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
              </label>
              <button type="button" className="btn" onClick={onResetClick} disabled={busy} data-testid="fedid-reset">Reset</button>
            </div>
            <p className="status" role="status" aria-live="polite" data-testid="fedid-status">{status}</p>
            <p className="hint">Virtual time now {live.now.slice(11, 19)} UTC; {live.requests} of {live.requestCap} requests sent. The raw refusals are real HTTP 401 and 403 answers, which the browser logs as console messages.</p>
          </section>

          <section className="panel" aria-labelledby="fedid-last-h">
            <h3 id="fedid-last-h">Live: the gateway&apos;s last answer</h3>
            <ResultCard result={last} />
          </section>
          <section className="panel no-present" aria-labelledby="fedid-log-h">
            <h3 id="fedid-log-h">Live: request log (newest 50)</h3>
            <ResultTable rows={[...live.log].reverse()} />
          </section>
        </>
      )}
      {view === "live" && !live && !error && <p className="empty">Loading the Live engine...</p>}

      {data && <CutStaysSaid {...data} notSaid={cat.notSaid} source={view} />}

      <section className="panel" aria-labelledby="fedid-why-h" data-testid="fedid-why">
        <h3 id="fedid-why-h">Why it matters <ClaimTag tag="deck claim" /></h3>
        <p className="hint">Ping&apos;s claims from slide {cat.why.slide}, UNVERIFIED on our tenant. Challenge first.</p>
        <dl className="fedid-why">
          <dt>Challenge</dt><dd>{cat.why.challenge}</dd>
          <dt>Technical</dt><dd>{cat.why.technical}</dd>
          <dt>Business</dt><dd>{cat.why.business}</dd>
        </dl>
      </section>

      <section className="panel" aria-labelledby="fedid-road-h" data-testid="fedid-roadmap">
        <h3 id="fedid-road-h">Roadmap, not built <ClaimTag tag="roadmap" /></h3>
        <ul className="fedid-list">
          {cat.roadmap.map((r) => <li key={r.id}><strong>{r.name}</strong> ({r.what}): {r.availability}, slide {r.slide}. {r.note}</li>)}
        </ul>
      </section>

      <details className="panel no-present" data-testid="fedid-claims">
        <summary>Every claim on this page, with its tag ({claimRows.length})</summary>
        <div className="fedid-scroll">
          <table className="fedid-table fedid-table--small">
            <thead><tr><th>Tag</th><th>Claim</th></tr></thead>
            <tbody>
              {claimRows.map((c) => (
                <tr key={c.id} data-testid="fedid-claim-row"><td><ClaimTag tag={c.tag} /></td><td>{c.text}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
