// Real RS256 signing and verification with node:crypto, for the Live engine. The issuer keys are throwaway RSA keys made in this
// process the first time they are needed; they sign nothing outside this demo and are never written, logged or returned.
// (RSA key generation is fine; EC key generation is avoided on purpose, see CLAUDE.md.) The Mock engine uses the fixed marker below
// instead of a signature, so the Mock table is the same on every machine.
import crypto from 'node:crypto';
import { ISSUERS } from './tables.js';

export const MOCK_SIGNATURE = 'sig-not-real';
export const MAX_PART = 4096; // each of the three token parts, characters
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const BASE64URL = /^[A-Za-z0-9_-]*$/;

let KEYS = null;
function issuerKeys() {
  if (KEYS) return KEYS;
  KEYS = {};
  for (const iss of Object.values(ISSUERS)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    KEYS[iss.id] = { privateKey, publicKey };
  }
  return KEYS;
}

// The two parts that are always the same shape: base64url(JSON header) . base64url(JSON claims)
export function signToken({ header, claims, issuerId, signing }) {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = signing === 'mock' ? MOCK_SIGNATURE : b64u(crypto.sign('sha256', Buffer.from(input), issuerKeys()[issuerId].privateKey));
  return `${input}.${sig}`;
}

// Splits and decodes a compact token. Never throws. Bounded: three parts, each at most MAX_PART characters, JSON objects only.
export function parseToken(raw) {
  if (typeof raw !== 'string') return { ok: false };
  const parts = raw.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0 || p.length > MAX_PART || !BASE64URL.test(p))) return { ok: false };
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (!plain(header) || !plain(claims)) return { ok: false };
    return { ok: true, header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2] };
  } catch { return { ok: false }; }
}

// True when the signature is valid for the issuer's key. Mock: the fixed marker. Live: RSASSA-PKCS1-v1_5 with SHA-256.
export function signatureValid({ parsed, issuerId, signing }) {
  if (!Object.hasOwn(ISSUERS, issuerId)) return false;
  if (signing === 'mock') return parsed.signature === MOCK_SIGNATURE;
  try { return crypto.verify('sha256', Buffer.from(parsed.signingInput), issuerKeys()[issuerId].publicKey, Buffer.from(parsed.signature, 'base64url')); } catch { return false; }
}

// A short digest so the page can say "this is the same token" without showing it twice.
export const fingerprint = (raw) => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
