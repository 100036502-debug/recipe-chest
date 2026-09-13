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

// Strip reasoning blocks, markdown fences, and control chars
function cleanText(raw) {
  let t = String(raw || '');
  t = t.replace(/<think[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<\/?think>/gi, '');
  t = t.replace(/```json\s*/gi, '').replace(/```/g, '');
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return t.trim();
}

// Extract a balanced { ... } object from a string
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

// Light JSON repair
function repairJson(text) {
  return text
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

// Try hard to get JSON out of any text
function tryParseJson(raw) {
  const cleaned = cleanText(raw);
  // 1. Direct parse
  try { return JSON.parse(cleaned); } catch {}
  // 2. Extract braced section
  const braced = extractBraced(cleaned);
  if (braced) {
    try { return JSON.parse(braced); } catch {}
    try { return JSON.parse(repairJson(braced)); } catch {}
  }
  // 3. Give up
  return null;
}

// Ask Qwen (text-only) to reformat messy output into clean JSON
async function reformatAsJson(rawText, apiKey) {
  const short = rawText.substring(0, 6000);
  const prompt = `The following text was supposed to be a recipe in JSON format, but it is malformed or contains extra text. Extract the recipe and return ONLY valid JSON, no markdown, no commentary, with this exact structure:

{
  "title": "Recipe name",
  "description": "short description",
  "ingredients": ["..."],
  "instructions": ["..."],
  "prepTime": "",
  "cookTime": "",
  "servings": "",
  "tags": ["..."],
  "notes": ""
}

If no recipe can be identified, return: {"error": "no recipe found"}

TEXT:
${short}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  });
  const data = await res.json();
  if (!data.choices || !data.choices[0]) return null;
  return tryParseJson(data.choices[0].message.content);
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

  const prompt = `You are a recipe extraction AI. Read the attached image and return the recipe as a JSON object.

RULES:
- Output ONLY the JSON object.
- Do NOT include any text before or after the JSON.
- Do NOT include markdown code fences.
- Do NOT include reasoning or explanation.
- Do NOT include any  thinking tags.

The JSON must have exactly this structure:
{
  "title": "Recipe name",
  "description": "1-2 sentence description",
  "ingredients": ["1 cup flour", "2 large eggs"],
  "instructions": ["Preheat oven to 350F.", "Mix dry ingredients."],
  "prepTime": "15 minutes",
  "cookTime": "30 minutes",
  "servings": "4",
  "tags": ["dessert", "italian"],
  "notes": "any extra notes or tips"
}

If the image is NOT a recipe or is unreadable, return exactly: {"error": "brief reason"}

Now output the JSON:`;

  let rawAiText = '';

  try {
    // 1. Extract the recipe from the image
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
          ]
        }],
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    const data = await response.json();
    if (!data.choices || !data.choices[0]) {
      return res.status(500).json({
        error: 'AI error',
        details: JSON.stringify(data).substring(0, 600)
      });
    }

    rawAiText = data.choices[0].message.content || '';

    // 2. Try to parse the response
    let recipe = tryParseJson(rawAiText);

    // 3. Fallback: ask the AI to reformat its own output
    if (!recipe) {
      console.log('Initial parse failed, attempting reformat. Raw was:', rawAiText.substring(0, 300));
      recipe = await reformatAsJson(rawAiText, GROQ_API_KEY);
    }

    // 4. Still failed? Give up with useful diagnostic info
    if (!recipe) {
      return res.status(500).json({
        error: 'AI returned invalid JSON',
        details: 'Raw response (first 500 chars): ' + rawAiText.substring(0, 500)
      });
    }

    if (recipe.error) return res.status(400).json({ error: recipe.error });

    const id = 'r_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const title = String(recipe.title || 'Untitled Recipe').slice(0, 200);
    const tags = Array.isArray(recipe.tags) ? recipe.tags.slice(0, 10).map(t => String(t).toLowerCase()) : [];

    // 5. Generate an AI food photo from the title
    let thumbnail = `data:${mimeType};base64,${imageBase64}`;
    if (title && title !== 'Untitled Recipe') {
      const generated = await generateRecipeImage(title, tags);
      if (generated) thumbnail = generated;
      else console.log('Image generation failed, using original scan as thumbnail');
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
      error: 'Failed',
      details: error.message + (rawAiText ? ' | Raw: ' + rawAiText.substring(0, 300) : '')
    });
  }
}
