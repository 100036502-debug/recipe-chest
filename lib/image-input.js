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

// ---- Decoding limits -------------------------------------------------------
// A tiny file can claim an enormous canvas ("decompression bomb"), and sharp
// will happily allocate it. 25 megapixels is far more than any phone photo the
// app needs and keeps the worst case bounded.
export const MAX_INPUT_PIXELS = 25_000_000;

export function isImageTooLarge(err) {
  return /exceeds pixel limit|limitinputpixels|pixel limit|too large/i.test(String((err && err.message) || ''));
}

/**
 * Rotate, fit inside a box, re-encode as JPEG. `engine` is injectable so the
 * limits and the error mapping can be tested without a real decoder.
 */
export async function resizeImage(input, { width, height, quality }, engine) {
  const decode = engine || (await import('sharp')).default;
  try {
    return await decode(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width, height, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
  } catch (err) {
    if (isImageTooLarge(err)) {
      const tooBig = new Error('Image too large');
      tooBig.status = 400;
      tooBig.code = 'IMAGE_TOO_LARGE';
      throw tooBig;
    }
    throw err;
  }
}
