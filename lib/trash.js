// Short-lived copies of deleted recipes, so a mis-tapped delete can be undone.
// This is an undo window, not a recycling bin: the entry expires on its own and
// nothing in the UI lists it.
//
// key: trash:<id> — { recipe, photo?, photothumb?, deletedAt }, TTL TRASH_TTL_SECONDS
export const TRASH_TTL_SECONDS = 600; // 10 minutes

export function trashKey(id) {
  return `trash:${id}`;
}

// Builds the trash entry for a recipe about to be deleted. Returns null when
// there is no recipe to keep, so the delete handler reports "not undoable"
// instead of offering an Undo that cannot work.
export function buildTrashEntry(recipe, photo, photothumb, now = Date.now()) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return null;
  const entry = { recipe, deletedAt: now };
  if (typeof photo === 'string' && photo) entry.photo = photo;
  if (typeof photothumb === 'string' && photothumb) entry.photothumb = photothumb;
  return entry;
}

// A trash entry is only usable when it still carries a recipe object.
export function isRestorable(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.recipe && typeof entry.recipe === 'object');
}
