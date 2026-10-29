import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { sendServerError } from '../lib/http.js';
import { cleanItems, decideWrite } from '../lib/shopping-list.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

function keyFor(deviceId) {
  return `shopping_list:${deviceId}`;
}

function cleanDeviceId(raw) {
  // Only allow safe characters, max 64 chars
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAuth(req, res)) return;

  // deviceId can arrive via query (?deviceId=...) or body
  const rawId = req.query?.deviceId || (req.body && req.body.deviceId);
  const deviceId = cleanDeviceId(rawId);
  if (!deviceId) {
    return res.status(400).json({ error: 'Missing or invalid deviceId' });
  }

  const key = keyFor(deviceId);

  // GET: return the current list for this device
  if (req.method === 'GET') {
    try {
      const list = await kv.get(key);
      return res.status(200).json(list || { items: [], updatedAt: null });
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  // POST: replace the whole list for this device
  if (req.method === 'POST') {
    const body = req.body || {};
    if (!Array.isArray(body.items)) {
      return res.status(400).json({ error: 'Body must include an items array' });
    }
    const clean = cleanItems(body.items);
    if (!clean) return res.status(400).json({ error: 'Body must include an items array' });

    try {
      // Two people sharing one list must not silently overwrite each other.
      const stored = await kv.get(key);
      const verdict = decideWrite({ stored, baseUpdatedAt: body.baseUpdatedAt });
      if (!verdict.write) {
        return res.status(409).json({ error: 'conflict', current: verdict.current });
      }

      const payload = { items: clean, updatedAt: Date.now() };
      await kv.set(key, payload);
      return res.status(200).json(payload);
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  // DELETE: clear the list for this device
  if (req.method === 'DELETE') {
    try {
      await kv.del(key);
      return res.status(200).json({ success: true });
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
