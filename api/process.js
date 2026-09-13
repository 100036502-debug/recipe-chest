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
      max_tokens: options.max_tokens ?? 2200,
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

// ---------- Cleaning ----------
function preclean(raw) {
  if (!raw) return '';
  let t = String(raw);
  t = t.replace(/<think[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<\/?think>/gi, '');
  t = t.replace(/```[a-z]*\n?/gi, '');
  t = t.replace(/```/g, '');
  t = t.replace(/\r\n/g, '\n');
  return t;
}

// ---------- List item cleaner ----------
function cleanItem(s) {
  return String(s)
    .replace(/^[-*•·]\s+/, '')
    .replace(/^[-*•·]/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^[*_]+|[*_]+$/g, '')
    .trim();
}

// ---------- Split a block into a list ----------
function blockToList(content) {
  if (!content) return [];
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];

  for (const line of lines) {
    // Skip sub-headers or empties
    if (!line) continue;
    // Inline separators: " - item - item" or " • item • item"
    if (/\s[-•·]\s+\S/.test(line)) {
      const parts = line.split(/\s+[-•·]\s+/).map(s => s.trim()).filter(Boolean);
      for (const p of parts) items.push(cleanItem(p));
      continue;
    }
    // Inline numbered: "1. x 2. y 3. z"
    if (/^\d+[.)]\s+.+\s+\d+[.)]\s+/.test(line)) {
      const parts = line.split(/\s+(?=\d+[.)]\s+)/).map(s => s.trim()).filter(Boolean);
      for (const p of parts) items.push(cleanItem(p));
      continue;
    }
    items.push(cleanItem(line));
  }

  return items.filter(Boolean);
}

// ---------- Normalizer (from any parsed object) ----------
function normalizeRecipe(r) {
  if (!r || !r.title) return null;
  const validMeals = ['breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'drink'];
  let mealType = 'default';
  const mtRaw = String(r.mealType || r.meal_type || '').toLowerCase();
  for (const vm of validMeals) if (mtRaw.includes(vm)) { mealType = vm; break; }

  let tags = [];
  if (Array.isArray(r.tags)) tags = r.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean);
  else if (typeof r.tags === 'string') tags = r.tags.split(/[,;]/).map(t => t.trim().toLowerCase()).filter(Boolean);

  const toArr = (v) => Array.isArray(v) ? v.map(String).map(cleanItem).filter(Boolean) :
    (typeof v === 'string' ? blockToList(v) : []);

  return {
    title: String(r.title).slice(0, 200),
    description: String(r.description || '').slice(0, 500),
    ingredients: toArr(r.ingredients).slice(0, 60),
    instructions: toArr(r.instructions).slice(0, 60),
    prepTime: String(r.prepTime || r.prep_time || '').slice(0, 40),
    cookTime: String(r.cookTime || r.cook_time || '').slice(0, 40),
    servings: String(r.servings || '').slice(0, 40),
    tags: tags.slice(0, 10),
    notes: String(r.notes || '').slice(0, 1000),
    mealType,
  };
}

// ---------- Parser 1: delimiter format (===LABEL===) ----------
function parseDelimited(text) {
  const t = text;
  const firstIdx = t.indexOf('===');
  if (firstIdx === -1) return null;
  const sub = t.substring(firstIdx);

  const regex = /===\s*([A-Za-z_ ]+?)\s*===/g;
  const markers = [];
  let m;
  while ((m = regex.exec(sub)) !== null) {
    markers.push({
      label: m[1].toUpperCase().replace(/\s+/g, '_').trim(),
      idx: m.index,
      contentStart: regex.lastIndex,
    });
  }
  if (!markers.length) return null;

  const sections = {};
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i];
    const end = markers[i + 1] ? markers[i + 1].idx : sub.length;
    const content = sub.substring(cur.contentStart, end).trim();
    if (!(cur.label in sections)) sections[cur.label] = content;
  }

  const firstLine = (k) => (sections[k] || '').split('\n')[0].trim();
  const title = firstLine('TITLE');
  if (!title) return null;

  return normalizeRecipe({
    title,
    description: firstLine('DESCRIPTION'),
    prepTime: firstLine('PREP_TIME') || firstLine('PREP TIME'),
    cookTime: firstLine('COOK_TIME') || firstLine('COOK TIME'),
    servings: firstLine('SERVINGS'),
    mealType: firstLine('MEAL_TYPE') || firstLine('MEAL TYPE'),
    tags: firstLine('TAGS'),
    ingredients: sections['INGREDIENTS'] || '',
    instructions: sections['INSTRUCTIONS'] || '',
    notes: sections['NOTES'] || '',
  });
}

