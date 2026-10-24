// api/verify-code.js
import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { makeToken, parseCookies } from '../lib/auth.js';

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

  const expectedToken = makeToken(ACCESS_CODE);

  // GET: check if the caller already has a valid session cookie
  if (req.method === 'GET') {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies['rc_session'] || '';
    const a = Buffer.from(token);
    const b = Buffer.from(expectedToken);
    const unlocked = a.length === b.length && crypto.timingSafeEqual(a, b);
    return res.status(200).json({ unlocked });
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
    const a = Buffer.from(submitted);
    const b = Buffer.from(ACCESS_CODE);
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!match) {
      return res.status(401).json({ unlocked: false });
    }

    try { await kv.del(attemptsKey); } catch (_) { /* ignore */ }

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
