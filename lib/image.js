// Looks up a photo of a dish on Unsplash.
// Never throws: any failure (no key, timeout, rate limit, no match) just returns null,
// so an image problem can never block a recipe import.
//
// Unsplash API rules this follows:
//  - photos are hotlinked from the URLs Unsplash returns (never re-hosted)
//  - the photographer and Unsplash are credited with links carrying utm parameters
//  - the "download" endpoint is pinged when a photo is picked for a recipe

const UNSPLASH_SEARCH_URL = 'https://api.unsplash.com/search/photos';
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

export async function findDishImage(title, { timeoutMs = 3000 } = {}) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) return null;

  const query = buildQuery(title);
  if (!query) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let photo = null;
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
      return null;
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
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!photo) return null;

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

  await trackUse(image.downloadLocation, accessKey);
  return image;
}
