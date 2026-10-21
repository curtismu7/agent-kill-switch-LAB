// One Express app: the API under /api. createApp() is what the tests use.
// Every agent- and operator-provided string in a response was made inert and redacted when it was stored, and is served as
// JSON only. No route accepts a token, a URL or a credential; access tokens never appear in any response.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createHealth } from './health.js';
import { createRuntime } from './runtime.js';
import { assertBindAllowed, bindHost, credentialGuard, hostGuard, originGuard, serverPort } from './safety.js';
import { describeScenario, getScenario } from './scenarios.js';
import { MODELS, TOOLS } from './policy.js';

export const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
// The built UI is served from this server, so it is same-origin with the API. It may load script, style, image and fetch from itself only.
export const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const bad = (res, message, status = 400) => res.status(status).json({ error: status === 404 ? 'not_found' : 'bad_request', message });
const API_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const ID_RE = /^[a-z0-9-]{1,40}$/;
const uint = (v, max = 1e9) => { if (v === undefined) return 0; if (!/^\d{1,10}$/.test(String(v))) return null; const n = Number(v); return n <= max ? n : null; };
const onlyKeys = (body, allowed) => !body || Object.keys(body).every((k) => allowed.includes(k));
const methods = (allow) => (_req, res) => res.set('Allow', allow).status(405).json({ error: 'method_not_allowed' });
const optString = (v, max) => v === undefined || (typeof v === 'string' && v.length <= max);

// POST /api/kill and /api/unrevoke bodies. Returns { value } or { error }.
function operatorBody(body, kind) {
  const allowed = kind === 'kill' ? ['scope', 'agentId', 'operator', 'reason', 'inFlight'] : ['scope', 'agentId', 'operator', 'reason', 'resetBudget'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || !onlyKeys(body, allowed)) return { error: `body must be JSON with only: ${allowed.join(', ')}` };
  if (body.scope !== 'agent' && body.scope !== 'global') return { error: 'scope must be "agent" or "global"' };
  if (body.scope === 'agent' && (typeof body.agentId !== 'string' || body.agentId.length === 0 || body.agentId.length > 64)) return { error: 'agentId is required for scope "agent"' };
  if (body.scope === 'global' && body.agentId !== undefined) return { error: 'agentId must not be given for scope "global"' };
  if (!optString(body.reason, 200) || !optString(body.operator, 40)) return { error: 'operator (max 40) and reason (max 200) must be short strings' };
  if (kind === 'unrevoke' && (typeof body.operator !== 'string' || body.operator.trim() === '')) return { error: 'unrevoke needs an operator name: bringing an agent back is a deliberate, audited action' };
  if (kind === 'kill' && body.inFlight !== undefined && body.inFlight !== 'finish' && body.inFlight !== 'cancel') return { error: 'inFlight must be "finish" or "cancel"' };
  if (kind === 'unrevoke' && body.resetBudget !== undefined && typeof body.resetBudget !== 'boolean') return { error: 'resetBudget must be true or false' };
  return { value: body };
}

