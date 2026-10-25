// Upload, serve and remove a user's own photo of a finished dish.
// Photos live in Redis under photo:<id> (1000px) and photothumb:<id> (400px).
import { Redis } from '@upstash/redis';
import sharp from 'sharp';
import { requireAuth } from '../lib/auth.js';
import { ID_PATTERN } from '../lib/recipes.js';
import { sendServerError } from '../lib/http.js';
import { rateLimited } from '../lib/rate-limit.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
  maxDuration: 30,
};

const MAX_INPUT_BYTES = 3 * 1024 * 1024; // decoded upload size
const MAX_MAIN_BYTES = 600 * 1024;       // processed full-size photo

async function resize(input, size, quality) {
  return sharp(input)
    .rotate()
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAuth(req, res)) return;

  // ---- GET: serve a photo (?id=...&size=thumb optional) ----
  if (req.method === 'GET') {
    const id = String(req.query.id || '');
    if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid id' });

    const key = req.query.size === 'thumb' ? `photothumb:${id}` : `photo:${id}`;
    try {
      const b64 = await kv.get(key);
      if (!b64 || typeof b64 !== 'string') {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'No photo' });
      }
      const buf = Buffer.from(b64, 'base64');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // The page adds ?v=<timestamp>, so a new upload gets a new URL.
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      return res.status(200).send(buf);
    } catch (e) {
      res.setHeader('Cache-Control', 'no-store');
      return sendServerError(res, e);
    }
  }

  // ---- POST: save a photo for a recipe ----
  if (req.method === 'POST') {
    if (await rateLimited(kv, req, 'photo', 30)) {
      res.setHeader('Retry-After', '3600');
      return res.status(429).json({ error: 'Too many uploads this hour. Try again later.' });
    }
    const body = req.body || {};
    const id = String(body.id || '');
    if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid recipe id' });

    const b64 = typeof body.imageBase64 === 'string'
      ? body.imageBase64.replace(/^data:image\/[a-z+.-]+;base64,/i, '')
      : '';
    if (!b64) return res.status(400).json({ error: 'No image provided' });

    const input = Buffer.from(b64, 'base64');
    if (!input.length) return res.status(400).json({ error: 'Empty image' });
    if (input.length > MAX_INPUT_BYTES) {
      return res.status(413).json({ error: 'That image is too large' });
    }

    try {
      const existing = await kv.get(`recipe:${id}`);
      if (!existing) return res.status(404).json({ error: 'Recipe not found' });

      // Re-encoding with sharp proves it's a real image, strips metadata,
      // and keeps stored sizes small.
      let main = null;
      for (const size of [1000, 800, 600]) {
        main = await resize(input, size, 80);
        if (main.length <= MAX_MAIN_BYTES) break;
      }
      const thumb = await resize(input, 400, 75);

      await kv.set(`photo:${id}`, main.toString('base64'));
      await kv.set(`photothumb:${id}`, thumb.toString('base64'));

      // Re-read right before writing so edits made in the meantime aren't lost
      const fresh = await kv.get(`recipe:${id}`);
      if (!fresh) {
        await kv.del(`photo:${id}`, `photothumb:${id}`);
        return res.status(404).json({ error: 'Recipe was deleted' });
      }
      const credit = typeof body.credit === 'string' ? body.credit.trim().slice(0, 100) : '';
      const userPhoto = { updatedAt: Date.now() };
      if (credit) userPhoto.credit = credit;
      const updated = { ...fresh, userPhoto };
      await kv.set(`recipe:${id}`, updated);
      return res.status(200).json(updated);
    } catch (e) {
      // sharp throws for invalid/corrupt images; those are user errors (400).
      // Anything else (Redis, network) is our failure (500).
      if (e && (e.message || '').toLowerCase().includes('input buffer is empty') ||
          e instanceof Error && /sharp|decode|unsupported image|vips/i.test(e.message || '')) {
        return res.status(400).json({ error: 'Could not process that image. Is it a valid photo?' });
      }
      return sendServerError(res, e, 'Could not save that photo. Try again.');
    }
  }

  // ---- DELETE: remove the user's photo (falls back to Unsplash image or emoji) ----
  if (req.method === 'DELETE') {
    const id = String(req.query.id || '');
    if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
      await kv.del(`photo:${id}`, `photothumb:${id}`);
      const recipe = await kv.get(`recipe:${id}`);
      if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

      const { userPhoto, ...rest } = recipe;
      await kv.set(`recipe:${id}`, rest);
      return res.status(200).json(rest);
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
