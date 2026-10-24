// MODE switch. One code base, two deployments:
//  - local (default): the standalone demo, on the host or in compose. Workspaces are used as well, but a single user never sees them.
//  - se-mock: the hosted mock build on the SE cluster. It is mock only: it refuses any live or credential setting, and any setting
//    that would widen what the server answers. Pure functions; server/src/doctor.js runs them, and index.js refuses to start on a fail.
// Refusals name the setting, never its value.
export const MODES = ['local', 'se-mock'];

export function modeOf(env = process.env) {
  const m = env.MODE === undefined || env.MODE === '' ? 'local' : env.MODE;
  return MODES.includes(m) ? m : null;
}

export const isHosted = (env = process.env) => modeOf(env) === 'se-mock';

// Any setting whose name says it carries a live tenant or a credential. The hosted build takes none of them.
const LIVE_OR_CREDENTIAL = /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|CREDENTIAL|PRIVATE_KEY|PINGONE|TENANT|LIVE|REAL_)/i;
// A plain DNS host (no scheme, port, path or IP literal) for the ingress to serve, for example ai-demo.example.com.
const PLAIN_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function publicHostOf(env = process.env) {
  if (!isHosted(env)) return null;
  const h = String(env.KILL_SWITCH_PUBLIC_HOST || '').trim().toLowerCase();
  return PLAIN_HOST.test(h) && !/^\d+(\.\d+){3}$/.test(h) && h !== 'localhost' ? h : null;
}

// Checks for the doctor. Returns [{ id, level, detail }].
export function modeChecks(env = process.env) {
  const mode = modeOf(env);
  if (mode === null) return [{ id: 'mode', level: 'fail', detail: `MODE must be one of: ${MODES.join(', ')}` }];
  const checks = [{ id: 'mode', level: 'pass', detail: mode }];
  if (mode !== 'se-mock') return checks;
  const live = Object.keys(env).filter((k) => LIVE_OR_CREDENTIAL.test(k) && env[k] !== '');
  checks.push(live.length === 0
    ? { id: 'se-mock-no-live', level: 'pass', detail: 'no live or credential settings' }
    : { id: 'se-mock-no-live', level: 'fail', detail: `${live.length} live or credential setting(s) present; the hosted mock build refuses them (names are not printed)` });
  checks.push(publicHostOf(env)
    ? { id: 'se-mock-host', level: 'pass', detail: 'KILL_SWITCH_PUBLIC_HOST is a plain host' }
    : { id: 'se-mock-host', level: 'fail', detail: 'KILL_SWITCH_PUBLIC_HOST must be set to one plain DNS host (no scheme, port, path, IP or localhost)' });
  const bind = env.KILL_SWITCH_BIND;
  checks.push(bind === undefined || bind === '0.0.0.0' || bind === '127.0.0.1'
    ? { id: 'se-mock-bind', level: 'pass', detail: `bind ${bind ?? '127.0.0.1 (default)'}` }
    : { id: 'se-mock-bind', level: 'fail', detail: 'KILL_SWITCH_BIND must be 0.0.0.0 (the pod) or 127.0.0.1 in the hosted build' });
  return checks;
}
