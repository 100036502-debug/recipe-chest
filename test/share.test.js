import test from 'node:test';
import assert from 'node:assert';

import { createHandler as createShare } from '../lib/actions/share.js';
import { createHandler as createView, publicView } from '../lib/actions/share-view.js';
import { createHandler as createPhoto } from '../lib/actions/share-photo.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const GONE = { error: 'This link is no longer available.' };

const RECIPE = {
  id: 'r1',
  title: 'Lemon Pasta',
  description: 'Bright',
  ingredients: ['spaghetti', 'lemon'],
  instructions: ['Boil', 'Toss'],
  tags: ['pasta'],
  mealType: 'dinner',
  notes: 'nice',
  sourceUrl: 'https://example.com/r',
  image: { url: 'https://img.example/x.jpg', alt: 'x', photographer: 'Ana', photographerUrl: 'https://u.example/ana', photoUrl: 'https://p.example/1', source: 'unsplash', secret: 'nope' },
  // everything below must never leave the server
  addedBy: 'Sam',
  cookLog: [{ id: 'c1' }],
  collections: ['Weeknight'],
  favorite: true,
  createdAt: 1,
};

async function seed(extra) {
  const kv = createFakeKv();
  await kv.set('recipe:r1', { ...RECIPE, ...(extra || {}) });
  await kv.lpush('recipe_ids', 'r1');
  sessionCookie();
  return kv;
}

function req(opts) {
  return makeReq({ method: 'GET', headers: { cookie: sessionCookie() }, ...opts });
}

async function call(handler, reqObj) {
  const res = makeRes();
  await handler(reqObj, res);
  return res;
}

test('creating a link validates days, existence and returns a 32 char token', async () => {
  const kv = await seed();
  const handler = createShare({ kv, now: () => 1000 });

  const ok = await call(handler, req({ method: 'POST', body: { id: 'r1', days: 7 } }));
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body.token, TOKEN_RE);
  assert.equal(ok.body.expiresAt, 1000 + 7 * 86400000);
  assert.match(ok.body.url, /\/s\/[A-Za-z0-9_-]{32}$/);

  // an unsupported number falls back to 30 days
  const fallback = await call(handler, req({ method: 'POST', body: { id: 'r1', days: 999 } }));
  assert.equal(fallback.body.expiresAt, 1000 + 30 * 86400000);

  const missing = await call(handler, req({ method: 'POST', body: { id: 'nope' } }));
  assert.equal(missing.statusCode, 404);
});

test('a recipe can hold at most ten live links', async () => {
  const kv = await seed();
  const handler = createShare({ kv, now: () => 1000 });
  for (let i = 0; i < 10; i += 1) {
    const res = await call(handler, req({ method: 'POST', body: { id: 'r1' } }));
    assert.equal(res.statusCode, 200);
  }
  const eleventh = await call(handler, req({ method: 'POST', body: { id: 'r1' } }));
  assert.equal(eleventh.statusCode, 409);
});

test('listing drops tokens whose record is gone', async () => {
  const kv = await seed();
  const handler = createShare({ kv, now: () => 1000 });
  const made = await call(handler, req({ method: 'POST', body: { id: 'r1' } }));
  await kv.sadd('share_tokens:r1', 'a'.repeat(32)); // no share:a... record

  const list = await call(handler, req({ query: { id: 'r1' } }));
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].token, made.body.token);
  assert.deepEqual(await kv.smembers('share_tokens:r1'), [made.body.token]);
});

test('revoking removes the link and is idempotent', async () => {
  const kv = await seed();
  const handler = createShare({ kv, now: () => 1000 });
  const made = await call(handler, req({ method: 'POST', body: { id: 'r1' } }));

  const revoked = await call(handler, req({ method: 'DELETE', query: { token: made.body.token } }));
  assert.deepEqual(revoked.body, { ok: true });
  assert.equal(await kv.get(`share:${made.body.token}`), null);

  const again = await call(handler, req({ method: 'DELETE', query: { token: made.body.token } }));
  assert.deepEqual(again.body, { ok: true });
});

test('share-view returns the whitelisted fields and nothing else', async () => {
  const kv = await seed();
  await kv.set('share:' + 'b'.repeat(32), { recipeId: 'r1', createdAt: 1, expiresAt: Date.now() + 100000 });
  const view = createView({ kv });

  const res = await call(view, req({ query: { token: 'b'.repeat(32) } }));
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.equal(body.title, 'Lemon Pasta');
  assert.deepEqual(body.tags, ['pasta']);
  assert.equal(body.hasUserPhoto, false);
  assert.equal(body.sourceUrl, 'https://example.com/r');
  assert.equal(body.image.photographer, 'Ana');
  assert.equal(body.image.secret, undefined);

  for (const leak of ['id', 'addedBy', 'cookLog', 'collections', 'favorite', 'createdAt', 'user']) {
    assert.equal(body[leak], undefined, leak + ' must not leak');
  }
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('every failure mode looks identical', async () => {
  const kv = await seed();
  const view = createView({ kv });
  const live = 'c'.repeat(32);
  await kv.set(`share:${live}`, { recipeId: 'r1', createdAt: 1, expiresAt: 1000 });
  await kv.set('share:' + 'd'.repeat(32), { recipeId: 'gone', createdAt: 1, expiresAt: Date.now() + 100000 });
  await kv.set('share:' + 'e'.repeat(32), { recipeId: 'r1', createdAt: 1, expiresAt: Date.now() + 100000 });
  await kv.set('trash:r1', { at: Date.now() });

  const bad = await call(view, req({ query: { token: 'short' } }));
  const expired = await call(view, req({ query: { token: live } }));
  const deletedRecipe = await call(view, req({ query: { token: 'd'.repeat(32) } }));
  const trashed = await call(view, req({ query: { token: 'e'.repeat(32) } }));

  for (const res of [bad, expired, deletedRecipe, trashed]) {
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, GONE);
  }
});

test('publicView never copies a non http source url', () => {
  const out = publicView({ title: 'T', sourceUrl: 'javascript:alert(1)' }, false);
  assert.equal(out.sourceUrl, undefined);
  assert.equal(out.title, 'T');
});

test('share-photo serves the photo bytes only for a live token', async () => {
  const kv = await seed();
  const token = 'f'.repeat(32);
  await kv.set(`share:${token}`, { recipeId: 'r1', createdAt: 1, expiresAt: Date.now() + 100000 });
  await kv.set('photo:r1', Buffer.from('hello').toString('base64'));
  const photo = createPhoto({ kv });

  const ok = await call(photo, req({ query: { token } }));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'image/jpeg');
  assert.equal(ok.headers['cache-control'], 'private, max-age=60');

  const bad = await call(photo, req({ query: { token: 'nope' } }));
  assert.equal(bad.statusCode, 404);
  assert.deepEqual(bad.body, GONE);
});
