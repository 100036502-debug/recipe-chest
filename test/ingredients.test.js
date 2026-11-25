import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import {
  ingredientToText, cleanIngredientList, normalizeIncomingRecipe, stripBrokenIngredients,
} from '../lib/recipes.js';

// A Gmail import of "Holiday Salad" stored 18 ingredients as the literal text
// "[object Object]": the model returned {amount, unit, name} objects and every
// path ran String() over them. These tests pin the shapes that broke it.

test('ingredient objects become the line a person would write', () => {
  assert.equal(ingredientToText({ amount: '2', unit: 'cups', name: 'flour' }), '2 cups flour');
  assert.equal(ingredientToText({ quantity: 1, item: 'red onion' }), '1 red onion');
  assert.equal(ingredientToText({ qty: '1/2', unit: 'tsp', ingredient: 'salt' }), '1/2 tsp salt');
  assert.equal(ingredientToText({ name: 'Fresh basil' }), 'Fresh basil');
  assert.equal(ingredientToText({ amount: 3, name: 'eggs' }), '3 eggs');
});

test('a shape nobody predicted is read, never printed as a type', () => {
  const line = ingredientToText({ foo: 'one bunch', bar: 'parsley' });
  assert.equal(line, 'one bunch parsley');
  assert.ok(!/\[object/i.test(line));
  // Nothing readable in it: empty, not "[object Object]".
  assert.equal(ingredientToText({}), '');
  assert.equal(ingredientToText({ nested: { deep: 1 } }), '');
});

test('plain strings, numbers and nulls are left alone', () => {
  assert.equal(ingredientToText('1 cup milk'), '1 cup milk');
  assert.equal(ingredientToText(2), '2');
  assert.equal(ingredientToText(null), '');
  assert.equal(ingredientToText(undefined), '');
});

test('cleanIngredientList cleans, caps and drops empties', () => {
  const list = cleanIngredientList([' 1 cup milk ', { amount: '2', unit: 'cups', name: 'flour' }, {}, 3]);
  assert.deepEqual(list, ['1 cup milk', '2 cups flour', '3']);
  assert.deepEqual(cleanIngredientList('not an array'), []);
  assert.equal(cleanIngredientList(new Array(200).fill('x')).length, 100);
});

test('normalizeIncomingRecipe converts ingredient objects on every path', () => {
  const out = normalizeIncomingRecipe({
    id: 'r_1', title: 'Holiday Salad',
    ingredients: [{ amount: '2', unit: 'cups', name: 'mixed greens' }, '1/2 cup walnuts'],
    instructions: ['Toss everything together'],
  });
  assert.deepEqual(out.ingredients, ['2 cups mixed greens', '1/2 cup walnuts']);
  assert.ok(!JSON.stringify(out).includes('[object Object]'));
});

test('no import path stringifies ingredients directly any more', () => {
  // Regression guard: the bug was four separate String()/map(String) calls.
  for (const file of ['api/import-email.js', 'api/process-pdf.js', 'lib/url-recipe.js', 'api/process.js']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const ingredientLines = src.split('\n').filter((l) => /ingredients:/.test(l));
    for (const line of ingredientLines) {
      assert.ok(!/\.map\(String\)/.test(line), `${file} still maps ingredients with String(): ${line.trim()}`);
    }
  }
});

test('stored [object Object] ingredients are dropped on read', () => {
  const stored = {
    id: 'r_2', title: 'Holiday Salad',
    ingredients: ['[object Object]', '[object Object]', '1/2 cup walnuts'],
  };
  assert.deepEqual(stripBrokenIngredients(stored).ingredients, ['1/2 cup walnuts']);
  // Untouched when there is nothing to fix, and safe on odd input.
  const clean = { id: 'r_3', ingredients: ['1 egg'] };
  assert.equal(stripBrokenIngredients(clean), clean);
  assert.equal(stripBrokenIngredients(null), null);
  assert.deepEqual(stripBrokenIngredients({ id: 'r_4' }), { id: 'r_4' });
});
