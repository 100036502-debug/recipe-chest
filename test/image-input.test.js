import test from 'node:test';
import assert from 'node:assert';

import { validateImageBody } from '../lib/image-input.js';

const jpg = 'a'.repeat(1000);

test('a legacy single image still works', () => {
  const out = validateImageBody({ imageBase64: jpg, mimeType: 'image/jpeg' });
  assert.equal(out.images.length, 1);
  assert.equal(out.error, undefined);
});

test('a batch of three is accepted', () => {
  const out = validateImageBody({ images: [1, 2, 3].map(() => ({ imageBase64: jpg, mimeType: 'image/png' })) });
  assert.equal(out.images.length, 3);
});

test('four photos are refused', () => {
  const out = validateImageBody({ images: [1, 2, 3, 4].map(() => ({ imageBase64: jpg, mimeType: 'image/png' })) });
  assert.match(out.error, /At most 3/);
});

test('an unsupported type is refused', () => {
  assert.ok(validateImageBody({ images: [{ imageBase64: jpg, mimeType: 'image/gif' }] }).error);
  assert.ok(validateImageBody({ imageBase64: jpg, mimeType: 'application/pdf' }).error);
});

test('empty bodies are refused', () => {
  assert.ok(validateImageBody({}).error);
  assert.ok(validateImageBody({ images: [] }).error);
  assert.ok(validateImageBody(null).error);
  assert.ok(validateImageBody({ images: [{ imageBase64: '', mimeType: 'image/png' }] }).error);
});

test('the combined size is capped', () => {
  const big = 'a'.repeat(2000000);
  const out = validateImageBody({ images: [{ imageBase64: big, mimeType: 'image/png' }, { imageBase64: big, mimeType: 'image/png' }] });
  assert.match(out.error, /too large/);
});
