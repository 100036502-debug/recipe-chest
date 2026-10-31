// api/verify-code.js
import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { makeSessionValue, getSession, guestCode, guestOpen, guestSigningCode } from '../lib/auth.js';
import { bumpCounter, failurePenalty, getClientIp, sleep } from '../lib/rate-limit.js';
import { logError } from '../lib/log.js';

const ACCESS_CODE = process.env.ACCESS_CODE;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ACCESS_CODE) {
  console.error('ACCESS_CODE is not set in environment variables');
} else if (ACCESS_CODE.length < 12) {
  // A short code is a guessable code. Warn on cold start, do not refuse to run.
  logError('weak-access-code', new Error(`ACCESS_CODE is only ${ACCESS_CODE.length} characters; use 12 or more.`));
}
if (SESSION_SECRET && SESSION_SECRET.length < 32) {
  logError('weak-session-secret', new Error(`SESSION_SECRET is only ${SESSION_SECRET.length} characters; use 32 or more.`));
}

// let, not const: tests swap in a fake store instead of a real connection.
let kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export function __setKvForTests(store) { kv = store; }

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!ACCESS_CODE || !SESSION_SECRET) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // GET: check if the caller already has a valid session cookie
  if (req.method === 'GET') {
    const cur = getSession(req);
    return res.status(200).json({ unlocked: cur !== null, role: cur ? cur.role : null, guestOpen: guestOpen() });
  }

  // POST: verify a submitted code
  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    // Open guest access: a body of exactly { guest: true } and nothing else.
    // This sits before the attempt counter because no code is being guessed,
    // and a sent code always wins so a member can never be downgraded.
    if (body.guest === true && typeof body.code !== 'string') {
      if (!guestOpen()) return res.status(403).json({ unlocked: false });
      const guestSecret = guestSigningCode();
      if (!guestSecret) return res.status(403).json({ unlocked: false });
      const guestHttps = (req.headers['x-forwarded-proto'] || '').includes('https');
      res.setHeader('Set-Cookie', [
        `rc_session=${makeSessionValue(guestSecret, undefined, 'guest')}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        guestHttps ? 'Secure' : '',
        'Max-Age=2592000',
      ].filter(Boolean).join('; '));
      return res.status(200).json({ unlocked: true, role: 'guest' });
    }

    // Throttle guesses per IP. If Redis is down, fail open rather than lock everyone out.
    const attemptsKey = `verify_attempts:${getClientIp(req)}`;
    let attempts = 0;
    try {
      attempts = await bumpCounter(kv, attemptsKey, WINDOW_SECONDS);
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
      // Count failures across every IP, and slow the answer down once there are
      // a lot of them. A hard global lockout would let an attacker shut the
      // owner out; a delay only makes guessing expensive.
      let failures = 0;
      try {
        failures = await bumpCounter(kv, 'verify_failures:global', WINDOW_SECONDS);
      } catch (e) { /* a counter we cannot read must not block the answer */ }
      const penalty = failurePenalty(failures);
      if (penalty) await sleep(penalty);
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
