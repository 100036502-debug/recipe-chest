// What a guest may write, shared by the two per-device buckets (shopping list
// and meal plan).
//
// A guest session is allowed to edit its own device bucket: that is what makes
// the shared device in the kitchen work. It must never be able to touch the
// 'shared' bucket, which is the household list, and guest writes are rate
// limited because a guest cookie costs nothing to obtain when GUEST_OPEN is on.
import { getSession } from './auth.js';
import { rateLimited } from './rate-limit.js';

export const SHARED_ID = 'shared';
export const GUEST_WRITE_LIMIT = 120; // per hour, per IP

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

  return false;
}
