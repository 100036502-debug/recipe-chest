import test from 'node:test';
import assert from 'node:assert';

import { createHandler, CACHE_KEY, computeStats } from '../lib/actions/storage-stats.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

const PHOTO_A = 'a'.repeat(1000);
const PHOTO_B = 'b'.repeat(400);

async function seed({ recipes = 2, cap } = {}) {
  const kv = createFakeKv();
  const ids = [];
  for (let i = 0; i < recipes; i += 1) {
    const id = `r${i + 1}`;
    ids.push(id);
    const recipe = { id, title: `Recipe ${i + 1}`, ingredients: ['1 cup flour'], instructions: ['Mix'], notes: '' };
    if (i === 0) recipe.userPhoto = { url: 'data:...' };
    await kv.set(`recipe:${id}`, recipe);
  }
  await kv.lpush('recipe_ids', ...ids);
  if (recipes > 0) {
    await kv.set('photo:r1', PHOTO_A);
    await kv.set('photothumb:r1', PHOTO_B);
  }
  const saved = process.env.STORAGE_CAP_MB;
  if (cap === undefined) delete process.env.STORAGE_CAP_MB;
  else process.env.STORAGE_CAP_MB = String(cap);
  return {
    kv,
    handler: createHandler({ kv }),
    restore: () => {
      if (saved === undefined) delete process.env.STORAGE_CAP_MB;
      else process.env.STORAGE_CAP_MB = saved;
    },
  };
}

async function get(handler, query = {}) {
  const res = makeRes();
  await handler(makeReq({ method: 'GET', query, headers: { cookie: sessionCookie() } }), res);
  return res;
}

test('totals add up across recipes and photos', async () => {
  const ctx = await seed();
  try {
    const res = await get(ctx.handler);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.recipes, 2);
    assert.equal(res.body.userPhotos, 1);
    assert.ok(res.body.recipeBytes > 0);
    assert.equal(res.body.photoBytes, PHOTO_A.length + PHOTO_B.length);
    assert.equal(res.body.totalBytes, res.body.recipeBytes + res.body.photoBytes);
    assert.equal(res.body.capBytes, null);
    assert.equal(res.body.percent, null, 'no cap means no percentage');
  } finally { ctx.restore(); }
});

test('an empty chest reports zeros, not an error', async () => {
  const ctx = await seed({ recipes: 0 });
  try {
    const res = await get(ctx.handler);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      [res.body.recipes, res.body.userPhotos, res.body.recipeBytes, res.body.photoBytes, res.body.totalBytes],
      [0, 0, 0, 0, 0],
    );
  } finally { ctx.restore(); }
});

test('the cap produces a percentage, clamped to 100', async () => {
  const ctx = await seed({ cap: 0.001 }); // ~1 KB cap, the chest is larger
  try {
    const res = await get(ctx.handler);
    assert.equal(res.body.capBytes, 1049);
    assert.equal(res.body.percent, 100);
  } finally { ctx.restore(); }

  const roomy = await seed({ cap: 0.002 });
  try {
    const res = await get(roomy.handler);
    assert.ok(res.body.percent > 0 && res.body.percent < 100);
    assert.equal(res.body.capBytes, 2097);
  } finally { roomy.restore(); }
});

test('the answer is cached for ten minutes and ?refresh=1 bypasses it', async () => {
  const ctx = await seed();
  try {
    const first = await get(ctx.handler);
    assert.equal(first.body.cached, false);
    assert.ok(await ctx.kv.get(CACHE_KEY), 'cached after the first call');

    // Change the data behind the cache: a cached read must not notice.
    await ctx.kv.set('recipe:r1', { id: 'r1', title: 'Renamed', ingredients: ['x'], instructions: ['y'], notes: '', userPhoto: {} });
    const second = await get(ctx.handler);
    assert.equal(second.body.cached, true);
    assert.equal(second.body.recipeBytes, first.body.recipeBytes);

    const refreshed = await get(ctx.handler, { refresh: '1' });
    assert.equal(refreshed.body.cached, false);
    assert.notEqual(refreshed.body.recipeBytes, first.body.recipeBytes);
  } finally { ctx.restore(); }
});

test('computeStats tolerates a recipe that cannot be stringified', async () => {
  const kv = createFakeKv();
  const circular = { id: 'c1', title: 'Loop', ingredients: ['x'], instructions: ['y'], notes: '' };
  circular.self = circular;
  await kv.set('recipe:c1', circular);
  await kv.lpush('recipe_ids', 'c1');
  const stats = await computeStats(kv);
  assert.equal(stats.recipes, 1);
  assert.equal(stats.recipeBytes, 0);
});

test('guests and unauthenticated callers are refused', async () => {
  const ctx = await seed();
  const saved = process.env.GUEST_CODE;
  process.env.GUEST_CODE = 'guest-code';
  try {
    const { makeSessionValue } = await import('../lib/auth.js');
    const guest = makeSessionValue('guest-code', undefined, 'guest');
    const guestRes = await get(ctx.handler);
    // member cookie helper above; now the guest one explicitly
    const res = makeRes();
    await ctx.handler(makeReq({ method: 'GET', headers: { cookie: `rc_session=${guest}` } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(guestRes.statusCode, 200);

    const anon = makeRes();
    await ctx.handler(makeReq({ method: 'GET', headers: {} }), anon);
    assert.equal(anon.statusCode, 401);
  } finally {
    if (saved === undefined) delete process.env.GUEST_CODE; else process.env.GUEST_CODE = saved;
    ctx.restore();
  }
});

test('only GET is allowed', async () => {
  const ctx = await seed();
  try {
    const res = makeRes();
    await ctx.handler(makeReq({ method: 'POST', body: {}, headers: { cookie: sessionCookie() } }), res);
    assert.equal(res.statusCode, 405);
  } finally { ctx.restore(); }
});
