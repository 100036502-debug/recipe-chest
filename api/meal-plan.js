import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const KEY = 'meal_plan';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: return the whole plan object
  if (req.method === 'GET') {
    try {
      const plan = await kv.get(KEY);
      return res.status(200).json(plan || {});
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST: set the recipes for one day
  // Body: { date: 'YYYY-MM-DD', recipeIds: string[] }
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
      .filter(Boolean)
      .slice(0, 10);

    try {
      const plan = (await kv.get(KEY)) || {};
      if (ids.length === 0) {
        delete plan[date];
      } else {
        plan[date] = ids;
      }
      await kv.set(KEY, plan);
      return res.status(200).json(plan);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // DELETE: clear the whole plan
  if (req.method === 'DELETE') {
    try {
      await kv.del(KEY);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
