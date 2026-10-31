import test from 'node:test';
import assert from 'node:assert';

import { parsePdfText, PdfUnreadable, MAX_PDF_PAGES } from '../lib/pdf-text.js';
import { resizeImage, isImageTooLarge, MAX_INPUT_PIXELS } from '../lib/image-input.js';
import { fetchWithTimeout, GroqTimeout, GROQ_TIMEOUT_MS } from '../lib/groq.js';

// ---- PDFs --------------------------------------------------------------

test('a PDF is parsed with the page cap', async () => {
  const calls = [];
  const text = await parsePdfText(Buffer.from('%PDF-1.4'), {
    parse: async (buffer, options) => { calls.push({ buffer: buffer.length, options }); return { text: '  Flour, water  ' }; },
  });
  assert.equal(text, 'Flour, water');
  assert.deepEqual(calls[0].options, { max: MAX_PDF_PAGES });
  assert.equal(MAX_PDF_PAGES, 10);
});

test('a PDF with no text is a clean user error', async () => {
  await assert.rejects(
    () => parsePdfText(Buffer.from('%PDF'), { parse: async () => ({ text: '   ' }) }),
    (err) => err instanceof PdfUnreadable && /No readable text/.test(err.message),
  );
});

test('a PDF that never finishes is cut off by the timeout', async () => {
  const slow = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(
    () => parsePdfText(Buffer.from('%PDF'), { parse: slow, timeoutMs: 40 }),
    (err) => err instanceof PdfUnreadable && /took too long/.test(err.message),
  );
  assert.ok(Date.now() - started < 2000, 'it gave up quickly');
});

test('a parser crash keeps its own error, it is not relabelled', async () => {
  const boom = new Error('Invalid PDF structure');
  await assert.rejects(
    () => parsePdfText(Buffer.from('%PDF'), { parse: async () => { throw boom; } }),
    (err) => err === boom,
  );
});

// ---- Images ------------------------------------------------------------

test('the decoder is called with a pixel limit', async () => {
  const seen = [];
  const engine = (input, options) => {
    seen.push(options);
    const chain = {
      rotate: () => chain,
      resize: (opts) => { seen.push(opts); return chain; },
      jpeg: () => chain,
      toBuffer: async () => Buffer.from('jpeg'),
    };
    return chain;
  };

  const out = await resizeImage(Buffer.from('raw'), { width: 400, height: 400, quality: 75 }, engine);
  assert.equal(out.toString(), 'jpeg');
  assert.deepEqual(seen[0], { limitInputPixels: MAX_INPUT_PIXELS });
  assert.equal(MAX_INPUT_PIXELS, 25_000_000);
  assert.deepEqual(seen[1], { width: 400, height: 400, fit: 'inside', withoutEnlargement: true });
});

test('a decompression bomb becomes a clean 400', async () => {
  const engine = () => { throw new Error('Input image exceeds pixel limit'); };
  await assert.rejects(
    () => resizeImage(Buffer.from('raw'), { width: 10, height: 10, quality: 70 }, engine),
    (err) => err.code === 'IMAGE_TOO_LARGE' && err.status === 400 && err.message === 'Image too large',
  );
});

test('other decoder errors are passed through untouched', async () => {
  const boom = new Error('unsupported image format');
  const engine = () => { throw boom; };
  await assert.rejects(
    () => resizeImage(Buffer.from('raw'), { width: 10, height: 10, quality: 70 }, engine),
    (err) => err === boom,
  );
});

test('isImageTooLarge only matches the pixel limit message', () => {
  assert.equal(isImageTooLarge(new Error('Input image exceeds pixel limit')), true);
  assert.equal(isImageTooLarge(new Error('unsupported image format')), false);
  assert.equal(isImageTooLarge(null), false);
});

// ---- Groq --------------------------------------------------------------

test('a stalled AI call is abandoned at the timeout', async () => {
  const realFetch = globalThis.fetch;
  let passedSignal = null;
  globalThis.fetch = (url, options) => {
    passedSignal = options.signal;
    return new Promise(() => {}); // never settles, ignores the signal
  };
  try {
    await assert.rejects(
      () => fetchWithTimeout('https://example.test', { method: 'POST' }, 40),
      (err) => err instanceof GroqTimeout && err.status === 504,
    );
    assert.ok(passedSignal instanceof AbortSignal, 'the request carried an abort signal');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a fast AI call is untouched', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
  try {
    const res = await fetchWithTimeout('https://example.test', {}, 1000);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(GROQ_TIMEOUT_MS, 45_000);
});
