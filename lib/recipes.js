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

// ---------- Backup restore helpers ----------

// Returns the normalised URL only when it is a valid http(s) URL, else ''.
export function safeHttpUrl(u) {
  try {
    const x = new URL(String(u));
    return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : '';
  } catch {
    return '';
  }
}

// https URL on a hostname matching the pattern, else ''.
function httpsOn(u, hostPattern) {
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'https:') return '';
    if (!hostPattern.test(x.hostname)) return '';
    return x.href;
  } catch {
    return '';
  }
}

const UNSPLASH_IMAGE_HOST = /^images\.unsplash\.com$/;
const UNSPLASH_HOST = /(^|\.)unsplash\.com$/;
const UNSPLASH_API_HOST = /^api\.unsplash\.com$/;

// Rebuilds the image block only when it points at Unsplash's CDN as
// expected; every URL is re-validated so a tampered backup cannot plant
// javascript: links in the UI.
export function sanitizeStoredImage(image) {
  if (!image || typeof image !== 'object') return null;
  const url = httpsOn(image.url, UNSPLASH_IMAGE_HOST);
  if (!url) return null;
  const out = {
    url,
    thumb: httpsOn(image.thumb, UNSPLASH_IMAGE_HOST) || url,
    alt: String(image.alt || '').slice(0, 120),
    photographer: String(image.photographer || '').slice(0, 80),
    photographerUrl: httpsOn(image.photographerUrl, UNSPLASH_HOST),
    photoUrl: httpsOn(image.photoUrl, UNSPLASH_HOST),
    downloadLocation: httpsOn(image.downloadLocation, UNSPLASH_API_HOST),
    source: 'Unsplash',
  };
  return out;
}

function cleanStringArray(v, maxItems, maxChars) {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s).trim().slice(0, maxChars)).filter(Boolean).slice(0, maxItems);
}

/**
 * Builds a NEW object containing ONLY the known, cleaned recipe fields.
 * Returns null when the recipe fails validation (bad id, no title).
 * userPhoto is deliberately NOT copied: the caller sets it only when the
 * backup actually contains photo data for the recipe.
 */
export function sanitizeStoredRecipe(input) {
  if (!input || typeof input !== 'object') return null;
  const id = String(input.id || '');
  if (!ID_PATTERN.test(id)) return null;

  const title = String(input.title || '').trim().slice(0, 200);
  if (!title) return null;

  const out = {
    id,
    title,
    description: String(input.description || '').slice(0, 500),
    prepTime: String(input.prepTime || '').slice(0, 40),
    cookTime: String(input.cookTime || '').slice(0, 40),
    servings: String(input.servings || '').slice(0, 40),
    ingredients: cleanStringArray(input.ingredients, 100, 1000),
    instructions: cleanStringArray(input.instructions, 100, 1000),
    notes: String(input.notes || '').slice(0, 1000),
    tags: cleanTags(input.tags, 20),
    mealType: normalizeMealType(input.mealType),
    sourceUrl: safeHttpUrl(input.sourceUrl),
  };

  if (input.favorite === true) out.favorite = true;

  const person = String(input.addedBy || '').slice(0, 40);
  if (person) out.addedBy = person;
  const user = String(input.user || '').slice(0, 40);
  if (user) out.user = user;

  for (const f of ['createdAt', 'updatedAt', 'imageChecked']) {
    const n = Number(input[f]);
    // finite AND > 0: Number(null) and Number('') are 0, which would
    // otherwise surface as a 1 Jan 1970 date in the UI.
    if (Number.isFinite(n) && n > 0) out[f] = n;
  }

  const image = sanitizeStoredImage(input.image);
  if (image) out.image = image;

  return out;
}
