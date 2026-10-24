import crypto from 'crypto';

// Deterministic session token derived from the access code and a server secret.
export function makeToken(code) {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(code)
    .digest('hex');
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

// Call at the top of a handler: if (!requireAuth(req, res)) return;
// Sends the 401/500 response itself and returns false when the caller is not allowed in.
export function requireAuth(req, res) {
  const accessCode = process.env.ACCESS_CODE;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!accessCode || !sessionSecret) {
    res.status(500).json({ error: 'Server configuration error' });
    return false;
  }

  const token = parseCookies(req.headers.cookie)['rc_session'] || '';
  const expected = makeToken(accessCode);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);

  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;

  res.status(401).json({ error: 'Not authorized. Unlock the app with the access code.' });
  return false;
}
