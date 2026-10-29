import { Redis } from '@upstash/redis';
import { validateImageBody } from '../lib/image-input.js';
import { requireAuth } from '../lib/auth.js';
import { groqChat, GROQ_VISION_MODEL } from '../lib/groq.js';
import { findDishImage } from '../lib/image.js';
import { findDuplicate, isUsableRecipe } from '../lib/recipes.js';
import { parseAiOutput } from '../lib/parse.js';
import { rateLimited } from '../lib/rate-limit.js';
import { sendServerError } from '../lib/http.js';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  if (await rateLimited(kv, req, 'process', 60)) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ error: 'Too many imports this hour. Try again later.' });
  }

  const body = req.body || {};
  // One body shape for a single photo and for up to three pages of one recipe.
  const checked = validateImageBody(body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const images = checked.images;
  const { addedBy, skipDuplicateCheck } = body;

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Groq API key not configured' });

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

  const multiNote = images.length > 1
    ? '\n\nThe images are consecutive parts (pages or sides) of ONE recipe. Combine them into a single recipe in the correct order; never repeat ingredients or steps.'
    : '';

  try {
    const raw = await groqChat({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt + multiNote },
          ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.imageBase64}` } })),
        ],
      }],
      temperature: 0.1,
      maxTokens: 3500,
      model: GROQ_VISION_MODEL,
      reasoningEffort: 'none',
    });

    if (process.env.DEBUG_AI === '1') {
      console.log('=== RAW AI OUTPUT (first 1200 chars) ===');
      console.log(raw.substring(0, 1200));
      console.log('=== END ===');
    }

    if (/^\s*NO_RECIPE\s*$/im.test(raw)) {
      return res.status(400).json({ error: 'No recipe detected in that image.' });
    }

    const recipe = parseAiOutput(raw);

    if (!isUsableRecipe(recipe)) {
      if (!recipe || !recipe.title) {
        console.error('Could not parse AI output. RAW (first 1800 chars):', raw.substring(0, 1800));
      }
      return res.status(400).json({ error: 'Could not read a recipe from that image. Try a clearer photo.' });
    }

    // Duplicate check and photo lookup run at the same time to keep imports fast.
    // skipDuplicateCheck: true saves a new copy even when a match exists
    // (the client's "Save a copy" on an already-in-your-chest queue row).
    const skipDup = skipDuplicateCheck === true;
    const [dup, image] = await Promise.all([
      skipDup ? null : findDuplicate(kv, { title: recipe.title }),
      findDishImage(recipe.title, { kv }),
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
      ...recipe,
      ...(image ? { image } : {}),
      createdAt: Date.now(),
      addedBy: String(addedBy || 'Anonymous').slice(0, 40),
    };

    await kv.set(`recipe:${id}`, finalRecipe);
    await kv.lpush('recipe_ids', id);
    return res.status(200).json(finalRecipe);
  } catch (error) {
    return sendServerError(res, error, 'Failed to save that recipe.');
  }
}
