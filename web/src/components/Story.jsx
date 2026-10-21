import React from "react";

export const STORY = [
  ["The agent works", "A scripted agent calls tools through the gateway with a short-lived token."],
  ["A cap or an operator steps in", "A rate or cost cap trips by itself, or an operator pulls the switch."],
  ["Access is revoked", "The token is revoked and the token service stops issuing new ones."],
  ["The next call fails", "The very next call is refused. Anything already in flight is a separate question."],
];

export default function Story({ stage, scenario }) {
  return (
    <section className="story" aria-label="The story in four steps">
      <ol>
        {STORY.map(([h, p], i) => (
          <li key={h} className={i < stage ? "done" : i === stage ? "now" : ""} aria-current={i === stage ? "step" : undefined}>
            <span className="n" aria-hidden="true">{i + 1}</span>
            <strong>{h}</strong>
            <span>{p}</span>
          </li>
        ))}
      </ol>
      {scenario && <p className="teaches"><strong>{scenario.title}.</strong> {scenario.summary} <em>{scenario.teaches}</em></p>}
    </section>
  );
}
