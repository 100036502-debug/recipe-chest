import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb', // Accommodate photo attachments
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body || {};

    // 1. Extract sender and body text (Handles SendGrid/Postmark format variants)
    const sender = payload.from || payload.From || 'Email Import';
    const senderName = sender.split('<')[0].replace(/"/g, '').trim() || 'Email Contributor';
    const bodyText = payload.text || payload['body-plain'] || payload.html || '';

    // 2. Extract attachments (images encoded in base64 or URLs)
    const images = [];
    if (Array.isArray(payload.attachments)) {
      for (const att of payload.attachments) {
        if (att.type?.startsWith('image/') || att.contentType?.startsWith('image/')) {
          const base64Data = att.content || att.data;
          if (base64Data) {
            const mimeType = att.type || att.contentType || 'image/jpeg';
            images.push(`data:${mimeType};base64,${base64Data}`);
          }
        }
      }
    }

    if (!bodyText && images.length === 0) {
      return res.status(400).json({ error: 'No readable text or image attachments found in email' });
    }

    // 3. Construct prompt payload for Groq multimodal AI
    const contentPayload = [];

    if (bodyText) {
      contentPayload.push({
        type: 'text',
        text: `Extract recipe details from this email message:\n\n${bodyText.substring(0, 15000)}`
      });
    }

    images.slice(0, 3).forEach((imgDataUrl) => {
      contentPayload.push({
        type: 'image_url',
        image_url: { url: imgDataUrl }
      });
    });

    const systemPrompt = `You are a recipe parser. Extract the recipe details from the provided text and images into a single clean JSON object. 
Return ONLY raw JSON with these exact keys:
{
  "title": "Recipe Name",
  "description": "Brief summary",
  "prepTime": "15 mins",
  "cookTime": "30 mins",
  "servings": "4",
  "mealType": "Dinner", // Options: Breakfast, Lunch, Dinner, Dessert, Snack, Drink
  "tags": ["Tag1", "Tag2"],
  "ingredients": ["1 cup flour", "2 eggs"],
  "instructions": ["Step 1 description", "Step 2 description"]
}`;

    // 4. Send query to Groq
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: contentPayload }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      throw new Error(`Groq API error: ${errText}`);
    }

    const groqData = await groqRes.json();
    const rawContent = groqData.choices?.[0]?.message?.content || '{}';
    const parsedRecipe = JSON.parse(rawContent);

    // 5. Construct standardized recipe object
    const recipeId = `r_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const recipeObject = {
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
      createdAt: new Date().toISOString()
    };

    // 6. Save directly into Upstash / Vercel KV Redis
    await redis.set(`recipe:${recipeId}`, JSON.stringify(recipeObject));
    await redis.lpush('recipe_ids', recipeId);

    return res.status(200).json({ success: true, id: recipeId, recipe: recipeObject });

  } catch (error) {
    console.error('Failed to import email recipe:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}
