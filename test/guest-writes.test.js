import test from 'node:test';
import assert from 'node:assert';

// Both routes read their module-level Redis connection when imported, so the
// fake store is injected afterwards through each file's test seam.
process.env.ACCESS_CODE = 'open-sesame';
process.env.SESSION_SECRET = 'session-secret';
process.env.GUEST_OPEN = '1';

const shopping = (await import('../api/shopping-list.js')).default;
const setShoppingKv = (await import('../api/shopping-list.js')).__setKvForTests;
const mealPlan = (await import('../api/meal-plan.js')).default;
const setPlanKv = (await import('../api/meal-plan.js')).__setKvForTests;
const { makeSessionValue, guestSigningCode } = await import('../lib/auth.js');
const { guestBucketId, GUEST_BUCKET_TTL_SECONDS } = await import('../lib/device-buckets.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');

// One guest cookie for the whole file: the bucket is derived from the cookie,
// so a fresh token every call would look like a new session.
const GUEST_COOKIE = `rc_session=${makeSessionValue(guestSigningCode(), undefined, 'guest')}`;
const guestHeaders = () => ({ cookie: GUEST_COOKIE, 'x-forwarded-for': '203.0.113.9' });
const memberHeaders = () => ({ cookie: `rc_session=${makeSessionValue('open-sesame')}`, 'x-forwarded-for': '203.0.113.9' });

async function call(handler, setKv, { method = 'POST', body = {}, deviceId = 'shared', headers = guestHeaders(), kv = createFakeKv() }) {
  setKv(kv);
  const res = makeRes();
  await handler(makeReq({ method, body: { ...body, deviceId }, headers, query: { deviceId } }), res);
  return { res, kv };
}

test('a guest cannot write the shared shopping list', async () => {
  const { res, kv } = await call(shopping, setShoppingKv, { body: { items: [{ text: 'milk' }] } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'View-only access' });
  assert.equal(await kv.get('shopping_list:shared'), null, 'nothing was written');
});

test('a guest cannot delete the shared shopping list either', async () => {
  const { res } = await call(shopping, setShoppingKv, { method: 'DELETE' });
  assert.equal(res.statusCode, 403);
});

test('a guest writes its own derived bucket, not the id it asked for', async () => {
  const { res, kv } = await call(shopping, setShoppingKv, { deviceId: 'd_mine', body: { items: [{ text: 'milk' }] } });
  assert.equal(res.statusCode, 200);
  assert.equal(await kv.get('shopping_list:d_mine'), null, 'the requested id is not used');
  assert.ok(await kv.get(`shopping_list:${guestBucketId(makeReq({ headers: guestHeaders() }))}`), 'it landed in the derived bucket');
});

