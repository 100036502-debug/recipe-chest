import { requireAuth } from '../lib/auth.js';
import { VALID_MEAL_TYPES, ID_PATTERN, cleanTags, cleanCollections, findDuplicate, getRecipesByIds, normalizeIncomingRecipe } from '../lib/recipes.js';
import { TRASH_TTL_SECONDS, buildTrashEntry, trashKey } from '../lib/trash.js';
import { sendServerError } from '../lib/http.js';
import { saveRecipeRecord } from '../lib/save-recipe.js';
import { revokeShareLinks } from '../lib/actions/share.js';
import { getKv } from '../lib/redis.js';

// One shared client from lib/redis.js, created on first use: a module-level
// client here threw during a cold start if the env was missing, and it could
// not be replaced in tests.

// Fields the client is allowed to set or edit
const EDITABLE_FIELDS = [
  'title', 'description', 'prepTime', 'cookTime', 'servings',
  'mealType', 'tags', 'collections', 'ingredients', 'instructions', 'notes', 'favorite',
  // cookLog is intentionally absent: it is written only by the "cooked"
  // action (task 11), so PATCH and POST must never set it.
];

const MEAL_TYPES_WITH_DEFAULT = [...VALID_MEAL_TYPES, 'default'];

export function applyEditableFields(target, body) {
  for (const field of EDITABLE_FIELDS) {
    if (!(field in body)) continue;

    if (field === 'tags') {
      if (!Array.isArray(body.tags)) continue;
      target.tags = cleanTags(body.tags, 20);
    } else if (field === 'collections') {
      if (!Array.isArray(body.collections)) continue;
      target.collections = cleanCollections(body.collections);
    } else if (field === 'ingredients' || field === 'instructions') {
      if (!Array.isArray(body[field])) continue;
      target[field] = body[field]
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 100);
    } else if (field === 'mealType') {
      const mt = String(body.mealType || '').toLowerCase();
      target.mealType = MEAL_TYPES_WITH_DEFAULT.includes(mt) ? mt : 'default';
    } else if (field === 'favorite') {
      // Booleans only; a missing field means false (older recipes stay valid).
      target.favorite = body.favorite === true;
    } else {
      target[field] = String(body[field] ?? '').trim();
    }
  }
  // Lengths, tags and the list caps, the same way an imported recipe is treated.
  // Assign back into target: this function has always mutated its argument, and
  // a caller that ignores the return value must not lose the edit.
  Object.assign(target, normalizeIncomingRecipe(target));
  return target;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  const kv = getKv();
  if (!(await requireAuth(req, res))) return;

  // ---- GET: list every recipe, newest first ----
  if (req.method === 'GET') {
    try {
      const ids = await kv.lrange('recipe_ids', 0, -1);
      if (!ids || !ids.length) return res.status(200).json([]);
      const recipes = await getRecipesByIds(kv, ids);
      recipes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return res.status(200).json(recipes);
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  // ---- POST: save one recipe (with duplicate detection) ----
  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.title || typeof body.title !== 'string') {
      return res.status(400).json({ error: 'Recipe must have a title' });
    }

    const skipDuplicateCheck = body.skipDuplicateCheck === true;
    const sourceUrl = typeof body.sourceUrl === 'string' && /^https?:\/\//i.test(body.sourceUrl.trim())
      ? body.sourceUrl.trim().slice(0, 2000)
      : '';

    try {
      if (!skipDuplicateCheck) {
        const dup = await findDuplicate(kv, { title: body.title, sourceUrl });
        if (dup) {
          return res.status(409).json({ error: 'Possible duplicate', duplicate: dup });
        }
      }

      const rawId = typeof body.id === 'string' ? body.id : '';
      const id = ID_PATTERN.test(rawId)
        ? rawId
        : 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

      // An id that already exists is never overwritten from here: that used to
      // wipe cookLog, the dish photo and the image of a recipe the client had
      // not read. A restore is the one explicit exception.
      const wantsRestore = body.restore === true && skipDuplicateCheck === true;
      if (!wantsRestore && ID_PATTERN.test(rawId)) {
        const sameId = await kv.get(`recipe:${id}`);
        if (sameId) {
          return res.status(409).json({
            error: 'A recipe with that id already exists.',
            existing: { id: sameId.id, title: sameId.title },
          });
        }
      }

      const recipe = applyEditableFields({
        id,
        ingredients: [],
        instructions: [],
        tags: [],
        collections: [],
        mealType: 'default',
        sourceUrl,
        addedBy: String(body.addedBy || 'Anonymous').slice(0, 40),
        createdAt: Number.isFinite(body.createdAt) ? body.createdAt : Date.now(),
      }, body);

      await saveRecipeRecord(kv, recipe);
      const added = await kv.sadd('recipe_id_set', id);
      if (Number(added) === 1) await kv.lpush('recipe_ids', id);
      return res.status(200).json(recipe);
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  // ---- PATCH: update any editable field on an existing recipe ----
  if (req.method === 'PATCH') {
    const body = req.body || {};
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) return res.status(400).json({ error: 'Missing recipe id' });

    try {
      const existing = await kv.get(`recipe:${id}`);
      if (!existing) return res.status(404).json({ error: 'Recipe not found' });

      const updated = applyEditableFields({ ...existing }, body);
      updated.updatedAt = Date.now();
      await saveRecipeRecord(kv, updated);
      return res.status(200).json(updated);
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  // ---- DELETE: remove one recipe by id, keeping a short-lived copy for undo ----
  if (req.method === 'DELETE') {
    const id = String(req.query.id || '');
    if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid or missing id' });
    try {
      const [recipe, photo, photothumb] = await kv.mget(`recipe:${id}`, `photo:${id}`, `photothumb:${id}`);
      // Copy first, delete second: if keeping the copy fails we have not
      // destroyed anything, so a failed delete is safe to retry.
      const entry = buildTrashEntry(recipe, photo, photothumb);
      if (entry) await kv.set(trashKey(id), entry, { ex: TRASH_TTL_SECONDS });
      await kv.del(`recipe:${id}`, `photo:${id}`, `photothumb:${id}`);
      // A share link must not outlive the recipe it points at: the token is
      // still valid for anyone who has the URL, and a re-created id would make
      // it point at something new.
      const revoked = await revokeShareLinks(kv, id);
      await kv.lrem('recipe_ids', 0, id);
      await kv.srem('recipe_id_set', id);
      return res.status(200).json({
        success: true,
        undoable: Boolean(entry),
        undoWindowSeconds: entry ? TRASH_TTL_SECONDS : 0,
        shareLinksRevoked: revoked,
      });
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
