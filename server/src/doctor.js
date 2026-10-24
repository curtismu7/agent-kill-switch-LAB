// Preflight checks shared by `npm run doctor` and GET /api/health. Synchronous, no network, never prints a secret.
// Each check: { id, level: 'pass' | 'info' | 'fail', detail }.
import { AGENTS, DEFAULT_GATEWAY, DEFAULT_LIMITS, MODELS, TOOLS } from './policy.js';
import { SCENARIOS } from './scenarios.js';
import { PORT_MAX, PORT_MIN, assertBindAllowed, bindHost, portInRange, serverPort } from './safety.js';
import { modeChecks } from './mode.js';

export function runChecks({ env = process.env } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const [major, minor] = process.versions.node.split('.').map(Number);
  add('node', major > 20 || (major === 20 && minor >= 12) ? 'pass' : 'fail', `v${process.versions.node} (need >= 20.12)`);

  try { add('bind', 'pass', `${assertBindAllowed(bindHost(env), env)}${env.KILL_SWITCH_BIND ? ' (KILL_SWITCH_BIND opt-in)' : ' (loopback)'}`); }
  catch (e) { add('bind', 'fail', e.message); }

  for (const c of modeChecks(env)) checks.push(c);

  const port = serverPort(env);
  add('port-range', portInRange(port) ? 'pass' : 'fail', portInRange(port) ? `server port ${port} (within ${PORT_MIN}-${PORT_MAX})` : `server port ${port} is outside ${PORT_MIN}-${PORT_MAX}`);

  const bad = [];
  if (!(DEFAULT_LIMITS.rate.max > 0 && DEFAULT_LIMITS.rate.windowMs > 0 && DEFAULT_LIMITS.cost.maxTokens > 0 && DEFAULT_LIMITS.cost.maxMicros > 0)) bad.push('default limits');
  if (!(DEFAULT_GATEWAY.tokenTtlMs > 0 && DEFAULT_GATEWAY.revocationSyncMs > 0)) bad.push('gateway timing');
  for (const s of SCENARIOS) {
    for (const a of s.actions) {
      if (a.t === 'call' && (!Object.hasOwn(AGENTS, a.agent) || !Object.hasOwn(TOOLS, a.tool) || !Object.hasOwn(MODELS, a.model))) bad.push(`${s.id}: unknown agent, tool or model`);
    }
    if (!s.expect?.length) bad.push(`${s.id}: no expected end state`);
  }
  add('tables', bad.length === 0 ? 'pass' : 'fail', bad.length ? [...new Set(bad)].join('; ') : `${Object.keys(AGENTS).length} agents, ${Object.keys(TOOLS).length} tools, ${Object.keys(MODELS).length} models, ${SCENARIOS.length} scenarios, all with an expected end state`);

  add('outbound', 'pass', 'no outbound settings: the gateway, token service and tools are in-process; no credential is accepted or sent');
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
