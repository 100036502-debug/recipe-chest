import test from 'node:test';
import assert from 'node:assert';

import { createHandler } from '../lib/actions/import-text.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

const MODEL_JSON = JSON.stringify({
  title: 'Pasted Soup',
  description: 'From a message',
  mealType: 'dinner',
  tags: ['soup'],
  ingredients: ['2 cups stock', '1 onion'],
  instructions: ['Simmer everything.'],
});

function run(kv, body, chat) {
  const res = makeRes();
  const req = makeReq({ method: 'POST', body, headers: { cookie: sessionCookie() } });
  const handler = createHandler({ kv, chat, now: () => 1000, });
  return handler(req, res).then(() => res);
}

test('import-text rejects short text', async () => {
  const res = await run(createFakeKv(), { text: 'soup' }, async () => MODEL_JSON);
  assert.equal(res.statusCode, 400);
});

test('import-text rejects very long text', async () => {
  const res = await run(createFakeKv(), { text: 'x'.repeat(12001) }, async () => MODEL_JSON);
  assert.equal(res.statusCode, 400);
});

test('import-text saves a recipe from model output', async () => {
  const kv = createFakeKv();
  const res = await run(kv, { text: 'a'.repeat(60), addedBy: 'Sam' }, async () => MODEL_JSON);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.title, 'Pasted Soup');
  assert.equal(res.body.addedBy, 'Sam');
  const ids = await kv.lrange('recipe_ids', 0, -1);
  assert.equal(ids.length, 1);
});

test('import-text reports a duplicate with 409', async () => {
  const kv = createFakeKv();
  await run(kv, { text: 'a'.repeat(60) }, async () => MODEL_JSON);
  const res = await run(kv, { text: 'a'.repeat(60) }, async () => MODEL_JSON);
  assert.equal(res.statusCode, 409);
  assert.ok(res.body.duplicate);
});

test('import-text saves a copy when asked', async () => {
  const kv = createFakeKv();
  await run(kv, { text: 'a'.repeat(60) }, async () => MODEL_JSON);
  const res = await run(kv, { text: 'a'.repeat(60), skipDuplicateCheck: true }, async () => MODEL_JSON);
  assert.equal(res.statusCode, 200);
});
