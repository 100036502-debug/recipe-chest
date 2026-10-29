// The parts of the shopping-list route that are worth testing without Redis.

// Clean whatever the client sent into the items we are willing to store.
export function cleanItems(input) {
  if (!Array.isArray(input)) return null;
  return input
    .map((it) => ({
      text: String((it && it.text) || '').trim().slice(0, 200),
      checked: !!(it && it.checked),
      recipeId: it && it.recipeId ? String(it.recipeId).slice(0, 40) : null,
    }))
    .filter((it) => it.text.length > 0)
    .slice(0, 200);
}

// Optimistic concurrency. The client sends the updatedAt it last saw; if the
// stored list has moved on, the write is refused and the caller gets the
// current list back so it can re-apply its change instead of clobbering it.
// No baseUpdatedAt means an older client, which keeps the old last-write-wins
// behaviour.
export function decideWrite({ stored, baseUpdatedAt }) {
  if (baseUpdatedAt == null || !Number.isFinite(Number(baseUpdatedAt))) {
    return { write: true };
  }
  const current = stored && typeof stored.updatedAt === 'number' ? stored.updatedAt : null;
  if (current !== null && current > Number(baseUpdatedAt)) {
    return { write: false, current: stored };
  }
  return { write: true };
}
