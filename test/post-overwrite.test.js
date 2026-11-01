import test from 'node:test';
import assert from 'node:assert';

// S6 + S7: an existing recipe is not overwritten by POST, and a delete takes
// its share links with it.

process.env.ACCESS_CODE = 'open-sesame';
process.env.SESSION_SECRET = 'session-secret';

const recipesRoute = (await import('../api/recipes.js')).default;
const { __setKvForTests } = await import('../lib/redis.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');
const { makeSessionValue } = await import('../lib/auth.js');

const cookie = `rc_session=${makeSessionValue('open-sesame')}`;

function post(body) {
  const res = makeRes();
  return recipesRoute(makeReq({ method: 'POST', headers: { cookie }, body }), res).then(() => res);
}

test('POST refuses to overwrite a recipe that already exists', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);
  await kv.set('recipe:r_existing', {
    id: 'r_existing', title: 'Grandma soup', ingredients: ['stock'],
    cookLog: [{ id: 'c1', date: '2026-01-01', rating: 5 }],
    userPhoto: { updatedAt: 1 },
  });

  const res = await post({ id: 'r_existing', title: 'Something else', skipDuplicateCheck: true });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.existing.title, 'Grandma soup');

  const kept = await kv.get('recipe:r_existing');
  assert.equal(kept.title, 'Grandma soup', 'the stored recipe is untouched');
  assert.equal(kept.cookLog.length, 1, 'the cook log survives');
  assert.ok(kept.userPhoto, 'the dish photo survives');
});

test('an explicit restore may reuse the id', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);
  await kv.set('recipe:r_undo', { id: 'r_undo', title: 'Old' });
  const res = await post({ id: 'r_undo', title: 'Restored', restore: true, skipDuplicateCheck: true });
  assert.equal(res.statusCode, 200);
  assert.equal((await kv.get('recipe:r_undo')).title, 'Restored');
});

test('a new recipe is recorded once, in the list and the membership set', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);
  const res = await post({ title: 'Fresh bread' });
  assert.equal(res.statusCode, 200);
  const ids = await kv.lrange('recipe_ids', 0, -1);
  assert.equal(ids.length, 1);
  assert.equal(await kv.sismember('recipe_id_set', ids[0]), true);
});

test('deleting a recipe revokes its share links', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);
  const saved = await post({ title: 'Shared stew' });
  const id = saved.body.id;

  await kv.set(`share:tok123`, { recipeId: id, expiresAt: Date.now() + 86400000 });
  await kv.sadd(`share_tokens:${id}`, 'tok123');

  const res = makeRes();
  await recipesRoute(makeReq({ method: 'DELETE', headers: { cookie }, query: { id } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.shareLinksRevoked, 1);
  assert.equal(await kv.get('share:tok123'), null, 'the public link is gone');
  assert.equal(await kv.sismember('recipe_id_set', id), false, 'and the index is clean');
});
