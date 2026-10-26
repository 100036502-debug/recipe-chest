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

// A recipe is only worth saving when it has a title and at least one
// ingredient or instruction. Guards against the AI returning {} or
// junk for photo/PDF/URL/email imports.
export function isUsableRecipe(r) {
  return Boolean(r && typeof r === 'object' && !r.error &&
    String(r.title || '').trim() &&
    ((Array.isArray(r.ingredients) && r.ingredients.length) ||
     (Array.isArray(r.instructions) && r.instructions.length)));
}

export function normalizeTitle(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Loads all recipes for the given ids with MGET in batches of 100,
// instead of one HTTP call per recipe.
export async function getRecipesByIds(kv, ids) {
  const out = [];
  if (!ids || !ids.length) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const keys = ids.slice(i, i + 100).map((id) => `recipe:${id}`);
    const vals = await kv.mget(...keys);
    for (const v of vals) if (v) out.push(v);
  }
  return out;
}

// Returns the existing recipe that matches on normalized title or source URL, or null.
export async function findDuplicate(kv, { title, sourceUrl }) {
  const ids = await kv.lrange('recipe_ids', 0, -1);
  if (!ids || !ids.length) return null;

  const existing = await getRecipesByIds(kv, ids);
  const normTitle = normalizeTitle(title);
  const url = String(sourceUrl || '').trim();

  return existing.find((r) => {
    if (normTitle && normalizeTitle(r.title) === normTitle) return true;
    if (url && String(r.sourceUrl || '').trim() === url) return true;
    return false;
  }) || null;
}
