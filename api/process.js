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
      const match = errMsg.match(/try again in ([\d.]+)\s*s/i);
      const waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) + 800 : 6000;
      await new Promise(r => setTimeout(r, waitMs));
      return groqChat(apiKey, messages, options, attempt + 1);
    }
    throw new Error('Groq error: ' + errMsg.substring(0, 300));
  }
  return data.choices[0].message.content || '';
}

// Parse the labeled plain-text format that the AI outputs
function parseLabeledRecipe(text) {
  if (!text) return null;

  // Strip reasoning blocks and any content before "TITLE:"
  let t = String(text);
  t = t.replace(/<think[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<\/?think>/gi, '');

  // Find where the actual recipe starts
  const titleIdx = t.search(/TITLE\s*:/i);
  if (titleIdx === -1) return null;
  t = t.substring(titleIdx);

  // Normalize line endings
  t = t.replace(/\r\n/g, '\n');

  // Helper: pull out a single-line field
  const single = (label) => {
    const re = new RegExp('^' + label + '\\s*:\\s*(.*)$', 'im');
    const m = t.match(re);
    return m ? m[1].trim() : '';
  };

  // Helper: pull out a list of "- item" lines under a section header
  const list = (label, nextLabels) => {
    const re = new RegExp('^' + label + '\\s*:\\s*\\n([\\s\\S]*?)(?=\\n(?:' + nextLabels + ')\\s*:|$)', 'im');
    const m = t.match(re);
    if (!m) return [];
    return m[1]
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
      .filter(Boolean);
  };

  const title = single('TITLE');
  if (!title) return null;

  const description = single('DESCRIPTION');
  const prepTime = single('PREP_?TIME');
  const cookTime = single('COOK_?TIME');
  const servings = single('SERVINGS');
  const mealTypeRaw = single('MEAL_?TYPE').toLowerCase().replace(/[^a-z]/g, '');
  const tagsRaw = single('TAGS');
  const notes = single('NOTES');

  const ingredients = list('INGREDIENTS', 'INSTRUCTIONS|NOTES');
  const instructions = list('INSTRUCTIONS', 'NOTES');

  const validMeals = ['breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'drink'];
  let mealType = 'default';
  for (const m of validMeals) {
    if (mealTypeRaw.includes(m)) { mealType = m; break; }
  }

  const tags = tagsRaw
    ? tagsRaw.split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 10)
    : [];

  return {
    title: title.slice(0, 200),
    description: description.slice(0, 500),
    ingredients: ingredients.slice(0, 60),
    instructions: instructions.slice(0, 60),
    prepTime: prepTime.slice(0, 40),
    cookTime: cookTime.slice(0, 40),
    servings: servings.slice(0, 40),
    tags,
    notes: notes.slice(0, 1000),
    mealType,
  };
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

  const prompt = `Read the recipe from the attached image. Output the recipe using EXACTLY this labeled format. Nothing else — no reasoning, no commentary, no markdown, no JSON.

TITLE: <recipe name>
DESCRIPTION: <one short sentence>
PREP_TIME: <time or leave blank>
COOK_TIME: <time or leave blank>
SERVINGS: <number or leave blank>
MEAL_TYPE: <one of: breakfast, lunch, dinner, dessert, snack, drink>
TAGS: <comma-separated keywords, 2-5 items>
INGREDIENTS:
- <ingredient 1>
- <ingredient 2>
INSTRUCTIONS:
- <step 1>
- <step 2>
NOTES: <optional, or leave blank>

If there is no recipe in the image, output exactly: NO_RECIPE

Start with TITLE: on the first line.`;

  try {
    const raw = await groqChat(GROQ_API_KEY, [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
      ]
    }], { temperature: 0.1, max_tokens: 1800 });

    console.log('Raw AI output (first 400):', raw.substring(0, 400));

    if (/NO_RECIPE/i.test(raw) && !/TITLE\s*:/i.test(raw)) {
      return res.status(400).json({ error: 'No recipe detected in that image.' });
    }

    const recipe = parseLabeledRecipe(raw);

    if (!recipe || !recipe.title) {
      return res.status(500).json({
        error: 'Could not parse the AI output',
        details: 'Raw (first 400): ' + raw.substring(0, 400)
      });
    }

    const id = 'r_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const finalRecipe = {
      id,
      ...recipe,
      createdAt: Date.now(),
      addedBy: String(addedBy || 'Anonymous').slice(0, 40),
    };

    await kv.set(`recipe:${id}`, finalRecipe);
    await kv.lpush('recipe_ids', id);
    return res.status(200).json(finalRecipe);
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}
