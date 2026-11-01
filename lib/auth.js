import { timingSafeEqual } from 'node:crypto';
import crypto from 'crypto';

// Session cookies last 30 days and carry their own expiry, signed, plus a
// session epoch so a cookie can be revoked before it expires:
//   member "<expiryMs>.<epoch>.<hmacHex>"        hmac over `${code}.${expiryMs}.${epoch}`
//   guest  "<expiryMs>.guest.<epoch>.<hmacHex>"  hmac over `${code}.guest.${expiryMs}.${epoch}`
// Cookies issued before the epoch existed have no epoch segment and verify as
// epoch 0, so a deploy does not log everyone out.
export const SESSION_EPOCH_KEY = 'session_epoch';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const GUEST_MARK = 'guest.';

let warnedAboutSameCode = false;

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Guest access is off unless GUEST_CODE is set and differs from ACCESS_CODE.
export function guestCode() {
  const guest = process.env.GUEST_CODE;
  const member = process.env.ACCESS_CODE;
  if (!guest) return '';
  if (member && guest === member) {
    if (!warnedAboutSameCode) {
      console.warn('GUEST_CODE equals ACCESS_CODE: guest access stays disabled.');
      warnedAboutSameCode = true;
    }
    return '';
  }
  return guest;
}

// Open guest access: one flag, and only the exact string "1" turns it on.
export function guestOpen() {
  return process.env.GUEST_OPEN === '1';
}

// What signs a guest cookie. A typed GUEST_CODE keeps working exactly as
// before; with no code set, open guests are signed with a value derived from
// SESSION_SECRET, which is never a usable access code. Turning GUEST_OPEN off
// removes that value, so every open-guest cookie stops verifying at once.
export function guestSigningCode() {
  const typed = guestCode();
  if (typed) return typed;
  if (!guestOpen()) return '';
  const secret = process.env.SESSION_SECRET;
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update('rc-open-guest').digest('hex');
}

export function makeSessionValue(code, expiry = Date.now() + SESSION_TTL_MS, role = 'member', epoch = 0) {
  const secret = process.env.SESSION_SECRET;
  if (role === 'guest') {
    return `${expiry}.${GUEST_MARK}${epoch}.${sign(secret, `${code}.${GUEST_MARK}${expiry}.${epoch}`)}`;
  }
  return `${expiry}.${epoch}.${sign(secret, `${code}.${expiry}.${epoch}`)}`;
}

/**
 * A cookie is valid only while its epoch matches the stored one. Redis being
 * unreachable fails OPEN on purpose: the app's data lives in the same store, so
 * a Redis outage already breaks every route, and logging the whole household
 * out on a blip would be the worse failure. Revocation is a defence against a
 * stolen cookie being used for weeks, not a substitute for expiry.
 */
async function sessionStillValid(req) {
  const session = getSession(req);
  if (!session) return false;
  if (session.role === 'guest') return true; // guests are pinned to a signed bucket

  const { getKv } = await import('./redis.js');
  const current = await sessionEpoch(getKv());
  if (current === null) {
    console.warn('session epoch unreadable: allowing this request');
    return true;
  }
  return session.epoch === current;
}

// "Log out everywhere": bumping this invalidates every cookie issued before.
export async function sessionEpoch(kv) {
  try {
    const raw = await kv.get(SESSION_EPOCH_KEY);
    const n = Number(raw || 0);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch (e) {
    return null; // unknown, callers decide what that means
  }
}

export async function revokeAllSessions(kv) {
  const next = await kv.incr(SESSION_EPOCH_KEY);
  return Number(next) || 1;
}

export function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}

// { role: 'member' | 'guest', exp } or null. Never throws.
export function getSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;

  const token = parseCookies(req && req.headers && req.headers.cookie).rc_session || '';
  const dot = token.indexOf('.');
  if (dot === -1) return null;

  const expiry = Number(token.slice(0, dot));
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;

  const rest = token.slice(dot + 1);
  const isGuest = rest.startsWith(GUEST_MARK);
  const afterMark = isGuest ? rest.slice(GUEST_MARK.length) : rest;
  const code = isGuest ? guestSigningCode() : process.env.ACCESS_CODE;
  if (!code) return null;

  // "<epoch>.<sig>" is the current shape. A cookie issued before the epoch
  // existed carries only the signature and counts as epoch 0, so deploying this
  // does not log everyone out; bumping the epoch still kills both shapes.
  const lastDot = afterMark.lastIndexOf('.');
  const hasEpoch = lastDot !== -1;
  const signature = hasEpoch ? afterMark.slice(lastDot + 1) : afterMark;
  const epochPart = hasEpoch ? afterMark.slice(0, lastDot) : '0';
  if (!/^\d{1,12}$/.test(epochPart)) return null;
  const epoch = Number(epochPart);

  const prefix = isGuest ? `${code}.${GUEST_MARK}${expiry}` : `${code}.${expiry}`;
  const candidates = hasEpoch ? [`${prefix}.${epoch}`] : [`${prefix}.0`, prefix];
  const given = Buffer.from(signature);
  const matches = candidates.some((payload) => {
    const expected = Buffer.from(sign(secret, payload));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  if (!matches) return null;

  return { role: isGuest ? 'guest' : 'member', exp: expiry, epoch };
}

// A long random secret for machine callers (the weekly backup). Returns false
// whenever the secret is unset, so an unconfigured deploy has no back door.
// The comparison is timing safe; only the length can be observed.
export function hasBearerSecret(req, secret) {
  if (!secret || typeof secret !== 'string') return false;
  const header = req && req.headers ? (req.headers.authorization || req.headers.Authorization) : '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  if (!match) return false;
  const given = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export function hasValidSession(req) {
  return getSession(req) !== null;
}

// Call at the top of a handler: if (!(await requireAuth(req, res))) return;
//
// opts.memberOnly        the member role is required for every method
// opts.allowGuestWrite   a guest may also use unsafe methods here
export async function requireAuth(req, res, opts = {}) {

  if (!process.env.ACCESS_CODE || !process.env.SESSION_SECRET) {
    res.status(500).json({ error: 'Server configuration error' });
    return false;
  }

  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not authorized. Unlock the app with the access code.' });
    return false;
  }

  // A cookie whose epoch is behind has been revoked, even though it still
  // verifies: check it only once the session itself is known to be good.
  if (opts.skipRevocationCheck !== true && !(await sessionStillValid(req))) {
    res.status(401).json({ error: 'Session has ended. Unlock the app again.' });
    return false;
  }

  if (opts.memberOnly && session.role !== 'member') {
    res.status(403).json({ error: 'View-only access' });
    return false;
  }

  const method = String(req.method || 'GET').toUpperCase();
  if (session.role === 'guest' && !SAFE_METHODS.has(method) && opts.allowGuestWrite !== true) {
    res.status(403).json({ error: 'View-only access' });
    return false;
  }

  return true;
}
