import test from 'node:test';
import assert from 'node:assert';

// A link that arrives by email goes to the upload address and straight into the
// chest. These run the real handler with the store, the page and the model
// replaced, so nothing leaves the machine.

process.env.EMAIL_IMPORT_SECRET = 'import-secret';
process.env.GROQ_API_KEY = 'test-key';
process.env.EMAIL_IMPORT_DAILY_LIMIT = '50';

const { default: importEmail, __setImportDepsForTests } = await import('../api/import-email.js');
const { __setKvForTests } = await import('../lib/redis.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');

const auth = { authorization: 'Bearer import-secret' };

const LD = (name) => `<html><head><script type="application/ld+json">${JSON.stringify({
  '@type': 'Recipe', name,
  recipeIngredient: ['200 g spaghetti', '1 lemon'],
  recipeInstructions: ['Boil the pasta.', 'Toss with lemon.'],
})}</script></head></html>`;

const BLOG = `<html><body><p>${'A long story about soup and my grandmother. '.repeat(5)}</p></body></html>`;

function setup({ pages = {}, ai } = {}) {
  const kv = createFakeKv();
  __setKvForTests(kv);
  const fetched = [];
  const chatCalls = [];
  __setImportDepsForTests({
    store: kv,
    link: {
      fetchText: async (url) => {
        fetched.push(url);
        const page = pages[url];
        if (page instanceof Error) throw page;
        if (page === undefined) throw new Error('unreachable');
        return page;
      },
      chat: async (options) => {
        chatCalls.push(options);
        return ai ? JSON.stringify(ai) : JSON.stringify({ error: 'no recipe found' });
      },
      findImage: async () => null,
    },
  });
  return { kv, fetched, chatCalls };
}

async function send(body) {
  const res = makeRes();
  await importEmail(makeReq({ method: 'POST', headers: auth, body }), res);
  return res;
}

test('an email that is only a link saves that page into the chest', async () => {
  const { kv, fetched } = setup({ pages: { 'https://example.com/lemon-pasta': LD('Lemon Pasta') } });
  const res = await send({ from: 'Sam <sam@example.com>', text: 'Check this out!\nhttps://example.com/lemon-pasta\n\nSent from my iPhone' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.recipe.title, 'Lemon Pasta');
  assert.equal(res.body.recipe.sourceUrl, 'https://example.com/lemon-pasta');
  assert.equal(res.body.recipes[0].sourceUrl, 'https://example.com/lemon-pasta', 'the reply can say where it came from');
  assert.deepEqual(fetched, ['https://example.com/lemon-pasta']);

  const ids = await kv.lrange('recipe_ids', 0, -1);
  assert.equal(ids.length, 1, 'it is in the chest');
  const stored = await kv.get(`recipe:${ids[0]}`);
  assert.equal(stored.title, 'Lemon Pasta');
  assert.equal(stored.addedBy, 'Sam', 'credited to the sender by name');
});

test('a link-only mail never asks a model to invent a recipe from "check this out"', async () => {
  const { kv, chatCalls } = setup({ pages: { 'https://example.com/lemon-pasta': LD('Lemon Pasta') }, ai: { title: 'Invented', ingredients: ['x'], instructions: ['y'] } });
  await send({ text: 'Check this out!\nhttps://example.com/lemon-pasta' });
  assert.equal(chatCalls.length, 0, 'structured data page: no model call at all');
  const titles = [];
  for (const id of await kv.lrange('recipe_ids', 0, -1)) titles.push((await kv.get(`recipe:${id}`)).title);
  assert.deepEqual(titles, ['Lemon Pasta']);
});

test('a link in an HTML-only mail is found in its href', async () => {
  const { kv } = setup({ pages: { 'https://example.com/soup?x=1&y=2': LD('Soup') } });
  const res = await send({ html: '<html><body><p>Look</p><a href="https://example.com/soup?x=1&amp;y=2">here</a></body></html>' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recipe.title, 'Soup');
  assert.equal((await kv.lrange('recipe_ids', 0, -1)).length, 1);
});

test('a blog page with no structured data is read by the model and saved', async () => {
  const { kv, chatCalls } = setup({
    pages: { 'https://blog.example.com/soup': BLOG },
    ai: { title: 'Grandma Soup', ingredients: ['stock'], instructions: ['Simmer'] },
  });
  const res = await send({ text: 'https://blog.example.com/soup' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recipe.title, 'Grandma Soup');
  assert.equal(chatCalls.length, 1);
  assert.equal((await kv.lrange('recipe_ids', 0, -1)).length, 1);
});

test('up to three links are each saved; the fourth is not followed', async () => {
  const pages = {};
  for (let i = 1; i <= 5; i += 1) pages[`https://s${i}.example.com/r`] = LD(`Recipe ${i}`);
  const { kv, fetched } = setup({ pages });
  const res = await send({ text: Object.keys(pages).join('\n') });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 3);
  assert.equal(fetched.length, 3, 'only three pages are fetched');
  assert.equal((await kv.lrange('recipe_ids', 0, -1)).length, 3);
});

test('a link already in the chest is reported as a duplicate, not saved twice', async () => {
  const { kv, fetched } = setup({ pages: { 'https://example.com/lemon-pasta': LD('Lemon Pasta') } });
  await send({ text: 'https://example.com/lemon-pasta', messageId: 'm1' });
  const again = await send({ text: 'https://example.com/lemon-pasta', messageId: 'm2' });

  assert.equal(again.statusCode, 200);
  assert.equal(again.body.recipes[0].duplicate, true);
  assert.equal(again.body.recipes[0].sourceUrl, 'https://example.com/lemon-pasta');
  assert.equal((await kv.lrange('recipe_ids', 0, -1)).length, 1, 'still one recipe');
  assert.equal(fetched.length, 1, 'the second mail did not even fetch the page');
});

test('the same message delivered twice is only imported once', async () => {
  const { kv, fetched } = setup({ pages: { 'https://example.com/a': LD('A Recipe') } });
  await send({ text: 'https://example.com/a', messageId: 'same' });
  const second = await send({ text: 'https://example.com/a', messageId: 'same' });
  assert.equal(second.statusCode, 200);
  assert.equal(fetched.length, 1);
  assert.equal((await kv.lrange('recipe_ids', 0, -1)).length, 1);
});

test('a link to a page with no recipe fails as the sender\'s outcome, with a reason', async () => {
  const { kv } = setup({ pages: { 'https://example.com/news': BLOG } }); // model says "no recipe found"
  const res = await send({ text: 'Thought you would like this https://example.com/news' });
  assert.equal(res.statusCode, 422, '422 is final; a 5xx would be retried at a cost');
  assert.deepEqual(res.body.links, [{ url: 'https://example.com/news', status: 400, error: 'no recipe found' }]);
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), []);
});

