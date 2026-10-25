import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { VALID_MEAL_TYPES, ID_PATTERN, cleanTags, findDuplicate } from '../lib/recipes.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

// Fields the client is allowed to set or edit
const EDITABLE_FIELDS = [
  'title', 'description', 'prepTime', 'cookTime', 'servings',
  'mealType', 'tags', 'ingredients', 'instructions', 'notes',
];

const MEAL_TYPES_WITH_DEFAULT = [...VALID_MEAL_TYPES, 'default'];

function applyEditableFields(target, body) {
  for (const field of EDITABLE_FIELDS) {
    if (!(field in body)) continue;

    if (field === 'tags') {
      if (!Array.isArray(body.tags)) continue;
      target.tags = cleanTags(body.tags, 20);
    } else if (field === 'ingredients' || field === 'instructions') {
      if (!Array.isArray(body[field])) continue;
      target[field] = body[field]
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 100);
    } else if (field === 'mealType') {
      const mt = String(body.mealType || '').toLowerCase();
      target.mealType = MEAL_TYPES_WITH_DEFAULT.includes(mt) ? mt : 'default';
    } else {
      target[field] = String(body[field] ?? '').trim();
    }
  }
  return target;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAuth(req, res)) return;

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
    const sourceUrl = typeof body.sourceUrl === 'string' && /^https?:\/\//i.test(body.sourceUrl.trim())
      ? body.sourceUrl.trim().slice(0, 2000)
      : '';

    try {
      if (!skipDuplicateCheck) {
        const dup = await findDuplicate(kv, { title: body.title, sourceUrl });
        if (dup) {
          return res.status(409).json({ error: 'Possible duplicate', duplicate: dup });
        }
      }

      const rawId = typeof body.id === 'string' ? body.id : '';
      const id = ID_PATTERN.test(rawId)
        ? rawId
        : 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

      const recipe = applyEditableFields({
        id,
        ingredients: [],
        instructions: [],
        tags: [],
        mealType: 'default',
        sourceUrl,
        addedBy: String(body.addedBy || 'Anonymous').slice(0, 40),
        createdAt: Number.isFinite(body.createdAt) ? body.createdAt : Date.now(),
      }, body);

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

      const updated = applyEditableFields({ ...existing }, body);
      updated.updatedAt = Date.now();
      await kv.set(`recipe:${id}`, updated);
      return res.status(200).json(updated);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ---- DELETE: remove one recipe by id ----
  if (req.method === 'DELETE') {
    const id = String(req.query.id || '');
    if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid or missing id' });
    try {
      await kv.del(`recipe:${id}`);
      await kv.del(`photo:${id}`, `photothumb:${id}`);
      await kv.lrem('recipe_ids', 0, id);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
