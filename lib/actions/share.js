// /api/share — read-only links, managed by the owner.
//
// POST   { id, days }   create a link (7, 30 or 90 days, default 30)
// GET    ?id=<id>       list live links
// DELETE ?token=<tok>   revoke
import crypto from 'node:crypto';
import { requireAuth } from '../auth.js';
import { sendServerError } from '../http.js';
import { ID_PATTERN } from '../recipes.js';

const ALLOWED_DAYS = [7, 30, 90];
// Same shape the public share routes demand of a token (32 url-safe characters).
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
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

/**
 * Remove every share link for a recipe. Called when the recipe is permanently
 * deleted: without it a token stayed valid for its full life, and a re-created
 * id would silently reopen the old link on the new content.
 */
export async function revokeShareLinks(kv, recipeId) {
  const setKey = `share_tokens:${recipeId}`;
  let tokens;
  try {
    tokens = (await kv.smembers(setKey)) || [];
  } catch {
    tokens = [];
  }
  for (const token of tokens) {
    await kv.del(`share:${token}`);
  }
  if (tokens.length) await kv.del(setKey);
  return tokens.length;
}

export function createHandler({ kv, now = Date.now }) {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!(await requireAuth(req, res, { memberOnly: true }))) return;

    try {
      if (req.method === 'POST') {
        const body = req.body || {};
        const id = String(body.id || '');
        const days = ALLOWED_DAYS.includes(Number(body.days)) ? Number(body.days) : 30;

        if (id && !ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid recipe id' });
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
        // The index is only useful while some link in it is; keep it no longer
        // than the longest expiry it can hold.
        await kv.expire(setKey, days * 86400);

        return res.status(200).json({
          token,
          url: `${baseUrl(req)}/s/${token}`,
          expiresAt: record.expiresAt,
        });
      }

      if (req.method === 'GET') {
        const id = String((req.query && req.query.id) || (req.body && req.body.id) || '');
        if (!id) return res.status(400).json({ error: 'Missing recipe id' });
        if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid recipe id' });

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
        // A malformed token cannot be one we issued; answering as a revoked link
        // keeps the reply identical and never builds a key from stray input.
        const record = token && TOKEN_RE.test(token) ? await kv.get(`share:${token}`) : null;
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