test('a guest cannot address a member bucket by id', async () => {
  const kv = createFakeKv();
  await kv.set('shopping_list:d_members_phone', { items: [{ text: 'theirs' }], updatedAt: 1 });

  const { res } = await call(shopping, setShoppingKv, { kv, deviceId: 'd_members_phone', body: { items: [{ text: 'mine' }] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((await kv.get('shopping_list:d_members_phone')).items, [{ text: 'theirs' }], 'the member list is untouched');
});

test('two guest sessions get two different buckets', async () => {
  const first = guestBucketId(makeReq({ headers: guestHeaders() }));
  const second = guestBucketId(makeReq({ headers: { cookie: 'rc_session=other-guest' } }));
  assert.notEqual(first, second);
  assert.match(first, /^g_[0-9a-f]{16}$/, 'and the id is opaque, not guessable from the cookie text');
});

test('a guest bucket expires, a member bucket does not', async () => {
  const guest = await call(shopping, setShoppingKv, { deviceId: 'd_x', body: { items: [{ text: 'milk' }] } });
  const guestKey = `shopping_list:${guestBucketId(makeReq({ headers: guestHeaders() }))}`;
  const ttl = await guest.kv.ttl(guestKey);
  assert.ok(ttl > 0 && ttl <= GUEST_BUCKET_TTL_SECONDS, `guest key has a TTL (${ttl})`);

  const member = await call(shopping, setShoppingKv, { headers: memberHeaders(), deviceId: 'd_phone', body: { items: [{ text: 'milk' }] } });
  assert.equal(await member.kv.ttl('shopping_list:d_phone'), -1, 'member keys are kept');
});

test('one guest session cannot write without end', async () => {
  const kv = createFakeKv();
  let last;
  for (let i = 0; i < 241; i += 1) {
    last = await call(shopping, setShoppingKv, { kv, deviceId: 'd_mine', body: { items: [] }, headers: { ...guestHeaders(), 'x-forwarded-for': `198.51.100.${i % 250}` } });
  }
  assert.equal(last.res.statusCode, 429);
});

test('a member may write the shared shopping list', async () => {
  const { res } = await call(shopping, setShoppingKv, { headers: memberHeaders(), body: { items: [{ text: 'milk' }] } });
  assert.equal(res.statusCode, 200);
});

test('a guest cannot write the shared meal plan', async () => {
  const { res } = await call(mealPlan, setPlanKv, { body: { date: '2026-11-02', recipeIds: ['r1'] } });
  assert.equal(res.statusCode, 403);
});

test('a member may write the shared meal plan', async () => {
  const { res } = await call(mealPlan, setPlanKv, { headers: memberHeaders(), body: { date: '2026-11-02', recipeIds: ['r1'] } });
  assert.equal(res.statusCode, 200);
});

test('a meal plan date must sit within 400 days of today', async () => {
  const far = await call(mealPlan, setPlanKv, {
    headers: memberHeaders(),
    body: { date: '2099-01-01', recipeIds: ['r1'] },
  });
  assert.equal(far.res.statusCode, 400);

  const past = await call(mealPlan, setPlanKv, {
    headers: memberHeaders(),
    body: { date: '1999-01-01', recipeIds: ['r1'] },
  });
  assert.equal(past.res.statusCode, 400);

  const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ok = await call(mealPlan, setPlanKv, { headers: memberHeaders(), body: { date: soon, recipeIds: ['r1'] } });
  assert.equal(ok.res.statusCode, 200);
});

test('a meal plan holds at most 400 days', async () => {
  const kv = createFakeKv();
  const plan = {};
  for (let i = 0; i < 400; i += 1) {
    const day = new Date(Date.now() + (i - 200) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    plan[day] = ['r1'];
  }
  await kv.set('meal_plan:shared', plan);

  const over = await call(mealPlan, setPlanKv, {
    headers: memberHeaders(),
    kv,
    body: {
      date: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      recipeIds: ['r1'],
      baseUpdatedAt: Date.now(),
    },
  });
  assert.equal(over.res.statusCode, 400);
  assert.match(String(over.res.body.error), /at most 400 days/);

  // Updating a day already in the plan is still allowed at the cap.
  const existing = Object.keys(plan)[0];
  const update = await call(mealPlan, setPlanKv, {
    headers: memberHeaders(), kv, body: { date: existing, recipeIds: ['r2'], baseUpdatedAt: Date.now() },
  });
  assert.equal(update.res.statusCode, 200);
});

test('guest writes are rate limited', async () => {
  const kv = createFakeKv();
  let last;
  for (let i = 0; i < 121; i += 1) {
    last = await call(shopping, setShoppingKv, { deviceId: 'd_mine', kv, body: { items: [] } });
  }
  assert.equal(last.res.statusCode, 429);
  assert.equal(last.res.headers['retry-after'], '3600');

  // A member on the same IP is not caught by the guest bucket.
  const member = await call(shopping, setShoppingKv, { kv, headers: memberHeaders(), deviceId: 'd_member', body: { items: [] } });
  assert.equal(member.res.statusCode, 200);
});
