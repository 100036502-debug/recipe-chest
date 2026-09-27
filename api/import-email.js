import { Redis } from '@upstash/redis';
import sharp from 'sharp';

const MAX_EMAIL_TEXT_CHARACTERS = 6000;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
  maxDuration: 60,
};

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
    const senderName = (sender.match(/^\s*"?([^"<]+)"?\s*</)?.[1] || sender).trim() || 'Email Contributor';
    const bodyText = String(payload.text || payload['body-plain'] || payload.html || '');
    const messageId = String(payload.messageId || '');

    if (messageId) {
      const previousImport = await redis.get(`email_import:${messageId}`);
      if (previousImport) {
        return res.status(200).json({ success: true, ...previousImport });
      }
    }

    const images = [];
    if (Array.isArray(payload.attachments)) {
      for (const attachment of payload.attachments.slice(0, 3)) {
        const mimeType = attachment.type || attachment.contentType || '';
        const base64Data = attachment.content || attachment.data;
        if (mimeType.startsWith('image/') && base64Data) {
          const resizedImage = await sharp(Buffer.from(base64Data, 'base64'))
            .rotate()
            .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 75 })
            .toBuffer();
          images.push(`data:image/jpeg;base64,${resizedImage.toString('base64')}`);
        }
      }
    }

    if (!bodyText && images.length === 0) {
      return res.status(400).json({ error: 'No readable text or image attachments found in email' });
    }

    const contentPayload = [];
    if (bodyText) {
      contentPayload.push({
        type: 'text',
        text: `Extract recipe details from this email message:\n\n${bodyText.substring(0, MAX_EMAIL_TEXT_CHARACTERS)}`,
      });
    }
    images.slice(0, 3).forEach((image) => {
      contentPayload.push({ type: 'image_url', image_url: { url: image } });
    });

    const systemPrompt = `You are a recipe parser. Extract one recipe from the provided text and images. Return only compact JSON with these keys: title, description, prepTime, cookTime, servings, mealType, tags, ingredients, instructions. Keep the description to one sentence and each instruction concise. Do not include commentary.`;
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.8-27b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: contentPayload },
        ],
        temperature: 0.2,
        max_tokens: 900,
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
      } catch {}
      throw new Error(`Groq API returned status ${groqRes.status}: ${detail.substring(0, 500)}`);
    }

    const groqData = await groqRes.json();
    const rawContent = groqData.choices?.[0]?.message?.content || '{}';
    const parsedRecipe = JSON.parse(rawContent);
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
      user: senderName,
      createdAt: Date.now(),
    };

    await redis.set(`recipe:${recipeId}`, recipe);
    await redis.lpush('recipe_ids', recipeId);

    const result = { id: recipeId, recipe };
    if (messageId) {
      await redis.set(`email_import:${messageId}`, result);
    }

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('Failed to import email recipe:', error);
    return res.status(500).json({ error: 'Failed to import recipe' });
  }
}