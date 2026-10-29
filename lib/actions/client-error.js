// POST /api/client-error — a browser-side crash, reported from the page.
//
// The server never sees these otherwise: an exception in js/app.js just leaves
// the user staring at a half-rendered screen while the logs stay quiet.
//
// Everything is untrusted input, so each field is type-checked and truncated,
// and the whole endpoint is authenticated and rate limited.
import { requireAuth } from '../auth.js';
import { rateLimited } from '../rate-limit.js';
import { logError } from '../log.js';
import { getKv } from '../redis.js';

const TEXT_LIMIT = 500;
const STACK_LIMIT = 1500;

const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export function createHandler({ kv }) {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!requireAuth(req, res, { allowGuestWrite: true })) return;

    if (await rateLimited(kv, req, 'client-error', 20)) {
      return res.status(429).json({ error: 'Too many error reports' });
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const message = text(body.message, TEXT_LIMIT);
    const source = text(body.source, TEXT_LIMIT);
    const url = text(body.url, TEXT_LIMIT);
    const stack = text(body.stack, STACK_LIMIT);

    logError('client-error', { message: message || 'Unknown client error', stack }, {
      source,
      line: number(body.line),
      col: number(body.col),
      url,
    });

    return res.status(204).end();
  };
}

export default function handler(req, res) {
  return createHandler({ kv: getKv() })(req, res);
}
