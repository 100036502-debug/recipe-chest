// GET /api/health — is the app alive and can it reach Redis?
//
// Public on purpose (no auth): an uptime checker cannot hold a session cookie.
// It therefore reveals nothing beyond two booleans.
import { getKv } from '../redis.js';
import { rateLimited } from '../rate-limit.js';
import { logError } from '../log.js';

export function createHandler({ kv }) {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    res.setHeader('Cache-Control', 'no-store');

    // 60 checks a minute is plenty for a monitor and stops this being a free
    // way to hammer Redis.
    if (await rateLimited(kv, req, 'health', 60, 60)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    let redis = false;
    try {
      await kv.ping();
      redis = true;
    } catch (e) {
      logError('health-redis-unreachable', e);
    }

    return res.status(200).json({ ok: true, redis });
  };
}

export default function handler(req, res) {
  return createHandler({ kv: getKv() })(req, res);
}
