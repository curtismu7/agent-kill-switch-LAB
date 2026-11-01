// Masking for the text a visitor types into the Federated Identity section (operator name, reason). It is a HEURISTIC: it removes the
// secret shapes listed below and nothing else, so a secret in a shape not listed here can get through. Do not type real secrets.
//
// Order matters, and each step defeats a known evasion:
//   1. delete invisible and control characters FIRST, so a secret with zero-width characters between its letters is whole again;
//   2. NFKC-normalise, so full-width and other look-alike letters become the ASCII letters the patterns expect;
//   3. percent-decode (twice, bounded, only when the text decodes cleanly), so %73k-... is seen as sk-...;
//   4. mask, using the app's existing redactor plus the extra shapes below;
//   5. only THEN truncate, so a secret placed after thousands of filler characters is masked before the cut, never cut in half.
import { redactText } from '../redaction.js';
import { INVISIBLE } from '../sanitize.js';

export const MARK = '[REDACTED]';
const STRIP = new RegExp(`${INVISIBLE.source}|[\\u0000-\\u001F\\u007F-\\u009F]`, 'gu');
const HARD_LIMIT = 200_000; // characters looked at at all; the request body limit (2 KB) is far below this

// "my password is hunter2", "pw: abc", "api key = abc", "secret=abc"
const SAID = /\b(?:(?:password|passwd|passphrase|passcode|pwd|pw|secret|api[\s_-]*key)s?\s+(?:is|was|are)\b|(?:password|passwd|passphrase|passcode|pwd|pw|pin|secret|token|api[\s_-]*key|credential)s?\s*[:=])\s*[^\s,;]+/gi;
// scheme://user:password@host (any scheme)
const USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@/gi;
// short prefixed tokens: tok_abc12345, sk-live-..., pat_..., glpat-..., hf_...
const PREFIXED = /\b(?:sk|pk|rk|tok|token|key|secret|pat|ghp|gho|ghu|ghs|github_pat|glpat|xox[a-z]|npm|pypi|hf|api|bearer)[-_][A-Za-z0-9_-]{6,}/gi;
// a long unbroken run of base64 or hex that is almost certainly a key, a hash of a key, or a token
const BLOB = /\b[A-Za-z0-9+/_=-]{32,}\b/g;
const AUTH_LINE = /\b(?:Proxy-)?Authorization\b[^\r\n]*/gi;

function percentDecode(s) {
  let out = s;
  for (let i = 0; i < 2 && out.includes('%'); i += 1) {
    try { const d = decodeURIComponent(out); if (d === out) break; out = d; } catch { break; }
  }
  return out;
}

export function maskText(value, max = 200) {
  if (typeof value !== 'string') return '';
  const unseen = value.length > HARD_LIMIT ? value.slice(0, HARD_LIMIT) : value;
  let s = percentDecode(unseen.replace(STRIP, '').normalize('NFKC'));
  s = redactText(s) // PEM blocks, URL query secrets, Bearer/Basic, JWTs, AWS keys, sk-/ghp_/xox, name=value, Authorization and Cookie lines
    .replace(AUTH_LINE, MARK)
    .replace(USERINFO, `://${MARK}@`)
    .replace(SAID, MARK)
    .replace(PREFIXED, MARK)
    .replace(BLOB, MARK);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// True when masking changed the text, so a response can say "something in what you typed was masked" without saying what.
export const wasMasked = (value, masked) => typeof value === 'string' && masked.includes(MARK);
