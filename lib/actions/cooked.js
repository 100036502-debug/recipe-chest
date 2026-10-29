// /api/cooked — the cooking log.
//
// POST   body { id, date?, rating?, note?, by? }  appends one entry
// DELETE ?id=<recipe>&entry=<entry>               removes one entry
// Both return the whole updated recipe, and both 404 when the recipe is gone.
//
// cookLog is deliberately absent from the PATCH allow-list, so this action is
// the only way an entry can be written.
import { requireAuth } from '../auth.js';
import { ID_PATTERN, cleanCookLog } from '../recipes.js';
import { sendServerError } from '../http.js';
import { logInfo } from '../log.js';
import { getKv } from '../redis.js';

const FUTURE_DAYS = 1;

function utcDate(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
}
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}
function stripTags(v) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
}

export function createHandler({ kv }) {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!requireAuth(req, res)) return;

    const id = String((req.query && req.query.id) || (req.body && req.body.id) || '');
    if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid recipe id' });

    try {
      const current = await kv.get(`recipe:${id}`);
      if (!current || typeof current !== 'object') return res.status(404).json({ error: 'Recipe not found' });

      if (req.method === 'DELETE') {
        const entry = String((req.query && req.query.entry) || '');
        const before = Array.isArray(current.cookLog) ? current.cookLog : [];
        const after = before.filter((e) => !e || e.id !== entry);
        if (after.length === before.length) return res.status(200).json(current);
        const updated = { ...current, cookLog: cleanCookLog(after) };
        await kv.set(`recipe:${id}`, updated);
        logInfo('cooked-deleted', { id });
        return res.status(200).json(updated);
      }

      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const body = req.body || {};

      const date = typeof body.date === 'string' && body.date.trim() ? body.date.trim().slice(0, 10) : utcDate(0);
      if (!isRealDate(date)) return res.status(400).json({ error: 'That date does not exist' });
      if (date > utcDate(FUTURE_DAYS)) return res.status(400).json({ error: 'That date is in the future' });

      let rating = null;
      if (body.rating !== undefined && body.rating !== null && body.rating !== '') {
        const n = Number(body.rating);
        if (!Number.isInteger(n) || n < 1 || n > 5) return res.status(400).json({ error: 'Rating must be 1 to 5' });
        rating = n;
      }

      const entry = {
        id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        date,
        rating,
        note: stripTags(body.note).replace(/\s+/g, ' ').trim().slice(0, 300),
        by: String(body.by == null ? '' : body.by).trim().slice(0, 40),
      };

      // cleanCookLog is the same validator the backup restore uses, so an entry
      // written here and one restored from a backup come out identical.
      const log = cleanCookLog([...(Array.isArray(current.cookLog) ? current.cookLog : []), entry]);
      const updated = { ...current, cookLog: log };
      await kv.set(`recipe:${id}`, updated);
      logInfo('cooked-added', { id, entries: log.length });
      return res.status(200).json(updated);
    } catch (e) {
      return sendServerError(res, e);
    }
  };
}

export default function handler(req, res) {
  return createHandler({ kv: getKv() })(req, res);
}
