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
import { updateRecipe, sendUpdateResult } from '../update-recipe.js';

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
    if (!(await requireAuth(req, res))) return;

    const id = String((req.query && req.query.id) || (req.body && req.body.id) || '');
    if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid recipe id' });

    try {
      if (req.method === 'DELETE') {
        const entry = String((req.query && req.query.entry) || '');
        // Compare-and-set, so a cook entry removed on one device and a tag edit
        // on another both land instead of one clobbering the other.
        const result = await updateRecipe(kv, id, (current) => {
          const before = Array.isArray(current.cookLog) ? current.cookLog : [];
          const after = before.filter((e) => !e || e.id !== entry);
          if (after.length === before.length) return null;
          return { ...current, cookLog: cleanCookLog(after) };
        });
        if (result.status === 200 && result.changed) logInfo('cooked-deleted', { id });
        return sendUpdateResult(res, result);
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
      const result = await updateRecipe(kv, id, (current) => ({
        ...current,
        cookLog: cleanCookLog([...(Array.isArray(current.cookLog) ? current.cookLog : []), entry]),
      }));
      if (result.status === 200) logInfo('cooked-added', { id, entries: (result.body.cookLog || []).length });
      return sendUpdateResult(res, result);
    } catch (e) {
      return sendServerError(res, e);
    }
  };
}

export default function handler(req, res) {
  return createHandler({ kv: getKv() })(req, res);
}
