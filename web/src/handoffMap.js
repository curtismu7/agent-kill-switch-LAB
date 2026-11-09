// Customer Agent LAB hands a use case here with ?from=customer-agent&uc=<id>&vertical=<id> (read by the vendored return-link module).
// Preselect only where the catalog id obviously maps to this lab's own scenario; anything else opens the defaults (strip only).
// UC18 (rate-limit / resource-overload defense) -> the rate-cap loop; UC39 (centralized revocation, the operator kill switch option) ->
// the manual kill mid-run. This lab has no verticals, so `vertical` is shown in the strip only.
export const UC_SCENARIO = Object.freeze({ UC18: "rate-loop", UC39: "manual-kill" });
export const scenarioFor = (ctx) => (ctx && Object.hasOwn(UC_SCENARIO, ctx.uc) ? UC_SCENARIO[ctx.uc] : null);
