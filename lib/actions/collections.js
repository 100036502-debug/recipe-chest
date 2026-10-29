// POST /api/collections — rename or delete a collection across every recipe.
//
// A collection lives inside each recipe, so a rename is N small writes. Every
// recipe is re-read immediately before it is written, so a recipe edited
// elsewhere in the meantime is never quietly rolled back.
import { requireAuth } from '../auth.js';
import { cleanCollections, getRecipesByIds } from '../recipes.js';
import { sendServerError } from '../http.js';
import { getKv } from '../redis.js';
import { logInfo } from '../log.js';

const MAX_RECIPES = 2000;

export function createHandler({ kv }) {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!requireAuth(req, res)) return;

    const body = req.body || {};
    const rename = body.rename && typeof body.rename === 'object' ? body.rename : null;
    const remove = typeof body.delete === 'string' ? body.delete : '';

    const from = rename ? (cleanCollections([rename.from])[0] || '') : '';
    const to = rename ? (cleanCollections([rename.to])[0] || '') : '';
    const target = remove ? (cleanCollections([remove])[0] || '') : '';

    if (!rename && !target) return res.status(400).json({ error: 'Provide rename or delete' });
    if (rename && (!from || !to)) return res.status(400).json({ error: 'Both names are required' });

    try {
      const ids = (await kv.lrange('recipe_ids', 0, -1)) || [];
      const listed = await getRecipesByIds(kv, ids.slice(0, MAX_RECIPES));
      let changed = 0;

      for (const summary of listed) {
        if (!summary || !summary.id) continue;
        const current = await kv.get(`recipe:${summary.id}`);
        if (!current || typeof current !== 'object') continue;
        const before = Array.isArray(current.collections) ? current.collections : [];
        if (!before.length) continue;

        const next = cleanCollections(rename
          ? before.map((c) => (String(c).toLowerCase() === from.toLowerCase() ? to : c))
          : before.filter((c) => String(c).toLowerCase() !== target.toLowerCase()));

        if (JSON.stringify(next) === JSON.stringify(before)) continue;
        await kv.set(`recipe:${summary.id}`, { ...current, collections: next });
        changed += 1;
      }

      logInfo('collections-changed', { mode: rename ? 'rename' : 'delete', changed });
      return res.status(200).json({ changed });
    } catch (e) {
      return sendServerError(res, e);
    }
  };
}

export default function handler(req, res) {
  return createHandler({ kv: getKv() })(req, res);
}
