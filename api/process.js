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
      max_tokens: options.max_tokens ?? 1800,
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

// Parse the delimiter-based format: ===LABEL===\n content
function parseDelimitedRecipe(text) {
  if (!text) return null;

  let t = String(text);
  t = t.replace(/<think[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<\/?think>/gi, '');
  t = t.replace(/\r\n/g, '\n');

  // Find first ===
  const startIdx = t.indexOf('===');
  if (startIdx === -1) return null;
  t = t.substring(startIdx);

  // Extract all sections
  const sections = {};
  const regex = /===\s*([A-Za-z_ ]+?)\s*===/g;
  const matches = [];
  let m;
  while ((m = regex.exec(t)) !== null) {
    matches.push({ label: m[1].toUpperCase().replace(/\s+/g, '_').trim(), idx: m.index, endIdx: regex.lastIndex });
  }

  if (matches.length === 0) return null;

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const end = next ? next.idx : t.length;
    let content = t.substring(cur.endIdx, end).trim();
    if (!(cur.label in sections)) sections[cur.label] = content;
  }

  const firstLine = (key) => {
    const v = sections[key] || '';
    return v.split('\n')[0].trim();
  };

  // Parse a list section — handles bullets, numbers, one-per-line, and one-line-separated formats
  const parseList = (key) => {
    const content = sections[key] || '';
    if (!content) return [];

    // Split into lines first
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    const items = [];

    for (const line of lines) {
      // If line has multiple items separated by " - " or " • " or " * ", split them
      const hasInlineSeparator = /\s[-•*]\s+/.test(line);
      if (hasInlineSeparator) {
        const parts = line.split(/\s+[-•*]\s+/).map(s => s.trim()).filter(Boolean);
        for (const p of parts) items.push(p);
        continue;
      }
      // Check for inline numbered items "1. x 2. y"
      if (/^\d+[.)]\s+.+\s+\d+[.)]\s+/.test(line)) {
        const parts = line.split(/\s+(?=\d+[.)]\s+)/).map(s => s.trim()).filter(Boolean);
        for (const p of parts) items.push(p);
        continue;
      }
      items.push(line);
    }

    // Strip leading bullets/numbers and clean
    const cleaned = items
      .map(item => item.replace(/^[-*•]\s+/, '').replace(/^[-*•]/, '').replace(/^\d+[.)]\s+/, '').trim())
      .filter(Boolean);

    // If we only got 1 item, try comma/semicolon splitting
    if (cleaned.length === 1 && (cleaned[0].includes(';') || cleaned[0].includes(', '))) {
      const splitter = cleaned[0].includes(';') ? ';' : ',';
      const parts = cleaned[0].split(splitter).map(s => s.trim()).filter(Boolean);
      // Only accept comma splitting if items look independent (each has length > 3)
      if (parts.length > 1 && parts.every(p => p.length > 2)) {
        return parts;
      }
    }

    return cleaned;
  };

  const title = firstLine('TITLE');
  if (!title) return null;

  const description = firstLine('DESCRIPTION');
  const prepTime = firstLine('PREP_TIME') || firstLine('PREP TIME') || '';
  const cookTime = firstLine('COOK_TIME') || firstLine('COOK TIME') || '';
  const servings = firstLine('SERVINGS');
  const mealTypeRaw = (firstLine('MEAL_TYPE') || firstLine('MEAL TYPE') || '').toLowerCase();
  const tagsRaw = firstLine('TAGS');
  const notes = sections['NOTES'] || '';

  const ingredients = parseList('INGREDIENTS');
  const instructions = parseList('INSTRUCTIONS');

  const validMeals = ['breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'drink'];
  let mealType = 'default';
  for (const vm of validMeals) {
    if (mealTypeRaw.includes(vm)) { mealType = vm; break; }
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

  const prompt = `Read the recipe from the attached image. Output using EXACTLY this delimiter format. Nothing else — no reasoning, no commentary, no markdown.

===TITLE===
<recipe name>

===DESCRIPTION===
<one short sentence>

===PREP_TIME===
<time or blank>

===COOK_TIME===
<time or blank>

===SERVINGS===
<number or blank>

===MEAL_TYPE===
<one of: breakfast, lunch, dinner, dessert, snack, drink>

===TAGS===
<comma-separated keywords, 2-5 items>

===INGREDIENTS===
<one ingredient per line, no bullet points>

===INSTRUCTIONS===
<one step per line, no numbering>

===NOTES===
<optional, or blank>

IMPORTANT RULES:
- Each ingredient must be on its OWN line.
- Each instruction step must be on its OWN line.
- Do NOT combine multiple ingredients onto one line.
- Do NOT combine multiple steps onto one line.

If there is no recipe in the image, output exactly: NO_RECIPE`;

  try {
    const raw = await groqChat(GROQ_API_KEY, [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
      ]
    }], { temperature: 0.1, max_tokens: 2200 });

    console.log('Raw AI output (first 500):', raw.substring(0, 500));

    if (/NO_RECIPE/i.test(raw) && !/===\s*TITLE\s*===/i.test(raw)) {
      return res.status(400).json({ error: 'No recipe detected in that image.' });
    }

    const recipe = parseDelimitedRecipe(raw);

    if (!recipe || !recipe.title) {
      return res.status(500).json({
        error: 'Could not parse the AI output',
        details: 'Raw (first 500): ' + raw.substring(0, 500)
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
