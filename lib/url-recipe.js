// Turns a web page address into a saved recipe. One implementation for the
// two routes that need it: /api/import-url (a member pastes a link) and
// /api/import-email (a link arrives in a mail). Neither route knows how a page
// becomes a recipe; both just map the result onto their own response.
//
// The result is plain data, never a response object:
//   { ok: true,  recipe }                       saved
//   { ok: false, status, error, duplicate? }    not saved, and why
import { groqChat } from './groq.js';
import { findDishImage } from './image.js';
import { safeFetchText } from './safe-fetch.js';
import { normalizeMealType, cleanTags, findDuplicate, isUsableRecipe, normalizeIncomingRecipe } from './recipes.js';
import { tryParseJson } from './parse.js';
import { extractRecipeFromJsonLd } from './jsonld-recipe.js';
import { truncateHtml, removeBlocks, removeComments } from './html-text.js';
import { saveRecipeRecord } from './save-recipe.js';
import { listRecipeId } from './recipe-index.js';

export function stripHtml(rawHtml) {
  // Bounded first, then linear block removal: the lazy regexes this replaced
  // went quadratic on a page full of unclosed script tags.
  let html = truncateHtml(rawHtml);
  for (const tag of ['script', 'style', 'noscript', 'svg']) html = removeBlocks(html, tag);
  return removeComments(html)
    .replace(/<[^<>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const fail = (status, error, extra) => ({ ok: false, status, error, ...(extra || {}) });

/**
 * @param {object} opts
 * @param {object} opts.kv        the Redis client
 * @param {string} opts.url       the address to import
 * @param {string} opts.addedBy   who gets the credit
 * @param {Function} [opts.fetchText]  injected in tests
 * @param {Function} [opts.chat]       injected in tests
 * @param {Function} [opts.findImage]  injected in tests
 * @param {Function} [opts.beforeAi]   called before a model call; return false to stop
 */
export async function importRecipeFromUrl({
  kv, url, addedBy,
  fetchText = safeFetchText,
  chat = groqChat,
  findImage = findDishImage,
  beforeAi,
}) {
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return fail(400, 'Invalid URL'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return fail(400, 'Only http and https URLs are allowed');
  }

  // Skip the fetch and the AI call entirely if this exact URL is already saved
  try {
    const existing = await findDuplicate(kv, { title: '', sourceUrl: parsedUrl.toString() });
    if (existing) {
      return fail(409, `"${existing.title}" is already in your chest.`, { duplicate: existing });
    }
  } catch (e) {
    console.error('Duplicate pre-check failed:', e.message);
  }

  // Fetch the page (private/internal addresses are refused)
  let html;
  try {
    html = await fetchText(parsedUrl.toString(), {
      timeoutMs: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RecipeChestBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
  } catch (e) {
    // One message for every failure: "not allowed" vs "could not resolve" told
    // a member which internal names exist. The detail stays in the server log.
    console.error('URL import fetch failed:', e.message);
    return fail(400, 'Could not fetch that page.');
  }

  // 1. Structured data first: exact, fast and free. Most recipe sites
  //    publish a complete Recipe in ld+json; if it is there, use it and
  //    skip the AI call entirely.
  let recipe = extractRecipeFromJsonLd(html);

  // 2. Fall back to the AI path for plain blog pages.
  if (!recipe) {
    let pageText = stripHtml(html);
    if (pageText.length > 20000) pageText = pageText.substring(0, 20000);
    if (pageText.length < 50) return fail(400, 'Page appears to be empty or blocked.');

    // The caller's budget is only spent when a model is really needed.
    if (beforeAi && !(await beforeAi())) return fail(429, 'Daily import limit reached.');

    const prompt = `Output ONLY a JSON object (no markdown, no reasoning) with the recipe extracted from this webpage. Pick the best mealType: breakfast, lunch, dinner, dessert, snack, or drink. If no recipe is found, output {"error":"no recipe found"}.

{"title":"","description":"","ingredients":[],"instructions":[],"prepTime":"","cookTime":"","servings":"","tags":[],"notes":"","mealType":"dinner"}

WEBPAGE TEXT:
${pageText}`;

    let content;
    try {
      content = await chat({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 3500,
        reasoningEffort: 'none',
      });
    } catch (e) {
      console.error('AI error during URL import:', e.message);
      return fail(500, 'The recipe could not be read. Try again later.');
    }

    recipe = tryParseJson(content);
    if (!recipe) return fail(500, 'AI returned invalid JSON');
    if (recipe.error) return fail(400, recipe.error);
  }

  // JSON-LD and AI output both land here: cap lengths and strip markup before
  // anything is stored or echoed back.
  recipe = normalizeIncomingRecipe(recipe);

  // Never save an empty shell; the JSON-LD path already guarantees both.
  if (!isUsableRecipe(recipe)) return fail(400, 'Could not find a recipe on that page.');

  try {
    const title = String(recipe.title).slice(0, 200);

    // Duplicate check and photo lookup run at the same time to keep imports fast
    const [dup, image] = await Promise.all([
      findDuplicate(kv, { title, sourceUrl: parsedUrl.toString() }),
      findImage(title, { kv }),
    ]);
    if (dup) return fail(409, `"${dup.title}" is already in your chest.`, { duplicate: dup });

    const id = 'r_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const finalRecipe = {
      id,
      title,
      description: String(recipe.description || '').slice(0, 500),
      ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.slice(0, 60).map(String) : [],
      instructions: Array.isArray(recipe.instructions) ? recipe.instructions.slice(0, 60).map(String) : [],
      prepTime: String(recipe.prepTime || ''),
      cookTime: String(recipe.cookTime || ''),
      servings: String(recipe.servings || ''),
      tags: cleanTags(recipe.tags, 10),
      notes: String(recipe.notes || '').slice(0, 1000),
      mealType: normalizeMealType(recipe.mealType),
      sourceUrl: parsedUrl.toString(),
      ...(image ? { image } : {}),
      createdAt: Date.now(),
      addedBy: String(addedBy || 'Anonymous').slice(0, 40),
    };

    await saveRecipeRecord(kv, finalRecipe);
    await listRecipeId(kv, id);
    return { ok: true, recipe: finalRecipe };
  } catch (error) {
    console.error('URL import save failed:', error && error.message);
    return fail(500, 'Failed to import that page.', { cause: error });
  }
}
