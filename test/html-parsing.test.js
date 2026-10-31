import test from 'node:test';
import assert from 'node:assert';

import { truncateHtml, removeBlocks, MAX_HTML_CHARS } from '../lib/html-text.js';
import { extractRecipeFromJsonLd } from '../lib/jsonld-recipe.js';

test('fetched HTML is truncated before parsing', () => {
  const huge = 'a'.repeat(MAX_HTML_CHARS + 5000);
  assert.equal(truncateHtml(huge).length, MAX_HTML_CHARS);
  assert.equal(truncateHtml('short').length, 5);
  assert.equal(truncateHtml(null), '');
});

test('a run of unclosed script tags stays fast', () => {
  const hostile = '<script'.repeat(66_666); // ~400k of "<script", no closing tag
  const started = Date.now();
  const out = removeBlocks(hostile, 'script');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `took ${elapsed} ms`);
  assert.equal(/<script/i.test(out), false);
});

test('a long page of closed script tags stays fast and is fully removed', () => {
  const hostile = '<script>var a=1;</script>'.repeat(15_000); // ~375k
  const started = Date.now();
  const out = removeBlocks(hostile, 'script');
  assert.ok(Date.now() - started < 500);
  assert.equal(out.trim(), '');
});

test('script and style blocks are removed, text between them is kept', () => {
  const html = '<p>Mix</p><script>alert(1)</script><style>p{}</style><p>Bake</p>';
  const out = removeBlocks(removeBlocks(html, 'script'), 'style');
  assert.match(out, /Mix/);
  assert.match(out, /Bake/);
  assert.equal(/alert|<style/i.test(out), false);
});

test('JSON-LD extraction is bounded and still finds a recipe', () => {
  const recipe = {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Lemon Pasta',
    recipeIngredient: ['spaghetti', 'lemon'],
    recipeInstructions: ['Boil', 'Toss'],
  };
  const page = `<html><head><script type="application/ld+json">${JSON.stringify(recipe)}</script></head></html>`;
  const found = extractRecipeFromJsonLd(page);
  assert.equal(found.title, 'Lemon Pasta');
  assert.deepEqual(found.ingredients, ['spaghetti', 'lemon']);
});

test('unclosed script runs do not stall the JSON-LD scan', () => {
  const hostile = `<script type="application/ld+json">{"@type":"Recipe"` + '<script'.repeat(50_000);
  const started = Date.now();
  const found = extractRecipeFromJsonLd(hostile);
  assert.ok(Date.now() - started < 500);
  assert.equal(found, null); // truncated JSON is not a recipe
});
