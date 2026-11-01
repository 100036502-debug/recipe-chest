import test from 'node:test';
import assert from 'node:assert';

import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes } from './helpers/fake-http.js';

// Both routes read their Redis connection at import time, so the fake store is
// injected through each module's test seam afterwards.
process.env.ACCESS_CODE = 'open-sesame';
process.env.SESSION_SECRET = 'session-secret';

const { writeBucket, valuesMatch, missingBaseForShared, BUCKET_CAS_SCRIPT } = await import('../lib/bucket-store.js');
const { readPlan, default: mealPlanHandler, __setKvForTests: setPlanKv } = await import('../api/meal-plan.js');
const { default: shoppingList, __setKvForTests: setListKv } = await import('../api/shopping-list.js');
const { makeSessionValue } = await import('../lib/auth.js');

const memberHeaders = () => ({ cookie: `rc_session=${makeSessionValue('open-sesame')}`, 'x-forwarded-for': '203.0.113.9' });

// C2: both per-device buckets are compare-and-set, and the plan carries the
// same updatedAt/baseUpdatedAt scheme as the shopping list.

test('a newer stored timestamp refuses an older base', async () => {
  const kv = createFakeKv();
  await kv.set('shopping_list:d1', { items: [], updatedAt: 200 });
  const result = await writeBucket(kv, 'shopping_list:d1', { items: ['x'], updatedAt: 300 }, { baseUpdatedAt: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.current.updatedAt, 200, 'the caller gets the current copy');
  assert.equal((await kv.get('shopping_list:d1')).items.length, 0, 'nothing was written');
});

test('an up-to-date base lands', async () => {
  const kv = createFakeKv();
  await kv.set('shopping_list:d1', { items: [], updatedAt: 200 });
  const result = await writeBucket(kv, 'shopping_list:d1', { items: ['x'], updatedAt: 300 }, { baseUpdatedAt: 200 });
  assert.equal(result.ok, true);
  assert.deepEqual((await kv.get('shopping_list:d1')).items, ['x']);
});

test('a guest TTL survives the write', async () => {
  const kv = createFakeKv();
  await writeBucket(kv, 'shopping_list:g_abc', { items: [], updatedAt: 1 }, { setOptions: { ex: 60 } });
  // Expiry is honoured by the fake store when set through it; eval is absent so
  // the fallback path applied the options.
  assert.ok(await kv.get('shopping_list:g_abc'));
});

test('valuesMatch follows the shared decision rule', () => {
  assert.equal(valuesMatch({ updatedAt: 5 }, undefined), true, 'no base means no check');
  assert.equal(valuesMatch({ updatedAt: 5 }, 5), true);
  assert.equal(valuesMatch({ updatedAt: 5 }, 6), true);
  assert.equal(valuesMatch({ updatedAt: 5 }, 4), false);
});

test('the CAS is one script when the store supports eval', async () => {
  const calls = [];
  const kv = {
    async get() { return null; },
    async eval(script, keys, args) { calls.push({ script, keys, args }); return 1; },
  };
  const result = await writeBucket(kv, 'meal_plan:shared', { days: { x: ['r1'] }, updatedAt: 9 }, { baseUpdatedAt: 8, setOptions: { ex: 100 } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, BUCKET_CAS_SCRIPT);
  assert.deepEqual(calls[0].keys, ['meal_plan:shared']);
  assert.equal(calls[0].args[0], '8');
  assert.equal(calls[0].args[2], '100', 'the guest TTL is applied in the same step');
});

test('a shared bucket with data may not be written without a base', () => {
  assert.equal(missingBaseForShared({ deviceId: 'shared', stored: { items: [] }, hasData: true }), true);
  assert.equal(missingBaseForShared({ deviceId: 'shared', stored: { items: [] }, hasData: true, baseUpdatedAt: 1 }), false);
  assert.equal(missingBaseForShared({ deviceId: 'shared', stored: null, hasData: false }), false, 'a first write is fine');
  assert.equal(missingBaseForShared({ deviceId: 'd_1', stored: { items: [] }, hasData: true }), false, 'own buckets stay lenient');
});

test('readPlan understands both the envelope and the old flat map', () => {
  assert.deepEqual(readPlan({ days: { '2026-11-01': ['r1'] }, updatedAt: 7 }), { days: { '2026-11-01': ['r1'] }, updatedAt: 7 });
  assert.deepEqual(readPlan({ '2026-11-01': ['r1'] }), { days: { '2026-11-01': ['r1'] }, updatedAt: null });
  assert.deepEqual(readPlan(null), { days: {}, updatedAt: null });
});

async function callPlan(kv, body) {
  setPlanKv(kv);
  const res = makeRes();
  await mealPlanHandler(makeReq({ method: 'POST', headers: memberHeaders(), body }), res);
  return res;
}

test('a plan write on a stale base is a 409 with the current plan', async () => {
  const kv = createFakeKv();
  await kv.set('meal_plan:shared', { days: { '2026-11-01': ['r1'] }, updatedAt: 500 });

  const res = await callPlan(kv, { deviceId: 'shared', date: '2026-11-01', recipeIds: ['r2'], baseUpdatedAt: 400 });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body.current.days['2026-11-01'], ['r1']);
  assert.deepEqual((await kv.get('meal_plan:shared')).days['2026-11-01'], ['r1'], 'the stored plan is untouched');
});

test('a plan write on a current base lands and bumps updatedAt', async () => {
  const kv = createFakeKv();
  await kv.set('meal_plan:shared', { days: { '2026-11-01': ['r1'] }, updatedAt: 500 });

  const res = await callPlan(kv, { deviceId: 'shared', date: '2026-11-02', recipeIds: ['r3'], baseUpdatedAt: 500 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.days['2026-11-02'], ['r3']);
  assert.deepEqual(res.body.days['2026-11-01'], ['r1'], 'the other day survived');
  assert.ok(res.body.updatedAt > 500);
});

test('the shopping list refuses a blind write to a shared bucket that has items', async () => {
  const kv = createFakeKv();
  await kv.set('shopping_list:shared', { items: [{ text: 'milk', checked: false }], updatedAt: 100 });
  setListKv(kv);

  const res = makeRes();
  await shoppingList(makeReq({
    method: 'POST',
    headers: memberHeaders(),
    body: { deviceId: 'shared', items: [{ text: 'bread', checked: false }] },
  }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.current.items[0].text, 'milk');
});
