// Gateway auth. Two independent credentials, deliberately NOT interchangeable:
//
//   gateway_token  ("用户 key")  — given to people who only *use* the relay. Sent
//                                 as the tool's API key, checked on /v1 and /models.
//                                 It can never open the admin panel.
//   admin_password ("管理密码")  — known only to the owner, unlocks /api (channels,
//                                 upstream keys, logs, settings). Never returned by
//                                 any endpoint.
//
// A loopback bind keeps both checks off (personal local use, unchanged behavior).
//
// The token is read from whatever credential slot the client already fills, so a
// tool's key field doubles as the gateway key and no extra client config is needed.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CLIENT_KEY_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key'];

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const SESSION_MAX = 50;

// Only literal loopback addresses count: a hostname such as "127.0.0.1.example.com"
// would pass a naive prefix test while resolving anywhere, and listen() accepts hostnames.
function isLoopbackAddress(b) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(b);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    return octets.every((n) => n <= 255) && octets[0] === 127;
  }
  return b === '::1' || b === '[::1]' || b === '0:0:0:0:0:0:0:1';
}

export function isLoopbackBind(bind) {
  let b = String(bind ?? '').trim().toLowerCase();
  if (!b) return true; // unset falls back to the 127.0.0.1 default
  if (b === 'localhost') return true;
  if (b.startsWith('::ffff:')) b = b.slice('::ffff:'.length); // IPv4-mapped form
  return isLoopbackAddress(b);
}

// First non-empty credential the client sent, with a leading "bearer " stripped.
export function extractClientKey(headers) {
  if (!headers) return '';
  for (const name of CLIENT_KEY_HEADERS) {
    const raw = headers[name];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t) continue;
    return /^bearer\s+/i.test(t) ? t.replace(/^bearer\s+/i, '').trim() : t;
  }
  return '';
}

export function clientKeyMatches(headers, token) {
  const want = String(token ?? '');
  if (!want) return false;
  return safeEqual(extractClientKey(headers), want);
}

// Length-independent constant-time compare: hash both sides first so unequal
// lengths cannot leak through timingSafeEqual's length check.
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb);
}

// ---------- admin sessions (in-memory: a restart logs the owner out) ----------

const sessions = new Map(); // token -> expiresAt

export function createSession() {
  if (sessions.size >= SESSION_MAX) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function sessionValid(token) {
  const t = String(token ?? '');
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(t);
    return false;
  }
  sessions.set(t, Date.now() + SESSION_TTL_MS); // sliding expiry
  return true;
}

export function dropSession(token) {
  sessions.delete(String(token ?? ''));
}

export function bearerOf(authorization) {
  return String(authorization ?? '').replace(/^bearer\s+/i, '').trim();
}

// ---------- login throttle (public bind makes the panel a brute-force target) ----------

const FREE_ATTEMPTS = 5;
let failures = 0;
let blockedUntil = 0;

export function loginBlockedFor() {
  return Math.max(0, blockedUntil - Date.now());
}

export function noteLoginFailure() {
  failures += 1;
  if (failures >= FREE_ATTEMPTS) {
    blockedUntil = Date.now() + Math.min(30_000 * (failures - FREE_ATTEMPTS + 1), 300_000);
  }
}

export function noteLoginSuccess() {
  failures = 0;
  blockedUntil = 0;
}
