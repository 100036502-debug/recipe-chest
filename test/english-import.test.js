import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { ENGLISH_ONLY } from '../lib/english.js';
import { createHandler as createImportText } from '../lib/actions/import-text.js';
import { importRecipeFromUrl } from '../lib/url-recipe.js';
import { needsEnglish } from '../lib/english.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

const MODEL_JSON = JSON.stringify({
  title: 'Onion Soup',
  description: 'From a message',
  mealType: 'dinner',
  tags: ['soup'],
  ingredients: ['2 cups stock', '1 onion'],
  instructions: ['Simmer everything.'],
});

test('the instruction asks for English and protects names, units and numbers', () => {
  assert.match(ENGLISH_ONLY, /English/);
  assert.match(ENGLISH_ONLY, /dish names|brand names/);
  assert.match(ENGLISH_ONLY, /number/);
});

test('the pasted-text import asks the model to translate', async () => {
  let seen = '';
  const res = makeRes();
  const handler = createImportText({
    kv: createFakeKv(),
    chat: async (messages) => { seen = JSON.stringify(messages); return MODEL_JSON; },
    now: () => 1000,
  });
  await handler(makeReq({
    method: 'POST',
    body: { text: 'Sopa de cebolla. Dos tazas de caldo y una cebolla. Cocer veinte minutos.' },
    headers: { cookie: sessionCookie() },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.ok(seen.includes('English'), 'the prompt must ask for English');
});

// A guard rather than a mock: these prompts are built inline, so a missing
// import is the way this would silently regress.
test('every import prompt carries the English instruction', () => {
  const sites = [
    'api/process.js',            // photo import
    'api/import-email.js',       // photo attached to an email
    'lib/pdf-recipe.js',         // PDF upload and PDF by email
    'lib/url-recipe.js',         // web page, AI fallback
    'lib/actions/import-text.js', // pasted text
  ];
  for (const file of sites) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.match(source, /import \{[^}]*ENGLISH_ONLY[^}]*\}/, `${file} must import ENGLISH_ONLY`);
    assert.match(source, /\$\{ENGLISH_ONLY\}/, `${file} must use ENGLISH_ONLY in its prompt`);
  }
});

test('structured data in another language is translated, and English is left alone', () => {
  assert.equal(needsEnglish({ title: 'Sopa de cebolla', ingredients: ['2 tazas de caldo'] }), true);
  assert.equal(needsEnglish({ title: 'Onion soup', ingredients: ['2 cups stock'] }), false);
});

test('a Spanish page with structured data is translated before it is saved', async () => {
  const spanish = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Recipe',
    name: 'Sopa de cebolla',
    recipeIngredient: ['2 tazas de caldo', '1 cebolla'],
    recipeInstructions: [{ '@type': 'HowToStep', text: 'Cocer veinte minutos.' }],
  })}</script></head><body>hi</body></html>`;

  const calls = [];
  const chat = async (options) => {
    calls.push(JSON.stringify(options.messages));
    return JSON.stringify({
      title: 'Onion soup',
      description: 'A simple soup',
      ingredients: ['2 cups stock', '1 onion'],
      instructions: ['Simmer twenty minutes.'],
      tags: ['soup'],
      notes: '',
    });
  };

  const out = await importRecipeFromUrl({
    kv: createFakeKv(),
    url: 'https://example.es/sopa',
    fetchText: async () => spanish,
    chat,
    findImage: async () => null,
  });

  assert.equal(out.ok, true);
  assert.equal(out.recipe.title, 'Onion soup');
  assert.deepEqual(out.recipe.ingredients, ['2 cups stock', '1 onion']);
  assert.equal(calls.length, 1, 'exactly one translation call');
  assert.ok(calls[0].includes('English'));
});
