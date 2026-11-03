import test from 'node:test';
import assert from 'node:assert';

import { importRecipeFromUrl } from '../lib/url-recipe.js';
import { createFakeKv } from './helpers/fake-kv.js';

// The shared page-to-recipe core, used by /api/import-url and /api/import-email.
// Every outcome the URL route used to give is pinned here, with the network and
// the model replaced so nothing leaves the machine.

const LD_PAGE = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Lemon Pasta',
  recipeIngredient: ['200 g spaghetti', '1 lemon'],
  recipeInstructions: [{ '@type': 'HowToStep', text: 'Boil the pasta.' }, { '@type': 'HowToStep', text: 'Toss with lemon.' }],
})}</script></head><body>hi</body></html>`;

const BLOG_PAGE = `<html><body><h1>My soup</h1><p>${'Here is a long story about soup and my grandmother. '.repeat(5)}</p></body></html>`;

const noImage = async () => null;
const page = (html) => async () => html;

function aiReturning(obj) {
  const calls = [];
  const fn = async (options) => { calls.push(options); return typeof obj === 'string' ? obj : JSON.stringify(obj); };
  fn.calls = calls;
  return fn;
}

test('a page with structured data is saved without any model call', async () => {
  const kv = createFakeKv();
  const chat = aiReturning({});
  const out = await importRecipeFromUrl({
    kv, url: 'https://example.com/pasta', addedBy: 'Sam',
    fetchText: page(LD_PAGE), chat, findImage: noImage,
  });
  assert.equal(out.ok, true);
  assert.equal(out.recipe.title, 'Lemon Pasta');
  assert.equal(out.recipe.sourceUrl, 'https://example.com/pasta');
  assert.equal(out.recipe.addedBy, 'Sam');
  assert.equal(chat.calls.length, 0, 'the free path never spends a model call');
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), [out.recipe.id], 'listed');
  assert.ok(await kv.get(`recipe:${out.recipe.id}`), 'stored');
});

test('a plain blog page goes to the model, and the budget hook runs first', async () => {
  const kv = createFakeKv();
  const order = [];
  const chat = async () => {
    order.push('chat');
    return JSON.stringify({ title: 'Grandma Soup', ingredients: ['stock'], instructions: ['Simmer'] });
  };
  const out = await importRecipeFromUrl({
    kv, url: 'https://example.com/soup', addedBy: 'Sam',
    fetchText: page(BLOG_PAGE), chat, findImage: noImage,
    beforeAi: async () => { order.push('budget'); return true; },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(order, ['budget', 'chat'], 'the budget is checked before the model is called');
});

test('when the budget hook refuses, no model call is made and nothing is saved', async () => {
  const kv = createFakeKv();
  const chat = aiReturning({ title: 'x', ingredients: ['a'], instructions: ['b'] });
  const out = await importRecipeFromUrl({
    kv, url: 'https://example.com/soup', fetchText: page(BLOG_PAGE), chat, findImage: noImage,
    beforeAi: async () => false,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 429);
  assert.equal(chat.calls.length, 0);
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), []);
});

test('the budget hook is not consulted when structured data made the model unnecessary', async () => {
  const kv = createFakeKv();
  let asked = 0;
  const out = await importRecipeFromUrl({
    kv, url: 'https://example.com/pasta', fetchText: page(LD_PAGE), chat: aiReturning({}), findImage: noImage,
    beforeAi: async () => { asked += 1; return true; },
  });
  assert.equal(out.ok, true);
  assert.equal(asked, 0, 'a free import costs nothing against the daily limit');
});

test('bad addresses are refused before any fetch', async () => {
  const kv = createFakeKv();
  let fetched = 0;
  const fetchText = async () => { fetched += 1; return LD_PAGE; };
  for (const url of ['not a url', 'ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', '']) {
    const out = await importRecipeFromUrl({ kv, url, fetchText, chat: aiReturning({}), findImage: noImage });
    assert.equal(out.ok, false, url);
    assert.equal(out.status, 400, url);
  }
  assert.equal(fetched, 0);
});

test('a fetch failure gives one generic message, whatever the cause', async () => {
  const kv = createFakeKv();
  for (const message of ['blocked: private address', 'ENOTFOUND internal.corp', 'timeout']) {
    const out = await importRecipeFromUrl({
      kv, url: 'https://example.com/x', fetchText: async () => { throw new Error(message); },
      chat: aiReturning({}), findImage: noImage,
    });
    assert.equal(out.status, 400);
    assert.equal(out.error, 'Could not fetch that page.');
  }
});

test('a page whose address is already saved is a duplicate, found before the fetch', async () => {
  const kv = createFakeKv();
  await kv.set('recipe:r_old', { id: 'r_old', title: 'Lemon Pasta', sourceUrl: 'https://example.com/pasta' });
  await kv.lpush('recipe_ids', 'r_old');
  let fetched = 0;
  const out = await importRecipeFromUrl({
    kv, url: 'https://example.com/pasta', fetchText: async () => { fetched += 1; return LD_PAGE; },
    chat: aiReturning({}), findImage: noImage,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.duplicate.id, 'r_old');
  assert.equal(fetched, 0, 'no fetch and no model call for a link we already hold');
});

test('a page with no recipe, an empty page and invalid model output are each refused', async () => {
  const kv = createFakeKv();
  const none = await importRecipeFromUrl({
    kv, url: 'https://example.com/a', fetchText: page(BLOG_PAGE),
    chat: aiReturning({ error: 'no recipe found' }), findImage: noImage,
  });
  assert.deepEqual([none.ok, none.status], [false, 400]);

  const empty = await importRecipeFromUrl({
    kv, url: 'https://example.com/b', fetchText: page('<html><body>hi</body></html>'),
    chat: aiReturning({}), findImage: noImage,
  });
  assert.deepEqual([empty.ok, empty.status, empty.error], [false, 400, 'Page appears to be empty or blocked.']);

  const junk = await importRecipeFromUrl({
    kv, url: 'https://example.com/c', fetchText: page(BLOG_PAGE),
    chat: aiReturning('this is not json at all'), findImage: noImage,
  });
  assert.deepEqual([junk.ok, junk.status], [false, 500]);

  const shell = await importRecipeFromUrl({
    kv, url: 'https://example.com/d', fetchText: page(BLOG_PAGE),
    chat: aiReturning({ title: 'Empty shell', ingredients: [], instructions: [] }), findImage: noImage,
  });
  assert.deepEqual([shell.ok, shell.status], [false, 400]);
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), [], 'nothing half-saved');
});

test('a model failure is reported without leaking its message', async () => {
  const kv = createFakeKv();
  const out = await importRecipeFromUrl({
    kv, url: 'https://example.com/a', fetchText: page(BLOG_PAGE), findImage: noImage,
    chat: async () => { throw new Error('secret upstream detail'); },
  });
  assert.equal(out.status, 500);
  assert.equal(out.error, 'The recipe could not be read. Try again later.');
  assert.ok(!JSON.stringify(out).includes('secret upstream detail'));
});

test('markup in a page is stripped before it is stored', async () => {
  const kv = createFakeKv();
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Recipe', name: 'Soup <img src=x onerror=alert(1)>',
    recipeIngredient: ['1 <b>onion</b>'], recipeInstructions: ['Chop <script>bad()<\\/script> it'],
  }).replace(/<\/script>/g, '<\\/script>')}</script>`;
  const out = await importRecipeFromUrl({ kv, url: 'https://example.com/s', fetchText: page(html), chat: aiReturning({}), findImage: noImage });
  assert.equal(out.ok, true);
  const stored = JSON.stringify(await kv.get(`recipe:${out.recipe.id}`));
  assert.ok(!/<img|<script|onerror/i.test(stored), 'no markup reaches storage');
});
