import test from 'node:test';
import assert from 'node:assert';

import { guestBucketId } from '../lib/device-buckets.js';
import { blockToList } from '../lib/parse.js';
import { saveImportedRecipe } from '../lib/save-recipe.js';
import { listRecipeId } from '../lib/recipe-index.js';
import mealPlan, { __setKvForTests } from '../api/meal-plan.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

test('a guest bucket depends only on the session cookie, not on other cookies', () => {
  const a = guestBucketId({ headers: { cookie: 'rc_session=abc; junk=1' } });
  const b = guestBucketId({ headers: { cookie: 'junk=2; rc_session=abc' } });
  const c = guestBucketId({ headers: { cookie: 'rc_session=different' } });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('a hyphen inside a line does not split it into separate items', () => {
  assert.deepEqual(
    blockToList('1 cup sugar - divided\nsalt - to taste\nBake 20 - 25 minutes'),
    ['1 cup sugar - divided', 'salt - to taste', 'Bake 20 - 25 minutes'],
  );
});

test('a bulleted list on one line is still split', () => {
  assert.deepEqual(blockToList('- eggs - milk - flour'), ['eggs', 'milk', 'flour']);
  assert.deepEqual(blockToList('eggs • milk • flour'), ['eggs', 'milk', 'flour']);
});

test('pasted-text imports look photos up with the shared cache', async () => {
  const kv = createFakeKv();
  let seen = null;
  await saveImportedRecipe({
    kv,
    recipe: { title: 'Lemon Soup', ingredients: ['lemon'], instructions: ['boil'] },
    findImage: async (title, options) => { seen = options; return null; },
    now: 1700000000000,
  });
  assert.ok(seen && seen.kv === kv);
});

test('a failed push to the id list can be retried and the recipe is then listed', async () => {
  const base = createFakeKv();
  let failing = true;
  const kv = Object.assign(Object.create(base), {
    async lpush(...args) {
      if (failing) throw new Error('network down');
      return base.lpush(...args);
    },
  });
  const id = 'r_1700000000000_abc123';
  await assert.rejects(() => listRecipeId(kv, id));
  failing = false;
  assert.equal(await listRecipeId(kv, id), true);
  assert.deepEqual(await base.lrange('recipe_ids', 0, -1), [id]);
});

test('a plan full of old dates still accepts a new day', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);
  const days = {};
  for (let i = 0; i < 400; i += 1) {
    days[new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10)] = ['r_1700000000000_abc123'];
  }
  await kv.set('meal_plan:dev1', { days, updatedAt: 1 });

  const today = new Date().toISOString().slice(0, 10);
  const res = makeRes();
  await mealPlan(makeReq({
    method: 'POST',
    headers: { cookie: sessionCookie() },
    body: { deviceId: 'dev1', date: today, recipeIds: ['r_1700000000000_abc123'] },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.days), [today]);
});
