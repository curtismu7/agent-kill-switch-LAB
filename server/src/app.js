// One Express app: the API under /api. createApp() is what the tests use.
// Every agent- and operator-provided string in a response was made inert and redacted when it was stored, and is served as
// JSON only. No route accepts a token, a URL or a credential; access tokens never appear in any response.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createHealth } from './health.js';
import { assertBindAllowed, bindHost, credentialGuard, makeGuards, serverPort } from './safety.js';
import { allowedHostsFrom, isHosted, publicHostOf } from './mode.js';
import { createWorkspaces } from './workspaces.js';
import { describeScenario, getScenario } from './scenarios.js';
import { MODELS, TOOLS } from './policy.js';
import { shelfInfo } from './shelfLink.js';

export const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
// The built UI is served from this server, so it is same-origin with the API. It may load script, style, image and fetch from itself only.
export const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const KILL_IN_FORCE = 'an operator kill is in force: unrevoke it (an audited action) or reset the demo before starting a scenario, which would otherwise clear it silently';
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

// Builds the /api router for ONE runtime (one workspace). Every route reads and writes only that runtime.
function buildApi(runtime) {
    const api = express.Router();
    api.use(express.json({ limit: '2kb' }));

    api.get('/scenarios', (_req, res) => res.json({ mode: runtime.mode, scenarios: runtime.scenarios.map(describeScenario) }));
    api.post('/scenarios/:id/run', (req, res) => {
      if (!ID_RE.test(req.params.id) || !getScenario(req.params.id)) return bad(res, 'no such scenario', 404);
      if (req.body && Object.keys(req.body).length) return bad(res, 'running a scenario takes no parameters');
      const run = runtime.runScenario(req.params.id);
      if (run.error) return res.status(409).json({ error: run.error, killed: run.killed, message: KILL_IN_FORCE });
      res.json({ mode: runtime.mode, run, state: runtime.snapshot() });
    });
    api.post('/scenarios/:id/step', (req, res) => {
      if (!ID_RE.test(req.params.id) || !getScenario(req.params.id)) return bad(res, 'no such scenario', 404);
      if (req.body && Object.keys(req.body).length) return bad(res, 'stepping a scenario takes no parameters');
      const r = runtime.stepScenario(req.params.id);
      if (r.error === 'kill_in_force') return res.status(409).json({ error: r.error, killed: r.killed, message: KILL_IN_FORCE });
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
  return api;
}

// Mock/Real. This app is mock only by design (a scripted agent, a stub token service and a mock gateway; nothing real to call), so
// Real is never available in a normal build. `realAvailable` is a TEST-ONLY seam, never read from the environment, so the switch
// itself can be tested.
const NO_REAL = 'Real mode is not available: this demo is mock only by design and has no real server to call.';
function buildModeApi({ realAvailable }) {
  const canReal = realAvailable === true;
  const state = { source: canReal ? 'real' : 'mock' };
  const info = () => ({ version: (() => { try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || null; } catch { return null; } })(), source: state.source, realAvailable: canReal, realReason: canReal ? null : NO_REAL });
  const r = express.Router();
  r.get('/info', (_req, res) => res.json(info()));
  // Body is exactly {source: "mock" | "real"}. The mode lives in memory, so a switch needs no restart.
  r.post('/mode', express.json({ limit: '2kb' }), (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length !== 1 || !['mock', 'real'].includes(b.source)) return bad(res, 'body must be exactly {"source": "mock" or "real"}');
    if (b.source === 'real' && !canReal) return res.status(409).json({ error: 'conflict', message: NO_REAL });
    state.source = b.source;
    return res.json(info());
  });
  r.use((err, _req, res, next) => {
    if (err.type === 'entity.parse.failed') return bad(res, 'request body is not valid JSON');
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large', message: 'request body is too large' });
    return next(err);
  });
  return r;
}

// The API router per runtime, cached weakly so a dropped workspace is garbage collected.
const routers = new WeakMap();
const routerFor = (runtime) => {
  let r = routers.get(runtime);
  if (!r) { r = buildApi(runtime); routers.set(runtime, r); }
  return r;
};

// webDist: directory with the built UI. null (default, so API tests never depend on a build) disables static serving.
// Either `runtime` (one fixed runtime: the tests) or `workspaces` (one runtime per browser, the default for startHttpServer).
export function createApp({ runtime = null, workspaces = null, health = createHealth(), webDist = null, publicHost = null, allowedHosts = new Set(), realAvailable = false, env = process.env } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const { hostGuard, originGuard } = makeGuards({ publicHost, allowedHosts });
  app.use(hostGuard);
  app.use(credentialGuard);
  app.use(originGuard);
  app.use((_req, res, next) => { res.set(API_HEADERS); next(); });
  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: 'index.html', dotfiles: 'ignore', setHeaders: (res) => res.set({ ...API_HEADERS, 'Content-Security-Policy': UI_CSP }) }));
  }
  // The health probe is shared and reads no workspace state, so it does not create one.
  app.use('/api/health', health.router);
  app.get('/api/shelf', (_req, res) => res.json(shelfInfo(env)));
  app.use('/api', buildModeApi({ realAvailable }));
  const ws = runtime ? null : (workspaces || createWorkspaces());
  app.use('/api', (req, res, next) => routerFor(runtime ?? ws.resolve(req, res))(req, res, next));
  app.use((_req, res) => bad(res, 'no such endpoint', 404));
  app.use((err, _req, res, _next) => (err instanceof URIError || err.status === 400 ? bad(res, 'malformed request') : res.status(500).json({ error: 'server_error' })));
  return app;
}


// Boot on `port`. Refuses a non-loopback host unless KILL_SWITCH_BIND is set. MODE=se-mock serves one public host (see mode.js)
// and gives every browser its own workspace; a local run does the same, with the same single-user behaviour.
export async function startHttpServer({ port = serverPort(), host = bindHost(), env = process.env, runtime, webDist = DEFAULT_WEB_DIST } = {}) {
  assertBindAllowed(host, env);
  const hosted = isHosted(env);
  const publicHost = publicHostOf(env);
  const allowedHosts = allowedHostsFrom(env); // before the workspaces and the health timer start: a bad name must leave nothing running
  const workspaces = runtime ? null : createWorkspaces({ hosted });
  const health = createHealth({ env });
  return new Promise((resolve, reject) => {
    const httpServer = createApp({ runtime, workspaces, health, webDist, publicHost, allowedHosts, env }).listen(port, host);
    httpServer.once('error', (e) => { health.stop(); reject(e); });
    httpServer.once('listening', () => {
      const { port: bound } = httpServer.address();
      resolve({
        port: bound, runtime: runtime ?? null, workspaces, url: `http://127.0.0.1:${bound}/`, hosted,
        close: async () => { health.stop(); await new Promise((r) => { httpServer.closeAllConnections?.(); httpServer.close(r); }); },
      });
    });
  });
}
