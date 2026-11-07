// The two indexes of recipe ids: `recipe_ids` (a list, newest first, what the
// grid reads) and `recipe_id_set` (a set, what answers "is this id listed?" in
// one call). They have to move together. Only POST used to keep the set, so a
// recipe imported from a URL, an email, a PDF or a photo was in the list but not
// the set, and a later POST or restore of the same id pushed it onto the list a
// second time and showed it twice.

/**
 * Records an id in both indexes. The list is only pushed when the set did not
 * already hold the id, so calling this twice for one recipe is harmless.
 * Resolves to true when the id was newly listed.
 */
export async function listRecipeId(kv, id) {
  const added = await kv.sadd('recipe_id_set', id);
  if (Number(added) !== 1) return false;

  // The set is new to a chest that existed before it did, so "not in the set"
  // does not yet mean "not in the list". Look once before pushing: the set is
  // then correct for this id from here on, and a legacy entry is not doubled.
  const listed = (await kv.lrange('recipe_ids', 0, -1)) || [];
  if (listed.includes(id)) return false;

  try {
    await kv.lpush('recipe_ids', id);
  } catch (e) {
    // The set already says "listed". Undo that, or a retry would see the id
    // as present and never list it, leaving a saved recipe nobody can see.
    try { await kv.srem('recipe_id_set', id); } catch { /* best effort */ }
    throw e;
  }
  return true;
}

/** Removes an id from both indexes. */
export async function unlistRecipeId(kv, id) {
  await kv.lrem('recipe_ids', 0, id);
  await kv.srem('recipe_id_set', id);
}
