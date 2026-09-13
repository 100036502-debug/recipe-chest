import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const GROQ_MODEL = 'qwen/qwen3.6-27b';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, addedBy } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http and https URLs are allowed' });
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'Groq API key not configured' });

  // Fetch and strip the page
  let pageText;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(parsedUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RecipeChestBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error('Page returned ' + response.status);
    const html = await response.text();
    pageText = html
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
    const aiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1500,
      }),
    });
    const data = await aiResponse.json();
    if (!data.choices || !data.choices[0]) {
      return res.status(500).json({ error: 'AI error', details: JSON.stringify(data).substring(0, 400) });
    }

    const recipe = tryParseJson(data.choices[0].message.content);
    if (!recipe) return res.status(500).json({ error: 'AI returned invalid JSON' });
    if (recipe.error) return res.status(400).json({ error: recipe.error });

    const id = 'r_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const validMeals = ['breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'drink'];
    const mealType = validMeals.includes(String(recipe.mealType || '').toLowerCase())
      ? String(recipe.mealType).toLowerCase() : 'default';

    const finalRecipe = {
      id,
      title: String(recipe.title || 'Untitled Recipe').slice(0, 200),
      description: String(recipe.description || '').slice(0, 500),
      ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.slice(0, 60).map(String) : [],
      instructions: Array.isArray(recipe.instructions) ? recipe.instructions.slice(0, 60).map(String) : [],
      prepTime: String(recipe.prepTime || ''),
      cookTime: String(recipe.cookTime || ''),
      servings: String(recipe.servings || ''),
      tags: Array.isArray(recipe.tags) ? recipe.tags.slice(0, 10).map(t => String(t).toLowerCase()) : [],
      notes: String(recipe.notes || '').slice(0, 1000),
      mealType,
      sourceUrl: parsedUrl.toString(),
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
