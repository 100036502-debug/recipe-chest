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
import { requireAuth, hasBearerSecret } from '../lib/auth.js';
import { ID_PATTERN, getRecipesByIds } from '../lib/recipes.js';
import { sendServerError } from '../lib/http.js';

// let, not const: tests swap in a fake store instead of a real connection.
let kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export function __setKvForTests(store) { kv = store; }

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
async function collectPhotoSlice(ids, offset, limit, after) {
  const photos = {};
  let bytes = 0;
  // A cursor wins over a number. recipe_ids is a list new recipes are pushed
  // onto the front of, so a numeric offset slides whenever anything is added or
  // deleted between two slices, and a live recipe's photo is skipped. Resuming
  // after the last id we sent does not depend on where it sits any more.
  let start = offset;
  if (after) {
    const at = ids.indexOf(after);
    // An id that has since been deleted cannot anchor the cursor; fall back to
    // the number rather than restarting, which would repeat everything.
    start = at === -1 ? offset : at + 1;
  }
  let i = start;
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

  const lastSent = Object.keys(photos).pop() || null;
  return {
    photos,
    nextOffset: i >= ids.length ? null : i,
    // Where to resume, immune to the list changing underneath the next request.
    // When this slice sent nothing, the cursor it was given is still the anchor.
    nextAfter: i >= ids.length ? null : (lastSent || after || null),
    done: i >= ids.length,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // The weekly backup calls this with a bearer secret; a browser still uses a
  // session. The secret is checked first so a machine caller never needs a cookie.
  const viaSecret = hasBearerSecret(req, process.env.BACKUP_SECRET);
  if (!viaSecret && !(await requireAuth(req, res, { memberOnly: true }))) return;

  try {
    const ids = (await kv.lrange('recipe_ids', 0, -1)).filter(isId);

    // ---- Photo slices (?photos=1&offset=N[&limit=M]) ----
    // Only sliced responses include photos, so no response can exceed
    // the serverless body limit. offset defaults to 0, limit to 10.
    if (req.query.photos === '1' && ('offset' in req.query)) {
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const after = typeof req.query.after === 'string' && isId(req.query.after) ? req.query.after : '';
      const { photos, nextOffset, nextAfter, done } = await collectPhotoSlice(ids, offset, limit, after);
      return res.status(200).json({
        app: 'recipe-chest',
        exportedAt: new Date().toISOString(),
        offset,
        nextOffset,
        nextAfter,
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
