// Masking for every string a visitor types (operator name, reason). Typed text is stored in the audit trail and the event feed and shown in
// every answer, so it is masked on the way IN, BEFORE anything is stored (the audit trail and events survive Reset, so nothing raw may ever be kept).
//
// This is a HEURISTIC: it recognises common secret shapes, not every secret. Do not type a real credential. What it still misses:
//   - a bare word with no keyword and no recognisable shape ("hunter2xyz" on its own);
//   - look-alike letters from another alphabet (a Cyrillic "a" or a Greek "o" inside "password": NFKC does not fold them to Latin);
//   - a keyword split by an ordinary space or another letter ("pass word=x");
//   - a password with no digit typed after a keyword and a plain space ("password correcthorse"): see the tradeoff below;
//   - a secret that is itself a normal English sentence.
// It also over-masks on purpose ("author: Bob" is masked because "auth" is a keyword; "the key is 2026-stored" is masked).
//
// Steps (each defeats a known evasion):
//   1. NFKC-normalise (full-width and other compatibility letters become ASCII);
//   2. DELETE invisible characters and every C0/C1 control character (U+0000-0008, 000B, 000C, 000E-001F, 007F-009F) except tab, line feed and
//      carriage return, so "p<U+0001>a<U+0001>s<U+0001>s<U+0085>word=x" is whole again. The text is also read a second time with those controls
//      turned into a space (a vertical tab or NEL between two words is a separator), and the reading that masks more is kept;
//   3. percent-decode up to three rounds, each followed by the same normalisation (a round that does not decode cleanly decodes its ASCII escapes);
//   4. run the detectors below. Tab, LF, CR are separators and may split a keyword, so the detectors run twice: on the text as typed and on the
//      same text with those three deleted; the second result is kept only when it masks more. A "+" gets the same second look as a space
//      ("password+is+x"). A second look only ever adds masking;
//   5. collapse runs of whitespace to one space and trim.
// The result is NOT cut to a length. Callers refuse an over-long input whole (400) BEFORE masking, so a secret can never be cut in half and a
// value is never silently shortened. The masked text can be longer than the input ("pw 1a1a1a" -> "pw [REDACTED]"); it is bounded by the input limit.
// Keyword + plain space tradeoff: "password hunter2xyz" is masked, "password reset" is not. After a strong keyword (password, pw, token, secret, api key ...)
// and whitespace, only a token of 6 or more characters that CONTAINS A DIGIT (or a quoted value) is taken for the value, so ordinary sentences stay
// readable and a digit-free password in that one shape gets through. "token 2026-11-01" is therefore masked (a false positive).
// Every regex is linear or bounded: none nests an unbounded quantifier in another.
import { redactText } from './redaction.js';
import { INVISIBLE } from './sanitize.js';

export const MARK = '[REDACTED]';
export const MAX_RAW = 1_000_000; // an input longer than this is not looked at; it becomes MARK (the HTTP body limit and the field limits are far lower)
const STRIP = new RegExp(`${INVISIBLE.source}|[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\uFFFD]`, 'gu');
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g; // C0 and C1 except tab, LF, CR

// `ctl` is what a C0/C1 control character (other than tab, LF, CR) and U+2028/2029 become: '' (deleted) or ' ' (a separator).
const normalise = (s, ctl) => s.normalize('NFKC').replace(/[\u2028\u2029]/g, ctl).replace(STRIP, '').replace(CONTROL, ctl);
function decodeOnce(s) {
  try { return decodeURIComponent(s); } catch { return s.replace(/%([0-9a-f]{2})/gi, (m, h) => (parseInt(h, 16) < 128 ? String.fromCharCode(parseInt(h, 16)) : m)); }
}

