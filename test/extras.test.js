import test from 'node:test';
import assert from 'node:assert';

import extras from '../api/extras.js';
import { createHandler as createUndoDelete } from '../lib/actions/undo-delete.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

// The dispatcher keeps the number of Vercel functions at 12. These tests cover
// the routing itself and then the action logic through createHandler.

test.describe('api/extras dispatcher', () => {
  test('an unknown action returns 404', async () => {
    const res = makeRes();
    await extras(makeReq({ method: 'POST', query: { action: 'nope' } }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Unknown action' });
  });

  test('a missing action returns 404', async () => {
    const res = makeRes();
    await extras(makeReq({ method: 'POST', query: {} }), res);
    assert.equal(res.statusCode, 404);
  });

  test('an action name that only exists on Object.prototype is not dispatched', async () => {
    // Without the hasOwnProperty guard, ?action=constructor would resolve to a function.
    for (const action of ['constructor', 'toString', '__proto__']) {
      const res = makeRes();
      await extras(makeReq({ method: 'POST', query: { action } }), res);
      assert.equal(res.statusCode, 404, `${action} must not be treated as an action`);
      assert.deepEqual(res.body, { error: 'Unknown action' });
    }
  });

  test('a known action is dispatched rather than reported as unknown', async () => {
    // No real Redis credentials in unit tests, so the action fails on its own;
    // what matters here is that it was recognised and routed. Dummy values stop
    // the client library logging a missing-token warning during the test.
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    const res = makeRes();
    await extras(makeReq({ method: 'POST', query: { action: 'undo-delete' }, body: { id: 'abc' } }), res);
    assert.notEqual(res.statusCode, 404);
    assert.notEqual(res.body?.error, 'Unknown action');
  });
});

test.describe('undo-delete action', () => {
  const RECIPE = { id: 'r1', title: 'Lemon Pasta', tags: ['pasta'] };

  function seeded() {
    const kv = createFakeKv();
    return kv;
  }

  test('rejects a non-POST method', async () => {
    const res = makeRes();
    await createUndoDelete({ kv: seeded() })(makeReq({ method: 'GET' }), res);
    assert.equal(res.statusCode, 405);
  });

  test('answers a preflight', async () => {
    const res = makeRes();
    await createUndoDelete({ kv: seeded() })(makeReq({ method: 'OPTIONS' }), res);
    assert.equal(res.statusCode, 204);
  });

  test('refuses an unauthenticated request', async () => {
    delete process.env.ACCESS_CODE;
    delete process.env.SESSION_SECRET;
    const res = makeRes();
    await createUndoDelete({ kv: seeded() })(makeReq({ method: 'POST', body: { id: 'r1' } }), res);
    assert.equal(res.statusCode, 500); // misconfigured server, not a silent allow
  });

  test('rejects an invalid id', async () => {
    const res = makeRes();
    await createUndoDelete({ kv: seeded() })(
      makeReq({ method: 'POST', body: { id: 'not valid!' }, cookie: sessionCookie() }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Invalid or missing id' });
  });

  test('returns 410 when the undo window has passed', async () => {
    const res = makeRes();
    await createUndoDelete({ kv: seeded() })(
      makeReq({ method: 'POST', body: { id: 'gone1' }, cookie: sessionCookie() }),
      res
    );
    assert.equal(res.statusCode, 410);
  });

  test('restores the recipe, its photos and its id in the list', async () => {
    const kv = seeded();
    const cookie = sessionCookie();
    await kv.set('trash:r1', {
      recipe: RECIPE,
      photo: 'data:image/jpeg;base64,AAA',
      photothumb: 'data:image/jpeg;base64,BBB',
      deletedAt: Date.now(),
    });
    await kv.lpush('recipe_ids', 'other1');

    const res = makeRes();
    await createUndoDelete({ kv })(makeReq({ method: 'POST', body: { id: 'r1' }, cookie }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.title, 'Lemon Pasta');
    assert.equal(res.body.alreadyThere, false);

    assert.deepEqual(await kv.get('recipe:r1'), RECIPE);
    assert.equal(await kv.get('photo:r1'), 'data:image/jpeg;base64,AAA');
    assert.equal(await kv.get('photothumb:r1'), 'data:image/jpeg;base64,BBB');
    assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), ['r1', 'other1']);
    // The trash copy is consumed so a second undo cannot resurrect it again.
    assert.equal(await kv.get('trash:r1'), null);
  });

  test('a retried undo does not duplicate the id or overwrite the recipe', async () => {
    const kv = seeded();
    const cookie = sessionCookie();
    await kv.set('trash:r1', { recipe: RECIPE, deletedAt: Date.now() });
    await kv.set('recipe:r1', { ...RECIPE, title: 'Edited after restore' });
    await kv.lpush('recipe_ids', 'r1');

    const res = makeRes();
    await createUndoDelete({ kv })(makeReq({ method: 'POST', body: { id: 'r1' }, cookie }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.alreadyThere, true);
    assert.equal((await kv.get('recipe:r1')).title, 'Edited after restore');
    assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), ['r1']);
  });

  test('expired trash keys really are gone', async () => {
    const kv = seeded();
    const cookie = sessionCookie();
    await kv.set('trash:r2', { recipe: RECIPE }, { ex: 0.001 });
    await new Promise((r) => setTimeout(r, 20));

    const res = makeRes();
    await createUndoDelete({ kv })(makeReq({ method: 'POST', body: { id: 'r2' }, cookie }), res);
    assert.equal(res.statusCode, 410);
  });
});
