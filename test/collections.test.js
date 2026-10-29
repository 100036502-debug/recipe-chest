import test from 'node:test';
import assert from 'node:assert';

import { createHandler } from '../lib/actions/collections.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

async function seed(recipes) {
  const kv = createFakeKv();
  for (const r of recipes) await kv.set(`recipe:${r.id}`, r);
  // recipe_ids is a Redis LIST, so it has to be pushed, not set.
  if (recipes.length) await kv.lpush('recipe_ids', ...recipes.map((r) => r.id));
  return kv;
}

function call(kv, body, headers) {
  const res = makeRes();
  const req = makeReq({ method: 'POST', body, headers: headers || { cookie: sessionCookie() } });
  return createHandler({ kv })(req, res).then(() => res);
}

const BASE = { title: 'T', ingredients: ['x'], instructions: ['y'] };

test('collections requires a session', async () => {
  const kv = await seed([{ ...BASE, id: 'a', collections: ['Dinner'] }]);
  sessionCookie(); // configures ACCESS_CODE/SESSION_SECRET, but sends no cookie
  const res = await call(kv, { delete: 'Dinner' }, {});
  assert.equal(res.statusCode, 401);
});

test('collections rejects other methods', async () => {
  const kv = await seed([]);
  const res = makeRes();
  await createHandler({ kv })(makeReq({ method: 'GET', headers: { cookie: sessionCookie() } }), res);
  assert.equal(res.statusCode, 405);
});

test('collections rejects an empty body', async () => {
  const kv = await seed([]);
  const res = await call(kv, {});
  assert.equal(res.statusCode, 400);
});

test('rename needs both names', async () => {
  const kv = await seed([]);
  const res = await call(kv, { rename: { from: 'Dinner' } });
  assert.equal(res.statusCode, 400);
});

test('rename is case insensitive and reports the count', async () => {
  const kv = await seed([
    { ...BASE, id: 'a', collections: ['dinner', 'Quick'] },
    { ...BASE, id: 'b', collections: ['Dinner'] },
    { ...BASE, id: 'c', collections: ['Baking'] },
  ]);
  const res = await call(kv, { rename: { from: 'DINNER', to: 'Weeknight' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { changed: 2 });
  assert.deepEqual((await kv.get('recipe:a')).collections, ['Weeknight', 'Quick']);
  assert.deepEqual((await kv.get('recipe:b')).collections, ['Weeknight']);
  assert.deepEqual((await kv.get('recipe:c')).collections, ['Baking']);
});

test('rename into a name the recipe already has leaves one copy', async () => {
  const kv = await seed([{ ...BASE, id: 'a', collections: ['Dinner', 'Weeknight'] }]);
  const res = await call(kv, { rename: { from: 'Dinner', to: 'weeknight' } });
  assert.equal(res.statusCode, 200);
  const after = await kv.get('recipe:a');
  assert.equal(after.collections.length, 1);
  assert.equal(after.collections[0].toLowerCase(), 'weeknight');
});

test('delete removes the collection from every recipe', async () => {
  const kv = await seed([
    { ...BASE, id: 'a', collections: ['Dinner', 'Quick'] },
    { ...BASE, id: 'b', collections: ['Dinner'] },
  ]);
  const res = await call(kv, { delete: 'dinner' });
  assert.deepEqual(res.body, { changed: 2 });
  assert.deepEqual((await kv.get('recipe:a')).collections, ['Quick']);
  assert.deepEqual((await kv.get('recipe:b')).collections, []);
});

test('recipes without the collection are left alone', async () => {
  const kv = await seed([{ ...BASE, id: 'a', collections: ['Baking'] }]);
  const res = await call(kv, { delete: 'Dinner' });
  assert.deepEqual(res.body, { changed: 0 });
  assert.deepEqual((await kv.get('recipe:a')).collections, ['Baking']);
});

test('a recipe deleted between listing and writing is skipped', async () => {
  // recipe:b is in recipe_ids but its value is gone
  const kv = createFakeKv();
  await kv.set('recipe:a', { ...BASE, id: 'a', collections: ['Dinner'] });
  await kv.lpush('recipe_ids', 'a', 'b');
  const res = await call(kv, { delete: 'Dinner' });
  assert.deepEqual(res.body, { changed: 1 });
});
