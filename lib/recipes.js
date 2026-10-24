export const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'drink'];

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeMealType(raw) {
  const mt = String(raw || '').toLowerCase();
  for (const vm of VALID_MEAL_TYPES) if (mt.includes(vm)) return vm;
  return 'default';
}

// Accepts an array or a comma/semicolon-separated string. Lowercases, strips < and >,
// removes duplicates, and caps both tag length and tag count.
export function cleanTags(input, max = 10) {
  const list = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(/[,;]/) : []);
  const out = [];
  for (const t of list) {
    const clean = String(t).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns the existing recipe that matches on normalized title or source URL, or null.
export async function findDuplicate(kv, { title, sourceUrl }) {
  const ids = await kv.lrange('recipe_ids', 0, -1);
  if (!ids || !ids.length) return null;

  const existing = (await Promise.all(ids.map((id) => kv.get(`recipe:${id}`)))).filter(Boolean);
  const normTitle = normalizeTitle(title);
  const url = String(sourceUrl || '').trim();

  return existing.find((r) => {
    if (normTitle && normalizeTitle(r.title) === normTitle) return true;
    if (url && String(r.sourceUrl || '').trim() === url) return true;
    return false;
  }) || null;
}
