import { test } from 'node:test';
import assert from 'node:assert';
import { cleanTags, normalizeTitle, normalizeMealType, isUsableRecipe } from '../lib/recipes.js';

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
