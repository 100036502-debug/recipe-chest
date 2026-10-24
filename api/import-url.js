import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { groqChat } from '../lib/groq.js';
import { findDishImage } from '../lib/image.js';
import { safeFetchText } from '../lib/safe-fetch.js';
import { normalizeMealType, cleanTags, findDuplicate } from '../lib/recipes.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

function extractBraced(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return end === -1 ? null : text.substring(start, end + 1);
}

function tryParseJson(raw) {
  if (!raw) return null;
  let t = String(raw)
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/```json\s*/gi, '').replace(/```/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  try { return JSON.parse(t); } catch {}
  const braced = extractBraced(t);
  if (braced) {
    try { return JSON.parse(braced); } catch {}
    try { return JSON.parse(braced.replace(/,(\s*[}\]])/g, '$1').replace(/[\u201C\u201D]/g, '"')); } catch {}
  }
  return null;
}

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

  // Fetch and strip the page (private/internal addresses are refused)
  let pageText;
  try {
    const html = await safeFetchText(parsedUrl.toString(), {
      timeoutMs: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RecipeChestBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    pageText = stripHtml(html);
    if (pageText.length > 20000) pageText = pageText.substring(0, 20000);
  } catch (e) {
    return res.status(400).json({ error: 'Could not fetch page: ' + e.message });
  }

  if (pageText.length < 50) return res.status(400).json({ error: 'Page appears to be empty or blocked.' });

  const prompt = `Output ONLY a JSON object (no markdown, no reasoning) with the recipe extracted from this webpage. Pick the best mealType: breakfast, lunch, dinner, dessert, snack, or drink. If no recipe is found, output {"error":"no recipe found"}.

{"title":"","description":"","ingredients":[],"instructions":[],"prepTime":"","cookTime":"","servings":"","tags":[],"notes":"","mealType":"dinner"}

WEBPAGE TEXT:
${pageText}`;

  try {
    let content;
    try {
      content = await groqChat({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 1500,
      });
    } catch (e) {
      return res.status(500).json({ error: 'AI error', details: e.message.substring(0, 400) });
    }

    const recipe = tryParseJson(content);
    if (!recipe) return res.status(500).json({ error: 'AI returned invalid JSON' });
    if (recipe.error) return res.status(400).json({ error: recipe.error });

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
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}
