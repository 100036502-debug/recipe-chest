// api/verify-code.js
import crypto from 'crypto';

const ACCESS_CODE = process.env.ACCESS_CODE;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ACCESS_CODE) {
  console.error('ACCESS_CODE is not set in environment variables');
}

// Deterministic session value derived from the code and a server secret.
// Same code + same secret = same token. No session store needed.
function makeToken(code) {
  return crypto
    .createHmac('sha256', SESSION_SECRET || 'fallback-secret')
    .update(code)
    .digest('hex');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!ACCESS_CODE || !SESSION_SECRET) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const expectedToken = makeToken(ACCESS_CODE);

  // GET: check if the caller already has a valid session cookie
  if (req.method === 'GET') {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies['rc_session'];
    return res.status(200).json({ unlocked: token === expectedToken });
  }

  // POST: verify a submitted code
  if (req.method === 'POST') {
    const body = req.body || {};
    const submitted = typeof body.code === 'string' ? body.code : '';

    // Timing-safe compare to avoid leaking length or content via timing
    const a = Buffer.from(submitted);
    const b = Buffer.from(ACCESS_CODE);
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!match) {
      return res.status(401).json({ unlocked: false });
    }

    // Set an HttpOnly cookie so the browser doesn't send the code again
    const isHttps = (req.headers['x-forwarded-proto'] || '').includes('https');
    const cookie = [
      `rc_session=${expectedToken}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      isHttps ? 'Secure' : '',
      'Max-Age=2592000', // 30 days
    ].filter(Boolean).join('; ');

    res.setHeader('Set-Cookie', cookie);
    return res.status(200).json({ unlocked: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function parseCookies(header) {
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
