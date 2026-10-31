import test from 'node:test';
import assert from 'node:assert';

import { normalizeIncomingRecipe, cleanText, stripTags } from '../lib/recipes.js';
import { extractRecipeFromJsonLd } from '../lib/jsonld-recipe.js';
import { applyEditableFields } from '../api/recipes.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

test('every text field is capped', () => {
  const r = normalizeIncomingRecipe({
    title: 't'.repeat(500),
    description: 'd'.repeat(900),
    notes: 'n'.repeat(1500),
    prepTime: 'p'.repeat(100),
    cookTime: 'c'.repeat(100),
    servings: 's'.repeat(100),
  });
  assert.equal(r.title.length, 200);
  assert.equal(r.description.length, 500);
  assert.equal(r.notes.length, 1000);
  assert.equal(r.prepTime.length, 40);
  assert.equal(r.cookTime.length, 40);
  assert.equal(r.servings.length, 40);
});

test('lists are capped in both dimensions', () => {
  const r = normalizeIncomingRecipe({
    ingredients: Array.from({ length: 250 }, (_, i) => `item ${i}`),
    instructions: ['x'.repeat(5000), 'stir'],
  });
  assert.equal(r.ingredients.length, 100);
  assert.equal(r.instructions[0].length, 1000);
});

test('markup never survives, in any field', () => {
  const r = normalizeIncomingRecipe({
    title: `${HOSTILE}Pasta`,
    description: HOSTILE,
    notes: HOSTILE,
    ingredients: [HOSTILE],
    instructions: [HOSTILE],
    tags: [HOSTILE],
    collections: [HOSTILE],
    addedBy: HOSTILE,
    cookLog: [{ by: HOSTILE, note: HOSTILE }],
    userPhoto: { credit: HOSTILE, url: 'https://example.test/x.jpg' },
  });

  const text = JSON.stringify({
    title: r.title,
    description: r.description,
    notes: r.notes,
    ingredients: r.ingredients,
    instructions: r.instructions,
    tags: r.tags,
    collections: r.collections,
    addedBy: r.addedBy,
    cookLog: r.cookLog,
    credit: r.userPhoto.credit,
  });
  assert.equal(/<[a-z/]/i.test(text), false, `no tag survived: ${text}`);
  assert.equal(r.userPhoto.url, 'https://example.test/x.jpg', 'other keys are untouched');
});

test('unknown keys and missing fields survive a round trip', () => {
  const r = normalizeIncomingRecipe({ title: 'Soup', somethingNew: { a: 1 } });
  assert.deepEqual(r.somethingNew, { a: 1 });
  assert.equal('ingredients' in r, false, 'a field that was absent stays absent');
});

test('stripTags leaves a bare angle bracket alone but removes real tags', () => {
  assert.equal(stripTags('5 < 10 ideas'), '5  10 ideas');
  assert.equal(stripTags(`${HOSTILE}ok`), 'ok');
  assert.equal(cleanText(null, 10), '');
});

test('editing a recipe strips tags and caps the title', () => {
  const target = { id: 'r1', title: 'Old' };
  applyEditableFields(target, { title: `${HOSTILE}${'x'.repeat(400)}`, notes: HOSTILE });
  assert.equal(target.title.length, 200);
  assert.equal(/<[a-z/]/i.test(target.title + target.notes), false);
});

test('JSON-LD page data is stripped after entities are decoded', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Pasta &lt;script&gt;alert(1)&lt;/script&gt;',
    description: 'Nice &lt;b&gt;bowl&lt;/b&gt;',
    recipeIngredient: ['1 cup &lt;img src=x onerror=alert(1)&gt; flour', 'salt'],
    recipeInstructions: [{ '@type': 'HowToStep', text: 'Boil &lt;script&gt;x&lt;/script&gt;' }],
    prepTime: 'PT10M',
  })}</script>`;

  const recipe = extractRecipeFromJsonLd(html);
  const text = JSON.stringify([recipe.title, recipe.description, recipe.ingredients, recipe.instructions]);
  assert.equal(/<[a-z/]/i.test(text), false, `no tag survived: ${text}`);
  assert.match(recipe.title, /Pasta/);
});