// ---------- Parser 2: colon-label format (TITLE:, INGREDIENTS:) ----------
function parseColon(text) {
  const t = text.replace(/[*_#]+/g, '').replace(/\r\n/g, '\n');
  const idx = t.search(/\bTITLE\s*:/i);
  if (idx === -1) return null;
  const sub = t.substring(idx);

  const grabSection = (startLabels, endLabels) => {
    const startRe = new RegExp('(?:^|\\n)\\s*(?:' + startLabels + ')\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:' + endLabels + ')\\s*:|$)', 'i');
    const m = sub.match(startRe);
    return m ? m[1].trim() : '';
  };

  const grabLine = (label) => {
    const re = new RegExp('(?:^|\\n)\\s*' + label + '\\s*:\\s*(.*?)(?:\\n|$)', 'i');
    const m = sub.match(re);
    return m ? m[1].trim() : '';
  };

  const title = grabLine('TITLE');
  if (!title) return null;

  const ingredientsRaw = grabSection('INGREDIENTS?|INGREDIENT LIST', 'INSTRUCTIONS?|DIRECTIONS?|METHOD|STEPS?|NOTES?');
  const instructionsRaw = grabSection('INSTRUCTIONS?|DIRECTIONS?|METHOD|STEPS?', 'NOTES?|TAGS?|SERVINGS?');

  return normalizeRecipe({
    title,
    description: grabLine('DESCRIPTION'),
    prepTime: grabLine('PREP[ _]?TIME'),
    cookTime: grabLine('COOK[ _]?TIME'),
    servings: grabLine('SERVINGS?'),
    mealType: grabLine('MEAL[ _]?TYPE'),
    tags: grabLine('TAGS?'),
    ingredients: ingredientsRaw,
    instructions: instructionsRaw,
    notes: grabSection('NOTES?', '$^'),
  });
}

// ---------- Parser 3: JSON ----------
function parseJson(raw) {
  if (!raw) return null;
  let t = raw
    .replace(/```json\s*/gi, '').replace(/```/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false, end = -1;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  const jsonText = t.substring(start, end + 1);
  let obj;
  try { obj = JSON.parse(jsonText); }
  catch { try { obj = JSON.parse(jsonText.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; } }
  return normalizeRecipe(obj);
}

// ---------- Parser 4: heuristic — find TITLE line, INGREDIENTS section, INSTRUCTIONS section ----------
function parseHeuristic(text) {
  const t = text.replace(/[*_#]+/g, '').replace(/\r\n/g, '\n');

  // Find the first non-empty line as title (fallback)
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  // Look for a line that looks like "TITLE: xxx" anywhere
  let title = '';
  for (const line of lines) {
    const m = line.match(/title\s*[:\-]\s*(.+)/i);
    if (m) { title = m[1].trim(); break; }
  }
  if (!title && lines[0].length < 100) title = lines[0];

  if (!title) return null;

  // Look for section keywords
  let ingredients = [];
  let instructions = [];
  let mode = null;
  for (const line of lines) {
    if (/^ingredients?\s*[:\-]?$/i.test(line) || /^ingredients?\s*[:\-]/i.test(line)) { mode = 'i'; continue; }
    if (/^(instructions?|directions?|method|steps?)\s*[:\-]?$/i.test(line) || /^(instructions?|directions?|method|steps?)\s*[:\-]/i.test(line)) { mode = 's'; continue; }
    if (/^(notes?|tags?|prep|servings?)\s*[:\-]?/i.test(line)) { mode = null; continue; }
    if (mode === 'i' && line) ingredients.push(cleanItem(line));
    else if (mode === 's' && line) instructions.push(cleanItem(line));
  }

  if (!ingredients.length && !instructions.length) return null;

  return normalizeRecipe({ title, ingredients, instructions });
}

// ---------- Master parser ----------
function parseAiOutput(text) {
  const cleaned = preclean(text);

  // 1. Delimiter
  let r = parseDelimited(cleaned);
  if (r && r.title) return r;

  // 2. Colon
  r = parseColon(cleaned);
  if (r && r.title) return r;

  // 3. JSON
  r = parseJson(cleaned);
  if (r && r.title) return r;

  // 4. Heuristic
  r = parseHeuristic(cleaned);
  if (r && r.title) return r;

  return null;
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

    console.log('=== RAW AI OUTPUT (first 1200 chars) ===');
    console.log(raw.substring(0, 1200));
    console.log('=== END ===');

    if (/^\s*NO_RECIPE\s*$/im.test(raw)) {
      return res.status(400).json({ error: 'No recipe detected in that image.' });
    }

    const recipe = parseAiOutput(raw);

    if (!recipe) {
      return res.status(500).json({
        error: 'Could not parse AI output',
        details: 'RAW: ' + raw.substring(0, 1800)
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
