import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 60,
};

// Repair common JSON issues returned by LLMs
function repairJson(text) {
  let t = text.trim();
  t = t.replace(/,(\s*[}\]])/g, '$1');
  t = t.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return t;
}

// Robustly extract a JSON object from a model response
function extractJson(raw) {
  let text = raw.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/```json\s*|```\s*/g, '').trim();
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');

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
  if (end === -1) throw new Error('Unbalanced JSON braces');

  const jsonText = text.substring(start, end + 1);
  try { return JSON.parse(jsonText); }
  catch { return JSON.parse(repairJson(jsonText)); }
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

  const prompt = `You are a recipe extraction AI. The user sends an image of a recipe (cookbook page, handwritten card, screenshot, magazine, etc.).

Read the image carefully and extract the recipe. Return ONLY valid JSON (no markdown, no backticks, no commentary before or after) in this exact format:

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

If the image is NOT a recipe or is completely unreadable, return:
{ "error": "brief reason" }

Return ONLY the JSON object.`;

  try {
    // 1. Extract the recipe from the image
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
          ]
        }],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    const data = await response.json();
    if (!data.choices || !data.choices[0]) {
      return res.status(500).json({ error: 'AI error', details: JSON.stringify(data).substring(0, 500) });
    }

    const aiText = data.choices[0].message.content;

    let recipe;
    try {
      recipe = extractJson(aiText);
    } catch (parseErr) {
      return res.status(500).json({
        error: 'AI returned invalid JSON',
        details: parseErr.message + ' | Raw: ' + aiText.substring(0, 400)
      });
    }

    if (recipe.error) return res.status(400).json({ error: recipe.error });

    const id = 'r_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const title = String(recipe.title || 'Untitled Recipe').slice(0, 200);
    const tags = Array.isArray(recipe.tags) ? recipe.tags.slice(0, 10).map(t => String(t).toLowerCase()) : [];

    // 2. Generate an AI food photo from the title
    //    Default to the original scan as a fallback if generation fails
    let thumbnail = `data:${mimeType};base64,${imageBase64}`;
    if (title && title !== 'Untitled Recipe') {
      const generated = await generateRecipeImage(title, tags);
      if (generated) {
        thumbnail = generated; // replace with the AI image
      } else {
        console.log('Image generation failed, using original scan as thumbnail');
      }
    }

    const finalRecipe = {
      id,
      title,
      description: String(recipe.description || '').slice(0, 500),
      ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.slice(0, 60) : [],
      instructions: Array.isArray(recipe.instructions) ? recipe.instructions.slice(0, 60) : [],
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
    return res.status(500).json({ error: 'Failed', details: error.message });
  }
}
