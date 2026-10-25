import { test } from 'node:test';
import assert from 'node:assert';
import {
  extractRecipeFromJsonLd,
  recipeFromJsonLd,
  isoDurationToText,
  decodeEntities,
} from '../lib/jsonld-recipe.js';

test('isoDurationToText converts ISO-8601 durations to readable text', () => {
  assert.equal(isoDurationToText('PT1H30M'), '1 hour 30 minutes');
  assert.equal(isoDurationToText('PT15M'), '15 minutes');
  assert.equal(isoDurationToText('P1DT2H'), '1 day 2 hours');
  assert.equal(isoDurationToText('PT90S'), '90 seconds');
  assert.equal(isoDurationToText('nonsense'), '');
});

test('decodeEntities handles named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&#39;quoted&#39;'), "'quoted'");
  assert.equal(decodeEntities('&#x27;hex&#x27;'), "'hex'");
  assert.equal(decodeEntities('plain'), 'plain');
});

test('recipeFromJsonLd maps a full Recipe node', () => {
  const r = recipeFromJsonLd({
    '@type': 'Recipe',
    name: 'Best Pancakes',
    description: 'Fluffy',
    recipeIngredient: ['1 cup flour', '2 tbsp sugar'],
    recipeInstructions: [
      { '@type': 'HowToStep', text: 'Mix the batter' },
      { '@type': 'HowToSection', itemListElement: [{ '@type': 'HowToStep', text: 'Cook on a griddle' }] },
    ],
    prepTime: 'PT15M',
    cookTime: 'PT1H',
    recipeYield: ['8 pancakes', 'enough for 2'],
    keywords: 'pancakes, breakfast',
    recipeCategory: 'Breakfast',
  });
  assert.equal(r.title, 'Best Pancakes');
  assert.deepEqual(r.ingredients, ['1 cup flour', '2 tbsp sugar']);
  assert.deepEqual(r.instructions, ['Mix the batter', 'Cook on a griddle']);
  assert.equal(r.prepTime, '15 minutes');
  assert.equal(r.cookTime, '1 hour');
  assert.equal(r.servings, '8 pancakes');
  assert.equal(r.mealType, 'breakfast');
  assert.ok(r.tags.includes('pancakes'));
});

test('extractRecipeFromJsonLd finds a Recipe in @graph and arrays, decodes entities', () => {
  const html = `
    <script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Recipe","name":"A &amp; B Soup","recipeIngredient":["broth"],"recipeInstructions":"Heat it up"}]}
    </script>`;
  const r = extractRecipeFromJsonLd(html);
  assert.equal(r.title, 'A & B Soup');
  assert.deepEqual(r.ingredients, ['broth']);
  assert.deepEqual(r.instructions, ['Heat it up']);
});

test('extractRecipeFromJsonLd ignores pages without a usable Recipe', () => {
  assert.equal(extractRecipeFromJsonLd('<script type="application/ld+json">{"@type":"Product","name":"Thing"}</script>'), null);
  assert.equal(extractRecipeFromJsonLd('<script type="application/ld+json">not json</script>'), null);
  assert.equal(extractRecipeFromJsonLd('<p>plain</p>'), null);
});
