import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const KEY = 'shopping_list';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: return the current list
  if (req.method === 'GET') {
    try {
      const list = await kv.get(KEY);
      return res.status(200).json(list || { items: [], updatedAt: null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST: replace the whole list
  // Body: { items: [{ text: string, checked: boolean, recipeId?: string }] }
  if (req.method === 'POST') {
    const body = req.body || {};
    if (!Array.isArray(body.items)) {
      return res.status(400).json({ error: 'Body must include an items array' });
    }
    const clean = body.items
      .map((it) => ({
        text: String(it.text || '').trim().slice(0, 200),
        checked: !!it.checked,
        recipeId: it.recipeId ? String(it.recipeId).slice(0, 40) : null,
      }))
      .filter((it) => it.text.length > 0)
      .slice(0, 200);

    const payload = { items: clean, updatedAt: Date.now() };

    try {
      await kv.set(KEY, payload);
      return res.status(200).json(payload);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // DELETE: clear the list
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
