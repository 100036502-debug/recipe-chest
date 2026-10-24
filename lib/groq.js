// One place for the Groq model name and the chat call (with rate-limit retry).
export const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Returns the model's text content. Throws an Error with a .status on failure.
 * Options: { messages, temperature = 0.1, maxTokens = 2000, json = false }
 */
export async function groqChat(options, attempt = 0) {
  const { messages, temperature = 0.1, maxTokens = 2000, json = false } = options;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const err = new Error('Groq API key not configured');
    err.status = 500;
    throw err;
  }

  const body = {
    model: GROQ_MODEL,
    messages,
    temperature,
    max_completion_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }

  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;

  if (!res.ok || content === null || content === undefined) {
    const errMsg =
      (data && data.error && data.error.message) ||
      (data ? JSON.stringify(data) : `HTTP ${res.status}`);

    const isRateLimit =
      res.status === 429 ||
      /rate limit/i.test(errMsg) ||
      (data && data.error && data.error.code === 'rate_limit_exceeded');

    if (isRateLimit && attempt < 3) {
      const match = errMsg.match(/try again in ([\d.]+)\s*s/i);
      const waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) + 800 : 6000;
      await new Promise((r) => setTimeout(r, waitMs));
      return groqChat(options, attempt + 1);
    }

    const err = new Error('Groq error: ' + String(errMsg).substring(0, 300));
    err.status = res.ok ? 502 : res.status;
    throw err;
  }

  return content;
}
