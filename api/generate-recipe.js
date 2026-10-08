import { Redis } from '@upstash/redis';
import sharp from 'sharp';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const MAX_EMAIL_TEXT_CHARACTERS = 6000;
const MAX_PDF_TEXT_CHARACTERS = 18000;
const MAX_IMAGES_PER_REQUEST = 3; // Groq's hard limit for qwen/qwen3.8-27b

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = {
  maxDuration: 60,
};

const PDF_PROMPT = `You are a recipe parser. The text below comes from a PDF, and may span multiple pages of the SAME recipe. Read all of it together and extract ONE recipe.

Return ONLY a json object with these keys:
{
  "title": "...",
  "description": "one short sentence",
  "prepTime": "...",
  "cookTime": "...",
  "servings": "...",
  "mealType": "breakfast | lunch | dinner | dessert | snack | drink",
  "tags": ["..."],
  "ingredients": ["..."],
  "instructions": ["..."],
  "notes": "..."
}

Rules:
- Treat all the text as parts of a single recipe. Do not create multiple recipes.
- If ingredients or steps span across pages, combine them in the correct order.
- Keep each ingredient and each instruction as its own string in the arrays.
- No commentary, no markdown, no explanation.`;

const IMAGE_PROMPT = `You are a recipe parser. The image(s) below show a recipe (or parts of one recipe). Read everything together and extract ONE recipe.

Return ONLY a json object with these keys:
{
  "title": "...",
  "description": "one short sentence",
  "prepTime": "...",
  "cookTime": "...",
  "servings": "...",
  "mealType": "breakfast | lunch | dinner | dessert | snack | drink",
  "tags": ["..."],
  "ingredients": ["..."],
  "instructions": ["..."],
  "notes": "..."
}

Rules:
- Treat all provided images as parts of the same recipe. Do not create multiple recipes.
- Keep each ingredient and each instruction as its own string in the arrays.
- If the image contains no recipe, return {"error": "no recipe found"}.
- No commentary, no markdown, no explanation.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const importSecret = process.env.EMAIL_IMPORT_SECRET;
  if (!importSecret) {
    return res.status(500).json({ error: 'Email import is not configured' });
  }
  if (req.headers.authorization !== `Bearer ${importSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'Groq API is not configured' });
  }

  try {
    const payload = req.body || {};
    const sender = String(payload.from || payload.From || 'Email Import');
    const senderName =
      (sender.match(/^\s*"?([^"<]+)"?\s*</)?.[1] || sender).trim() || 'Email Contributor';
    const bodyText = String(payload.text || payload['body-plain'] || payload.html || '');
    const messageId = String(payload.messageId || '');

    // Idempotency: skip if we already handled this exact message
    if (messageId) {
      const previousImport = await redis.get(`email_import:${messageId}`);
      if (previousImport) {
        return res.status(200).json({ success: true, ...previousImport });
      }
    }

    const allAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const imageAttachments = allAttachments.filter((a) => {
      const mime = a.type || a.contentType || '';
      return mime.startsWith('image/');
    });
    const pdfAttachments = allAttachments.filter((a) => {
      const mime = a.type || a.contentType || '';
      const name = (a.filename || a.name || '').toLowerCase();
      return mime === 'application/pdf' || name.endsWith('.pdf');
    });

    console.log(
      `Received: bodyText=${bodyText.length} chars, ` +
      `${imageAttachments.length} image(s), ${pdfAttachments.length} PDF(s)`
    );

    const savedRecipes = [];

    // -----------------------------------------------------------------
    // 1. Process each PDF as its own recipe (all pages together)
    // -----------------------------------------------------------------
    for (const pdf of pdfAttachments) {
      const filename = pdf.filename || pdf.name || 'attachment.pdf';
      const base64 = pdf.content || pdf.data;
      if (!base64) {
        console.warn(`PDF ${filename} has no content; skipping`);
        continue;
      }

      try {
        const buffer = Buffer.from(base64, 'base64');
        const parsed = await pdfParse(buffer);
        const text = (parsed.text || '').trim();

        console.log(`PDF ${filename}: ${parsed.numpages || 1} pages, ${text.length} chars of text`);

        if (text.length < 50) {
          console.warn(`PDF ${filename} has almost no text (${text.length} chars); skipping`);
          continue;
        }

        const recipe = await callGroq([
          {
            type: 'text',
            text: `${PDF_PROMPT}\n\nPDF TEXT:\n${text.substring(0, MAX_PDF_TEXT_CHARACTERS)}`,
          },
        ]);

        if (recipe.error) {
          console.warn(`PDF ${filename}: model reported ${recipe.error}`);
          continue;
        }

        const saved = await persistRecipe(recipe, senderName);
        savedRecipes.push(saved);
        console.log(`Saved recipe from PDF ${filename}: ${saved.recipe.title}`);
      } catch (err) {
        console.error(`Failed to process PDF ${filename}:`, err.message);
      }
    }

    // -----------------------------------------------------------------
    // 2. Process images as one recipe (up to Groq's 3-image limit)
    // -----------------------------------------------------------------
    if (imageAttachments.length > 0) {
      const images = [];
      for (const att of imageAttachments.slice(0, MAX_IMAGES_PER_REQUEST)) {
        const base64Data = att.content || att.data;
        if (!base64Data) continue;
        try {
          const resized = await sharp(Buffer.from(base64Data, 'base64'))
            .rotate()
            .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

          // Groq expects a data URL: data:image/jpeg;base64,...
          images.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
        } catch (err) {
          console.warn('Image resize failed:', err.message);
        }
      }

      if (images.length > 0) {
        try {
          const contentPayload = [
            { type: 'text', text: IMAGE_PROMPT },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ];

          const recipe = await callGroq(contentPayload);

          if (recipe.error) {
            console.warn(`Image recipe: model reported ${recipe.error}`);
          } else {
            const saved = await persistRecipe(recipe, senderName);
            savedRecipes.push(saved);
            console.log(`Saved recipe from ${images.length} image(s): ${saved.recipe.title}`);
          }
        } catch (err) {
          console.error(`Failed to process images:`, err.message);
        }
      }
    }

    // -----------------------------------------------------------------
    // 3. If nothing else worked but there's body text, fall back to that
    // -----------------------------------------------------------------
    if (savedRecipes.length === 0 && bodyText.trim().length > 0) {
      try {
        const recipe = await callGroq([
          {
            type: 'text',
            text:
              `Extract recipe details from this email message. Return ONLY a json object:\n\n` +
              `${bodyText.substring(0, MAX_EMAIL_TEXT_CHARACTERS)}`,
          },
        ]);

        if (!recipe.error) {
          const saved = await persistRecipe(recipe, senderName);
          savedRecipes.push(saved);
          console.log(`Saved recipe from email body: ${saved.recipe.title}`);
        }
      } catch (err) {
        console.error('Failed to process email body text:', err.message);
      }
    }

    if (savedRecipes.length === 0) {
      return res.status(500).json({
        error: 'No recipes could be extracted from this email',
      });
    }

    const first = savedRecipes[0];
    const result = {
      id: first.id,
      recipe: first.recipe,
      recipes: savedRecipes,
      count: savedRecipes.length,
    };

    if (messageId) {
      await redis.set(`email_import:${messageId}`, result);
    }

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('Failed to import email recipe:', error);
    return res.status(500).json({ error: 'Failed to import recipe' });
  }
}

