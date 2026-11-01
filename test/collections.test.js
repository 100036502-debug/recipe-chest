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
  assert.equal(res.body.changed, 2);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.truncated, false);
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
  assert.equal(res.body.changed, 2);
  assert.equal(res.body.total, 2);
  assert.deepEqual((await kv.get('recipe:a')).collections, ['Quick']);
  assert.deepEqual((await kv.get('recipe:b')).collections, []);
});

test('recipes without the collection are left alone', async () => {
  const kv = await seed([{ ...BASE, id: 'a', collections: ['Baking'] }]);
  const res = await call(kv, { delete: 'Dinner' });
  assert.equal(res.body.changed, 0);
  assert.equal(res.body.examined, 1, 'it read the one recipe and left it alone');
  assert.deepEqual((await kv.get('recipe:a')).collections, ['Baking']);
});

test('a recipe deleted between listing and writing is skipped', async () => {
  // recipe:b is in recipe_ids but its value is gone
  const kv = createFakeKv();
  await kv.set('recipe:a', { ...BASE, id: 'a', collections: ['Dinner'] });
  await kv.lpush('recipe_ids', 'a', 'b');
  const res = await call(kv, { delete: 'Dinner' });
  assert.equal(res.body.changed, 1);
  assert.equal(res.body.examined, 1, 'the missing one was not counted');
});

test('a large chest is read in batches and every recipe is still reached', async () => {
  const recipes = [];
  for (let i = 0; i < 120; i += 1) recipes.push({ ...BASE, id: `r${i}`, collections: ['Dinner'] });
  const kv = await seed(recipes);

  let mgetCalls = 0;
  const realMget = kv.mget.bind(kv);
  kv.mget = (...keys) => { mgetCalls += 1; return realMget(...keys); };

  const res = await call(kv, { rename: { from: 'Dinner', to: 'Supper' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.changed, 120);
  assert.equal(res.body.total, 120);
  assert.equal(res.body.truncated, false);
  assert.equal(mgetCalls, 3, '120 recipes go out as three mget calls of 50, 50 and 20');
  assert.deepEqual((await kv.get('recipe:r119')).collections, ['Supper']);
});

test('crossing the cap is reported instead of silently dropped', async () => {
  const kv = createFakeKv();
  // Only the list is long; the values are absent, so this stays fast.
  const ids = [];
  for (let i = 0; i < 2005; i += 1) ids.push(`x${i}`);
  await kv.lpush('recipe_ids', ...ids);

  const res = await call(kv, { delete: 'Dinner' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 2005);
  assert.equal(res.body.truncated, true, 'the caller can see the pass was partial');
  assert.equal(res.body.changed, 0);
});
