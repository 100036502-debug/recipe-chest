// /api/share-view — the ONLY public read of recipe content.
//
// Everything about this file is a whitelist: one fixed set of fields goes out,
// and every failure (bad token, expired, missing recipe, trashed) returns the
// same body so a stranger cannot probe which tokens exist.
import { safeHttpUrl } from '../recipes.js';
import { trashKey } from '../trash.js';
import { rateLimited } from '../rate-limit.js';
import { sendServerError } from '../http.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const GONE = { error: 'This link is no longer available.' };

function list(value) {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function imageOut(image) {
  if (!image || typeof image !== 'object') return null;
  // Same treatment as every other URL field: http(s) only, and a recipe photo
  // may only ever point at Unsplash (the app stores nothing else).
  const url = safeHttpUrl(image.url) || '';
  let allowed = '';
  try {
    if (url && new URL(url).hostname === 'images.unsplash.com') allowed = url;
  } catch { /* not a URL */ }
  return {
    url: allowed,
    alt: String(image.alt || ''),
    photographer: String(image.photographer || ''),
    photographerUrl: safeHttpUrl(image.photographerUrl) || '',
    photoUrl: safeHttpUrl(image.photoUrl) || '',
    source: String(image.source || ''),
  };
}

// Exactly these keys, never anything else.
export function publicView(recipe, hasUserPhoto) {
  const out = {
    title: String(recipe.title || ''),
    description: String(recipe.description || ''),
    prepTime: String(recipe.prepTime || ''),
    cookTime: String(recipe.cookTime || ''),
    servings: String(recipe.servings || ''),
    mealType: String(recipe.mealType || ''),
    tags: list(recipe.tags),
    ingredients: list(recipe.ingredients),
    instructions: list(recipe.instructions),
    notes: String(recipe.notes || ''),
    hasUserPhoto: hasUserPhoto === true,
  };
  const source = safeHttpUrl(recipe.sourceUrl);
  if (source) out.sourceUrl = source;
  const image = imageOut(recipe.image);
  if (image) out.image = image;
  return out;
}

export function createHandler({ kv, now = Date.now }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json(GONE);

    try {
      if (await rateLimited(kv, req, 'share-view', 120)) {
        res.setHeader('Retry-After', '3600');
        return res.status(429).json({ error: 'Too many requests. Try again later.' });
      }

      const token = String((req.query && req.query.token) || '');
      if (!TOKEN_RE.test(token)) return res.status(404).json(GONE);

      const record = await kv.get(`share:${token}`);
      if (!record || !record.recipeId) return res.status(404).json(GONE);
      if (Number(record.expiresAt) <= now()) return res.status(404).json(GONE);

      const recipe = await kv.get(`recipe:${record.recipeId}`);
      if (!recipe) return res.status(404).json(GONE);

      const trashed = await kv.get(trashKey(record.recipeId));
      if (trashed) return res.status(404).json(GONE);

      const thumb = await kv.get(`photothumb:${record.recipeId}`);
      return res.status(200).json(publicView(recipe, !!thumb));
    } catch (e) {
      return sendServerError(res, e);
    }
  };
}
