// Preflight: the same checks GET /api/health reports from, plus whether the server port is free.
// Prints only pass/fail lines, never the value of a setting. Exit 1 on any failure. Needs no network.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* optional */ }

const { runChecks } = await import(pathToFileURL(path.join(root, 'server/src/doctor.js')));
const { serverPort, PORT_MIN, PORT_MAX } = await import(pathToFileURL(path.join(root, 'server/src/safety.js')));
let failed = 0;
const report = (level, name, detail) => {
  if (level === 'fail') failed++;
  console.log(`${level.toUpperCase().padEnd(4)}  ${name}: ${detail}`);
};

for (const c of runChecks()) report(c.level, c.id, c.detail);

const free = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => resolve(e.code));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(null)));
});
const port = serverPort();
const err = await free(port);
// A busy port is a WARNING, not a failure: the configuration is fine, something (often a running instance) holds the port.
report(err ? 'warn' : 'pass', 'port', err ? `${port} is in use (${err}); if that is not a running instance of this demo, set KILL_SWITCH_PORT in .env to a free port in ${PORT_MIN}-${PORT_MAX}` : `${port} is free`);

process.exit(failed ? 1 : 0);
