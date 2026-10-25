// POST /api/import-backup — restores a backup produced by GET /api/export.
// Recipes whose id already exists are skipped, never overwritten.
// Photos included in the file are restored to photo:<id> / photothumb:<id>.
// Keep files under ~4.5 MB (Vercel's request limit) — export photos in
// batches for large chests.
import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { ID_PATTERN } from '../lib/recipes.js';
import { sendServerError } from '../lib/http.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  try {
    const body = req.body || {};
    const incoming = Array.isArray(body.recipes)
      ? body.recipes
      : (Array.isArray(body) ? body : []);
    if (!incoming.length) return res.status(400).json({ error: 'No recipes in that backup' });

    const existingIds = new Set((await kv.lrange('recipe_ids', 0, -1)) || []);
    const photos = (body.photos && typeof body.photos === 'object') ? body.photos : {};

    let imported = 0;
    let skipped = 0;
    const importedIds = [];

    for (const recipe of incoming) {
      const id = String(recipe && recipe.id || '');
      if (!ID_PATTERN.test(id)) { skipped++; continue; }

      const exists = existingIds.has(id) || Boolean(await kv.get(`recipe:${id}`));
      if (exists) { skipped++; continue; }

      // Sanitize the same way a normal create would.
      const clean = {
        ...recipe,
        id,
        title: String(recipe.title || 'Untitled Recipe').slice(0, 200),
        createdAt: Number.isFinite(recipe.createdAt) ? recipe.createdAt : Date.now(),
      };

      await kv.set(`recipe:${id}`, clean);
      await kv.lpush('recipe_ids', id);
      existingIds.add(id);
      importedIds.push(id);
      imported++;

      const photo = photos[id] || {};
      if (photo.photo) await kv.set(`photo:${id}`, photo.photo);
      if (photo.photothumb) await kv.set(`photothumb:${id}`, photo.photothumb);
    }

    return res.status(200).json({ imported, skipped });
  } catch (e) {
    return sendServerError(res, e, 'Could not restore that backup');
  }
}
