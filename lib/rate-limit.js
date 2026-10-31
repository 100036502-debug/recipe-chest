// Tiny Redis-backed rate limiter for the cost-bearing endpoints.
// Fails open if Redis is unavailable, same as the login throttle: an outage
// must not take the whole app down with it.
import { logError } from './log.js';

const WINDOW_SECONDS = 60 * 60; // 1 hour

// Mutable so a test can lower them without waiting 1.5 s or 100 requests.
export const limits = {
  globalFailureThreshold: 100, // wrong codes per hour, across all IPs
  failurePenaltyMs: 1500,
};

/**
 * The caller's address. Vercel sets x-vercel-forwarded-for itself, so it is
 * preferred over anything the client could have sent; the plain
 * x-forwarded-for fallback is only trustworthy behind a proxy that overwrites
 * it. Keep the order: a spoofed header must not buy a fresh bucket.
 */
export function getClientIp(req) {
  const header = (name) => String((req && req.headers && req.headers[name]) || '').split(',')[0].trim();
  const ip = header('x-vercel-forwarded-for')
    || header('x-real-ip')
    || header('x-forwarded-for')
    || (req && req.socket && req.socket.remoteAddress)
    || 'unknown';
  return ip.replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 64) || 'unknown';
}

/**
 * incr, and make sure the key has an expiry.
 *
 * The old code expired only when the count came back as 1: if that single
 * expire call failed, the key lived forever and the caller was locked out
 * permanently. Re-checking the TTL costs one round trip and removes that.
 */
export async function bumpCounter(kv, key, windowSeconds = WINDOW_SECONDS) {
  const count = await kv.incr(key);
  if (count === 1) {
    await kv.expire(key, windowSeconds);
    return count;
  }
  let ttl = null;
  try {
    if (typeof kv.ttl === 'function') ttl = await kv.ttl(key);
  } catch { ttl = null; }
  if (ttl === null || ttl === -1) await kv.expire(key, windowSeconds); // -1: no expiry set
  return count;
}

/**
 * How long a wrong-code answer should be held back. Zero below the threshold:
 * a hard global lockout would let one attacker lock the owner out, so the
 * penalty only makes guessing slower.
 */
export function failurePenalty(count) {
  return Number(count) > limits.globalFailureThreshold ? limits.failurePenaltyMs : 0;
}

export function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
}

/**
 * Increments the counter for (name, client ip) and returns true when the
 * caller is over the limit. Never throws: on Redis errors it allows the
 * request through.
 *
 * windowSeconds defaults to the historical 1 hour, so existing callers keep
 * their behaviour; the health check passes 60 for a per-minute limit.
 */
export async function rateLimited(kv, req, name, limit, windowSeconds = WINDOW_SECONDS) {
  try {
    const key = `rl:${name}:${getClientIp(req)}`;
    const count = await bumpCounter(kv, key, windowSeconds);
    return count > limit;
  } catch (e) {
    logError('rate-limit-unavailable', e, { name });
    return false;
  }
}
