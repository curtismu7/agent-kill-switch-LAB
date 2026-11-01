import { useCallback, useEffect, useState } from "react";

export const STEP_TIME_OPTIONS = [
  { value: 800, label: "0.8 s (fast)" },
  { value: 1500, label: "1.5 s" },
  { value: 2500, label: "2.5 s (default)" },
  { value: 4000, label: "4 s" },
  { value: 6000, label: "6 s (slow)" },
];

// Step state for a diagram that walks its arrows in order. step -1 means the walkthrough is off; 0..total-1 is the arrow in focus.
export function useStepper(total) {
  const [step, setStep] = useState(-1);
  const [paused, setPaused] = useState(false);
  const [stepMs, setStepMs] = useState(2500);
  const last = total - 1;
  useEffect(() => {
    if (step < 0 || paused) return undefined;
    if (step >= last) { setPaused(true); return undefined; }
    const id = setTimeout(() => setStep((s) => s + 1), stepMs);
    return () => clearTimeout(id);
  }, [step, paused, stepMs, last]);
  const simulate = useCallback(() => { if (total < 1) return; setPaused(false); setStep(0); }, [total]);
  const resume = useCallback(() => { if (step >= last) setStep(0); setPaused(false); }, [step, last]);
  const next = useCallback(() => setStep((s) => Math.min(s + 1, last)), [last]);
  const prev = useCallback(() => setStep((s) => Math.max(s - 1, 0)), []);
  const pause = useCallback(() => setPaused(true), []);
  const stop = useCallback(() => { setStep(-1); setPaused(false); }, []);
  return { step, total, active: step >= 0, paused, stepMs, setStepMs, simulate, resume, next, prev, pause, stop };
}
