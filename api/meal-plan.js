import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { ID_PATTERN } from '../lib/recipes.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

function keyFor(deviceId) {
  return `meal_plan:${deviceId}`;
}

function cleanDeviceId(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAuth(req, res)) return;

  const rawId = req.query?.deviceId || (req.body && req.body.deviceId);
  const deviceId = cleanDeviceId(rawId);
  if (!deviceId) {
    return res.status(400).json({ error: 'Missing or invalid deviceId' });
  }

  const key = keyFor(deviceId);

  // GET: return the whole plan for this device
  if (req.method === 'GET') {
    try {
      const plan = await kv.get(key);
      return res.status(200).json(plan || {});
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST: set the recipes for one day for this device
  if (req.method === 'POST') {
    const body = req.body || {};
    const date = String(body.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Body must include date as YYYY-MM-DD' });
    }
    if (!Array.isArray(body.recipeIds)) {
      return res.status(400).json({ error: 'Body must include a recipeIds array' });
    }

    const ids = body.recipeIds
      .map((id) => String(id).trim())
      .filter((id) => ID_PATTERN.test(id))
      .slice(0, 10);

    try {
      const plan = (await kv.get(key)) || {};
      if (ids.length === 0) {
        delete plan[date];
      } else {
        plan[date] = ids;
      }
      await kv.set(key, plan);
      return res.status(200).json(plan);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // DELETE: clear the whole plan for this device
  if (req.method === 'DELETE') {
    try {
      await kv.del(key);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
