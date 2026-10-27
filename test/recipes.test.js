import { test } from 'node:test';
import assert from 'node:assert';
import { cleanTags, normalizeTitle, normalizeMealType, isUsableRecipe, sanitizeStoredRecipe } from '../lib/recipes.js';

test('cleanTags dedupes, strips angle brackets, caps length and count', () => {
  assert.deepEqual(cleanTags(['Soup', 'soup', '<script>x</script>', '  a  b  ']), ['soup', 'scriptx/script', 'a b']);
  assert.deepEqual(cleanTags(['x'.repeat(50)]), ['x'.repeat(40)]);
  assert.deepEqual(cleanTags(Array.from({ length: 15 }, (_, i) => 'tag' + i), 10).length, 10);
  assert.deepEqual(cleanTags('one, two;three'), ['one', 'two', 'three']);
  assert.deepEqual(cleanTags('no-tags'), ['no-tags']);
  assert.deepEqual(cleanTags(undefined), []);
});

test('normalizeTitle handles accents, non-Latin scripts and punctuation', () => {
  assert.equal(normalizeTitle('Crème Brûlée'), normalizeTitle('creme brulee'));
  assert.equal(normalizeTitle('Bœuf à la Bourguignonne!'), normalizeTitle('bœuf à la bourguignonne')); // ligature kept
  assert.equal(normalizeTitle('Pâté aux Herbes'), 'pate aux herbes');
  assert.notEqual(normalizeTitle('борщ'), ''); // non-Latin is kept, not emptied
  assert.equal(normalizeTitle('Chicken & (gravy)'), 'chicken gravy');
  assert.equal(normalizeTitle('  Multiple   spaces  '), 'multiple spaces');
  assert.equal(normalizeTitle(null), '');
});

test('normalizeMealType matches by substring with a default fallback', () => {
  assert.equal(normalizeMealType('Breakfast'), 'breakfast');
  assert.equal(normalizeMealType('DESSERT'), 'dessert');
  assert.equal(normalizeMealType('late-night snack'), 'snack');
  assert.equal(normalizeMealType('whatever'), 'default');
  assert.equal(normalizeMealType(undefined), 'default');
});

test('isUsableRecipe rejects junk the AI might return', () => {
  assert.equal(isUsableRecipe({}), false); // empty object
  assert.equal(isUsableRecipe({ title: 'Only a title' }), false); // nothing to cook
  assert.equal(isUsableRecipe({ error: 'no recipe found' }), false);
  assert.equal(isUsableRecipe(null), false);
  assert.equal(isUsableRecipe('string'), false);
  assert.equal(isUsableRecipe({ title: 'Pancakes', ingredients: ['1 cup flour'] }), true);
  assert.equal(isUsableRecipe({ title: 'Pancakes', instructions: ['Mix'] }), true); // steps alone are enough
});

test("sanitizeStoredRecipe cleans untrusted backup data", () => {
  // javascript: sourceUrl removed
  const r1 = sanitizeStoredRecipe({ id: "r_1", title: "T", sourceUrl: "javascript:alert(1)" });
  assert.equal(r1.sourceUrl, "");
  assert.equal(sanitizeStoredRecipe({ id: "r_1", title: "T", sourceUrl: "https://ok.example/p" }).sourceUrl, "https://ok.example/p");

  // non-Unsplash image dropped entirely
  const r2 = sanitizeStoredRecipe({ id: "r_2", title: "T", image: { url: "https://evil.example/x.jpg" } });
  assert.equal("image" in r2, false);
  const r2b = sanitizeStoredRecipe({ id: "r_2", title: "T", image: { url: "http://images.unsplash.com/x.jpg" } }); // http not https
  assert.equal("image" in r2b, false);
  const goodImg = sanitizeStoredRecipe({ id: "r_2", title: "T",
    image: { url: "https://images.unsplash.com/x.jpg", photographerUrl: "javascript:alert(2)", photoUrl: "https://unsplash.com/photos/x" } });
  assert.ok(goodImg.image.url.startsWith("https://images.unsplash.com"));
  assert.equal(goodImg.image.photographerUrl, ""); // javascript: photographer link removed
  assert.ok(goodImg.image.photoUrl.startsWith("https://unsplash.com"));

  // tags with angle brackets cleaned
  const r3 = sanitizeStoredRecipe({ id: "r_3", title: "T", tags: ["<b>dinner</b>"] });
  assert.deepEqual(r3.tags, ["bdinner/b"]);

  // unknown fields dropped, userPhoto never copied
  const r4 = sanitizeStoredRecipe({ id: "r_4", title: "T", injected: "x", userPhoto: { updatedAt: 1 } });
  assert.equal("injected" in r4, false);
  assert.equal("userPhoto" in r4, false);

  // bad id rejected, missing title rejected
  assert.equal(sanitizeStoredRecipe({ id: "bad id!", title: "T" }), null);
  assert.equal(sanitizeStoredRecipe({ id: "r_5", title: " " }), null);
});

test('sanitizeStoredRecipe never emits a 0 (1970) date', () => {
  const restored = sanitizeStoredRecipe({ id: 'r_1', title: 'X', createdAt: null });
  // No createdAt of 0; the restore path assigns a real timestamp when absent
  assert.notEqual(restored.createdAt, 0);
  assert.ok(!('createdAt' in restored)); // dropped, so import-backup sets Date.now()
  assert.ok(!('updatedAt' in restored)); // undefined date dropped too
  const real = sanitizeStoredRecipe({ id: 'r_2', title: 'X', createdAt: 1729000000000, updatedAt: 1729000000001 });
  assert.equal(real.createdAt, 1729000000000);
  assert.equal(real.updatedAt, 1729000000001);
});
