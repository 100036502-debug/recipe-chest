// api/verify-code.js
import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { makeSessionValue, hasValidSession, getSession, guestCode } from '../lib/auth.js';

const ACCESS_CODE = process.env.ACCESS_CODE;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ACCESS_CODE) {
  console.error('ACCESS_CODE is not set in environment variables');
}

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
  return ip.replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 64) || 'unknown';
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!ACCESS_CODE || !SESSION_SECRET) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // GET: check if the caller already has a valid session cookie
  if (req.method === 'GET') {
    const cur = getSession(req);
    return res.status(200).json({ unlocked: cur !== null, role: cur ? cur.role : null });
  }

  // POST: verify a submitted code
  if (req.method === 'POST') {
    // Throttle guesses per IP. If Redis is down, fail open rather than lock everyone out.
    const attemptsKey = `verify_attempts:${clientIp(req)}`;
    let attempts = 0;
    try {
      attempts = await kv.incr(attemptsKey);
      if (attempts === 1) await kv.expire(attemptsKey, WINDOW_SECONDS);
    } catch (e) {
      console.error('Rate limit check failed:', e.message);
    }
    if (attempts > MAX_ATTEMPTS) {
      res.setHeader('Retry-After', String(WINDOW_SECONDS));
      return res.status(429).json({
        unlocked: false,
        error: 'Too many attempts. Try again in 15 minutes.',
      });
    }

    const body = req.body || {};
    const submitted = typeof body.code === 'string' ? body.code : '';

    // Timing-safe compare to avoid leaking length or content via timing
    function same(candidate) {
      const a = Buffer.from(submitted);
      const b = Buffer.from(candidate);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    // Member code first, so a member is never downgraded to guest.
    const guest = guestCode();
    const role = same(ACCESS_CODE) ? 'member' : (guest && same(guest) ? 'guest' : null);
    if (!role) {
      return res.status(401).json({ unlocked: false });
    }

    try { await kv.del(attemptsKey); } catch (_) { /* ignore */ }

    // Set an HttpOnly cookie so the browser doesn't send the code again
    const isHttps = (req.headers['x-forwarded-proto'] || '').includes('https');
    const cookie = [
      `rc_session=${makeSessionValue(role === 'guest' ? guest : ACCESS_CODE, undefined, role)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      isHttps ? 'Secure' : '',
      'Max-Age=2592000', // 30 days
    ].filter(Boolean).join('; ');

    res.setHeader('Set-Cookie', cookie);
    return res.status(200).json({ unlocked: true, role });
  }

  // DELETE: log out — clear the session cookie
  if (req.method === 'DELETE') {
    const isHttps = (req.headers['x-forwarded-proto'] || '').includes('https');
    const cookie = [
      'rc_session=',
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      isHttps ? 'Secure' : '',
      'Max-Age=0',
    ].filter(Boolean).join('; ');
    res.setHeader('Set-Cookie', cookie);
    return res.status(200).json({ unlocked: false });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
