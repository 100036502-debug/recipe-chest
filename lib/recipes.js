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

// Free-text fields never keep markup: drop whole tags, then any stray angle
// bracket. Stripping only the brackets would turn "<b>bad</b>" into "bbad/b".
// Shared by the normalizers below and by normalizeIncomingRecipe: every write
// path runs incoming text through it, so a missed escape downstream cannot turn
// into stored markup.
export function stripTags(value) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
}

// Collections are the reader's own groupings ("weeknight", "baking"): free
// text, so keep them short and plain. Dedupe case-insensitively but keep the
// first spelling, since that is the one they typed.
export function cleanCollections(input, max = 10) {
  const list = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(/[,;]/) : []);
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const clean = stripTags(c).replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

// YYYY-MM-DD that really exists: 2025-02-30 and 2025-13-01 are not dates.
function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function newEntryId() {
  return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// cookLog is the history of having cooked a recipe. It is written only by the
// "cooked" action (task 11), never through PATCH, but it still has to survive
// storage and backup restore, so it is cleaned like everything else.
export function cleanCookLog(input, max = 50) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;

    const date = String(entry.date == null ? '' : entry.date).trim();
    if (!isRealDate(date)) continue;

    const rawId = String(entry.id == null ? '' : entry.id).trim();
    const id = ID_PATTERN.test(rawId) ? rawId : newEntryId();

    const ratingNum = Number(entry.rating);
    const rating = Number.isInteger(ratingNum) && ratingNum >= 1 && ratingNum <= 5 ? ratingNum : null;

    const note = stripTags(entry.note).replace(/\s+/g, ' ').trim().slice(0, 300);
    const by = String(entry.by == null ? '' : entry.by).trim().slice(0, 40);

    out.push({ id, date, rating, note, by });
  }

  if (out.length <= max) return out;
  // Keep the newest by date, but hand them back in their original order.
  const keep = new Set(
    out
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (a.e.date < b.e.date ? 1 : a.e.date > b.e.date ? -1 : a.i - b.i))
      .slice(0, max)
      .map((x) => x.i)
  );
  return out.filter((_, i) => keep.has(i));
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

// ---- Incoming data -------------------------------------------------------
// One sanitizer for everything that arrives from outside the app. Renderers
// escape as well; this exists so that one missed escape can never become
// stored XSS, and so a 2 MB "title" cannot get in.
const TEXT_LIMITS = {
  title: 200,
  description: 500,
  time: 40, // prepTime, cookTime, servings
  note: 1000,
  item: 1000, // one ingredient or instruction
  items: 100,
};

export function cleanText(text, max) {
  const out = stripTags(text);
  return max ? out.slice(0, max) : out;
}

function cleanTextList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => cleanText(entry, TEXT_LIMITS.item))
    .filter(Boolean)
    .slice(0, TEXT_LIMITS.items);
}

/**
 * Sanitized copy of an incoming recipe. Only the fields that are present are
 * touched, and every other key is passed through untouched, so this can wrap
 * any path (import, edit, AI) without dropping data it does not know about.
 */
export function normalizeIncomingRecipe(raw) {
  const out = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? { ...raw } : {};
  const setIfPresent = (field, value) => {
    if (Object.prototype.hasOwnProperty.call(out, field)) out[field] = value;
  };

  setIfPresent('title', cleanText(out.title, TEXT_LIMITS.title));
  setIfPresent('description', cleanText(out.description, TEXT_LIMITS.description));
  setIfPresent('notes', cleanText(out.notes, TEXT_LIMITS.note));
  setIfPresent('prepTime', cleanText(out.prepTime, TEXT_LIMITS.time));
  setIfPresent('cookTime', cleanText(out.cookTime, TEXT_LIMITS.time));
  setIfPresent('servings', cleanText(out.servings, TEXT_LIMITS.time));
  setIfPresent('addedBy', cleanText(out.addedBy, 40));
  setIfPresent('sourceUrl', cleanText(out.sourceUrl, 500));
  setIfPresent('ingredients', cleanTextList(out.ingredients));
  setIfPresent('instructions', cleanTextList(out.instructions));
  setIfPresent('tags', cleanTags(out.tags, 20));
  setIfPresent('collections', cleanCollections(out.collections));

  if (Array.isArray(out.cookLog)) {
    out.cookLog = out.cookLog.slice(0, 50).map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const copy = { ...entry };
      if ('by' in copy) copy.by = cleanText(copy.by, 40);
      if ('note' in copy) copy.note = cleanText(copy.note, TEXT_LIMITS.note);
      return copy;
    });
  }
  if (out.userPhoto && typeof out.userPhoto === 'object') {
    out.userPhoto = {
      ...out.userPhoto,
      credit: cleanText(out.userPhoto.credit, 80),
    };
  }
  return out;
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

// What a backup restore should do with one id. Existence is decided by whether
// the recipe value is actually there, never by membership in recipe_ids: an id
// can outlive its recipe (a half-failed delete, or Redis dropping the key), and
// that recipe must still be restorable — it is exactly what a backup is for.
export function restoreDecision(storedRecipe, isListed) {
  if (storedRecipe) return { write: false, addToList: false };
  return { write: true, addToList: !isListed };
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
    collections: cleanCollections(input.collections),
    cookLog: cleanCookLog(input.cookLog),
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
