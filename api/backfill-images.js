// One-time backfill: adds an Unsplash photo to recipes that don't have one.
// Safe to run repeatedly. Delete this file when you're done.
import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { lookupDishImage } from '../lib/image.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = { maxDuration: 60 };

const TIME_BUDGET_MS = 40000;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  if (!requireAuth(req, res)) return;

  if (!process.env.UNSPLASH_ACCESS_KEY) {
    return res.status(500).json({ error: 'UNSPLASH_ACCESS_KEY is not set' });
  }

  const body = req.body || {};
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 15, 1), 25);
  const retryMisses = body.retryMisses === true;
  const started = Date.now();

  try {
    const ids = (await kv.lrange('recipe_ids', 0, -1)) || [];
    const all = (await Promise.all(ids.map((id) => kv.get(`recipe:${id}`)))).filter(Boolean);

    const todo = all.filter((r) => !r.image && (retryMisses || !r.imageChecked));

    const summary = {
      totalRecipes: all.length,
      alreadyHadImage: all.filter((r) => r.image).length,
      attempted: 0,
      updated: 0,
      noMatch: 0,
      failed: 0,
      remaining: 0,
      stoppedEarly: null,
      results: [],
    };

    for (const r of todo) {
      if (summary.attempted >= limit) {
        summary.stoppedEarly = 'Batch limit reached. Run it again to continue.';
        break;
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        summary.stoppedEarly = 'Time budget reached. Run it again to continue.';
        break;
      }

      summary.attempted++;
      const { image, status } = await lookupDishImage(r.title);

      if (status === 'rate_limited') {
        summary.attempted--;
        summary.stoppedEarly = 'Unsplash rate limit reached. Wait an hour, then run it again.';
        break;
      }

      const key = `recipe:${r.id}`;

      if (image) {
        const fresh = await kv.get(key); // re-read so edits made meanwhile aren't overwritten
        if (!fresh) continue;
        await kv.set(key, { ...fresh, image });
        summary.updated++;
        summary.results.push({ title: r.title, outcome: 'photo added' });
      } else if (status === 'none') {
        const fresh = await kv.get(key);
        if (!fresh) continue;
        await kv.set(key, { ...fresh, imageChecked: Date.now() });
        summary.noMatch++;
        summary.results.push({ title: r.title, outcome: 'no matching photo' });
      } else {
        summary.failed++;
        summary.results.push({ title: r.title, outcome: 'error, will retry next run' });
      }
    }

    summary.remaining = todo.length - summary.updated - summary.noMatch;
    return res.status(200).json(summary);
  } catch (e) {
    console.error('Backfill failed:', e);
    return res.status(500).json({ error: e.message });
  }
}
