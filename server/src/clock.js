// Injectable time. Every cap window, token TTL and cooldown reads this clock and nothing else; no timers are used anywhere,
// so a test (or a scenario) moves time by calling advance() and never sleeps.
//  - createClock({ fixed })  : a fake clock at `fixed` ms that moves only when advance()/set() is called (tests).
//  - createClock()           : real time plus a virtual offset; advance() adds to the offset (the running app, so a scenario
//                              can "wait 30 seconds" instantly while real time keeps flowing too).
export function createClock({ fixed = null } = {}) {
  let manual = fixed;
  let offset = 0;
  const now = () => (manual !== null ? manual : Date.now() + offset);
  return {
    now,
    iso: () => new Date(now()).toISOString(),
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('clock.advance needs a non-negative number of ms');
      if (manual !== null) manual += ms; else offset += ms;
    },
    set(ms) { if (manual === null) throw new Error('only a fake clock can be set'); manual = ms; },
    get fake() { return manual !== null; },
  };
}
