// The save step every import route performs, in one place for the new
// paste-text action. The existing routes keep their own copies in this task.

// Every write of a recipe object goes through here, so the sanitizer cannot be
// forgotten on a new path: lengths are capped, item lists bounded and markup
// stripped before the bytes reach Redis.
export async function saveRecipeRecord(kv, recipe) {
  const clean = normalizeIncomingRecipe(recipe);
  if (!clean || !clean.id) throw new Error('A recipe needs an id before it can be saved');
  await kv.set(`recipe:${clean.id}`, clean);
  return clean;
}
import { findDuplicate, normalizeIncomingRecipe } from './recipes.js';
import { findDishImage } from './image.js';
import { listRecipeId } from './recipe-index.js';

export async function saveImportedRecipe({
  kv,
  recipe,
  sourceUrl = '',
  addedBy,
  skipDuplicateCheck = false,
  findImage = findDishImage,
  now = Date.now(),
}) {
  const [dup, image] = await Promise.all([
    skipDuplicateCheck === true ? null : findDuplicate(kv, { title: recipe.title, sourceUrl }),
    findImage(recipe.title, { kv }),
  ]);

  if (dup) {
    return { status: 409, body: { error: `"${dup.title}" is already in your chest.`, duplicate: dup } };
  }

  const id = 'r_' + now + '_' + Math.random().toString(36).substring(2, 8);
  const stored = {
    id,
    ...recipe,
    ...(image ? { image } : {}),
    createdAt: now,
    addedBy: String(addedBy || 'Anonymous').slice(0, 40),
  };
  if (sourceUrl) stored.sourceUrl = sourceUrl;

  const saved = await saveRecipeRecord(kv, stored);
  await listRecipeId(kv, id);
  return { status: 200, body: saved };
}
