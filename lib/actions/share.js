// /api/share — read-only links, managed by the owner.
//
// POST   { id, days }   create a link (7, 30 or 90 days, default 30)
// GET    ?id=<id>       list live links
// DELETE ?token=<tok>   revoke
import crypto from 'node:crypto';
import { requireAuth } from '../auth.js';
import { sendServerError } from '../http.js';

const ALLOWED_DAYS = [7, 30, 90];
const MAX_LINKS = 10;
const DAY_MS = 86400000;

// Where a share link points. PUBLIC_BASE_URL is authoritative; the Host header
// is only a fallback for local development, because a link minted from a forged
// Host would send readers somewhere else.
export function baseUrl(req) {
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return String(env).replace(/\/+$/, '');
  if (process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production') {
    return '';
  }
  const header = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return 'https://' + String(header).split(',')[0].trim();
}

export function createHandler({ kv, now = Date.now }) {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!requireAuth(req, res, { memberOnly: true })) return;

    try {
      if (req.method === 'POST') {
        const body = req.body || {};
        const id = String(body.id || '');
        const days = ALLOWED_DAYS.includes(Number(body.days)) ? Number(body.days) : 30;

        const recipe = id ? await kv.get(`recipe:${id}`) : null;
        if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

        // Prune dead tokens before counting, so revoking frees a slot.
        const setKey = `share_tokens:${id}`;
        const known = (await kv.smembers(setKey)) || [];
        const live = [];
        for (const token of known) {
          if (await kv.get(`share:${token}`)) live.push(token);
          else await kv.srem(setKey, token);
        }
        if (live.length >= MAX_LINKS) {
          return res.status(409).json({ error: `This recipe already has ${MAX_LINKS} live links. Revoke one first.` });
        }

        const token = crypto.randomBytes(24).toString('base64url');
        const createdAt = now();
        const record = { recipeId: id, createdAt, expiresAt: createdAt + days * DAY_MS };
        await kv.set(`share:${token}`, record, { ex: days * 86400 });
        await kv.sadd(setKey, token);

        return res.status(200).json({
          token,
          url: `${baseUrl(req)}/s/${token}`,
          expiresAt: record.expiresAt,
        });
      }

      if (req.method === 'GET') {
        const id = String((req.query && req.query.id) || (req.body && req.body.id) || '');
        if (!id) return res.status(400).json({ error: 'Missing recipe id' });

        const setKey = `share_tokens:${id}`;
        const known = (await kv.smembers(setKey)) || [];
        const links = [];
        for (const token of known) {
          const record = await kv.get(`share:${token}`);
          if (!record) {
            await kv.srem(setKey, token);
            continue;
          }
          links.push({
            token,
            url: `${baseUrl(req)}/s/${token}`,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
          });
        }
        links.sort((a, b) => b.createdAt - a.createdAt);
        return res.status(200).json(links);
      }

      if (req.method === 'DELETE') {
        const token = String((req.query && req.query.token) || (req.body && req.body.token) || '');
        const record = token ? await kv.get(`share:${token}`) : null;
        if (record) {
          await kv.del(`share:${token}`);
          await kv.srem(`share_tokens:${record.recipeId}`, token);
        }
        // Revoking something already gone is not an error.
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    } catch (e) {
      return sendServerError(res, e);
    }
  };
}
