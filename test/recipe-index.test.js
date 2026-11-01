import test from 'node:test';
import assert from 'node:assert';

import { createFakeKv } from './helpers/fake-kv.js';
import { listRecipeId, unlistRecipeId } from '../lib/recipe-index.js';

// The list and the set must agree, and an id must never appear in the list twice.

test('a new id lands in both indexes', async () => {
  const kv = createFakeKv();
  assert.equal(await listRecipeId(kv, 'r1'), true);
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), ['r1']);
  assert.equal(Number(await kv.sismember('recipe_id_set', 'r1')), 1);
});

test('listing the same id twice pushes it once', async () => {
  const kv = createFakeKv();
  await listRecipeId(kv, 'r1');
  assert.equal(await listRecipeId(kv, 'r1'), false);
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), ['r1']);
});

test('an id already in the list from before the set existed is not doubled', async () => {
  const kv = createFakeKv();
  await kv.lpush('recipe_ids', 'old1'); // a legacy chest: list only, no set
  assert.equal(await listRecipeId(kv, 'old1'), false);
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), ['old1'], 'still one entry');
  assert.equal(Number(await kv.sismember('recipe_id_set', 'old1')), 1, 'and now the set agrees');
});

test('removing an id clears both indexes', async () => {
  const kv = createFakeKv();
  await listRecipeId(kv, 'r1');
  await listRecipeId(kv, 'r2');
  await unlistRecipeId(kv, 'r1');
  assert.deepEqual(await kv.lrange('recipe_ids', 0, -1), ['r2']);
  assert.equal(Number(await kv.sismember('recipe_id_set', 'r1')), 0);
});

test('no route pushes to recipe_ids behind the helper any more', async () => {
  const { execSync } = await import('node:child_process');
  const out = execSync(
    "grep -rln \"lpush('recipe_ids'\" api lib --include=*.js || true",
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean);
  assert.deepEqual(out, ['lib/recipe-index.js']);
});
