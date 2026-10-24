// api/generate-recipe.js
// Vercel serverless function — proxies requests to Groq with the secret API key.
import { requireAuth } from '../lib/auth.js';
import { groqChat } from '../lib/groq.js';

const SYSTEM_PROMPT = `You are a professional recipe developer. Generate complete, realistic recipes with accurate cooking times, temperatures, and techniques.

Return ONLY a json object with exactly these keys:
{
  "title": "string — recipe title",
  "description": "string — one short sentence",
  "source": "string — always 'AI generated'",
  "servings": integer,
  "prepTime": "string, e.g. '15 minutes'",
  "cookTime": "string, e.g. '30 minutes'",
  "tags": ["array", "of", "lowercase", "tags"],
  "ingredients": [
    { "amount": "string, e.g. '1' or '1/2'", "unit": "string, e.g. 'cup' or 'tbsp'", "name": "string" }
  ],
  "steps": [
    { "title": "string — short step title", "content": "string — full instruction", "timerSeconds": integer }
  ],
  "notes": "string — optional tips, or empty string"
}

Rules:
- Populate every field. Use empty string "" or 0 when something does not apply.
- For timerSeconds, use a realistic number of seconds (e.g. 600 for 10 minutes), or 0 if no timer is needed.
- Set source to "AI generated" unless the user specifies otherwise.
- No commentary, no markdown, no explanation.`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAuth(req, res)) return;

  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY is not set in environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const body = req.body || {};
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

  if (!prompt) {
    return res.status(400).json({ error: 'A prompt is required' });
  }
  if (prompt.length > 2000) {
    return res.status(400).json({ error: 'Prompt is too long (max 2000 characters)' });
  }

  try {
    const content = await groqChat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      maxTokens: 2048,
      json: true,
    });

    if (!content) {
      return res.status(502).json({ error: 'Groq returned an empty response' });
    }

    let recipe;
    try {
      recipe = JSON.parse(content);
    } catch (parseErr) {
      console.error('Failed to parse Groq JSON:', content.slice(0, 500));
      return res.status(502).json({ error: 'Groq returned malformed JSON' });
    }

    return res.status(200).json({ recipe });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(err.status || 500).json({
      error: err.message || 'Internal server error',
    });
  }
}
