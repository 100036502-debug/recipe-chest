// GET /api/export — backup download.
//   /api/export                       -> all recipes (no photos), one file.
//   /api/export?photos=1              -> SAME recipes-only file (unchanged behaviour).
//   /api/export?photos=1&offset=N&limit=M -> a photo SLICE for big chests:
//        { app, exportedAt, offset, nextOffset, done,
//          photos: { <id>: { photo, photothumb } } }
//      Photos are 100-300 KB per pair, so a single response could exceed
//      Vercel's ~4.5 MB limit; slices keep every response under ~3.5 MB
//      (the limit shrinks automatically if the data is large).
import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { ID_PATTERN, getRecipesByIds } from '../lib/recipes.js';
import { sendServerError } from '../lib/http.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = { maxDuration: 60 };

const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

function isId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

// Fetches the photo pair for one recipe id, or null when none is stored.
async function readPhotoPair(id) {
  const [photo, photothumb] = await kv.mget(`photo:${id}`, `photothumb:${id}`);
  if (!photo || !photothumb) return null;
  return { photo, photothumb };
}

/**
 * Collects photos for ids[offset..] until the limit count or the byte
 * budget would be exceeded. Returns { photos, nextOffset, done }.
 */
async function collectPhotoSlice(ids, offset, limit) {
  const photos = {};
  let bytes = 0;
  let i = offset;
  let served = 0;

  for (; i < ids.length; i++) {
    if (served >= limit) break;
    const pair = await readPhotoPair(ids[i]);
    if (!pair) continue; // recipe has no photo; does not consume budget
    const pairBytes = (pair.photo ? String(pair.photo).length : 0) +
      (pair.photothumb ? String(pair.photothumb).length : 0);
    if (served > 0 && bytes + pairBytes > MAX_RESPONSE_BYTES) {
      break; // would blow the budget; keep this pair for the next slice
    }
    photos[ids[i]] = pair;
    bytes += pairBytes;
    served++;
  }

  return {
    photos,
    nextOffset: i >= ids.length ? null : i,
    done: i >= ids.length,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  try {
    const ids = (await kv.lrange('recipe_ids', 0, -1)).filter(isId);

    // ---- Photo slices (?photos=1&offset=N[&limit=M]) ----
    // Only sliced responses include photos, so no response can exceed
    // the serverless body limit. offset defaults to 0, limit to 10.
    if (req.query.photos === '1' && ('offset' in req.query)) {
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const { photos, nextOffset, done } = await collectPhotoSlice(ids, offset, limit);
      return res.status(200).json({
        app: 'recipe-chest',
        exportedAt: new Date().toISOString(),
        offset,
        nextOffset,
        done,
        photos,
      });
    }

    // ---- Recipes-only backup (exactly the historical shape) ----
    const recipes = await getRecipesByIds(kv, ids);
    const payload = {
      app: 'recipe-chest',
      exportedAt: new Date().toISOString(),
      count: recipes.length,
      recipes,
    };

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="recipe-chest-backup-${date}.json"`);
    return res.status(200).json(payload);
  } catch (e) {
    return sendServerError(res, e, 'Could not build the backup');
  }
}
