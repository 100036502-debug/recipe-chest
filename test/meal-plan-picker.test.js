import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { loadClientUtils } from './helpers/load-client.js';

const RC = loadClientUtils();
const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const RECIPES = [
  { id: 'a', title: 'Lemon Pasta', description: 'Bright and quick', ingredients: ['spaghetti', '1 lemon'], tags: ['dinner'] },
  { id: 'b', title: 'Chicken Soup', description: 'Comfort', ingredients: ['chicken', 'carrot', 'celery'], tags: ['winter'] },
  { id: 'c', title: 'Carrot Cake', description: 'Sweet', ingredients: ['carrot', 'flour'], tags: ['dessert'] },
  { id: 'd', title: 'Pancakes', description: 'Breakfast with lemon zest', ingredients: ['flour', 'milk'], tags: [] },
];
const ids = (list) => list.map((r) => r.id);

test('an empty search returns every recipe in its original order', () => {
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, '')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, '   ')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, null)), ['a', 'b', 'c', 'd']);
  assert.notEqual(RC.searchRecipes(RECIPES, ''), RECIPES, 'a copy, so sorting it cannot reorder the app list');
});

test('search finds a recipe by title, ingredient, tag and description', () => {
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, 'pasta')), ['a']);
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, 'celery')), ['b']);
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, 'dessert')), ['c']);
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, 'zest')), ['d']);
});

test('search ignores case and surrounding space', () => {
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, '  CHICKEN ')), ['b']);
});

test('every word has to match, so more words narrow the list', () => {
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, 'carrot')).sort(), ['b', 'c']);
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, 'carrot cake')), ['c']);
  assert.deepEqual(RC.searchRecipes(RECIPES, 'carrot pasta'), []);
});

test('a title match ranks above an ingredient match', () => {
  // "lemon" is the title of a, and only in the description of d.
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, 'lemon')), ['a', 'd']);
  // "carrot": title of c, ingredient of b. c leads even though b comes first in the list.
  assert.deepEqual(ids(RC.searchRecipes(RECIPES, 'carrot')), ['c', 'b']);
});

test('nothing found is an empty list, and odd recipes do not throw', () => {
  assert.deepEqual(RC.searchRecipes(RECIPES, 'zzzz'), []);
  const odd = [null, {}, { id: 'x', title: 5, ingredients: 'not-an-array', tags: null }, { id: 'y', title: 'Soup' }];
  assert.deepEqual(ids(RC.searchRecipes(odd, 'soup')), ['y']);
  assert.deepEqual(RC.searchRecipes(undefined, 'a'), []);
});

test('regex characters in a search are plain text', () => {
  assert.deepEqual(RC.searchRecipes(RECIPES, '.*'), []);
  assert.deepEqual(RC.searchRecipes(RECIPES, '(lemon'), []);
});

// ---- wiring ----

test('the recipe has an Add to meal plan button that opens the day chooser', () => {
  assert.match(app, /data-action="openPlanPickerForRecipe" data-id="\$\{r\.id\}">📅 Add to meal plan/);
  assert.match(app, /^\s+openPlanPickerForRecipe,$/m, 'registered as a click handler');
  assert.match(app, /^\s+pickPlanDay,$/m);
});

test('the picker has a search box wired to re-render as you type', () => {
  assert.match(html, /id="picker-search"[^>]*data-input="filterPicker"/);
  assert.match(app, /filterPicker: \(\) => renderPicker\(\)/);
  assert.match(app, /RCUtils\.searchRecipes\(recipes, query\)/);
});

test('the day chooser hides the search box and offers two weeks of days', () => {
  assert.match(app, /const PICKER_DAYS = 14/);
  const open = app.slice(app.indexOf('async function openPlanPickerForRecipe'), app.indexOf('function renderPicker'));
  assert.match(open, /setPickerSearch\(false\)/);
  assert.match(open, /mealPlanReady\(\)/, 'a failed plan load blocks adding, like every other plan write');
});

test('the search text is escaped when nothing matches', () => {
  assert.match(app, /No recipes match "\$\{escapeHtml\(query\.trim\(\)\)\}"/);
});

test('guests can still plan meals: none of the new actions are write-only', () => {
  const pattern = new RegExp(app.match(/const WRITE_HANDLERS = \/(.*)\/;/)[1]);
  for (const name of ['openPlanPickerForRecipe', 'pickPlanDay', 'openPicker', 'pickRecipe', 'filterPicker']) {
    assert.equal(pattern.test(name), false, name);
  }
});

test('every recipe id placed in the picker markup is one the server accepts', () => {
  // ids go into data-id unescaped; they are [A-Za-z0-9_-] by the server's rule.
  assert.match(app, /data-action="pickRecipe" data-id="\$\{r\.id\}"/);
});
