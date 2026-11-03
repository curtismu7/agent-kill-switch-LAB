// Thin fetch wrapper. Same origin only. Sends the workspace cookie (ks_ws, same-origin) and no credentials or auth headers: the server refuses those.
// A POST body is JSON, the only body type the server accepts.
async function call(path, method = "GET", body) {
  const init = { method, headers: { Accept: "application/json" }, credentials: "same-origin" };
  if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

export const getInfo = () => call("/api/info");
export const setMode = (source) => call("/api/mode", "POST", { source });
export const getHealth = () => call("/api/health");
export const getScenarios = () => call("/api/scenarios");
export const getState = () => call("/api/state");
export const getEvents = (since = 0) => call(`/api/events?since=${Number(since) || 0}&limit=500`);
export const getAudit = () => call("/api/audit?limit=500");
export const verifyAudit = () => call("/api/audit/verify");
export const runScenario = (id) => call(`/api/scenarios/${encodeURIComponent(id)}/run`, "POST", {});
export const stepScenario = (id) => call(`/api/scenarios/${encodeURIComponent(id)}/step`, "POST", {});
export const postReset = () => call("/api/reset", "POST", {});
export const postKill = (body) => call("/api/kill", "POST", body);
export const postUnrevoke = (body) => call("/api/unrevoke", "POST", body);

// ---- Federated Identity revoke section (H2 2026 update) ----
const vq = (vertical) => `?vertical=${encodeURIComponent(vertical || "finance")}`;
export const getFedid = (vertical) => call(`/api/fedid${vq(vertical)}`);
export const getFedidDiagram = () => call("/api/fedid/diagram");
export const getFedidMock = (vertical) => call(`/api/fedid/mock${vq(vertical)}`);
export const getFedidState = () => call("/api/fedid/state");
export const postFedidRevoke = (body) => call("/api/fedid/revoke", "POST", body);
export const postFedidIssuer = (body) => call("/api/fedid/issuer", "POST", body);
export const postFedidAdvance = (body) => call("/api/fedid/advance", "POST", body);
// A request through the gateway is answered 200 (allowed), 401 or 403 (refused) with the full result in the body each time, so this one
// returns { status, data } instead of throwing on a refusal. A 400, 404 or 429 has no result and throws like every other call.
export async function postFedidRequest(body) {
  const res = await fetch("/api/fedid/request", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (data && data.result) return { status: res.status, data };
  const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
  err.status = res.status; err.code = data?.error;
  throw err;
}
