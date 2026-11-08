import test from 'node:test';
import assert from 'node:assert';

import { instructionsToList, recipeFromJsonLd, extractRecipeFromJsonLd } from '../lib/jsonld-recipe.js';
import { removeBlocks, removeComments } from '../lib/html-text.js';
import { stripTags } from '../lib/recipes.js';
import { stripHtml } from '../lib/url-recipe.js';
import { groqChat } from '../lib/groq.js';
import { createHandler as createHealth } from '../lib/actions/health.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes } from './helpers/fake-http.js';

function elapsed(fn) {
  const start = Date.now();
  fn();
  return Date.now() - start;
}

test('steps inside a HowToSection are kept, not just the section name', () => {
  const steps = instructionsToList([
    {
      '@type': 'HowToSection',
      name: 'For the sauce',
      itemListElement: [
        { '@type': 'HowToStep', text: 'Simmer 10 minutes' },
        { '@type': 'HowToStep', text: 'Season' },
      ],
    },
    { '@type': 'HowToStep', text: 'Serve' },
  ]);
  assert.deepEqual(steps, ['Simmer 10 minutes', 'Season', 'Serve']);
});

test('a flat list of steps is unchanged', () => {
  assert.deepEqual(
    instructionsToList([{ '@type': 'HowToStep', text: 'A' }, 'B']),
    ['A', 'B'],
  );
});

test('author and cuisine arrays become readable notes, and empty ones add nothing', () => {
  const withNames = recipeFromJsonLd({
    name: 'Soup',
    recipeIngredient: ['water'],
    author: [{ '@type': 'Person', name: 'Ana' }],
    recipeCuisine: ['Italian'],
  });
  assert.equal(withNames.notes, 'Cuisine: Italian. From Ana.');

  const empty = recipeFromJsonLd({ name: 'Soup', recipeIngredient: ['water'], author: {} });
  assert.equal(empty.notes, '');
});

test('a dotted capital I before a script tag does not shift the cut', () => {
  assert.equal(
    removeBlocks('İİİİİ intro <script>SECRET()</script> after', 'script'),
    'İİİİİ intro  after',
  );
});

test('structured data is still found after Turkish text', () => {
  const html = 'İİİİİİİİİİ <script type="application/ld+json">'
    + '{"@type":"Recipe","name":"Çorba","recipeIngredient":["su"],"recipeInstructions":["pişir"]}'
    + '</script>';
  const recipe = extractRecipeFromJsonLd(html);
  assert.ok(recipe);
  assert.equal(recipe.title, 'Çorba');
});

test('removeComments drops closed comments and the tail after an unclosed one', () => {
  assert.equal(removeComments('a<!-- x -->b'), 'a b');
  assert.equal(removeComments('a<!-- never closed b'), 'a ');
  assert.equal(removeComments('plain'), 'plain');
});

test('markup stripping stays fast on hostile input', () => {
  assert.ok(elapsed(() => stripTags('<'.repeat(300000))) < 1000);
  assert.ok(elapsed(() => stripHtml('<'.repeat(300000))) < 1000);
  assert.ok(elapsed(() => stripHtml('<!--'.repeat(120000))) < 1000);
});

test('markup stripping still gives the same answer on normal input', () => {
  assert.equal(stripTags('<b>bad</b>'), 'bad');
  assert.equal(stripTags('<a href="x">link</a> text'), 'link text');
  assert.equal(stripTags('2 < 3'), '2  3');
});

test('a long rate-limit wait is reported at once instead of slept through', async () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { message: 'Rate limit reached. Please try again in 45.2s.' } }),
  });
  try {
    const start = Date.now();
    await assert.rejects(
      () => groqChat({ messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err.status === 429,
    );
    assert.ok(Date.now() - start < 2000);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = realKey;
  }
});

test('the health check answers 503 when Redis cannot be reached', async () => {
  const kv = Object.assign(Object.create(createFakeKv()), {
    async ping() { throw new Error('down'); },
  });
  const res = makeRes();
  await createHealth({ kv })(makeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.redis, false);
});
