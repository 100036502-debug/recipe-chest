// What a guest may write, shared by the two per-device buckets (shopping list
// and meal plan).
//
// A guest session is allowed to edit its own device bucket: that is what makes
// the shared device in the kitchen work. It must never be able to touch the
// 'shared' bucket, which is the household list, and guest writes are rate
// limited because a guest cookie costs nothing to obtain when GUEST_OPEN is on.
import { createHash } from 'node:crypto';
import { getSession, parseCookies } from './auth.js';
import { bumpCounter, rateLimited } from './rate-limit.js';

export const SHARED_ID = 'shared';
export const GUEST_WRITE_LIMIT = 120; // per hour, per IP
export const GUEST_SESSION_WRITE_LIMIT = 240; // per hour, per guest session
export const GUEST_BUCKET_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// A guest must not be able to address a bucket by name: a client-chosen id let
// anyone create unlimited keys, or overwrite a member's bucket if the id leaked.
// The bucket is derived from the session cookie instead, so a guest has exactly
// one, and the key carries a TTL so it cannot live in Redis for ever.
export function guestBucketId(req) {
  // Only the signed session cookie identifies a guest. Hashing the whole
  // Cookie header let anyone get a fresh bucket (and a fresh per-session
  // rate-limit counter) by adding a junk cookie, and moved a guest's list
  // whenever an unrelated cookie changed.
  const token = parseCookies(req && req.headers && req.headers.cookie).rc_session || '';
  return 'g_' + createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function isGuestRequest(req) {
  const session = getSession(req);
  return !session || session.role !== 'member';
}

/**
 * Refuses a guest write and answers the request itself. Returns true when the
 * response has been sent, so the caller simply returns.
 */
export async function refuseGuestWrite(req, res, kv, { deviceId, name }) {
  if (!isGuestRequest(req)) return false;

  if (deviceId === SHARED_ID) {
    res.status(403).json({ error: 'View-only access' });
    return true;
  }

  if (await rateLimited(kv, req, name, GUEST_WRITE_LIMIT)) {
    res.setHeader('Retry-After', '3600');
    res.status(429).json({ error: 'Too many list updates. Try again later.' });
    return true;
  }

  // A second, per-session ceiling, so one cookie cannot keep writing while the
  // traffic is spread across addresses.
  try {
    const used = await bumpCounter(kv, `guest_writes:${guestBucketId(req)}`, 3600);
    if (used > GUEST_SESSION_WRITE_LIMIT) {
      res.setHeader('Retry-After', '3600');
      res.status(429).json({ error: 'Too many list updates. Try again later.' });
      return true;
    }
  } catch (e) {
    // An unreadable counter must not stop the write; the IP limit still applies.
  }

  return false;
}

/**
 * The bucket a request may actually touch: a guest is pinned to its derived id,
 * a member keeps the device id it asked for (including 'shared').
 */
export function resolveBucketId(req, requestedId, { keepalive = false } = {}) {
  if (!isGuestRequest(req)) return requestedId;
  return guestBucketId(req);
}

/** Guest buckets expire; member buckets do not. */
export function bucketSetOptions(req) {
  return isGuestRequest(req) ? { ex: GUEST_BUCKET_TTL_SECONDS } : undefined;
}
