import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 60,
};

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
  if (end === -1) return null;
  return text.substring(start, end + 1);
}

function tryParseJson(raw) {
  if (!raw) return null;
  let t = String(raw);
  t = t.replace(/<think[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<\/?think>/gi, '');
  t = t.replace(/```json\s*/gi, '').replace(/```/g, '');
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  try { return JSON.parse(t); } catch {}
  const braced = extractBraced(t);
  if (braced) {
    try { return JSON.parse(braced); } catch {}
    const repaired = braced.replace(/,(\s*[}\]])/g, '$1').replace(/[\u201C\u201D]/g, '"');
    try { return JSON.parse(repaired); } catch {}
  }
  return null;
}

// Retry-aware Groq call: if we hit a rate limit, wait and try again.
async function groqChat(apiKey, messages, options = {}, attempt = 0) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.max_tokens ?? 1500,
    }),
  });
  const data = await res.json();

  if (!data.choices || !data.choices[0]) {
    const errMsg = (data.error && data.error.message) || JSON.stringify(data);
    const isRateLimit = /rate limit/i.test(errMsg) || (data.error && data.error.code === 'rate_limit_exceeded');

    if (isRateLimit && attempt < 3) {
      // Extract "try again in X.XXs" if present
      const match = errMsg.match(/try again in ([\d.]+)\s*s/i);
      const waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) + 700 : 6000;
      console.log(`Rate limited. Waiting ${waitMs}ms then retrying (attempt ${attempt + 1}).`);
      await new Promise(r => setTimeout(r, waitMs));
      return groqChat(apiKey, messages, options, attempt + 1);
    }
    throw new Error('Groq error: ' + errMsg.substring(0, 400));
  }
  return data.choices[0].message.content || '';
}

// Generate a food photo from a recipe title using Pollinations.AI (free)
async function generateRecipeImage(title, tags = [], retries = 1) {
  try {
    const tagStr = tags.length ? `, ${tags.slice(0, 3).join(', ')}` : '';
    const prompt = `${title}${tagStr}, food photography, natural light, overhead shot, appetizing, professional`;
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=800&height=600&nologo=true`;

    const res = await fetch(url, { signal: AbortSignal.timeout(40000) });
    if (!res.ok) {
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 3000));
        return generateRecipeImage(title, tags, retries - 1);
      }
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get('content-type') || 'image/jpeg';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 3000));
      return generateRecipeImage(title, tags, retries - 1);
    }
    console.error('Image generation failed:', err.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mimeType, addedBy } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'Groq API key not configured' });

  let step1Raw = '';
  let step2Raw = '';

  try {
    // ---- STEP 1: Transcribe the image into plain text ----
    step1Raw = await groqChat(GROQ_API_KEY, [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Transcribe the recipe from this image into plain text. Include title, ingredients, and instructions. Be brief — no reasoning, no commentary. If no recipe is present, reply exactly: NO_RECIPE'
        },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
      ]
    }], { temperature: 0.1, max_tokens: 1200 });

    console.log('Step 1 transcription (first 200):', step1Raw.substring(0, 200));

    if (!step1Raw.trim() || /NO_RECIPE/i.test(step1Raw)) {
      return res.status(400).json({ error: 'No recipe detected in that image.' });
    }

    // ---- STEP 2: Convert the plain text into JSON ----
    step2Raw = await groqChat(GROQ_API_KEY, [{
      role: 'user',
      content: `Output ONLY a JSON object (no markdown, no commentary) with this shape, using the recipe below:

{"title":"","description":"","ingredients":[],"instructions":[],"prepTime":"","cookTime":"","servings":"","tags":[],"notes":""}

RECIPE:
${step1Raw}`
    }], { temperature: 0, max_tokens: 1200 });

    console.log('Step 2 JSON attempt (first 200):', step2Raw.substring(0, 200));

    let recipe = tryParseJson(step2Raw);

    if (!recipe) {
      const retryRaw = await groqChat(GROQ_API_KEY, [{
        role: 'user',
        content: `Convert this into a JSON object with keys title, description, ingredients[], instructions[], prepTime, cookTime, servings, tags[], notes. Output ONLY the JSON.\n\n${step1Raw}`
      }], { temperature: 0, max_tokens: 1200 });
      recipe = tryParseJson(retryRaw);
      if (!recipe) {
        return res.status(500).json({
          error: 'AI could not produce valid JSON',
          details: 'Step 1: ' + step1Raw.substring(0, 200) + ' || Step 2: ' + step2Raw.substring(0, 200)
        });
      }
    }

    if (recipe.error) return res.status(400).json({ error: recipe.error });

    const id = 'r_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const title = String(recipe.title || 'Untitled Recipe').slice(0, 200);
    const tags = Array.isArray(recipe.tags) ? recipe.tags.slice(0, 10).map(t => String(t).toLowerCase()) : [];

    let thumbnail = `data:${mimeType};base64,${imageBase64}`;
    if (title && title !== 'Untitled Recipe') {
      const generated = await generateRecipeImage(title, tags);
      if (generated) thumbnail = generated;
    }

    const finalRecipe = {
      id,
      title,
      description: String(recipe.description || '').slice(0, 500),
      ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.slice(0, 60).map(String) : [],
      instructions: Array.isArray(recipe.instructions) ? recipe.instructions.slice(0, 60).map(String) : [],
      prepTime: String(recipe.prepTime || ''),
      cookTime: String(recipe.cookTime || ''),
      servings: String(recipe.servings || ''),
      tags,
      notes: String(recipe.notes || '').slice(0, 1000),
      imageThumbnail: thumbnail,
      createdAt: Date.now(),
      addedBy: String(addedBy || 'Anonymous').slice(0, 40),
    };

    await kv.set(`recipe:${id}`, finalRecipe);
    await kv.lpush('recipe_ids', id);

    return res.status(200).json(finalRecipe);
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'Failed: ' + error.message,
      details: step1Raw ? 'Step 1: ' + step1Raw.substring(0, 200) : ''
    });
  }
}
