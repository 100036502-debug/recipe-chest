import test from 'node:test';
import assert from 'node:assert';

import { createHandler } from '../lib/actions/cooked.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

const today = new Date().toISOString().slice(0, 10);
const RECIPE = { id: 'r1', title: 'Soup', ingredients: ['x'], instructions: ['y'], cookLog: [] };

async function withRecipe(extra) {
  const kv = createFakeKv();
  await kv.set('recipe:r1', { ...RECIPE, ...(extra || {}) });
  return kv;
}
async function call(kv, opts) {
  const res = makeRes();
  const req = makeReq({
    method: opts.method || 'POST',
    query: opts.query || {},
    body: opts.body || {},
    headers: 'headers' in opts ? opts.headers : { cookie: sessionCookie() },
  });
  await createHandler({ kv })(req, res);
  return res;
}

test('cooked needs a session', async () => {
  const kv = await withRecipe();
  sessionCookie();
  const res = await call(kv, { body: { id: 'r1' }, headers: {} });
  assert.equal(res.statusCode, 401);
});

test('cooked rejects a bad id', async () => {
  const kv = await withRecipe();
  const res = await call(kv, { body: { id: 'not a valid id!' } });
  assert.equal(res.statusCode, 400);
});

test('cooked 404s when the recipe is gone', async () => {
  const kv = createFakeKv();
  const res = await call(kv, { body: { id: 'missing' } });
  assert.equal(res.statusCode, 404);
});

test('an entry gets an id and defaults to today', async () => {
  const kv = await withRecipe();
  const res = await call(kv, { body: { id: 'r1', rating: 4, note: ' Lovely ', by: 'Sam' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cookLog.length, 1);
  const entry = res.body.cookLog[0];
  assert.match(entry.id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(entry.date, today);
  assert.equal(entry.rating, 4);
  assert.equal(entry.note, 'Lovely');
  assert.equal(entry.by, 'Sam');
});

test('ratings outside 1 to 5 are refused', async () => {
  const kv = await withRecipe();
  assert.equal((await call(kv, { body: { id: 'r1', rating: 0 } })).statusCode, 400);
  assert.equal((await call(kv, { body: { id: 'r1', rating: 6 } })).statusCode, 400);
  assert.equal((await call(kv, { body: { id: 'r1', rating: 2.5 } })).statusCode, 400);
});

test('a rating is optional', async () => {
  const kv = await withRecipe();
  const res = await call(kv, { body: { id: 'r1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cookLog[0].rating, null);
});

test('impossible and far-future dates are refused', async () => {
  const kv = await withRecipe();
  assert.equal((await call(kv, { body: { id: 'r1', date: '2025-02-30' } })).statusCode, 400);
  const far = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  assert.equal((await call(kv, { body: { id: 'r1', date: far } })).statusCode, 400);
});

test('the log never grows past 50 entries', async () => {
  const log = Array.from({ length: 55 }, (_, i) => ({
    id: 'e' + i,
    date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    rating: null,
    note: '',
    by: '',
  }));
  const kv = await withRecipe({ cookLog: log });
  const res = await call(kv, { body: { id: 'r1', date: today } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cookLog.length, 50);
  assert.ok(res.body.cookLog.some((e) => e.date === today), 'the new entry is kept');
});

test('delete removes one entry and is idempotent', async () => {
  const kv = await withRecipe({ cookLog: [{ id: 'e1', date: today, rating: 5, note: '', by: '' }] });
  const res = await call(kv, { method: 'DELETE', query: { id: 'r1', entry: 'e1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cookLog.length, 0);

  const again = await call(kv, { method: 'DELETE', query: { id: 'r1', entry: 'e1' } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.cookLog.length, 0);
});

test('the note is trimmed to 300 characters and stripped of markup', async () => {
  const kv = await withRecipe();
  const res = await call(kv, { body: { id: 'r1', note: '<b>' + 'x'.repeat(400) + '</b>' } });
  assert.equal(res.body.cookLog[0].note.length, 300);
  assert.ok(!res.body.cookLog[0].note.includes('<'));
});
