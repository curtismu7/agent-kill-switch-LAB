import React from "react";
import { StatePill } from "./Badges.jsx";
import { agentName, money, pct } from "../lib/format.js";

function Meter({ label, now, max, text, tone, burn = false, testId }) {
  const left = max - now;
  const fill = burn ? pct(left, max) : pct(now, max);
  return (
    <div className="meter" data-testid={testId}>
      <div className="meter-head"><span>{label}</span><strong>{text}</strong></div>
      <div className={`track ${tone}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={burn ? left : now} aria-valuetext={text}>
        <div className="fill" style={{ width: `${fill}%` }} />
        <div className={`capline ${burn ? "cap-end" : "cap-right"}`} aria-hidden="true"><span>cap</span></div>
      </div>
    </div>
  );
}

function RateCells({ inWindow, max, windowMs }) {
  return (
    <div className="meter" data-testid="rate-gauge">
      <div className="meter-head"><span>Rate window</span><strong>{inWindow} of {max} calls in {windowMs / 1000} s</strong></div>
      <div className={`cells ${inWindow >= max ? "full" : inWindow >= max - 1 ? "hot" : ""}`} role="meter" aria-label="Calls in the rate window" aria-valuemin={0} aria-valuemax={max} aria-valuenow={inWindow} aria-valuetext={`${inWindow} of ${max} calls`}>
        {Array.from({ length: max }, (_, i) => <span key={i} className={i < inWindow ? "cell on" : "cell"} />)}
        <span className="cap-flag" aria-hidden="true">cap {max}</span>
      </div>
      <p className="hint">The window slides: a call stops counting once it is {windowMs / 1000} s old. The cap trips on the call that would be number {max + 1}.</p>
    </div>
  );
}

export default function Gauges({ agents }) {
  return (
    <div className="gauge-grid">
      {agents.map((a) => {
        const { limits: l, usage: u } = a;
        const moneyTone = a.budget.microsLeft <= l.cost.maxMicros * 0.2 ? "hot" : "";
        const tokTone = a.budget.tokensLeft <= l.cost.maxTokens * 0.2 ? "hot" : "";
        return (
          <article key={a.id} className="card gauge-card" aria-label={`Caps for ${a.id}`} data-testid={`gauges-${a.id}`}>
            <header><h3>{agentName(a.id)}</h3><StatePill state={a.state} reason={a.reason} /></header>
            <RateCells inWindow={a.rate.inWindow} max={a.rate.max} windowMs={a.rate.windowMs} />
            <Meter testId="money-gauge" burn label="Money budget left" now={u.micros} max={l.cost.maxMicros} tone={moneyTone}
              text={`${money(a.budget.microsLeft)} left of ${money(l.cost.maxMicros)} (spent ${money(u.micros)})`} />
            <Meter testId="token-gauge" burn label="Token budget left" now={u.tokens} max={l.cost.maxTokens} tone={tokTone}
              text={`${a.budget.tokensLeft.toLocaleString("en-US")} left of ${l.cost.maxTokens.toLocaleString("en-US")}`} />
            <p className="hint">{u.calls} allowed, {u.denied} refused. The cap compares with the next call&apos;s cost: spending exactly up to the budget is allowed, one more unit trips it.</p>
          </article>
        );
      })}
    </div>
  );
}
