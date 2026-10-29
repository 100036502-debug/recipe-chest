// Structured logging: one JSON line per event, so Vercel's function logs can be
// searched instead of read. Nothing secret ever goes in: cookies, tokens,
// access codes and password fields are redacted, and callers must not pass
// recipe text.
const MESSAGE_LIMIT = 500;
const STACK_LIMIT = 1500;
const REDACTED_KEYS = /^(cookie|set-cookie|authorization|token|secret|password|code|access_?code|session)$/i;

// Pulls { message, stack } out of an Error, a { message, stack } object or a string.
function describe(err) {
  if (!err) return { message: '', stack: '' };
  if (err instanceof Error) {
    return {
      message: String(err.message || '').slice(0, MESSAGE_LIMIT),
      stack: String(err.stack || '').slice(0, STACK_LIMIT),
    };
  }
  if (typeof err === 'object') {
    return {
      message: String(err.message || '').slice(0, MESSAGE_LIMIT),
      stack: String(err.stack || '').slice(0, STACK_LIMIT),
    };
  }
  return { message: String(err).slice(0, MESSAGE_LIMIT), stack: '' };
}

// Copies caller data, redacting anything that looks like a credential.
function safeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (REDACTED_KEYS.test(key)) { out[key] = '[redacted]'; continue; }
    if (value instanceof Error) { out[key] = describe(value).message; continue; }
    out[key] = value;
  }
  return out;
}

function write(level, event, message, stack, data) {
  const line = { level, event, message, ...(stack ? { stack } : {}), ...safeData(data), t: new Date().toISOString() };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else console.log(text);
}

export function logInfo(event, data) {
  write('info', String(event), '', '', data);
}

export function logError(event, err, data) {
  const { message, stack } = describe(err);
  write('error', String(event), message, stack, data);
}
