// GET /api/export — downloads every recipe as a JSON backup file.
// Pass ?photos=1 to include user dish photos (base64) in the file.
import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { ID_PATTERN, getRecipesByIds } from '../lib/recipes.js';
import { sendServerError } from '../lib/http.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = { maxDuration: 60 };

async function collectPhotos(ids) {
  const photos = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const keys = batch.flatMap((id) => [`photo:${id}`, `photothumb:${id}`]);
    const vals = await kv.mget(...keys);
    for (let j = 0; j < batch.length; j++) {
      const main = vals[j * 2];
      const thumb = vals[j * 2 + 1];
      if (main || thumb) photos[batch[j]] = { photo: main || null, photothumb: thumb || null };
    }
  }
  return photos;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  try {
    const ids = (await kv.lrange('recipe_ids', 0, -1)) || [];
    const recipes = await getRecipesByIds(kv, ids);

    const payload = {
      app: 'recipe-chest',
      exportedAt: new Date().toISOString(),
      count: recipes.length,
      recipes,
    };

    if (req.query.photos === '1') {
      payload.photos = await collectPhotos(ids.filter(ID_PATTERN.test.bind(ID_PATTERN)));
    }

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="recipe-chest-backup-${date}.json"`);
    return res.status(200).json(payload);
  } catch (e) {
    return sendServerError(res, e, 'Could not build the backup');
  }
}
