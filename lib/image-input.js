// One place to decide whether an image body is acceptable, so the legacy
// single-image body and the multi-photo body cannot drift apart.

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGES = 3;
// Roughly 2.6 MB of raw bytes, which keeps a three-page import under Vercel's
// 4 MB request ceiling once base64 padding and JSON overhead are added.
const MAX_BASE64_TOTAL = 3500000;

function clean(item) {
  const base64 = item && typeof item.imageBase64 === 'string' ? item.imageBase64 : '';
  const mimeType = String((item && item.mimeType) || '');
  if (!base64) return { error: 'One of the images is empty' };
  if (!ALLOWED.includes(mimeType)) return { error: 'Unsupported image type. Use JPEG, PNG or WebP.' };
  return { image: { imageBase64: base64, mimeType } };
}

export function validateImageBody(body) {
  const b = body || {};

  // The original single-image body must keep working exactly as before.
  if (typeof b.imageBase64 === 'string' && b.imageBase64) {
    const one = clean({ imageBase64: b.imageBase64, mimeType: b.mimeType });
    if (one.error) return one;
    if (one.image.imageBase64.length > MAX_BASE64_TOTAL) return { error: 'That image is too large.' };
    return { images: [one.image] };
  }

  const list = Array.isArray(b.images) ? b.images : null;
  if (!list || !list.length) return { error: 'No image provided' };
  if (list.length > MAX_IMAGES) return { error: `At most ${MAX_IMAGES} photos can be combined into one recipe.` };

  const images = [];
  let total = 0;
  for (const item of list) {
    const one = clean(item);
    if (one.error) return one;
    total += one.image.imageBase64.length;
    images.push(one.image);
  }
  if (total > MAX_BASE64_TOTAL) return { error: 'Those photos are too large together. Use fewer or smaller images.' };
  return { images };
}

export const IMAGE_LIMITS = { ALLOWED, MAX_IMAGES, MAX_BASE64_TOTAL };
