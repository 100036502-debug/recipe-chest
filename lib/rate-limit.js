// Tiny Redis-backed rate limiter for the cost-bearing endpoints.
// Fails open if Redis is unavailable, same as the login throttle.

const WINDOW_SECONDS = 60 * 60; // 1 hour

/**
 * Increments the counter for (name, client ip) and returns true when the
 * caller is over the limit. Never throws: on Redis errors it allows the
 * request through so an outage cannot take the app down with it.
 *
 * windowSeconds defaults to the historical 1 hour, so existing callers keep
 * their behaviour; the health check passes 60 for a per-minute limit.
 */
export async function rateLimited(kv, req, name, limit, windowSeconds = WINDOW_SECONDS) {
  try {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = (forwarded || (req.socket && req.socket.remoteAddress) || 'unknown')
      .replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 64) || 'unknown';
    const key = `rl:${name}:${ip}`;
    const count = await kv.incr(key);
    if (count === 1) await kv.expire(key, windowSeconds);
    return count > limit;
  } catch (e) {
    console.error('Rate limit check failed (allowing request):', e.message);
    return false;
  }
}