const KEYWORDS = 'password|passwd|passphrase|pwd|pw|pass|secret|token|api[-_ ]?key|apikey|authorization|auth|bearer|credentials?|private[-_ ]?key|access[-_ ]?key|client[-_ ]?secret|cookie|session[-_ ]?id|signature';
// Keywords after which a plain space still introduces a value (when the value has a digit). "pass", "auth", "cookie", "signature" and a bare "key" are left out: too common in prose.
const STRONG = 'passphrase|password|passwd|pwd|pw|secret|token|api[-_ ]?key|apikey|credential|private[-_ ]?key|access[-_ ]?key|session[-_ ]?id';
const QUOTED = '"[^"]{0,300}"|\'[^\']{0,300}\'|\\u201C[^\\u201D]{0,300}\\u201D|\\u2018[^\\u2019]{0,300}\\u2019';
const VALUE = `${QUOTED}|\\{[^}]{0,300}\\}|\\[[^\\]]{0,300}\\]|[^\\s,;&}\\])]{1,300}`;
// A value after a keyword and a plain space: quoted, or 6+ characters that include a digit.
const SPACED = `${QUOTED}|(?=[^\\s,;&}\\])]{0,300}\\d)[^\\s,;&}\\])]{6,300}`;
const DETECTORS = [
  // key blocks
  [/-----BEGIN [A-Z ]{1,40}-----[\s\S]*?(?:-----END [A-Z ]{1,40}-----|$)/g, () => MARK],
  // URL userinfo with a scheme: https://user:pw@host (any scheme)
  [/(:\/\/)[^\s/?#@]{1,200}@/g, (m, a) => `${a}${MARK}@`],
  // header-style values run to the end of the line
  [/\b(authorization|proxy-authorization|set-cookie|cookie)(\s{0,20}[:=]\s{0,20})[^\r\n]{1,300}/gi, (m, k, sep) => `${k}${sep}${MARK}`],
  // "Authorization Digest realm=x nonce=y" (no colon): the rest of the line
  [/\b(?:proxy-)?authorization\b[^\r\n]{1,300}/gi, (m0) => `${m0.match(/^[A-Za-z-]+/)[0]} ${MARK}`],
  // keyword assignments and JSON "key": value (the key may be glued into a longer name: my_password, xtoken, "apiKey")
  [new RegExp(`(${KEYWORDS})([\\w-]{0,30}["']?\\s{0,20}(?:=>|->|[:=])\\s{0,20})(?:${VALUE})`, 'gi'), (m, k, sep) => `${k}${sep}${MARK}`],
  // plain language: "password is x", "pw was x", "secrets are x", "the token is x" ("token was/are" is left alone: "the token was revoked")
  [new RegExp(`(password|passwd|passphrase|pwd|pw|secret|api[-_ ]?key|apikey|credentials?)(s?\\s{1,20}(?:is|was|are)\\s{1,20})(?:${VALUE})`, 'gi'), (m, k, sep) => `${k}${sep}${MARK}`],
  [new RegExp(`(tokens?|private[-_ ]?key|access[-_ ]?key|session[-_ ]?id)(\\s{1,20}is\\s{1,20})(?:${VALUE})`, 'gi'), (m, k, sep) => `${k}${sep}${MARK}`],
  // a strong keyword, a plain space, then the value ("password hunter2xyz", "api key hunter2xyz", "tokens abc123def")
  [new RegExp(`(${STRONG})(s?)(\\s{1,20})(?:${SPACED})`, 'gi'), (m, k, pl, sp) => `${k}${pl}${sp}${MARK}`],
  // a bare "key" (not inside monkey, turkey): key=x, key: x, "the key is x" (here the value must contain a digit: "the key is stored" stays)
  [new RegExp(`(?<![A-Za-z])(keys?)(["']?\\s{0,20}(?:=>|->|[:=])\\s{0,20})(?:${VALUE})`, 'gi'), (m, k, sep) => `${k}${sep}${MARK}`],
  [new RegExp(`(?<![A-Za-z])(keys?)(\\s{1,20}is\\s{1,20})(?:${SPACED})`, 'gi'), (m, k, sep) => `${k}${sep}${MARK}`],
  // user:password@host without a scheme, with or without a leading // (a "mailto:" address is left alone)
  [/(?<![\w.%+-])(?!mailto:)[\w.%+-]{1,200}:[^\s/?#@:]{1,200}@(?=[A-Za-z0-9[])/gi, () => `${MARK}@`],
  [/\b(?:bearer|basic)\s{1,5}[A-Za-z0-9._~+/=-]{6,}/gi, () => MARK],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, () => MARK],
  // short prefixed tokens: sk-live-..., ghp_..., tok_abc12345, glpat-..., hf_...
  [/\b(?:sk|pk|rk|tok|token|key|secret|pat|ghp|gho|ghu|ghs|github_pat|glpat|xox[a-z]|npm|pypi|hf|api|bearer)[-_][A-Za-z0-9_-]{6,}/gi, () => MARK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g, () => MARK],
  // any other long opaque run (base64, hex, a key hash)
  [/[A-Za-z0-9+/_=-]{32,}/g, () => MARK],
];

// The app's older redactor stays as a last net: it also drops secret pairs from URL query strings and fragments.
const detect = (text) => redactText(DETECTORS.reduce((acc, [re, fn]) => acc.replace(re, fn), text));
// A second look at the text with one kind of character changed; kept only when it finds something the first look did not.
const SECOND_LOOKS = [[/[\t\n\r]/g, ''], [/\+/g, ' ']];

const marks = (t) => t.split(MARK).length;
function look(text) {
  let out = detect(text);
  for (const [re, to] of SECOND_LOOKS) { const changed = out.replace(re, to); const again = detect(changed); if (again !== changed) out = again; }
  return out;
}
function prepare(input, ctl) {
  let s = normalise(input, ctl);
  for (let i = 0; i < 3; i += 1) { const d = normalise(decodeOnce(s), ctl); if (d === s) break; s = d; }
  return s;
}

export function maskText(input) {
  if (typeof input !== 'string') return '';
  if (input.length > MAX_RAW) return MARK;
  // Two readings of the same text: controls DELETED ("pass<U+0085>word" is whole) and controls turned into a SPACE ("Bearer<U+000B>token" is two words).
  // The reading that masks more wins; a tie keeps the deleting reading.
  const deleted = look(prepare(input, ''));
  const spaced = look(prepare(input, ' '));
  const out = marks(spaced) > marks(deleted) ? spaced : deleted;
  return out.replace(/\s+/g, ' ').trim();
}

// True when masking changed the text, so a response can say "something in what you typed was masked" without saying what.
export const wasMasked = (value, masked) => typeof value === 'string' && masked.includes(MARK);
