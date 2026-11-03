// Finding the recipe links in an email.
//
// A mail is untrusted text from outside, and most of the links in a real one are
// not recipes: an unsubscribe link, a tracking pixel, a signature's social
// icons. Each link we follow costs a fetch and possibly an AI call, so this
// picks conservatively and caps the count; the fetcher still refuses private
// addresses on its own.

export const MAX_LINKS_PER_EMAIL = 3;
const MAX_LINK_CHARS = 2048;

// Hosts that are never a recipe page.
const SKIP_HOSTS = [
  'google.com', 'gstatic.com', 'googleusercontent.com', 'apple.com', 'microsoft.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'youtu.be',
  'list-manage.com', 'mailchimp.com', 'sendgrid.net', 'doubleclick.net',
];

// Paths that mean "not content".
const SKIP_PATH = /(unsubscribe|optout|opt-out|preferences|manage[-_]?subscription|privacy|terms|mailto|tracking|pixel|\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip)(\?|$))/i;

function hostMatches(host, list) {
  return list.some((h) => host === h || host.endsWith('.' + h));
}

// Characters that follow a link in prose but are not part of it.
function trimTrail(url) {
  return url.replace(/[)\]}>.,;:!?'"]+$/g, '');
}

function usable(raw) {
  // Over the cap means refuse, never cut: a clipped address is still a valid
  // address, and it would fetch some other page than the one that was sent.
  if (String(raw).length > MAX_LINK_CHARS) return '';
  let url;
  try { url = new URL(trimTrail(raw)); } catch { return ''; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return ''; // credentials in a link are never a recipe
  const host = url.hostname.toLowerCase();
  if (!host.includes('.')) return '';
  if (hostMatches(host, SKIP_HOSTS)) return '';
  if (SKIP_PATH.test(url.pathname + url.search)) return '';
  url.hash = '';
  return url.toString();
}

/**
 * Links worth importing, in the order they appear, without duplicates.
 * Reads both plain text and the href of HTML anchors.
 */
export function extractRecipeLinks(text, limit = MAX_LINKS_PER_EMAIL) {
  const source = String(text == null ? '' : text).slice(0, 200000);
  const found = [];
  const seen = new Set();
  const take = (raw) => {
    const url = usable(raw);
    if (!url || seen.has(url)) return;
    seen.add(url);
    found.push(url);
  };

  // Anchors first: in an HTML mail the visible text is often "click here".
  const hrefs = source.matchAll(/href\s*=\s*["']([^"'<>\s]{4,2049})["']/gi);
  for (const m of hrefs) take(m[1].replace(/&amp;/g, '&'));

  // Then any bare address in the text.
  const bare = source.matchAll(/https?:\/\/[^\s<>"'`]{4,2049}/gi);
  for (const m of bare) take(m[0].replace(/&amp;/g, '&'));

  return found.slice(0, Math.max(0, limit));
}

/**
 * True when a mail is, in effect, just a link: after taking out the links, the
 * greetings and the signature there is too little left to be a written recipe.
 * Such a mail should be read by following its link, not by asking a model to
 * make a recipe out of "Check this out!".
 */
export function isMostlyLinks(text) {
  const plain = String(text == null ? '' : text)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A real recipe has an ingredient list and steps: well over 200 characters.
  return plain.length < 200;
}

/**
 * True when the mail is nothing but a link and the small talk around it: no
 * measurements, no list, no steps. Stricter than isMostlyLinks, which only
 * counts characters. A short written recipe has quantities and cooking verbs;
 * "Check this out!" does not.
 */
export function bareOfProse(text) {
  const plain = String(text == null ? '' : text)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .toLowerCase();
  const quantity = /\b\d+(\.\d+)?\s*(g|kg|ml|l|cups?|tbsp|tsp|tablespoons?|teaspoons?|oz|lb|pounds?|slices?|cloves?|eggs?|min|minutes?|hours?)\b/;
  const verbs = /\b(mix|stir|bake|boil|fry|chop|slice|simmer|whisk|knead|roast|grill|preheat|combine|add|season|serve|toast|spread)\b/;
  return !(quantity.test(plain) || verbs.test(plain));
}
