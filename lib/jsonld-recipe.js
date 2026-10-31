// Extracts a recipe from a page's schema.org JSON-LD markup
// (<script type="application/ld+json"> with "@type": "Recipe").
// Most recipe sites publish a complete, accurate recipe this way.
import { cleanTags, cleanText, normalizeMealType } from './recipes.js';

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    })
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

// "PT1H30M" -> "1 hour 30 minutes", "P1DT2H" -> "1 day 2 hours"
export function isoDurationToText(iso) {
  const m = /^P(?!$)(?:(\d+(?:\.\d+)?)D)?(?:T(?!$)(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:([\d.]+)S)?)?$/.exec(String(iso || '').trim());
  if (!m) return '';
  const parts = [];
  if (m[1]) parts.push(`${m[1]} day${m[1] !== '1' ? 's' : ''}`);
  if (m[2]) parts.push(`${m[2]} hour${m[2] !== '1' ? 's' : ''}`);
  if (m[3]) parts.push(`${m[3]} minute${m[3] !== '1' ? 's' : ''}`);
  if (m[4] && parseFloat(m[4]) >= 1) parts.push(`${Math.round(parseFloat(m[4]))} seconds`);
  return parts.join(' ');
}

// Entities are decoded first (so &lt;script&gt; becomes a real tag), then any
// markup is stripped and the text is capped: this is where untrusted page data
// enters the recipe object.
const asText = (v) => cleanText(decodeEntities(typeof v === 'string' ? v : (v && v.name) || ''), 1000);
const firstOr = (v) => (Array.isArray(v) ? v[0] : v);

// Flattens recipeInstructions: string | string[] | HowToStep[] | HowToSection[]
export function instructionsToList(raw) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'string') {
      const t = decodeEntities(node).trim();
      if (t) out.push(t);
      return;
    }
    if (typeof node !== 'object') return;
    if (typeof node.text === 'string' || typeof node.name === 'string') {
      const t = decodeEntities(node.text || node.name).trim();
      if (t) out.push(t);
      return;
    }
    if (Array.isArray(node.itemListElement)) node.itemListElement.forEach(walk);
  };
  walk(raw);
  return out;
}

function findRecipeNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  const types = node['@type'];
  const typeList = Array.isArray(types) ? types : (types ? [types] : []);
  if (typeList.some((t) => String(t).toLowerCase() === 'recipe')) return node;
  if (Array.isArray(node['@graph'])) {
    for (const item of node['@graph']) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Maps a schema.org Recipe node to the app's recipe shape.
 * Returns null when there is no title or no ingredients. The page's own
 * image URL is deliberately NOT used (it is copyrighted); photos still
 * come from Unsplash.
 */
export function recipeFromJsonLd(node) {
  if (!node) return null;

  const title = asText(node.name);
  const ingredients = (Array.isArray(node.recipeIngredient) ? node.recipeIngredient : [])
    .map((i) => asText(i)) // decode, strip markup, cap
    .filter(Boolean);
  if (!title || !ingredients.length) return null;

  const instructions = instructionsToList(node.recipeInstructions)
    .map((step) => asText(step))
    .filter(Boolean);

  const servings = asText(firstOr(node.recipeYield));

  const keywords = Array.isArray(node.keywords) ? node.keywords.join(', ') : String(node.keywords || '');
  const categories = Array.isArray(node.recipeCategory) ? node.recipeCategory.join(', ') : String(node.recipeCategory || '');
  const tags = cleanTags(
    [...keywords.split(/[,;]/), ...categories.split(/[,;]/)].map((t) => t.trim()).filter(Boolean),
    10
  );

  const notesBits = [];
  if (node.recipeCuisine) notesBits.push(`Cuisine: ${asText(node.recipeCuisine)}.`);
  if (node.author) notesBits.push(`From ${asText(node.author)}.`);

  return {
    title: title.slice(0, 200),
    description: asText(node.description).slice(0, 500),
    ingredients: ingredients.slice(0, 60),
    instructions: instructions.slice(0, 60),
    prepTime: isoDurationToText(node.prepTime).slice(0, 40),
    cookTime: isoDurationToText(node.cookTime).slice(0, 40),
    servings: servings.slice(0, 40),
    tags,
    notes: asText(notesBits.join(' ')),
    mealType: normalizeMealType(categories),
  };
}

// Entry point: pass the raw HTML, get a recipe object (or null).
export function extractRecipeFromJsonLd(html) {
  const blocks = String(html || '').match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  ) || [];

  for (const block of blocks) {
    const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '').trim();
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }
    const recipe = recipeFromJsonLd(findRecipeNode(data));
    if (recipe) return recipe;
  }
  return null;
}
