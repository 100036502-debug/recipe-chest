// Recipes arrive in whatever language the page, photo, PDF or message used.
// The chest is kept in English, so every import prompt carries this one
// instruction: the model translates as it extracts, in the same call.
//
// Kept as a single shared string so the six import prompts cannot drift apart.
export const ENGLISH_ONLY = `Write every field in English, translating from whatever language the source is in. Translate the title, description, ingredients, instructions, notes and tags into natural English. Keep proper dish names, brand names and units as they are normally written (paella, kimchi, 200 g), and keep every number exact. If the source is already English, leave it alone. Never mention the translation and never add a note about the source language.`;

/**
 * Whether a parsed recipe still needs translating. Latin letters with accents
 * (á, ñ, ü, ç, ş) are a reliable, free signal for Spanish, French, German,
 * Portuguese, Italian and Turkish sources. A page that is already pure ASCII
 * English returns false, so the structured-data path stays free for it.
 */
export function needsEnglish(recipe) {
  if (!recipe || typeof recipe !== 'object') return false;
  const bits = [recipe.title, recipe.description, recipe.notes]
    .concat(recipe.ingredients || [], recipe.instructions || [], recipe.tags || []);
  const text = bits.filter((b) => typeof b === 'string' && b.trim()).join(' ');
  if (!text.trim()) return false;

  // Accented letters (á, ñ, ü, ç, ş) settle it on their own.
  // Anything outside plain ASCII covers every accented recipe text.
  if (/[^\p{ASCII}]/u.test(text)) return true;

  // Plain ASCII still needs a look, because unaccented Spanish and Italian are
  // ASCII: "Sopa de cebolla" has no accents at all. Compare a few very common
  // function words per language. An English marker means leave it alone, and a
  // foreign marker only counts when no English one is present.
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  if (words.length < 4) return false;
  const english = new Set(['the', 'and', 'with', 'of', 'in', 'to', 'until', 'then', 'into', 'over', 'for', 'add']);
  const foreign = new Set([
    'de', 'la', 'el', 'y', 'con', 'para', 'los', 'las', 'una', 'del', 'al', 'muy', 'sin',
    'le', 'les', 'des', 'du', 'et', 'avec', 'dans', 'pour',
    'der', 'die', 'das', 'und', 'mit', 'fur', 'den', 'im',
    'di', 'il', 'della', 'delle', 'e', 'per', 'nel',
    'da', 'do', 'dos', 'das', 'com', 'uma', 'nao',
    've', 'ile', 'bir', 'icin', 'kadar',
  ]);
  let en = 0;
  let other = 0;
  for (const w of words) {
    if (english.has(w)) en += 1;
    else if (foreign.has(w)) other += 1;
  }
  return other > 0 && en === 0;
}

export default ENGLISH_ONLY;
