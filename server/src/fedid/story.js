// The scripted story, as data. The Mock table is this story run through the engine (mock.js); the Live page can play the same steps
// against the real engine one call at a time ("Run the story"), and a test checks that both make the same decisions.
// `afterSec` is virtual time that passes before the step. Names and reasons are lab-invented. The words that name a company, a host, a team or the operator
// are {{cast}} tokens (cast.js) filled when the story is served; the Mock table is generated with the tokens left in and filled the same way.
import { fillDeep } from '../cast.js';
import { STORY_START_MS } from './tables.js';

const B = 'fi-billing-agent';
const N = 'fi-nightly-job';
const req = (workload, service, via, say, afterSec = 2) => ({ t: 'request', workload, service, via, afterSec, say });

export const STORY = Object.freeze([
  req(B, 'mcp', 'token', 'The {{castTeam}} billing agent calls an MCP server on the {{castHost}}.example gateway with its platform token: allowed.'),
  req(B, 'a2a', 'token', 'The same identity reaches a peer agent: allowed. Only the scopes differ between service families.'),
  req(B, 'llm', 'token', 'And an LLM provider: allowed.'),
  req(B, 'mcp', 'key', 'An agent access key that names this identity as its principal: allowed.'),
  req(N, 'mcp', 'token', 'A second identity, the {{castBrand}} nightly job, works too.'),
  req(N, 'a2a', 'token', 'The nightly job has no A2A scope: refused for a different reason than a revoke (403 scope_missing).'),
  { t: 'revoke', workload: B, operator: '{{castOperator}}', reason: 'suspected compromise', afterSec: 2, say: 'An operator ({{castOperator}}) revokes the billing identity.' },
  req(B, 'mcp', 'token', 'The very next request from the billing agent is refused. Its token is still valid; the identity is not.', 1),
  req(B, 'a2a', 'token', 'The same identity is cut off from the peer-agent service too.', 1),
  req(B, 'llm', 'token', 'And from the LLM service: one revoke, every service family.', 1),
  req(B, 'mcp', 'key', 'The key that names the revoked identity is refused as well.', 1),
  req(N, 'mcp', 'token', 'The nightly job is untouched: allowed.', 1),
  { t: 'advance', seconds: 1000, afterSec: 0, say: 'Time passes. The billing token has expired and the key set is more than 15 minutes old.' },
  req(B, 'mcp', 'token', 'The platform minted a fresh, valid token (it knows nothing of the revoke). The gateway still refuses the identity.', 0),
  { t: 'issuer', outage: true, afterSec: 0, say: 'The platform issuer stops answering.' },
  { t: 'advance', seconds: 1000, afterSec: 0, say: 'More time passes with the issuer down.' },
  req(N, 'mcp', 'token', 'The nightly job still works: the gateway keeps the last known good key set through the outage.', 0),
  req(B, 'mcp', 'token', 'The revoked identity is still refused during the outage: an outage does not bring it back.', 0),
]);

export const STORY_START = STORY_START_MS;

// The story with a cast filled in (a deep copy; STORY itself keeps its tokens).
export const storyFor = (cast) => fillDeep(STORY, cast);

// Runs the story against an engine and returns { steps }, one entry per story step with the engine's answer.
export function runStory(engine) {
  const steps = [];
  STORY.forEach((s, i) => {
    if (s.afterSec > 0) engine.advance({ seconds: s.afterSec });
    let r;
    if (s.t === 'request') { r = engine.request({ workload: s.workload, service: s.service, via: s.via, lifetimeSec: 600 }); steps.push({ step: i + 1, t: s.t, say: s.say, ...(r.ok ? { result: r.result } : { error: r.error }) }); return; }
    if (s.t === 'revoke') r = engine.revoke({ workload: s.workload, operator: s.operator, reason: s.reason });
    else if (s.t === 'issuer') r = engine.setIssuer({ outage: s.outage });
    else r = engine.advance({ seconds: s.seconds });
    steps.push({ step: i + 1, t: s.t, say: s.say, ok: r.ok, ...(s.t === 'revoke' ? { workload: s.workload } : {}), ...(s.t === 'advance' ? { seconds: s.seconds } : {}), ...(s.t === 'issuer' ? { outage: s.outage } : {}) });
  });
  return steps;
}
