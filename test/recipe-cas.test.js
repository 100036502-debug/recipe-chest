import test from 'node:test';
import assert from 'node:assert';

import { createFakeKv } from './helpers/fake-kv.js';
import { updateRecipe, revOf, CAS_SCRIPT, MAX_UPDATE_TRIES } from '../lib/update-recipe.js';

// C1: recipes carry a rev, and a write only lands on the revision it was built
// from. Two writers that overlap must not lose each other's work.

function seed(kv, over = {}) {
  return kv.set('recipe:r1', { id: 'r1', title: 'Soup', ingredients: ['water'], ...over });
}

test('a new recipe starts at rev 0 and each write bumps it', async () => {
  const kv = createFakeKv();
  await seed(kv);
  assert.equal(revOf(await kv.get('recipe:r1')), 0);

  const first = await updateRecipe(kv, 'r1', (r) => ({ ...r, title: 'Soup two' }));
  assert.equal(first.status, 200);
  assert.equal(first.body.rev, 1);

  const second = await updateRecipe(kv, 'r1', (r) => ({ ...r, notes: 'salty' }));
  assert.equal(second.body.rev, 2);
  assert.equal(second.body.title, 'Soup two', 'the earlier edit survived');
});

test('a recipe written before rev existed still updates', async () => {
  const kv = createFakeKv();
  await seed(kv); // no rev field at all
  const result = await updateRecipe(kv, 'r1', (r) => ({ ...r, notes: 'old recipe' }));
  assert.equal(result.status, 200);
  assert.equal(result.body.rev, 1);
});

test('two interleaved writers that touch different fields both survive', async () => {
  const kv = createFakeKv();
  await seed(kv);

  // Both read rev 0 before either writes: the classic lost update.
  const writerA = updateRecipe(kv, 'r1', async (recipe) => {
    await new Promise((r) => setTimeout(r, 5)); // A is slow, B lands first
    return { ...recipe, notes: 'from A' };
  });
  const writerB = updateRecipe(kv, 'r1', (recipe) => ({ ...recipe, title: 'From B' }));

  const [a, b] = await Promise.all([writerA, writerB]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const stored = await kv.get('recipe:r1');
  assert.equal(stored.notes, 'from A', "A's note survived");
  assert.equal(stored.title, 'From B', "B's title survived");
  assert.equal(stored.rev, 2, 'one bump per landed write');
});

test('a stupid conflict gives up with 409 and the current recipe', async () => {
  const kv = createFakeKv();
  await seed(kv);

  // Every attempt fights a writer that keeps landing first: simulate by
  // bumping the rev underneath each read.
  let bumped = 0;
  const result = await updateRecipe(kv, 'r1', async (recipe) => {
    bumped += 1;
    await kv.set('recipe:r1', { ...(await kv.get('recipe:r1')), rev: 1000 + bumped });
    return { ...recipe, notes: 'never lands' };
  });

  assert.equal(result.status, 409);
  assert.match(result.body.error, /changed this recipe|Reload/i);
  assert.equal(result.body.rev, 1000 + bumped, 'the caller gets the revision to reload');
  assert.ok(result.body.current, 'and the recipe itself');
  assert.equal(bumped, MAX_UPDATE_TRIES, 'it retried the stated number of times');
});

test('a stale baseRev is refused before anything is written', async () => {
  const kv = createFakeKv();
  await seed(kv, { rev: 4 });

  let ran = false;
  const result = await updateRecipe(kv, 'r1', (r) => { ran = true; return { ...r, title: 'x' }; }, { baseRev: 3 });

  assert.equal(result.status, 409);
  assert.equal(ran, false, 'the mutation was never applied');
  assert.equal(result.body.rev, 4);
  assert.equal((await kv.get('recipe:r1')).title, 'Soup');
});

test('a matching baseRev is applied', async () => {
  const kv = createFakeKv();
  await seed(kv, { rev: 7 });
  const result = await updateRecipe(kv, 'r1', (r) => ({ ...r, title: 'Fresh' }), { baseRev: 7 });
  assert.equal(result.status, 200);
  assert.equal(result.body.rev, 8);
});

test('a mutation that returns nothing writes nothing', async () => {
  const kv = createFakeKv();
  await seed(kv);
  const result = await updateRecipe(kv, 'r1', () => null);
  assert.equal(result.status, 200);
  assert.equal(result.changed, false);
  assert.equal(revOf(await kv.get('recipe:r1')), 0, 'the rev did not move');
});

test('a missing recipe is a 404, not a silent create', async () => {
  const kv = createFakeKv();
  const result = await updateRecipe(kv, 'gone', (r) => ({ ...r, title: 'x' }));
  assert.equal(result.status, 404);
  assert.equal(await kv.get('recipe:gone'), null);
});

test('the compare-and-set is one Lua script when the store supports eval', async () => {
  const calls = [];
  const store = new Map([['recipe:r1', { id: 'r1', title: 'Soup', rev: 2 }]]);
  const kv = {
    async get(key) { return store.get(key) || null; },
    async eval(script, keys, args) {
      calls.push({ script, keys, args });
      const current = store.get(keys[0]);
      if (!current || revOf(current) !== Number(args[0])) return 0;
      store.set(keys[0], JSON.parse(args[1]));
      return 1;
    },
  };

  const result = await updateRecipe(kv, 'r1', (r) => ({ ...r, notes: 'y' }));
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, CAS_SCRIPT);
  assert.deepEqual(calls[0].keys, ['recipe:r1']);
  assert.equal(calls[0].args[0], '2', 'it compares against the rev it read');
  assert.equal(JSON.parse(calls[0].args[1]).rev, 3, 'and writes rev + 1');
});

test('the Lua script compares the stored rev and sets only on a match', () => {
  assert.match(CAS_SCRIPT, /redis\.call\('GET', KEYS\[1\]\)/);
  assert.match(CAS_SCRIPT, /if rev ~= expected then return 0 end/);
  assert.match(CAS_SCRIPT, /redis\.call\('SET', KEYS\[1\], ARGV\[2\]\)/);
  assert.equal(MAX_UPDATE_TRIES, 3);
});
