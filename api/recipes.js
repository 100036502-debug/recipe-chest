import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const ids = await kv.lrange('recipe_ids', 0, -1);
      if (!ids || !ids.length) return res.status(200).json([]);
      const recipes = await Promise.all(ids.map(id => kv.get(`recipe:${id}`)));
      const valid = recipes.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
      return res.status(200).json(valid);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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
