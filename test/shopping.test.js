import test from 'node:test';
import assert from 'node:assert';

import { loadClientUtils } from './helpers/load-client.js';

const RC = loadClientUtils();

test('classifyAisle sends ingredients to the aisle you would walk to', () => {
  const cases = [
    ['1 onion', 'Produce'],
    ['bell pepper', 'Produce'],
    ['chicken breast', 'Meat & seafood'],
    ['ground beef', 'Meat & seafood'],
    ['salmon', 'Meat & seafood'],
    ['2 cups milk', 'Dairy & eggs'],
    ['greek yogurt', 'Dairy & eggs'],
    ['sourdough bread', 'Bakery'],
    ['frozen peas', 'Frozen'],
    ['ice cream', 'Frozen'],
    ['olive oil', 'Pantry'],
    ['500 g rice', 'Pantry'],
    ['black pepper', 'Spices & baking'],
    ['cinnamon', 'Spices & baking'],
    ['orange juice', 'Drinks'],
    ['birthday candles', 'Other'],
    ['', 'Other'],
  ];
  for (const [text, aisle] of cases) {
    assert.equal(RC.classifyAisle(text), aisle, text);
  }
});

test('classifyAisle prefers the longest keyword', () => {
  // "pepper" is a spice, "bell pepper" is produce.
  assert.equal(RC.classifyAisle('pepper'), 'Spices & baking');
  assert.equal(RC.classifyAisle('bell pepper'), 'Produce');
  // "cream" is dairy, "ice cream" is frozen.
  assert.equal(RC.classifyAisle('cream'), 'Dairy & eggs');
  assert.equal(RC.classifyAisle('vanilla ice cream'), 'Frozen');
});

test('mergeShoppingItems adds up the same unit', () => {
  const out = RC.mergeShoppingItems([{ text: '2 cups flour' }, { text: '1 cup flour' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '3 cup flour');
});

test('mergeShoppingItems converts inside the volume family', () => {
  const tsp = RC.mergeShoppingItems([{ text: '3 tsp salt' }, { text: '1 tbsp salt' }]);
  assert.equal(tsp[0].text, '2 tbsp salt');

  const cups = RC.mergeShoppingItems([{ text: '16 tbsp stock' }]);
  assert.equal(cups[0].text, '1 cup stock');
});

test('mergeShoppingItems keeps small volumes in the natural unit', () => {
  assert.equal(RC.mergeShoppingItems([{ text: '1 tsp salt' }])[0].text, '1 tsp salt');
  assert.equal(RC.mergeShoppingItems([{ text: '2 tbsp oil' }])[0].text, '2 tbsp oil');
});

test('mergeShoppingItems converts inside the imperial weight family', () => {
  const out = RC.mergeShoppingItems([{ text: '1 lb beef' }, { text: '8 oz beef' }]);
  assert.equal(out[0].text, '1 1/2 lb beef');
  assert.equal(RC.mergeShoppingItems([{ text: '8 oz beef' }])[0].text, '8 oz beef');
});

test('mergeShoppingItems converts inside the metric weight family', () => {
  const out = RC.mergeShoppingItems([{ text: '500 g rice' }, { text: '1 kg rice' }]);
  assert.equal(out[0].text, '1 1/2 kg rice');
  assert.equal(RC.mergeShoppingItems([{ text: '400 g rice' }])[0].text, '400 g rice');
});

test('mergeShoppingItems never mixes volume with weight', () => {
  const out = RC.mergeShoppingItems([{ text: '1 cup milk' }, { text: '200 g milk' }]);
  assert.equal(out.length, 2);
});

test('mergeShoppingItems never mixes imperial with metric', () => {
  const out = RC.mergeShoppingItems([{ text: '1 lb chicken' }, { text: '500 g chicken' }]);
  assert.equal(out.length, 2);
});

test('mergeShoppingItems joins items that have no quantity', () => {
  const out = RC.mergeShoppingItems([{ text: 'salt' }, { text: 'salt' }, { text: 'pepper' }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'salt');
});

test('mergeShoppingItems sums countable things', () => {
  const out = RC.mergeShoppingItems([{ text: '2 eggs' }, { text: '3 eggs' }]);
  assert.equal(out[0].text, '5 eggs');
});

test('mergeShoppingItems keeps clove, can and pinch apart unless identical', () => {
  const out = RC.mergeShoppingItems([
    { text: '2 cloves garlic' }, { text: '3 cloves garlic' }, { text: '1 can tomatoes' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, '5 clove garlic');
  assert.equal(out[1].text, '1 can tomatoes'); // keeps the first spelling
});

test('a merged item is checked only when every part was checked', () => {
  const all = RC.mergeShoppingItems([{ text: '2 cups flour', checked: true }, { text: '1 cup flour', checked: true }]);
  assert.equal(all[0].checked, true);

  const some = RC.mergeShoppingItems([{ text: '2 cups flour', checked: true }, { text: '1 cup flour', checked: false }]);
  assert.equal(some[0].checked, false);
});

test('mergeShoppingItems keeps different ingredients apart and in order', () => {
  const out = RC.mergeShoppingItems([{ text: '2 cups flour' }, { text: '1 onion' }, { text: '1 cup flour' }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, '3 cup flour');
  assert.equal(out[1].text, '1 onion');
});

test('mergeShoppingItems carries the recipeId of the first part through', () => {
  const out = RC.mergeShoppingItems([{ text: '2 cups flour', recipeId: 'r1' }, { text: '1 cup flour', recipeId: 'r2' }]);
  assert.equal(out[0].recipeId, 'r1');
});

test('mergeShoppingItems tolerates junk input', () => {
  assert.deepEqual(RC.mergeShoppingItems(null), []);
  assert.deepEqual(RC.mergeShoppingItems([]), []);
});
