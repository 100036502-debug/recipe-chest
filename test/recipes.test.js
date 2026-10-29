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

// ---- collections and cookLog (task 6) ----
import { cleanCollections, cleanCookLog, ID_PATTERN } from '../lib/recipes.js';

test('cleanCollections trims, caps, dedupes case-insensitively and strips markup', () => {
  const out = cleanCollections(['  Weeknight ', 'weeknight', 'WEEKNIGHT', 'Baking', '<b>fast</b>', '', '   ']);
  assert.deepStrictEqual(out, ['Weeknight', 'Baking', 'fast']);

  // 40 characters each
  const long = cleanCollections(['x'.repeat(80)]);
  assert.equal(long[0].length, 40);

  // at most 10
  const many = cleanCollections(Array.from({ length: 25 }, (_, i) => 'c' + i));
  assert.equal(many.length, 10);

  // a comma-separated string works, and junk yields []
  assert.deepStrictEqual(cleanCollections('a, b , a'), ['a', 'b']);
  assert.deepStrictEqual(cleanCollections(null), []);
  assert.deepStrictEqual(cleanCollections({}), []);
});

test('cleanCookLog keeps good entries and drops impossible ones', () => {
  const out = cleanCookLog([
    { id: 'c_1', date: '2025-03-01', rating: 4, note: 'Lovely', by: 'Sam' },
    { date: '2025-02-30' },          // not a real date
    { date: '2025-13-01' },          // month 13
    { date: '01/02/2025' },          // wrong format
    { date: '' },
    null,
    'nope',
  ]);
  assert.equal(out.length, 1);
  assert.deepStrictEqual(out[0], { id: 'c_1', date: '2025-03-01', rating: 4, note: 'Lovely', by: 'Sam' });
});

test('cleanCookLog clamps ratings to 1-5 or null', () => {
  const out = cleanCookLog([
    { date: '2025-01-01', rating: 0 },
    { date: '2025-01-02', rating: 6 },
    { date: '2025-01-03', rating: 2.5 },
    { date: '2025-01-04', rating: '3' },
    { date: '2025-01-05', rating: 5 },
  ]);
  assert.deepStrictEqual(out.map((e) => e.rating), [null, null, null, 3, 5]);
});

test('cleanCookLog generates a usable id when one is missing or bad', () => {
  const out = cleanCookLog([{ date: '2025-01-01' }, { id: 'has spaces!', date: '2025-01-02' }]);
  assert.equal(out.length, 2);
  for (const entry of out) assert.match(entry.id, ID_PATTERN);
  assert.notEqual(out[0].id, out[1].id);
});

test('cleanCookLog trims note and by, strips markup and caps length', () => {
  const [entry] = cleanCookLog([{
    date: '2025-01-01',
    note: '<b>Great</b> with ' + 'x'.repeat(400),
    by: 'y'.repeat(80),
  }]);
  assert.equal(entry.note.length, 300);
  assert.ok(entry.note.startsWith('Great with'));
  assert.ok(!entry.note.includes('<'));
  assert.equal(entry.by.length, 40);
  assert.deepStrictEqual(cleanCookLog('nope'), []);
});

test('cleanCookLog keeps the newest 50 in their original order', () => {
  const many = Array.from({ length: 55 }, (_, i) => {
    const d = new Date(Date.UTC(2024, 0, 1 + i));
    return { date: d.toISOString().slice(0, 10), note: 'n' + i };
  });
  const kept = cleanCookLog(many);
  assert.equal(kept.length, 50);
  assert.ok(!kept.some((e) => e.date === '2024-01-01'), 'oldest dropped');
  assert.ok(kept.some((e) => e.date === '2024-02-24'), 'newest kept');
  const dates = kept.map((e) => e.date);
  assert.deepStrictEqual(dates, [...dates].sort(), 'order preserved');
});

test('sanitizeStoredRecipe carries collections and cookLog through a round trip', () => {
  const input = {
    id: 'r_9', title: 'Soup',
    collections: ['Weeknight', 'weeknight'],
    cookLog: [{ id: 'c_9', date: '2025-05-05', rating: 5, note: 'again', by: 'Sam' }],
  };
  const clean = sanitizeStoredRecipe(input);
  assert.deepStrictEqual(clean.collections, ['Weeknight']);
  assert.equal(clean.cookLog.length, 1);
  assert.equal(clean.cookLog[0].rating, 5);

  // a backup from before these fields existed still restores
  const old = sanitizeStoredRecipe({ id: 'r_10', title: 'Older', tags: ['soup'] });
  assert.deepStrictEqual(old.collections, []);
  assert.deepStrictEqual(old.cookLog, []);
});

test('applyEditableFields accepts collections but never cookLog', async () => {
  // Dummy env so importing the route does not warn about a missing token.
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const { applyEditableFields } = await import('../api/recipes.js');

  const existing = {
    id: 'r_11', title: 'Stew',
    collections: ['Old'],
    cookLog: [{ id: 'c_11', date: '2025-01-01', rating: 4, note: '', by: '' }],
  };
  const patched = applyEditableFields({ ...existing }, {
    collections: ['New', 'new', '<i>x</i>'],
    cookLog: [{ id: 'c_evil', date: '2030-01-01', rating: 1, note: 'injected', by: 'x' }],
    title: 'Stew 2',
  });

  assert.deepStrictEqual(patched.collections, ['New', 'x']);
  assert.equal(patched.title, 'Stew 2');
  // The injected history is ignored and the stored one survives untouched.
  assert.deepStrictEqual(patched.cookLog, existing.cookLog);
});
