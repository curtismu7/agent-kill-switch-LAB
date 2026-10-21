import { fileURLToPath } from 'node:url';
import { startHttpServer } from './app.js';
import { allPassed, runChecks } from './doctor.js';

// Local runs read the repo-root .env (real env vars win).
try { process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))); } catch { /* no .env */ }

const checks = runChecks();
if (!allPassed(checks)) {
  for (const c of checks.filter((x) => x.level === 'fail')) console.error(`[agent-kill-switch] refusing to start: ${c.id}: ${c.detail}`);
  process.exit(1);
}
const { url } = await startHttpServer();
console.log(`[agent-kill-switch] demo mode at ${url} (loopback unless KILL_SWITCH_BIND is set)`);
console.log(`[agent-kill-switch] API: GET ${url}api/health | GET ${url}api/scenarios | POST ${url}api/scenarios/:id/run | GET ${url}api/state | POST ${url}api/kill | POST ${url}api/unrevoke | GET ${url}api/audit/verify`);
