// Injectable time. Every cap window, token TTL and cooldown reads this clock and nothing else; no timers are used anywhere,
// so a test (or a scenario) moves time by calling advance() and never sleeps.
//  - createClock({ fixed })  : a fake clock at `fixed` ms (tests).
//  - createClock()           : scenario time (the running app): it starts at the wall-clock time at creation and then moves
//                              ONLY when advance() is called. Real time never leaks into a run, so a rate window or a
//                              token lifetime cannot expire because a person stepped slowly, and a scripted run gives the
//                              same numbers every time (a 500 ms gap is 500 ms, not 501).
export function createClock({ fixed = null } = {}) {
  let t = fixed !== null ? fixed : Date.now();
  const fake = fixed !== null;
  return {
    now: () => t,
    iso: () => new Date(t).toISOString(),
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('clock.advance needs a non-negative number of ms');
      t += ms;
    },
    set(ms) { if (!fake) throw new Error('only a fake clock can be set'); t = ms; },
    get fake() { return fake; },
  };
}