/**
 * Send content parts to Groq and parse the JSON recipe response.
 * Uses qwen/qwen3.8-27b, which handles both text and images.
 */
async function callGroq(contentPayload) {
  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'qwen/qwen3.8-27b',
      messages: [{ role: 'user', content: contentPayload }],
      temperature: 0.2,
      max_completion_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!groqRes.ok) {
    const errorDetails = await groqRes.text();
    let detail = errorDetails;
    try {
      const groqError = JSON.parse(errorDetails).error;
      if (groqError) {
        detail = [groqError.code, groqError.message].filter(Boolean).join(': ');
      }
    } catch (_) {}
    throw new Error(`Groq API returned ${groqRes.status}: ${detail.substring(0, 500)}`);
  }

  const groqData = await groqRes.json();
  const rawContent = groqData.choices?.[0]?.message?.content || '{}';
  return JSON.parse(rawContent);
}

/**
 * Normalize, give an id, and store a recipe in Redis.
 */
async function persistRecipe(parsedRecipe, senderName) {
  const recipeId = `r_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const recipe = {
    id: recipeId,
    title: parsedRecipe.title || 'Imported Email Recipe',
    description: parsedRecipe.description || '',
    prepTime: parsedRecipe.prepTime || '',
    cookTime: parsedRecipe.cookTime || '',
    servings: parsedRecipe.servings || '',
    mealType: parsedRecipe.mealType || 'Dinner',
    tags: Array.isArray(parsedRecipe.tags) ? parsedRecipe.tags : [],
    ingredients: Array.isArray(parsedRecipe.ingredients) ? parsedRecipe.ingredients : [],
    instructions: Array.isArray(parsedRecipe.instructions) ? parsedRecipe.instructions : [],
    notes: parsedRecipe.notes || '',
    user: senderName,
    addedBy: senderName,
    createdAt: Date.now(),
  };

  await redis.set(`recipe:${recipeId}`, recipe);
  await redis.lpush('recipe_ids', recipeId);

  return { id: recipeId, recipe };
}
