import test from 'node:test';
import assert from 'node:assert';

import { loadClientUtils } from './helpers/load-client.js';

const RC = loadClientUtils();

function recipe(id, ingredients, extra) {
  return Object.assign({ id: id, title: id, ingredients: ingredients }, extra || {});
}

function score(recipes, pantry, options) {
  return RC.matchRecipesToPantry(recipes, pantry, options).map((r) => r.recipe.id);
}

test('a plural pantry item covers the singular ingredient', () => {
  assert.equal(RC.matchRecipesToPantry([recipe('a', ['2 eggs'])], ['eggs'])[0].have, 1);
});

test('pantry synonyms cover the ingredient they mean', () => {
  // scallion normalises to green onion, and so does the pantry item
  assert.equal(RC.matchRecipesToPantry([recipe('a', ['3 scallions'])], ['green onion'])[0].have, 1);
});

test('salt and pepper are assumed when basics are on', () => {
  const out = RC.matchRecipesToPantry([recipe('a', ['salt', 'black pepper'])], [], { minScore: 0 });
  assert.equal(out[0].have, 2);
});

test('basics off means salt has to be in the pantry', () => {
  const out = RC.matchRecipesToPantry([recipe('a', ['salt', 'black pepper'])], [], { assumeBasics: false, minScore: 0 });
  assert.equal(out[0].have, 0);
  assert.deepEqual(out[0].missing.slice().sort(), ['black pepper', 'salt']);
});

test('a shorter pantry item covers a longer ingredient name', () => {
  assert.equal(RC.matchRecipesToPantry([recipe('a', ['chicken breast'])], ['chicken'], { minScore: 0 })[0].have, 1);
});

test('a longer pantry item covers a shorter ingredient name', () => {
  assert.equal(RC.matchRecipesToPantry([recipe('a', ['cheese'])], ['cheddar cheese'], { minScore: 0 })[0].have, 1);
});

test('cheese covers cheddar cheese', () => {
  assert.equal(RC.matchRecipesToPantry([recipe('a', ['cheddar cheese'])], ['cheese'], { minScore: 0 })[0].have, 1);
});

test('whole words only: oil does not cover boiled', () => {
  const out = RC.matchRecipesToPantry([recipe('a', ['boiled potatoes'])], ['oil'], { assumeBasics: false, minScore: 0 });
  assert.equal(out[0].have, 0);
});

test('an empty pantry with basics off returns nothing', () => {
  assert.deepEqual(score([recipe('a', ['bread'])], [], { assumeBasics: false }), []);
});

test('recipes with no ingredients are skipped', () => {
  assert.deepEqual(RC.matchRecipesToPantry([recipe('empty', []), recipe('b', [])], ['x'], { minScore: 0 }), []);
});

test('results are ordered best score first', () => {
  const recipes = [recipe('poor', ['bread', 'butter', 'jam']), recipe('rich', ['bread', 'butter'])];
  assert.deepEqual(score(recipes, ['bread', 'butter'], { minScore: 0 }), ['rich', 'poor']);
});

test('equal scores break on fewer missing items', () => {
  const recipes = [recipe('many', ['bread', 'x', 'y']), recipe('few', ['bread', 'z'])];
  assert.deepEqual(score(recipes, ['bread', 'x', 'y', 'z'], { minScore: 0 }), ['many', 'few']);
});

test('equal scores break on favourites, then newest', () => {
  const recipes = [
    recipe('old', ['bread'], { createdAt: 1 }),
    recipe('new', ['bread'], { createdAt: 9 }),
    recipe('fav', ['bread'], { createdAt: 2, favorite: true }),
  ];
  assert.deepEqual(score(recipes, ['bread']), ['fav', 'new', 'old']);
});

test('minScore is inclusive, so exactly half still shows', () => {
  // 1 of 3 is below the default 0.5 and is dropped
  assert.deepEqual(RC.matchRecipesToPantry([recipe('a', ['bread', 'butter', 'jam'])], ['bread']), []);
  // 1 of 2 is exactly 0.5, and the rule is score >= minScore
  assert.equal(RC.matchRecipesToPantry([recipe('b', ['bread', 'butter'])], ['bread']).length, 1);
});

test('junk input is tolerated', () => {
  assert.deepEqual(RC.matchRecipesToPantry(null, null), []);
  assert.deepEqual(RC.matchRecipesToPantry([null, 5, {}], ['x']), []);
});
