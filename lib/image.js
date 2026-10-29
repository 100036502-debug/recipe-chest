// Looks up a photo of a dish on Unsplash.
// Never throws: any failure (no key, timeout, rate limit, no match) just returns null,
// so an image problem can never block a recipe import.
//
// Unsplash API rules this follows:
//  - photos are hotlinked from the URLs Unsplash returns (never re-hosted)
//  - the photographer and Unsplash are credited with links carrying utm parameters
//  - the "download" endpoint is pinged when a photo is picked for a recipe

const UNSPLASH_SEARCH_URL = 'https://api.unsplash.com/search/photos';
const IMAGE_CACHE_TTL = 30 * 24 * 60 * 60; // a found photo: 30 days
const NONE_CACHE_TTL = 7 * 24 * 60 * 60; // a confirmed miss: 7 days
const APP_NAME = 'recipe_chest';

function buildQuery(title) {
  const cleaned = String(title || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(recipe|easy|best|quick|simple|homemade|the)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? `${cleaned} food` : '';
}

function hostIs(u, ...hosts) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && hosts.includes(x.hostname);
  } catch {
    return false;
  }
}

function withUtm(u) {
  try {
    const x = new URL(u);
    x.searchParams.set('utm_source', APP_NAME);
    x.searchParams.set('utm_medium', 'referral');
    return x.toString();
  } catch {
    return '';
  }
}

// Tells Unsplash the photo was chosen for use (required by their API guidelines).
async function trackUse(downloadLocation, accessKey, timeoutMs = 2000) {
  if (!hostIs(downloadLocation, 'api.unsplash.com')) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(downloadLocation, {
      headers: { Authorization: `Client-ID ${accessKey}`, 'Accept-Version': 'v1' },
      signal: controller.signal,
    });
  } catch (e) {
    console.warn('Unsplash download ping skipped:', e.name === 'AbortError' ? 'timed out' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns { image, status } where status is one of:
 *  'ok' (image found), 'none' (searched, nothing suitable), 'rate_limited',
 *  'error' (network/timeout/other), 'no_key'.
 */
// The cache key for a search. Two titles that differ only in case, accents or
// punctuation share one entry, which is the point: the demo quota is tiny.
function imageCacheKey(query) {
  const normalized = String(query || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // drop the accents the decomposition produced
    .replace(/['\u2019`]/g, '') // "chef's" and "chefs" are the same dish
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return normalized ? `imgcache:${normalized.slice(0, 120)}` : '';
}

async function readCache(kv, key) {
  if (!kv || !key) return null;
  try {
    return await kv.get(key);
  } catch {
    return null; // a cache that is down is a miss, never an error
  }
}

async function writeCache(kv, key, value, ttlSeconds) {
  if (!kv || !key) return;
  try {
    await kv.set(key, value, { ex: ttlSeconds });
  } catch { /* storing is best effort */ }
}

export async function lookupDishImage(title, { timeoutMs = 3000, kv = null } = {}) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) return { image: null, status: 'no_key' };

  const query = buildQuery(title);
  if (!query) return { image: null, status: 'none' };

  // A repeated (or similar) title should cost nothing: 50 demo requests an hour
  // is two imports' worth of searches.
  const cacheKey = imageCacheKey(query);
  const cached = await readCache(kv, cacheKey);
  if (cached && cached.none) return { image: null, status: 'none' };
  if (cached && cached.image && cached.image.url) {
    // Unsplash still wants the download ping when the photo is used again.
    await trackUse(cached.image.downloadLocation, accessKey);
    return { image: cached.image, status: 'ok' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let photo;
  try {
    const params = new URLSearchParams({
      query,
      per_page: '5',
      orientation: 'landscape',
      content_filter: 'high',
    });
    const res = await fetch(`${UNSPLASH_SEARCH_URL}?${params}`, {
      headers: { Authorization: `Client-ID ${accessKey}`, 'Accept-Version': 'v1' },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn('Unsplash lookup failed with status', res.status);
      const limited = res.status === 403 || res.status === 429;
      return { image: null, status: limited ? 'rate_limited' : 'error' };
    }

    const data = await res.json();
    photo = (data.results || []).find(
      (p) =>
        p &&
        p.urls &&
        hostIs(p.urls.regular, 'images.unsplash.com') &&
        hostIs(p.urls.small, 'images.unsplash.com') &&
        p.links &&
        hostIs(p.links.html, 'unsplash.com') &&
        hostIs(p.links.download_location, 'api.unsplash.com')
    ) || null;
  } catch (e) {
    console.warn('Unsplash lookup skipped:', e.name === 'AbortError' ? 'timed out' : e.message);
    return { image: null, status: 'error' };
  } finally {
    clearTimeout(timer);
  }

  if (!photo) {
    await writeCache(kv, cacheKey, { none: true }, NONE_CACHE_TTL);
    return { image: null, status: 'none' };
  }

  const user = photo.user || {};
  const image = {
    url: photo.urls.regular,
    thumb: photo.urls.small,
    alt: String(photo.alt_description || '').slice(0, 120),
    photographer: String(user.name || '').slice(0, 80),
    photographerUrl: user.links && hostIs(user.links.html, 'unsplash.com') ? withUtm(user.links.html) : '',
    photoUrl: withUtm(photo.links.html),
    downloadLocation: photo.links.download_location,
    source: 'Unsplash',
  };

  await writeCache(kv, cacheKey, { image }, IMAGE_CACHE_TTL);
  await trackUse(image.downloadLocation, accessKey);
  return { image, status: 'ok' };
}

export const __cacheKey = imageCacheKey;

// Simple version used by the import endpoints: the image, or null.
export async function findDishImage(title, options) {
  const { image } = await lookupDishImage(title, options);
  return image;
}
