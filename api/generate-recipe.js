// api/generate-recipe.js
// Vercel serverless function — proxies requests to Groq with the secret API key.

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    source: { type: 'string' },
    servings: { type: 'integer' },
    prepTime: { type: 'string' },
    cookTime: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          amount: { type: 'string' },
          unit: { type: 'string' },
          name: { type: 'string' }
        },
        required: ['amount', 'unit', 'name'],
        additionalProperties: false
      }
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          timerSeconds: { type: 'integer' }
        },
        required: ['title', 'content', 'timerSeconds'],
        additionalProperties: false
      }
    },
    notes: { type: 'string' }
  },
  required: [
    'title', 'description', 'source', 'servings',
    'prepTime', 'cookTime', 'tags', 'ingredients', 'steps', 'notes'
  ],
  additionalProperties: false
};

const SYSTEM_PROMPT =
  'You are a professional recipe developer. ' +
  'Generate complete, realistic recipes with accurate cooking times, temperatures, and techniques. ' +
  'Always populate every field in the schema. For timerSeconds, use a realistic number of seconds ' +
  'for the step (e.g. 600 for 10 minutes), or 0 if no timer is needed. ' +
  'Set source to "AI generated" unless the user specifies otherwise.';

export default async function handler(req, res) {
  // CORS for safety (same-origin by default, but harmless)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!GROQ_API_KEY) {
    console.error('GROQ_API_KEY is not set in environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Vercel parses JSON bodies automatically; guard anyway
  const body = req.body || {};
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

  if (!prompt) {
    return res.status(400).json({ error: 'A prompt is required' });
  }

  if (prompt.length > 2000) {
    return res.status(400).json({ error: 'Prompt is too long (max 2000 characters)' });
  }

  try {
    const groqResponse = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_completion_tokens: 2048,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'recipe',
            strict: true,
            schema: RECIPE_SCHEMA
          }
        }
      })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error('Groq API error:', groqResponse.status, errText);

      let clientMessage = 'Groq API request failed';
      try {
        const parsed = JSON.parse(errText);
        if (parsed && parsed.error && parsed.error.message) {
          clientMessage = parsed.error.message;
        }
      } catch (_) { /* keep default */ }

      return res.status(groqResponse.status).json({ error: clientMessage });
    }

    const data = await groqResponse.json();
    const content =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null;

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
    return res.status(500).json({
      error: 'Internal server error',
      details: err && err.message ? err.message : String(err)
    });
  }
}
