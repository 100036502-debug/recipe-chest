import test from 'node:test';
import assert from 'node:assert';

import { loadClientUtils } from './helpers/load-client.js';

// Everything here runs against js/utils.js exactly as the browser loads it.
const RC = loadClientUtils();

test('js/utils.js assigns one global and nothing else', () => {
  assert.deepStrictEqual(
    Object.keys(RC).sort(),
    ['formatQty', 'normalizeIngredientName', 'parseIngredientLine'],
  );
});

test('parseIngredientLine reads quantities, units and names', () => {
  const cases = [
    ['2 cups flour', { qty: 2, unit: 'cup', name: 'flour' }],
    ['1 1/2 tsp salt', { qty: 1.5, unit: 'tsp', name: 'salt' }],
    ['1½ cups milk', { qty: 1.5, unit: 'cup', name: 'milk' }],
    ['½ cup sugar', { qty: 0.5, unit: 'cup', name: 'sugar' }],
    ['3/4 lb ground beef', { qty: 0.75, unit: 'lb', name: 'ground beef' }],
    ['2-3 cloves garlic', { qty: 2, unit: 'clove', name: 'garlic' }],
    ['2 to 3 tablespoons olive oil', { qty: 2, unit: 'tbsp', name: 'olive oil' }],
    ['a pinch of salt', { qty: null, unit: 'pinch', name: 'salt' }],
    ['an ounce of butter', { qty: null, unit: 'oz', name: 'butter' }],
    ['3 eggs', { qty: 3, unit: '', name: 'eggs' }],
    ['1 kilogram potatoes', { qty: 1, unit: 'kg', name: 'potatoes' }],
    ['2 cups flour, sifted', { qty: 2, unit: 'cup', name: 'flour' }],
    ['1 l stock', { qty: 1, unit: 'l', name: 'stock' }],
  ];
  for (const [line, expected] of cases) {
    const got = RC.parseIngredientLine(line);
    assert.strictEqual(got.qty, expected.qty, `qty for ${line}`);
    assert.strictEqual(got.unit, expected.unit, `unit for ${line}`);
    assert.strictEqual(got.name, expected.name, `name for ${line}`);
    assert.strictEqual(got.raw, line, `raw for ${line}`);
  }
});

test('parseIngredientLine copes with empty and unit-only input', () => {
  // The object comes from the vm realm, so compare fields, not prototypes.
  const empty = RC.parseIngredientLine('');
  assert.strictEqual(empty.qty, null);
  assert.strictEqual(empty.unit, '');
  assert.strictEqual(empty.name, '');
  assert.strictEqual(empty.raw, '');
  assert.strictEqual(RC.parseIngredientLine(null).qty, null);
  const salt = RC.parseIngredientLine('Salt');
  assert.strictEqual(salt.qty, null);
  assert.strictEqual(salt.name, 'Salt');
});

test('parseIngredientLine prefers the lower number in a range', () => {
  assert.strictEqual(RC.parseIngredientLine('2–3 cloves garlic').qty, 2);
  assert.strictEqual(RC.parseIngredientLine('4 to 6 slices bread').qty, 4);
});

test('formatQty rounds to a common fraction within the inherited tolerance', () => {
  // js/app.js used a 0.03 window around each common fraction. Kept as-is so
  // scaled ingredients render exactly as they always have; 0.1 therefore
  // reads as 1/8 rather than 0.1.
  assert.strictEqual(RC.formatQty(0.1), '1/8');
  assert.strictEqual(RC.formatQty(0.5), '1/2');
});

test('formatQty renders whole numbers and common fractions', () => {
  assert.strictEqual(RC.formatQty(2), '2');
  assert.strictEqual(RC.formatQty(1.5), '1 1/2');
  assert.strictEqual(RC.formatQty(2.5), '2 1/2');
  assert.strictEqual(RC.formatQty(0.25), '1/4');
  assert.strictEqual(RC.formatQty(0.75), '3/4');
  assert.strictEqual(RC.formatQty(1 / 3), '1/3');
  assert.strictEqual(RC.formatQty(2.25), '2 1/4');
  assert.strictEqual(RC.formatQty(0.2), '0.2');
  assert.strictEqual(RC.formatQty(0), '');
  assert.strictEqual(RC.formatQty(-1), '');
  assert.strictEqual(RC.formatQty(NaN), '');
});

test('normalizeIngredientName strips prep words, parentheses and plurals', () => {
  const cases = [
    ['Fresh ripe tomatoes (drained)', 'tomato'],
    ['Chopped fresh basil', 'basil'],
    ['Onions', 'onion'],
    ['Berries', 'berry'],
    ['Leaves', 'leaf'],
    ['Asparagus', 'asparagus'],
    ['Grass', 'grass'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(RC.normalizeIngredientName(input), expected, `normalize ${input}`);
  }
});

test('normalizeIngredientName applies the synonym map', () => {
  const cases = [
    ['Scallions', 'green onion'],
    ['Coriander leaves', 'cilantro leaf'],
    ['Garbanzo beans', 'chickpea'],
    ['Courgette', 'zucchini'],
    ['Aubergine', 'eggplant'],
    ['Caster sugar', 'sugar'],
    ['Confectioners sugar', 'powdered sugar'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(RC.normalizeIngredientName(input), expected, `normalize ${input}`);
  }
});

test('normalizeIngredientName is safe on empty input', () => {
  assert.strictEqual(RC.normalizeIngredientName(''), '');
  assert.strictEqual(RC.normalizeIngredientName(null), '');
  assert.strictEqual(RC.normalizeIngredientName('   '), '');
});

test('loading the client utils does not need a DOM', () => {
  // The loader uses a bare vm context; if utils.js touched document or window
  // at load, this whole file would already have thrown.
  assert.strictEqual(typeof RC.parseIngredientLine, 'function');
});
