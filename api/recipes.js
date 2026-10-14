import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

// Fields the client is allowed to edit via PATCH
const EDITABLE_FIELDS = [
  'title', 'description', 'prepTime', 'cookTime', 'servings',
  'mealType', 'tags', 'ingredients', 'instructions', 'notes',
];

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'drink', 'default'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

  // ---- POST: save one recipe (with duplicate detection) ----
  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.title || typeof body.title !== 'string') {
      return res.status(400).json({ error: 'Recipe must have a title' });
    }

    const skipDuplicateCheck = body.skipDuplicateCheck === true;

    try {
      // Duplicate detection: match on normalized title, or source URL
      if (!skipDuplicateCheck) {
        const ids = await kv.lrange('recipe_ids', 0, -1);
        if (ids && ids.length) {
          const existing = (await Promise.all(ids.map((id) => kv.get(`recipe:${id}`))))
            .filter(Boolean);

          const normTitle = normalizeTitle(body.title);
          const sourceUrl = (body.sourceUrl || '').trim();

          const dup = existing.find((r) => {
            if (normalizeTitle(r.title) === normTitle) return true;
            if (sourceUrl && (r.sourceUrl || '').trim() === sourceUrl) return true;
            return false;
          });

          if (dup) {
            return res.status(409).json({
              error: 'Possible duplicate',
              duplicate: dup,
            });
          }
        }
      }

      const id = body.id || ('r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      const recipe = {
        ...body,
        id,
        createdAt: body.createdAt || Date.now(),
      };
      delete recipe.skipDuplicateCheck;

      await kv.set(`recipe:${id}`, recipe);
      const existingIds = await kv.lrange('recipe_ids', 0, -1);
      if (!existingIds.includes(id)) {
        await kv.lpush('recipe_ids', id);
      }
      return res.status(200).json(recipe);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ---- PATCH: update any editable field on an existing recipe ----
  if (req.method === 'PATCH') {
    const body = req.body || {};
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) return res.status(400).json({ error: 'Missing recipe id' });

    try {
      const existing = await kv.get(`recipe:${id}`);
      if (!existing) return res.status(404).json({ error: 'Recipe not found' });

      const updated = { ...existing };

      for (const field of EDITABLE_FIELDS) {
        if (!(field in body)) continue;

        if (field === 'tags') {
          if (!Array.isArray(body.tags)) continue;
          updated.tags = [...new Set(
            body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
          )].slice(0, 20);
        } else if (field === 'ingredients' || field === 'instructions') {
          if (!Array.isArray(body[field])) continue;
          updated[field] = body[field]
            .map((s) => String(s).trim())
            .filter(Boolean)
            .slice(0, 100);
        } else if (field === 'mealType') {
          const mt = String(body.mealType || '').toLowerCase();
          updated.mealType = VALID_MEAL_TYPES.includes(mt) ? mt : 'default';
        } else {
          updated[field] = String(body[field] ?? '').trim();
        }
      }

      updated.updatedAt = Date.now();
      await kv.set(`recipe:${id}`, updated);
      return res.status(200).json(updated);
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

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
