import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

// Generate an image for a recipe using Pollinations.AI (free, no API key needed)
async function generateRecipeImage(title, tags = [], retries = 1) {
  try {
    const tagStr = tags.length ? `, ${tags.slice(0, 3).join(', ')}` : '';
    const prompt = `${title}${tagStr}, food photography, natural light, overhead shot, appetizing`;
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=800&height=600&nologo=true`;

    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
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

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

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

  // Fetch the page server-side
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

  if (pageText.length < 50) {
    return res.status(400).json({ error: 'Page appears to be empty or blocked.' });
  }

  const prompt = `You are a recipe extraction AI. Below is the raw text content scraped from a webpage: ${parsedUrl.toString()}

Extract the recipe if one is present. Return ONLY valid JSON (no markdown, no backticks) in this exact format:

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

If no recipe is found on the page, return:
{ "error": "No recipe found on that page" }

Return ONLY the JSON.

WEBPAGE TEXT:
---
${pageText}
---`;

  try {
    const aiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
    });

    const data = await aiResponse.json();
    if (!data.choices || !data.choices[0]) {
      return res.status(500).json({ error: 'AI error', details: JSON.stringify(data).substring(0, 500) });
    }

    const aiText = data.choices[0].message.content;
    let jsonText = aiText.replace(/```json|```/g, '').trim();
    const s = jsonText.indexOf('{'), e = jsonText.lastIndexOf('}');
    if (s !== -1 && e !== -1) jsonText = jsonText.substring(s, e + 1);

    let recipe;
    try { recipe = JSON.parse(jsonText); }
    catch { return res.status(500).json({ error: 'AI returned invalid JSON', details: aiText.substring(0, 300) }); }

    if (recipe.error) return res.status(400).json({ error: recipe.error });

    const id = 'r_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const finalRecipe = {
      id,
      title: String(recipe.title || 'Untitled Recipe').slice(0, 200),
      description: String(recipe.description || '').slice(0, 500),
      ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.slice(0, 60) : [],
      instructions: Array.isArray(recipe.instructions) ? recipe.instructions.slice(0, 60) : [],
      prepTime: String(recipe.prepTime || ''),
      cookTime: String(recipe.cookTime || ''),
      servings: String(recipe.servings || ''),
      tags: Array.isArray(recipe.tags) ? recipe.tags.slice(0, 10).map(t => String(t).toLowerCase()) : [],
      notes: String(recipe.notes || '').slice(0, 1000),
      imageThumbnail: '',
      sourceUrl: parsedUrl.toString(),
      createdAt: Date.now(),
      addedBy: String(addedBy || 'Anonymous').slice(0, 40),
    };

    // Generate an image for the recipe using Pollinations.AI (free)
    if (finalRecipe.title) {
      const generatedImage = await generateRecipeImage(finalRecipe.title, finalRecipe.tags);
      if (generatedImage) {
        finalRecipe.imageThumbnail = generatedImage;
      }
    }

    await kv.set(`recipe:${id}`, finalRecipe);
    await kv.lpush('recipe_ids', id);
    return res.status(200).json(finalRecipe);
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed', details: error.message });
  }
}
