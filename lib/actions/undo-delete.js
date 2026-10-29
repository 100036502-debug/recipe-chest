// POST /api/undo-delete — puts a just-deleted recipe back, with its own id.
//
// Run through the dispatcher in api/extras.js (action=undo-delete); the URL is
// kept stable by a rewrite in vercel.json.
//
// DELETE /api/recipes leaves a copy in `trash:<id>` for TRASH_TTL_SECONDS, then
// removes the recipe. This handler restores that copy (recipe + photo) and its
// entry in `recipe_ids`. Once the window has passed the copy is gone and this
// says so plainly instead of reporting a success that did nothing.
//
// This is an undo, not a recycling bin: there is no endpoint that lists the
// trash, and entries expire on their own.
import { requireAuth } from '../auth.js';
import { ID_PATTERN } from '../recipes.js';
import { isRestorable, trashKey } from '../trash.js';
import { sendServerError } from '../http.js';
import { getKv } from '../redis.js';

// The fake, in-memory kv used by tests is injected here; production goes
// through the default export below.
export function createHandler({ kv }) {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!requireAuth(req, res)) return;

    const body = req.body || {};
    const id = String(body.id || '');
    if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid or missing id' });

    try {
      const entry = await kv.get(trashKey(id));
      if (!isRestorable(entry)) {
        // The window passed (the key expired) or this id was never deleted.
        return res.status(410).json({ error: 'Too late to undo — that recipe is gone.' });
      }

      // A retried undo may find the recipe already back; write only what is missing.
      const existing = await kv.get(`recipe:${id}`);
      if (!existing) {
        await kv.set(`recipe:${id}`, entry.recipe);
        if (entry.photo) await kv.set(`photo:${id}`, entry.photo);
        if (entry.photothumb) await kv.set(`photothumb:${id}`, entry.photothumb);
        const ids = (await kv.lrange('recipe_ids', 0, -1)) || [];
        if (!ids.includes(id)) await kv.lpush('recipe_ids', id);
      }
      await kv.del(trashKey(id));
      return res.status(200).json({
        success: true,
        id,
        title: String(entry.recipe.title || ''),
        alreadyThere: Boolean(existing),
      });
    } catch (e) {
      return sendServerError(res, e, 'Could not undo that delete');
    }
  };
}

export default function handler(req, res) {
  return createHandler({ kv: getKv() })(req, res);
}
