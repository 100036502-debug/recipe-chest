import crypto from 'crypto';

// Session cookies last 30 days and carry their own expiry, signed:
// "<expiryMs>.<hmacHex>" where hmac = HMAC-SHA256(SESSION_SECRET,
// `${ACCESS_CODE}.${expiryMs}`). A copied cookie stops working after
// the embedded expiry passes.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function makeSessionValue(code, expiry = Date.now() + SESSION_TTL_MS) {
  const hmac = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(`${code}.${expiry}`)
    .digest('hex');
  return `${expiry}.${hmac}`;
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

// True when the request carries a valid, unexpired session cookie.
export function hasValidSession(req) {
  const accessCode = process.env.ACCESS_CODE;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!accessCode || !sessionSecret) return false;

  const token = parseCookies(req.headers.cookie)['rc_session'] || '';
  const dot = token.indexOf('.');
  if (dot === -1) return false;

  const expiry = Number(token.slice(0, dot));
  const hmac = token.slice(dot + 1);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;

  const expected = crypto
    .createHmac('sha256', sessionSecret)
    .update(`${accessCode}.${expiry}`)
    .digest('hex');
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Call at the top of a handler: if (!requireAuth(req, res)) return;
// Sends the 401/500 response itself and returns false when the caller is not allowed in.
export function requireAuth(req, res) {
  if (!process.env.ACCESS_CODE || !process.env.SESSION_SECRET) {
    res.status(500).json({ error: 'Server configuration error' });
    return false;
  }

  if (hasValidSession(req)) return true;

  res.status(401).json({ error: 'Not authorized. Unlock the app with the access code.' });
  return false;
}
