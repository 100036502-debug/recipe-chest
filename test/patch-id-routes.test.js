import test from 'node:test';
import assert from 'node:assert';

// The AI replace and its undo send the recipe id in the query string, the edit
// form sends it in the body. Both have to reach the same recipe; before this,
// the query form answered 400 "Missing recipe id".

process.env.ACCESS_CODE = 'open-sesame';
process.env.SESSION_SECRET = 'session-secret';

const recipesRoute = (await import('../api/recipes.js')).default;
const { __setKvForTests } = await import('../lib/redis.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');
const { makeSessionValue } = await import('../lib/auth.js');

const cookie = `rc_session=${makeSessionValue('open-sesame')}`;

async function patch({ body, query }) {
  const res = makeRes();
  await recipesRoute(makeReq({ method: 'PATCH', headers: { cookie }, body, query }), res);
  return res;
}

async function seeded() {
  const kv = createFakeKv();
  __setKvForTests(kv);
  await kv.set('recipe:r1', { id: 'r1', title: 'Soup', ingredients: ['water'], instructions: ['boil'], rev: 2 });
  return kv;
}

test('PATCH finds the recipe by a body id', async () => {
  const kv = await seeded();
  const res = await patch({ body: { id: 'r1', notes: 'salty' } });
  assert.equal(res.statusCode, 200);
  assert.equal((await kv.get('recipe:r1')).notes, 'salty');
});

test('PATCH finds the recipe by a query id, as the AI replace sends it', async () => {
  const kv = await seeded();
  const res = await patch({ query: { id: 'r1' }, body: { ingredients: ['stock'], baseRev: 2 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((await kv.get('recipe:r1')).ingredients, ['stock']);
  assert.equal((await kv.get('recipe:r1')).rev, 3);
});

test('the body id wins when both are present', async () => {
  const kv = await seeded();
  await kv.set('recipe:r2', { id: 'r2', title: 'Stew', rev: 0 });
  const res = await patch({ query: { id: 'r2' }, body: { id: 'r1', notes: 'x' } });
  assert.equal(res.statusCode, 200);
  assert.equal((await kv.get('recipe:r1')).notes, 'x');
  assert.equal((await kv.get('recipe:r2')).notes, undefined);
});

test('PATCH with no id anywhere is still a 400', async () => {
  await seeded();
  const res = await patch({ body: { notes: 'x' } });
  assert.equal(res.statusCode, 400);
});

test('a stale baseRev through the query form is a 409 with the current recipe', async () => {
  await seeded();
  const res = await patch({ query: { id: 'r1' }, body: { notes: 'late', baseRev: 1 } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.current.id, 'r1');
});

test('the client no longer relies on the query id for PATCH', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.equal(/recipes\?id=\$\{encodeURIComponent\(aiRecipeId\)\}/.test(src), false);
});
