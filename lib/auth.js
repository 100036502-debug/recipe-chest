import crypto from 'crypto';

// Session cookies last 30 days and carry their own expiry, signed:
//   member "<expiryMs>.<hmacHex>"        hmac over `${ACCESS_CODE}.${expiryMs}`
//   guest  "<expiryMs>.guest.<hmacHex>"  hmac over `${GUEST_CODE}.guest.${expiryMs}`
// The member format is byte for byte what it always was, so existing logins
// keep working.
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

export function makeSessionValue(code, expiry = Date.now() + SESSION_TTL_MS, role = 'member') {
  const secret = process.env.SESSION_SECRET;
  if (role === 'guest') return `${expiry}.${GUEST_MARK}${sign(secret, `${code}.${GUEST_MARK}${expiry}`)}`;
  return `${expiry}.${sign(secret, `${code}.${expiry}`)}`;
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
  const signature = isGuest ? rest.slice(GUEST_MARK.length) : rest;
  const code = isGuest ? guestCode() : process.env.ACCESS_CODE;
  if (!code) return null;

  const expected = sign(secret, isGuest ? `${code}.${GUEST_MARK}${expiry}` : `${code}.${expiry}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return { role: isGuest ? 'guest' : 'member', exp: expiry };
}

export function hasValidSession(req) {
  return getSession(req) !== null;
}

// Call at the top of a handler: if (!requireAuth(req, res)) return;
//
// opts.memberOnly        the member role is required for every method
// opts.allowGuestWrite   a guest may also use unsafe methods here
export function requireAuth(req, res, opts = {}) {
  if (!process.env.ACCESS_CODE || !process.env.SESSION_SECRET) {
    res.status(500).json({ error: 'Server configuration error' });
    return false;
  }

  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not authorized. Unlock the app with the access code.' });
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
