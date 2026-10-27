// POST /api/import-backup — restores a backup produced by GET /api/export.
// Recipes whose id already exists are skipped, never overwritten.
// Photos included in the file are restored to photo:<id> / photothumb:<id>
// only when both strings are plausible base64 (and then set userPhoto on
// the restored recipe). userPhoto is never copied from the recipe itself.
// Keep files under ~4.5 MB (Vercel's request limit) — export photos in
// batches for large chests.
import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { sanitizeStoredRecipe } from '../lib/recipes.js';
import { sendServerError } from '../lib/http.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
  maxDuration: 60,
};

const MAX_RECIPES_PER_REQUEST = 500;
const BASE64_PATTERN = /^[A-Za-z0-9+/=]+$/;
const MAX_PHOTO_CHARS = 1200000; // ~900 KB binary, safe within the request limit

// Valid base64 photo pair or nothing: both strings are required together.
function validPhotoPair(photo) {
  if (!photo || typeof photo !== 'object') return null;
  const { photo: main, photothumb } = photo;
  if (typeof main !== 'string' || typeof photothumb !== 'string') return null;
  if (main.length > MAX_PHOTO_CHARS || photothumb.length > MAX_PHOTO_CHARS) return null;
  if (!BASE64_PATTERN.test(main) || !BASE64_PATTERN.test(photothumb)) return null;
  return { main, photothumb };
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    /* fall through */;
  } else if (req.method === 'OPTIONS') {
    return res.status(204).end();
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAuth(req, res)) return;

  try {
    const body = req.body || {};
    const incoming = Array.isArray(body.recipes)
      ? body.recipes
      : (Array.isArray(body) ? body : []);
    if (incoming.length > MAX_RECIPES_PER_REQUEST) {
      return res.status(400).json({ error: `Too many recipes in one request (max ${MAX_RECIPES_PER_REQUEST}).` });
    }
    const hasPhotos = body.photos && typeof body.photos === 'object';
    if (!incoming.length && !hasPhotos) {
      return res.status(400).json({ error: 'No recipes or photos in that backup' });
    }

    const existingIds = new Set((await kv.lrange('recipe_ids', 0, -1)) || []);
    const photos = hasPhotos ? body.photos : {};

    let imported = 0;
    let skipped = 0;

    for (const recipe of incoming) {
      // Rebuild the recipe from known-clean fields only; reject on failure.
      const clean = sanitizeStoredRecipe(recipe);
      if (!clean) { skipped++; continue; }

      if (existingIds.has(clean.id)) { skipped++; continue; }

      // Photos: both strings must be valid base64, or neither is written.
      const pair = validPhotoPair(photos[clean.id]);
      if (pair) {
        clean.userPhoto = { updatedAt: Date.now() };
      }

      await kv.set(`recipe:${clean.id}`, clean);
      await kv.lpush('recipe_ids', clean.id);
      existingIds.add(clean.id);
      imported++;

      if (pair) {
        await kv.set(`photo:${clean.id}`, pair.main);
        await kv.set(`photothumb:${clean.id}`, pair.photothumb);
      }
    }

    // Photos-only payload (a photo slice from the export): restore the
    // photo pair and set userPhoto on the recipe that already exists.
    let photosRestored = 0;
    if (!incoming.length) {
      for (const [id, data] of Object.entries(photos)) {
        if (!existingIds.has(id)) continue; // nothing to attach it to
        const pair = validPhotoPair(data);
        if (!pair) continue;
        const recipe = await kv.get(`recipe:${id}`);
        if (!recipe) continue;
        recipe.userPhoto = { updatedAt: Date.now() };
        await kv.set(`recipe:${id}`, recipe);
        await kv.set(`photo:${id}`, pair.main);
        await kv.set(`photothumb:${id}`, pair.photothumb);
        photosRestored++;
      }
    }

    return res.status(200).json({ imported, skipped, photosRestored });
  } catch (e) {
    return sendServerError(res, e, 'Could not restore that backup');
  }
}
