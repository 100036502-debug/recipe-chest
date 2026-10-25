import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { groqChat } from '../lib/groq.js';
import { findDishImage } from '../lib/image.js';
import { safeFetchText } from '../lib/safe-fetch.js';
import { normalizeMealType, cleanTags, findDuplicate } from '../lib/recipes.js';
import { tryParseJson } from '../lib/parse.js';
import { extractRecipeFromJsonLd } from '../lib/jsonld-recipe.js';
import { rateLimited } from '../lib/rate-limit.js';
import { sendServerError } from '../lib/http.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  if (await rateLimited(kv, req, 'import-url', 60)) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ error: 'Too many imports this hour. Try again later.' });
  }

  const { url, addedBy } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http and https URLs are allowed' });
  }

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Groq API key not configured' });

  // Skip the fetch and the AI call entirely if this exact URL is already saved
  try {
    const existing = await findDuplicate(kv, { title: '', sourceUrl: parsedUrl.toString() });
    if (existing) {
      return res.status(409).json({
        error: `"${existing.title}" is already in your chest.`,
        duplicate: existing,
      });
    }
  } catch (e) {
    console.error('Duplicate pre-check failed:', e.message);
  }

  // Fetch the page (private/internal addresses are refused)
  let html;
  try {
    html = await safeFetchText(parsedUrl.toString(), {
      timeoutMs: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RecipeChestBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
  } catch (e) {
    return res.status(400).json({ error: 'Could not fetch page: ' + e.message });
  }

  // 1. Structured data first: exact, fast and free. Most recipe sites
  //    publish a complete Recipe in ld+json; if it is there, use it and
  //    skip the AI call entirely.
  let recipe = extractRecipeFromJsonLd(html);

  // 2. Fall back to the AI path for plain blog pages.
  if (!recipe) {
    let pageText = stripHtml(html);
    if (pageText.length > 20000) pageText = pageText.substring(0, 20000);
    if (pageText.length < 50) return res.status(400).json({ error: 'Page appears to be empty or blocked.' });

    const prompt = `Output ONLY a JSON object (no markdown, no reasoning) with the recipe extracted from this webpage. Pick the best mealType: breakfast, lunch, dinner, dessert, snack, or drink. If no recipe is found, output {"error":"no recipe found"}.

{"title":"","description":"","ingredients":[],"instructions":[],"prepTime":"","cookTime":"","servings":"","tags":[],"notes":"","mealType":"dinner"}

WEBPAGE TEXT:
${pageText}`;

    let content;
    try {
      content = await groqChat({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 3500,
        reasoningEffort: 'none',
      });
    } catch (e) {
      console.error('AI error during URL import:', e.message);
      return res.status(500).json({ error: 'The recipe could not be read. Try again later.' });
    }

    recipe = tryParseJson(content);
    if (!recipe) return res.status(500).json({ error: 'AI returned invalid JSON' });
    if (recipe.error) return res.status(400).json({ error: recipe.error });
  }

  try {
    const title = String(recipe.title || 'Untitled Recipe').slice(0, 200);

    // Duplicate check and photo lookup run at the same time to keep imports fast
    const [dup, image] = await Promise.all([
      findDuplicate(kv, { title, sourceUrl: parsedUrl.toString() }),
      findDishImage(title),
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
      title,
      description: String(recipe.description || '').slice(0, 500),
      ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.slice(0, 60).map(String) : [],
      instructions: Array.isArray(recipe.instructions) ? recipe.instructions.slice(0, 60).map(String) : [],
      prepTime: String(recipe.prepTime || ''),
      cookTime: String(recipe.cookTime || ''),
      servings: String(recipe.servings || ''),
      tags: cleanTags(recipe.tags, 10),
      notes: String(recipe.notes || '').slice(0, 1000),
      mealType: normalizeMealType(recipe.mealType),
      sourceUrl: parsedUrl.toString(),
      ...(image ? { image } : {}),
      createdAt: Date.now(),
      addedBy: String(addedBy || 'Anonymous').slice(0, 40),
    };

    await kv.set(`recipe:${id}`, finalRecipe);
    await kv.lpush('recipe_ids', id);
    return res.status(200).json(finalRecipe);
  } catch (error) {
    return sendServerError(res, error, 'Failed to import that page.');
  }
}
