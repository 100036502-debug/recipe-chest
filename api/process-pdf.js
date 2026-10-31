// POST /api/process-pdf — extract a recipe from an uploaded PDF.
// Same duplicate detection, photo lookup and storage as api/process.js.
import { parsePdfText, PdfUnreadable } from '../lib/pdf-text.js';
import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { findDuplicate, isUsableRecipe, cleanTags, normalizeMealType } from '../lib/recipes.js';
import { findDishImage } from '../lib/image.js';
import { getKv } from '../lib/redis.js';
import { rateLimited } from '../lib/rate-limit.js';
import { sendServerError } from '../lib/http.js';
import { recipeFromPdfText } from '../lib/pdf-recipe.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = {
  // Vercel caps request bodies at ~4.5 MB regardless of this setting,
  // so the client keeps PDFs at 3 MB.
  api: { bodyParser: { sizeLimit: '4mb' } },
  maxDuration: 60,
};

const MAX_PDF_BYTES = 3 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  if (await rateLimited(kv, req, 'process', 60)) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ error: 'Too many imports this hour. Try again later.' });
  }

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Groq API key not configured' });

  const { pdfBase64, addedBy, skipDuplicateCheck } = req.body || {};
  if (!pdfBase64) return res.status(400).json({ error: 'No PDF provided' });

  const buffer = Buffer.from(String(pdfBase64), 'base64');
  if (!buffer.length) return res.status(400).json({ error: 'Empty PDF' });
  if (buffer.length > MAX_PDF_BYTES) {
    return res.status(413).json({ error: 'That PDF is too large (max 3 MB)' });
  }

  try {
    const text = await parsePdfText(buffer);
    if (text.length < 50) {
      return res.status(400).json({ error: 'That PDF has almost no readable text (it may be a scan). Copy the recipe text instead.' });
    }

    const recipe = await recipeFromPdfText(text);
    if (recipe && recipe.error) {
      return res.status(400).json({ error: recipe.error });
    }
    if (!isUsableRecipe(recipe)) {
      return res.status(400).json({ error: 'No recipe detected in that PDF.' });
    }

    // Duplicate check and photo lookup run at the same time to keep imports fast.
    // skipDuplicateCheck: true saves a new copy even when a match exists
    // (the client's "Save a copy" on an already-in-your-chest queue row).
    const skipDup = skipDuplicateCheck === true;
    const [dup, image] = await Promise.all([
      skipDup ? null : findDuplicate(kv, { title: recipe.title }),
      findDishImage(recipe.title, { kv: getKv() }),
    ]);

    if (dup) {
      return res.status(409).json({
        error: `"${dup.title}" is already in your chest.`,
        duplicate: dup,
      });
    }

    const id = 'r_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const finalRecipe = {
      id,
      title: String(recipe.title).slice(0, 200),
      description: String(recipe.description || '').slice(0, 500),
      ingredients: (Array.isArray(recipe.ingredients) ? recipe.ingredients : []).slice(0, 60).map(String),
      instructions: (Array.isArray(recipe.instructions) ? recipe.instructions : []).slice(0, 60).map(String),
      prepTime: String(recipe.prepTime || '').slice(0, 40),
      cookTime: String(recipe.cookTime || '').slice(0, 40),
      servings: String(recipe.servings || '').slice(0, 40),
      // Never trust model output: sanitise tags and mealType, and ignore any
      // sourceUrl the model invented (a PDF has no source page).
      tags: cleanTags(recipe.tags, 10),
      notes: String(recipe.notes || '').slice(0, 1000),
      mealType: normalizeMealType(recipe.mealType),
      sourceUrl: '',
      ...(image ? { image } : {}),
      createdAt: Date.now(),
      addedBy: String(addedBy || 'Anonymous').slice(0, 40),
    };

    await kv.set(`recipe:${id}`, finalRecipe);
    await kv.lpush('recipe_ids', id);
    return res.status(200).json(finalRecipe);
  } catch (error) {
    if (error instanceof PdfUnreadable) {
      return res.status(400).json({ error: error.message });
    }
    // pdf-parse throws for corrupt files; treat those as user errors.
    if (/pdf|invalid|unexpected end/i.test(String(error && error.message || ''))) {
      console.error('PDF parse failed:', error.message);
      return res.status(400).json({ error: 'Could not read that PDF. Is it a valid file?' });
    }
    return sendServerError(res, error, 'Failed to save that recipe.');
  }
}