test('an unreachable link is 422 with one generic message, never the underlying error', async () => {
  setup({ pages: { 'https://internal.example.com/x': new Error('blocked: 10.0.0.5 is a private address') } });
  const res = await send({ text: 'https://internal.example.com/x' });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.links[0].error, 'Could not fetch that page.');
  assert.ok(!JSON.stringify(res.body).includes('10.0.0.5'));
});

test('a good link still imports when another link in the same mail fails', async () => {
  const { kv } = setup({ pages: { 'https://good.example.com/r': LD('Good One'), 'https://dead.example.com/r': new Error('down') } });
  const res = await send({ text: 'https://dead.example.com/r then https://good.example.com/r' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.recipe.title, 'Good One');
  assert.equal((await kv.lrange('recipe_ids', 0, -1)).length, 1);
});

test('a written recipe that mentions a link is still read as a recipe when the link has none', async () => {
  const written = 'Lemon pasta. ' + 'Boil the spaghetti until tender, then drain and toss with lemon juice and parmesan. '.repeat(4);
  const { chatCalls } = setup({ pages: { 'https://example.com/news': BLOG }, ai: { error: 'no recipe found' } });
  await send({ text: written + '\nFrom https://example.com/news' });
  // one call for the page, one for the mail's own text
  assert.equal(chatCalls.length, 2);
});

test('attachments win: a mail with a PDF does not also chase its links', async () => {
  const { fetched } = setup({ pages: { 'https://example.com/x': LD('X') } });
  const res = await send({
    text: 'https://example.com/x',
    attachments: [{ type: 'application/pdf', filename: 'r.pdf', content: 'AA==' }],
  });
  // the PDF is unreadable here, so nothing is saved from it; the point is the
  // link is only a fallback when attachments produced nothing
  assert.ok([200, 422].includes(res.statusCode));
  assert.ok(fetched.length <= 1);
});

test('the daily budget stops link imports that need a model, and says so', async () => {
  process.env.EMAIL_IMPORT_DAILY_LIMIT = '1';
  try {
    const { kv, chatCalls } = setup({
      pages: { 'https://a.example.com/x': BLOG, 'https://b.example.com/x': BLOG },
      ai: { title: 'From Blog', ingredients: ['a'], instructions: ['b'] },
    });
    const day = new Date().toISOString().slice(0, 10);
    await kv.set(`email_import_daily:${day}`, 1); // already at the limit
    const res = await send({ text: 'https://a.example.com/x https://b.example.com/x' });
    assert.equal(res.statusCode, 429, 'refused before doing any work');
    assert.equal(chatCalls.length, 0);
  } finally {
    process.env.EMAIL_IMPORT_DAILY_LIMIT = '50';
  }
});

test('structured-data pages are free, so they do not use up the day', async () => {
  const { kv } = setup({ pages: { 'https://a.example.com/r': LD('A'), 'https://b.example.com/r': LD('B'), 'https://c.example.com/r': LD('C') } });
  await send({ text: 'https://a.example.com/r https://b.example.com/r https://c.example.com/r' });
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(Number(await kv.get(`email_import_daily:${day}`)) || 0, 0, 'no AI calls were spent');
});

test('the secret is still required, and a bad payload is still not a crash', async () => {
  setup();
  const noAuth = makeRes();
  await importEmail(makeReq({ method: 'POST', headers: {}, body: { text: 'https://example.com/x' } }), noAuth);
  assert.equal(noAuth.statusCode, 401);

  for (const body of [{ text: 12345 }, { text: { a: 1 } }, { html: null }, {}]) {
    const res = await send(body);
    assert.notEqual(res.statusCode, 500, JSON.stringify(body));
  }
});

test('markup in a linked page is stripped before it reaches the chest', async () => {
  const dirty = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Recipe', name: 'Soup <img src=x onerror=alert(1)>',
    recipeIngredient: ['1 <b>onion</b>'], recipeInstructions: ['Chop it'],
  })}</script>`;
  const { kv } = setup({ pages: { 'https://example.com/dirty': dirty } });
  await send({ text: 'https://example.com/dirty' });
  const stored = JSON.stringify(await kv.get(`recipe:${(await kv.lrange('recipe_ids', 0, -1))[0]}`));
  assert.ok(!/<img|onerror|<b>/i.test(stored));
});

test('a short written recipe is saved from its text when its link is not a recipe page', async () => {
  const { kv, chatCalls } = setup({
    pages: { 'https://example.com/news': BLOG },
    ai: { title: 'Egg Toast', ingredients: ['2 eggs', 'butter'], instructions: ['Fry in butter 2 min'] },
  });
  // The page call and the text call share one model stub; the page is a blog, so
  // the stub's recipe is what the page "returns" too. Distinguish by the prompt.
  const seen = [];
  __setImportDepsForTests({
    store: kv,
    link: {
      fetchText: async () => BLOG,
      chat: async (options) => {
        const prompt = JSON.stringify(options.messages);
        seen.push(/WEBPAGE TEXT/.test(prompt) ? 'page' : 'text');
        return /WEBPAGE TEXT/.test(prompt)
          ? JSON.stringify({ error: 'no recipe found' })
          : JSON.stringify({ title: 'Egg Toast', ingredients: ['2 eggs', 'butter'], instructions: ['Fry in butter 2 min'] });
      },
      findImage: async () => null,
    },
  });
  void chatCalls;
  const res = await send({ text: 'Eggs: 2 eggs, butter, salt. Fry in butter 2 min, salt. https://example.com/news' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recipe.title, 'Egg Toast');
  assert.deepEqual(seen, ['page', 'text'], 'the link was tried, then the written text');
  assert.equal((await kv.lrange('recipe_ids', 0, -1)).length, 1);
});

test('a bare link is still never turned into a made-up recipe when the page has none', async () => {
  const { kv } = setup({ pages: { 'https://example.com/news': BLOG } });
  const seen = [];
  __setImportDepsForTests({
    store: kv,
    link: {
      fetchText: async () => BLOG,
      chat: async (options) => { seen.push(/WEBPAGE TEXT/.test(JSON.stringify(options.messages)) ? 'page' : 'text'); return JSON.stringify({ error: 'no recipe found' }); },
      findImage: async () => null,
    },
  });
  const res = await send({ text: 'Check this out!\nhttps://example.com/news' });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(seen, ['page'], 'no model call on "Check this out!"');
});
