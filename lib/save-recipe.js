// The save step every import route performs, in one place for the new
// paste-text action. The existing routes keep their own copies in this task.
import { findDuplicate } from './recipes.js';
import { findDishImage } from './image.js';

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
    findImage(recipe.title),
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

  await kv.set(`recipe:${id}`, stored);
  await kv.lpush('recipe_ids', id);
  return { status: 200, body: stored };
}
