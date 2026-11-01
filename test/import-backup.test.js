import test from 'node:test';
import assert from 'node:assert';

// The restore route had no handler-level test, which is how it kept listing
// recipes in only one of the two id indexes and rewrote recipes it had read.

process.env.ACCESS_CODE = 'open-sesame';
process.env.SESSION_SECRET = 'session-secret';

const restore = await import('../api/import-backup.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');
const { makeSessionValue } = await import('../lib/auth.js');

const cookie = `rc_session=${makeSessionValue('open-sesame')}`;
const PHOTO = { photo: 'QUJD', photothumb: 'REVG' };
const RECIPE = { id: 'r_one', title: 'Soup', ingredients: ['water'], instructions: ['boil'], createdAt: 1 };

async function post(kv, body) {
  restore.__setKvForTests(kv);
  const res = makeRes();
  await restore.default(makeReq({ method: 'POST', headers: { cookie }, body }), res);
  return res;
}

test('a restored recipe is listed in both indexes, once', async () => {
  const kv = createFakeKv();
  const res = await post(kv, { recipes: [RECIPE] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.imported, 1);
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), ['r_one']);
  assert.equal(Number(await kv.sismember('recipe_id_set', 'r_one')), 1);
});

test('restoring the same file twice neither duplicates nor overwrites', async () => {
  const kv = createFakeKv();
  await post(kv, { recipes: [RECIPE] });
  await kv.set('recipe:r_one', { ...(await kv.get('recipe:r_one')), title: 'Edited since' });

  const again = await post(kv, { recipes: [RECIPE] });
  assert.equal(again.body.imported, 0);
  assert.equal(again.body.skipped, 1);
  assert.equal((await kv.get('recipe:r_one')).title, 'Edited since', 'the newer edit survives');
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), ['r_one']);
});

test('an id left in the list with no recipe is repaired without a second entry', async () => {
  const kv = createFakeKv();
  await kv.lpush('recipe_ids', 'r_one'); // half-failed delete: listed, nothing behind it
  const res = await post(kv, { recipes: [RECIPE] });
  assert.equal(res.body.imported, 1);
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), ['r_one']);
});

test('a photo slice attaches to the recipe and bumps its revision', async () => {
  const kv = createFakeKv();
  await kv.set('recipe:r_one', { ...RECIPE, rev: 3 });
  const res = await post(kv, { photos: { r_one: PHOTO } });
  assert.equal(res.body.photosRestored, 1);
  const stored = await kv.get('recipe:r_one');
  assert.ok(stored.userPhoto && stored.userPhoto.updatedAt);
  assert.equal(stored.rev, 4, 'written through the compare-and-set helper');
  assert.equal(await kv.get('photo:r_one'), 'QUJD');
});

test('a photo for a recipe that does not exist is ignored', async () => {
  const kv = createFakeKv();
  const res = await post(kv, { photos: { r_missing: PHOTO } });
  assert.equal(res.body.photosRestored, 0);
  assert.equal(await kv.get('photo:r_missing'), null);
  assert.equal(await kv.get('recipe:r_missing'), null, 'a photo never creates a recipe');
});

test('a photo with bad base64 is refused and leaves the recipe alone', async () => {
  const kv = createFakeKv();
  await kv.set('recipe:r_one', { ...RECIPE, rev: 0 });
  const res = await post(kv, { photos: { r_one: { photo: '<script>', photothumb: 'REVG' } } });
  assert.equal(res.body.photosRestored, 0);
  assert.equal((await kv.get('recipe:r_one')).rev, 0, 'not even a revision bump');
});

test('too many recipes in one request is a 400', async () => {
  const kv = createFakeKv();
  const many = Array.from({ length: 501 }, (_, i) => ({ ...RECIPE, id: `r_${i}` }));
  const res = await post(kv, { recipes: many });
  assert.equal(res.statusCode, 400);
});

test('it needs a session', async () => {
  const kv = createFakeKv();
  restore.__setKvForTests(kv);
  const res = makeRes();
  await restore.default(makeReq({ method: 'POST', headers: {}, body: { recipes: [RECIPE] } }), res);
  assert.equal(res.statusCode, 401);
});
