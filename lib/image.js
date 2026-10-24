// Looks up a free-to-use photo of a dish on Pexels.
// Never throws: any failure (no key, timeout, no match) just returns null,
// so an image problem can never block a recipe import.

const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search';

function buildQuery(title) {
  const cleaned = String(title || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(recipe|easy|best|quick|simple|homemade|the)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? `${cleaned} food` : '';
}

function isPexelsUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && (x.hostname === 'pexels.com' || x.hostname.endsWith('.pexels.com'));
  } catch {
    return false;
  }
}

export async function findDishImage(title, { timeoutMs = 3000 } = {}) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return null;

  const query = buildQuery(title);
  if (!query) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `${PEXELS_SEARCH_URL}?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`,
      { headers: { Authorization: apiKey }, signal: controller.signal }
    );
    if (!res.ok) {
      console.warn('Pexels lookup failed with status', res.status);
      return null;
    }

    const data = await res.json();
    const photo = (data.photos || []).find(
      (p) => p && p.src && isPexelsUrl(p.src.large) && isPexelsUrl(p.url)
    );
    if (!photo) return null;

    return {
      url: photo.src.large,
      thumb: isPexelsUrl(photo.src.medium) ? photo.src.medium : photo.src.large,
      photographer: String(photo.photographer || '').slice(0, 80),
      photographerUrl: isPexelsUrl(photo.photographer_url) ? photo.photographer_url : '',
      photoUrl: photo.url,
      source: 'Pexels',
    };
  } catch (e) {
    console.warn('Pexels lookup skipped:', e.name === 'AbortError' ? 'timed out' : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
