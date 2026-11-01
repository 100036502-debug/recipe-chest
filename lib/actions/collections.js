// POST /api/collections — rename or delete a collection across every recipe.
//
// A collection lives inside each recipe, so a rename is N small writes. Every
// recipe is re-read immediately before it is written, so a recipe edited
// elsewhere in the meantime is never quietly rolled back.
import { requireAuth } from '../auth.js';
import { cleanCollections } from '../recipes.js';
import { sendServerError } from '../http.js';
import { getKv } from '../redis.js';
import { logInfo } from '../log.js';
import { updateRecipe } from '../update-recipe.js';

const MAX_RECIPES = 2000;
// Small enough that one batch stays a single round trip and a failure loses
// very little work; large enough that a big chest is a handful of calls.
const CHUNK_SIZE = 50;

export function createHandler({ kv }) {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!(await requireAuth(req, res))) return;

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
      // The cap used to drop the rest in silence: the caller was told a count it
      // could not tell apart from "all of them". Now both are reported, and the
      // work happens in small batches rather than one request per recipe.
      const scanned = ids.slice(0, MAX_RECIPES);
      const truncated = ids.length > scanned.length;

      const applyTo = (current) => {
        const before = Array.isArray(current.collections) ? current.collections : [];
        if (!before.length) return null;

        const next = cleanCollections(rename
          ? before.map((c) => (String(c).toLowerCase() === from.toLowerCase() ? to : c))
          : before.filter((c) => String(c).toLowerCase() !== target.toLowerCase()));

        if (JSON.stringify(next) === JSON.stringify(before)) return null;
        return { ...current, collections: next };
      };

      let changed = 0;
      let examined = 0;

      for (let i = 0; i < scanned.length; i += CHUNK_SIZE) {
        const batch = scanned.slice(i, i + CHUNK_SIZE);
        const stored = await kv.mget(...batch.map((id) => `recipe:${id}`));

        // A failed batch is reported, not swallowed: some recipes will have been
        // renamed by then, and the caller needs to know the pass was partial.
        for (const current of stored) {
          if (!current || typeof current !== 'object' || !current.id) continue;
          examined += 1;
          if (!applyTo(current)) continue;

          // Compare-and-set per recipe: a recipe edited elsewhere at the same
          // moment is retried on the fresh copy, never rolled back.
          const result = await updateRecipe(kv, current.id, applyTo);
          if (result.status === 200 && result.changed) changed += 1;
        }
      }

      logInfo('collections-changed', {
        mode: rename ? 'rename' : 'delete', changed, total: ids.length, truncated,
      });
      return res.status(200).json({ changed, total: ids.length, examined, truncated });
    } catch (e) {
      return sendServerError(res, e);
    }
  };
}

export default function handler(req, res) {
  return createHandler({ kv: getKv() })(req, res);
}