// webDist: directory with the built UI. null (default, so API tests never depend on a build) disables static serving.
export function createApp({ runtime, health = createHealth(), webDist = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard);
  app.use(credentialGuard);
  app.use(originGuard);
  app.use((_req, res, next) => { res.set(API_HEADERS); next(); });
  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: 'index.html', dotfiles: 'ignore', setHeaders: (res) => res.set({ ...API_HEADERS, 'Content-Security-Policy': UI_CSP }) }));
  }

  const api = express.Router();
  api.use('/health', health.router);
  api.use(express.json({ limit: '2kb' }));

  api.get('/scenarios', (_req, res) => res.json({ mode: runtime.mode, scenarios: runtime.scenarios.map(describeScenario) }));
  api.post('/scenarios/:id/run', (req, res) => {
    if (!ID_RE.test(req.params.id) || !getScenario(req.params.id)) return bad(res, 'no such scenario', 404);
    if (req.body && Object.keys(req.body).length) return bad(res, 'running a scenario takes no parameters');
    res.json({ mode: runtime.mode, run: runtime.runScenario(req.params.id), state: runtime.snapshot() });
  });
  api.post('/scenarios/:id/step', (req, res) => {
    if (!ID_RE.test(req.params.id) || !getScenario(req.params.id)) return bad(res, 'no such scenario', 404);
    if (req.body && Object.keys(req.body).length) return bad(res, 'stepping a scenario takes no parameters');
    const r = runtime.stepScenario(req.params.id);
    if (r.error) return res.status(409).json({ error: r.error, message: 'this run has finished: POST /run to run it again, or POST /api/reset' });
    res.json({ mode: runtime.mode, ...r, state: runtime.snapshot() });
  });

  api.get('/agents', (_req, res) => res.json({ mode: runtime.mode, agents: runtime.gateway.agents(), global: runtime.gateway.global(), models: MODELS, tools: TOOLS }));
  api.get('/state', (_req, res) => res.json(runtime.snapshot()));

  // Operator endpoints. State-changing, so the CSRF guard above applies: a page on another origin cannot reach them.
  api.post('/kill', (req, res) => {
    const { value, error } = operatorBody(req.body, 'kill');
    if (error) return bad(res, error);
    const r = runtime.kill(value);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ mode: runtime.mode, ...r, state: runtime.snapshot() });
  });
  api.post('/unrevoke', (req, res) => {
    const { value, error } = operatorBody(req.body, 'unrevoke');
    if (error) return bad(res, error);
    const r = runtime.unrevoke(value);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ mode: runtime.mode, ...r, state: runtime.snapshot() });
  });

  api.get('/events', (req, res) => {
    const since = uint(req.query.since); const limit = uint(req.query.limit ?? '200', 500);
    if (since === null || limit === null || limit < 1) return bad(res, 'since and limit must be small non-negative integers');
    res.json({ mode: runtime.mode, ...runtime.events.list({ since, limit }) });
  });

  // The audit trail is read-only through the API: GET only.
  api.route('/audit').get((req, res) => {
    const after = uint(req.query.after); const limit = uint(req.query.limit ?? '200', 500);
    if (after === null || limit === null || limit < 1) return bad(res, 'after and limit must be small non-negative integers');
    res.json({ mode: runtime.mode, entries: runtime.audit.list({ after, limit }), headSeq: runtime.audit.headSeq, size: runtime.audit.size });
  }).all(methods('GET'));
  api.route('/audit/verify').get((_req, res) => res.json({ mode: runtime.mode, ...runtime.audit.verify() })).all(methods('GET'));

  api.post('/reset', (req, res) => {
    if (req.body && Object.keys(req.body).length) return bad(res, 'POST /api/reset takes no parameters');
    runtime.reset();
    res.json({ ok: true, mode: runtime.mode });
  });

  api.use((_req, res) => bad(res, 'no such endpoint', 404));
  api.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large', message: 'request body is too large' });
    if (err.type === 'entity.parse.failed') return bad(res, 'request body is not valid JSON');
    if (err instanceof URIError || err.status === 400) return bad(res, 'malformed request');
    console.error('[agent-kill-switch] api error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  });
  app.use('/api', api);
  app.use((_req, res) => bad(res, 'no such endpoint', 404));
  app.use((err, _req, res, _next) => (err instanceof URIError || err.status === 400 ? bad(res, 'malformed request') : res.status(500).json({ error: 'server_error' })));
  return app;
}


// Boot on `port`. Refuses a non-loopback host unless KILL_SWITCH_BIND is set.
export async function startHttpServer({ port = serverPort(), host = bindHost(), env = process.env, runtime, webDist = DEFAULT_WEB_DIST } = {}) {
  assertBindAllowed(host, env);
  const rt = runtime || createRuntime();
  const health = createHealth({ env });
  return new Promise((resolve, reject) => {
    const httpServer = createApp({ runtime: rt, health, webDist }).listen(port, host);
    httpServer.once('error', (e) => { health.stop(); reject(e); });
    httpServer.once('listening', () => {
      const { port: bound } = httpServer.address();
      resolve({
        port: bound, runtime: rt, url: `http://127.0.0.1:${bound}/`,
        close: async () => { health.stop(); await new Promise((r) => { httpServer.closeAllConnections?.(); httpServer.close(r); }); },
      });
    });
  });
}
