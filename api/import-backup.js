// POST /api/import-backup — restores a backup produced by GET /api/export.
// Recipes whose id already exists — meaning `recipe:<id>` is actually stored —
// are skipped, never overwritten. An id that is only in `recipe_ids` with no
// recipe behind it is missing, and is restored (and its id not duplicated).
// Photos included in the file are restored to photo:<id> / photothumb:<id>
// only when both strings are plausible base64 (and then set userPhoto on
// the restored recipe). userPhoto is never copied from the recipe itself.
// Keep files under ~4.5 MB (Vercel's request limit) — export photos in
// batches for large chests.
import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { ID_PATTERN, restoreDecision, sanitizeStoredRecipe } from '../lib/recipes.js';
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

// Reads `recipe:<id>` for each id, batched through MGET (100 keys per call)
// instead of one round trip per recipe. Returns a Map of id -> stored recipe;
// ids with nothing stored behind them are simply absent.
async function readStoredRecipes(ids) {
  const present = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const vals = await kv.mget(...batch.map((id) => `recipe:${id}`));
    batch.forEach((id, idx) => { if (vals[idx]) present.set(id, vals[idx]); });
  }
  return present;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
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

    const listedIds = new Set((await kv.lrange('recipe_ids', 0, -1)) || []);
    const photos = hasPhotos ? body.photos : {};

    // Rebuild every recipe from known-clean fields only; anything unsanitizable
    // is skipped before we spend any Redis calls on it.
    const candidates = [];
    let skipped = 0;
    for (const recipe of incoming) {
      const clean = sanitizeStoredRecipe(recipe);
      if (!clean) { skipped++; continue; }
      if (!clean.createdAt) clean.createdAt = Date.now();
      candidates.push(clean);
    }

    // Existence is decided by `recipe:<id>` itself, not by the id list, and the
    // whole batch is read with MGET so a 500-recipe restore still fits in 60 s.
    const stored = await readStoredRecipes(candidates.map((c) => c.id));

    let imported = 0;
    for (const clean of candidates) {
      const decision = restoreDecision(stored.get(clean.id), listedIds.has(clean.id));
      if (!decision.write) { skipped++; continue; }

      // Photos: both strings must be valid base64, or neither is written.
      const pair = validPhotoPair(photos[clean.id]);
      if (pair) {
        clean.userPhoto = { updatedAt: Date.now() };
      }

      await kv.set(`recipe:${clean.id}`, clean);
      // An id that is listed with no recipe behind it is repaired here rather
      // than pushed a second time.
      if (decision.addToList) {
        await kv.lpush('recipe_ids', clean.id);
        listedIds.add(clean.id);
      }
      stored.set(clean.id, clean);
      imported++;

      if (pair) {
        await kv.set(`photo:${clean.id}`, pair.main);
        await kv.set(`photothumb:${clean.id}`, pair.photothumb);
      }
    }

    // Photos-only payload (a photo slice from the export): restore the
    // photo pair and set userPhoto on the recipe that actually exists.
    let photosRestored = 0;
    if (!incoming.length) {
      const photoIds = Object.keys(photos).filter((id) => ID_PATTERN.test(id));
      const storedRecipes = await readStoredRecipes(photoIds);
      for (const id of photoIds) {
        const recipe = storedRecipes.get(id);
        if (!recipe) continue; // nothing to attach it to
        const pair = validPhotoPair(photos[id]);
        if (!pair) continue;
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
