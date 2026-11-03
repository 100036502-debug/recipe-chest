import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { rateLimited } from '../lib/rate-limit.js';
import { sendServerError } from '../lib/http.js';
import { importRecipeFromUrl } from '../lib/url-recipe.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await requireAuth(req, res))) return;

  if (await rateLimited(kv, req, 'import-url', 60)) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ error: 'Too many imports this hour. Try again later.' });
  }

  const { url, addedBy } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Groq API key not configured' });

  const result = await importRecipeFromUrl({ kv, url, addedBy });
  if (result.ok) return res.status(200).json(result.recipe);
  if (result.cause) return sendServerError(res, result.cause, result.error);
  return res.status(result.status).json({
    error: result.error,
    ...(result.duplicate ? { duplicate: result.duplicate } : {}),
  });
}
