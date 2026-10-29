// /api/share-photo — the owner's own photo, served to someone holding a link.
//
// Same generic 404 as share-view, a short cache so revoking takes effect
// quickly, and no indexing.
import { trashKey } from '../trash.js';
import { rateLimited } from '../rate-limit.js';
import { sendServerError } from '../http.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const GONE = { error: 'This link is no longer available.' };

export function createHandler({ kv, now = Date.now }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json(GONE);

    try {
      if (await rateLimited(kv, req, 'share-photo', 240)) {
        res.setHeader('Retry-After', '3600');
        return res.status(429).json({ error: 'Too many requests. Try again later.' });
      }

      const token = String((req.query && req.query.token) || '');
      const size = req.query && req.query.size === 'thumb' ? 'thumb' : 'full';
      if (!TOKEN_RE.test(token)) return res.status(404).json(GONE);

      const record = await kv.get(`share:${token}`);
      if (!record || !record.recipeId) return res.status(404).json(GONE);
      if (Number(record.expiresAt) <= now()) return res.status(404).json(GONE);

      const trashed = await kv.get(trashKey(record.recipeId));
      if (trashed) return res.status(404).json(GONE);

      const key = size === 'thumb' ? `photothumb:${record.recipeId}` : `photo:${record.recipeId}`;
      const base64 = await kv.get(key);
      if (!base64 || typeof base64 !== 'string') return res.status(404).json(GONE);

      const buffer = Buffer.from(base64, 'base64');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', String(buffer.length));
      // Short, so revoking the link stops the image being served.
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.status(200).send(buffer);
    } catch (e) {
      return sendServerError(res, e);
    }
  };
}
