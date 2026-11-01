// Tiny Redis-backed rate limiter for the cost-bearing endpoints.
//
// When Redis cannot be reached the limiter falls back to counting in this
// instance's memory, so an outage stops sharing the budget between instances
// rather than removing it. Only when even that is impossible (a new window in a
// fresh instance) is a request let through.
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
/**
 * Last-resort counter for when Redis is unreachable. Per instance, so during an
 * outage the effective limit is `limit` times the number of warm instances,
 * which is still a limit. Bounded so a flood of distinct addresses cannot grow
 * the map without end.
 */
const memoryBuckets = new Map();
const MEMORY_BUCKETS_MAX = 5000;

export function memoryLimited(name, ip, limit, windowSeconds, now = Date.now()) {
  const key = `${name}:${ip}`;
  const windowMs = windowSeconds * 1000;
  const entry = memoryBuckets.get(key);

  if (!entry || now - entry.start >= windowMs) {
    if (memoryBuckets.size >= MEMORY_BUCKETS_MAX) {
      // Drop whatever has already aged out before giving up the oldest slot.
      for (const [k, v] of memoryBuckets) {
        if (now - v.start >= windowMs) memoryBuckets.delete(k);
      }
      if (memoryBuckets.size >= MEMORY_BUCKETS_MAX) memoryBuckets.delete(memoryBuckets.keys().next().value);
    }
    memoryBuckets.set(key, { start: now, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > limit;
}

// Tests drive the fallback directly; nothing in the app calls this.
export function __resetMemoryBuckets() {
  memoryBuckets.clear();
}

export async function rateLimited(kv, req, name, limit, windowSeconds = WINDOW_SECONDS) {
  const ip = getClientIp(req);
  try {
    const key = `rl:${name}:${ip}`;
    const count = await bumpCounter(kv, key, windowSeconds);
    return count > limit;
  } catch (e) {
    logError('rate-limit-unavailable', e, { name });
    // Not open, just narrower: this instance keeps counting on its own.
    return memoryLimited(name, ip, limit, windowSeconds);
  }
}
