// /api/storage-stats — how much of the Redis quota the chest is using.
//
// Counting photo bytes means one strlen per photo and one per thumbnail, which
// is why the answer is cached for ten minutes and only recomputed on ?refresh=1.
import { requireAuth } from '../auth.js';
import { getRecipesByIds } from '../recipes.js';
import { getKv } from '../redis.js';
import { sendServerError } from '../http.js';
import { rateLimited } from '../rate-limit.js';

export const CACHE_KEY = 'storage_stats_cache';
export const CACHE_SECONDS = 600;
const CHUNK = 50;

function isId(id) {
  return typeof id === 'string' && id.length > 0 && id.length < 120;
}

function capBytes() {
  const mb = Number(process.env.STORAGE_CAP_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1048576) : null;
}

export async function computeStats(kv) {
  const ids = (await kv.lrange('recipe_ids', 0, -1)).filter(isId);
  const recipes = await getRecipesByIds(kv, ids);

  let recipeBytes = 0;
  const withPhoto = [];
  for (const recipe of recipes) {
    try {
      recipeBytes += JSON.stringify(recipe).length;
    } catch {
      recipeBytes += 0; // a circular record cannot be measured
    }
    if (recipe && recipe.userPhoto) withPhoto.push(recipe.id);
  }

  let photoBytes = 0;
  for (let i = 0; i < withPhoto.length; i += CHUNK) {
    const chunk = withPhoto.slice(i, i + CHUNK);
    const sizes = await Promise.all(chunk.map(async (id) => {
      const [photo, thumb] = await Promise.all([
        kv.strlen(`photo:${id}`).catch(() => 0),
        kv.strlen(`photothumb:${id}`).catch(() => 0),
      ]);
      return (Number(photo) || 0) + (Number(thumb) || 0);
    }));
    photoBytes += sizes.reduce((sum, n) => sum + n, 0);
  }

  const totalBytes = recipeBytes + photoBytes;
  const cap = capBytes();
  return {
    recipes: recipes.length,
    userPhotos: withPhoto.length,
    recipeBytes,
    photoBytes,
    totalBytes,
    capBytes: cap,
    percent: cap ? Math.min(100, Math.round((totalBytes / cap) * 1000) / 10) : null,
    measuredAt: new Date().toISOString(),
  };
}

export function createHandler({ kv }) {
  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (!requireAuth(req, res, { memberOnly: true })) return;

    const refresh = String((req.query && req.query.refresh) || '') === '1';
    // Recomputing walks every key, so a member (or a stuck tab) may ask for a
    // fresh count once a minute; anything more gets the cached answer instead.
    if (refresh && (await rateLimited(kv, req, 'storage-refresh', 1, 60))) {
      const cached = await kv.get(CACHE_KEY);
      if (cached) return res.status(200).json({ ...cached, cached: true });
      return res.status(429).json({ error: 'Too many refreshes. Try again in a minute.' });
    }
    try {
      if (!refresh) {
        const cached = await kv.get(CACHE_KEY);
        if (cached) return res.status(200).json({ ...cached, cached: true });
      }
      const stats = await computeStats(kv);
      await kv.set(CACHE_KEY, stats, { ex: CACHE_SECONDS });
      return res.status(200).json({ ...stats, cached: false });
    } catch (e) {
      return sendServerError(res, e);
    }
  };
}

export default async function storageStats(req, res) {
  return createHandler({ kv: getKv() })(req, res);
}
