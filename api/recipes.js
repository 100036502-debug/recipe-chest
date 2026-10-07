import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- GET: list every recipe, newest first ----
  if (req.method === 'GET') {
    try {
      const ids = await kv.lrange('recipe_ids', 0, -1);
      if (!ids || !ids.length) return res.status(200).json([]);
      const recipes = await Promise.all(ids.map((id) => kv.get(`recipe:${id}`)));
      const valid = recipes
        .filter(Boolean)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return res.status(200).json(valid);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ---- POST: save one recipe ----
  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.title || typeof body.title !== 'string') {
      return res.status(400).json({ error: 'Recipe must have a title' });
    }
    const id = body.id || ('r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const recipe = {
      ...body,
      id,
      createdAt: body.createdAt || Date.now(),
    };
    try {
      await kv.set(`recipe:${id}`, recipe);
      const existing = await kv.lrange('recipe_ids', 0, -1);
      if (!existing.includes(id)) {
        await kv.lpush('recipe_ids', id);
      }
      return res.status(200).json(recipe);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ---- DELETE: remove one recipe by id ----
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    try {
      await kv.del(`recipe:${id}`);
      await kv.lrem('recipe_ids', 0, id);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
