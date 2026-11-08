// Safety rules. Pure functions, no I/O.
//  1. Bind loopback only, unless KILL_SWITCH_BIND opts in (the container does).
//  2. Every port this app uses is in 6550-6599 (server 6550; 6551-6559 are reserved for stubs, none are opened in KS0).
//  3. Only loopback hosts are Host-header-accepted, plus, in the hosted mock build only, the one public host the ingress
//     serves (KILL_SWITCH_PUBLIC_HOST, passed through unchanged), plus the host names in LAB_ALLOWED_HOSTS (the lab-proxy's name for
//     this app). No credential header is accepted; there is no URL input.
//  4. State-changing requests (kill, unrevoke, run, reset) are CSRF-guarded.

export const PORT_MIN = 6550;
export const PORT_MAX = 6599;
export const SERVER_PORT = 6550;

const OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const LOOPBACK_V4 = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || LOOPBACK_V4.test(h);
}

export const portInRange = (p) => Number.isInteger(p) && p >= PORT_MIN && p <= PORT_MAX;
export const bindHost = (env = process.env) => env.KILL_SWITCH_BIND || '127.0.0.1';
export const serverPort = (env = process.env) => (env.KILL_SWITCH_PORT === undefined ? SERVER_PORT : Number(env.KILL_SWITCH_PORT));

export function assertBindAllowed(host, env = process.env) {
  if (isLoopbackHost(host) || env.KILL_SWITCH_BIND) return host;
  throw new Error(`refusing to bind ${host}: loopback only. Set KILL_SWITCH_BIND to opt in (the container does).`);
}

// Strict Host parsing: "localhost", "127.x.y.z" (each octet 0-255) or "[::1]", optionally ":port". Anything else -> null.
const HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::(\d{1,5}))?$/i;
export function parseHost(hostHeader, publicHost = null) {
  const raw = String(hostHeader ?? '').trim().toLowerCase();
  if (publicHost && raw === publicHost) return { hostname: publicHost, port: null, host: publicHost, hosted: true };
  const m = HOST_RE.exec(String(hostHeader ?? '').trim());
  if (!m || !isLoopbackHost(m[1])) return null;
  if (m[2] !== undefined && Number(m[2]) > 65535) return null;
  return { hostname: m[1].toLowerCase().replace(/^\[|\]$/g, ''), port: m[2] === undefined ? null : Number(m[2]), host: `${m[1]}${m[2] === undefined ? '' : `:${m[2]}`}`.toLowerCase(), hosted: false };
}

// The guards that depend on the public host. publicHost null (local runs, tests) means loopback only, as before.
// allowedHosts: the host names (no port, lower case) the lab-proxy sends in Host, from LAB_ALLOWED_HOSTS; loopback always works.
const hostName = (hostHeader) => String(hostHeader ?? '').trim().toLowerCase().replace(/:\d{1,5}$/, '');
export function makeGuards({ publicHost = null, allowedHosts = new Set() } = {}) {
  // Rejects a missing, malformed or non-allowed Host header (DNS rebinding): 421 Misdirected Request.
  function hostGuard(req, res, next) {
    if (!req.headers.host || !(parseHost(req.headers.host, publicHost) || allowedHosts.has(hostName(req.headers.host)))) {
      return res.status(421).json({ error: 'bad_host', message: 'this server answers loopback Host headers only' });
    }
    return next();
  }

  // CSRF defence for anything that is not a plain read. A page on another site can send a "simple" POST to 127.0.0.1 without
  // CORS permission, so the server refuses it itself. This is what stops a foreign page from killing or un-revoking an agent.
  //  - Sec-Fetch-Site: cross-site is refused (same-origin, same-site, none are fine);
  //  - an Origin header must be identical to the Host the request was sent to: an http loopback origin, or (hosted only)
  //    the https public origin;
  //  - a request with a body must be application/json.
  const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  function originGuard(req, res, next) {
    const refuse = (status, error, message) => res.status(status).json({ error, message });
    if (READ_METHODS.has(req.method)) {
      // A read through /api can still move the demo (a due auto-reset is applied lazily when state is looked at), so a page from another
      // site or another local port may not trigger one: only same-origin, address-bar (none) and header-less (curl, server-side) reads pass.
      // /api/health is exempt (shelf and probes). A browser too old to send Sec-Fetch-Site is not covered by this.
      const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      if (site && site !== 'same-origin' && site !== 'none' && req.path.startsWith('/api/') && !req.path.startsWith('/api/health')) return refuse(403, 'cross_site_refused', 'cross-site reads of the API are refused');
      return next();
    }
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return refuse(403, 'cross_site_refused', 'cross-site requests are refused');
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let u = null;
      try { u = new URL(origin); } catch { /* refused below */ }
      const host = parseHost(req.headers.host, publicHost);
      const loopbackSame = u && u.protocol === 'http:' && u.origin !== 'null' && isLoopbackHost(u.hostname) && host && !host.hosted
        && u.host.toLowerCase() === host.host && !u.username && !u.password && u.pathname === '/' && origin === u.origin;
      const hostedSame = u && host && host.hosted && u.protocol === 'https:' && u.hostname.toLowerCase() === publicHost && u.port === ''
        && !u.username && !u.password && u.pathname === '/' && origin === u.origin;
      // Behind the lab-proxy the browser's origin is https://local.ping-devops.com:8443 while Host is this app's own name. The proxy
      // sets X-Forwarded-Host/-Proto; they are believed only when Host is one of the allowed names (loopback does not count), so a
      // request that did not come through the proxy cannot use them.
      const xfh = String(req.headers['x-forwarded-host'] || '').toLowerCase();
      const xfp = String(req.headers['x-forwarded-proto'] || 'https').toLowerCase();
      const proxied = allowedHosts.has(hostName(req.headers.host)) && xfh !== '' && (xfp === 'https' || xfp === 'http') && origin === `${xfp}://${xfh}`;
      if (!loopbackSame && !hostedSame && !proxied) return refuse(403, 'bad_origin', 'this server accepts same-origin requests only');
    }
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return refuse(415, 'unsupported_media_type', 'a request body must be application/json');
    return next();
  }
  return { hostGuard, originGuard };
}

// No credential is ever accepted or used. A request that carries one is refused, not ignored.
// Cookies: the only cookie this server reads is the workspace id (ks_ws, see workspaces.js). It is a random session id that
// selects a demo workspace; it is not a credential and it is never sent anywhere.
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key'];
export function credentialGuard(req, res, next) {
  if (CREDENTIAL_HEADERS.some((h) => req.headers[h] !== undefined)) {
    return res.status(400).json({ error: 'credentials_not_accepted', message: 'this server accepts and uses no credentials' });
  }
  return next();
}
