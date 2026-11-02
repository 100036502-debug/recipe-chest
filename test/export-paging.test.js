import test from 'node:test';
import assert from 'node:assert';

// recipe_ids is a list that new recipes are pushed onto the front of. Paging it
// by number meant a delete between two slices skipped a live recipe's photo, and
// the backup still looked complete.

const SECRET = 'c'.repeat(48);
process.env.BACKUP_SECRET = SECRET;
process.env.ACCESS_CODE = 'open-sesame';
process.env.SESSION_SECRET = 'session-secret';

const { default: exportHandler, __setKvForTests } = await import('../api/export.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');

const auth = { authorization: `Bearer ${SECRET}` };

async function chest(ids) {
  const kv = createFakeKv();
  for (const id of ids) {
    await kv.set(`recipe:${id}`, { id, title: id });
    await kv.set(`photo:${id}`, `P${id}`);
    await kv.set(`photothumb:${id}`, `T${id}`);
  }
  // pushed in this order, so the list reads newest first: last id is index 0
  for (const id of ids) await kv.lpush('recipe_ids', id);
  __setKvForTests(kv);
  return kv;
}

async function slice(query) {
  const res = makeRes();
  await exportHandler(makeReq({ method: 'GET', headers: auth, query: { photos: '1', ...query } }), res);
  return res;
}

// Pages exactly as apps-script/Backup.gs does, optionally changing the chest
// between the first and second slice.
async function backup({ limit = 2, between = async () => {}, useCursor = true } = {}) {
  const got = [];
  let offset = 0;
  let after = '';
  let round = 0;
  for (;;) {
    const res = await slice({ offset: String(offset), limit: String(limit), ...(useCursor && after ? { after } : {}) });
    assert.equal(res.statusCode, 200);
    got.push(...Object.keys(res.body.photos));
    if (res.body.done) break;
    offset = res.body.nextOffset;
    after = res.body.nextAfter || after;
    if (round === 0) await between();
    round += 1;
    assert.ok(round < 50, 'terminates');
  }
  return got;
}

test('a quiet chest exports every photo exactly once', async () => {
  await chest(['a', 'b', 'c', 'd', 'e']);
  const got = await backup();
  assert.deepEqual([...got].sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('a recipe deleted between slices no longer costs another recipe its photo', async () => {
  const kv = await chest(['a', 'b', 'c', 'd', 'e']);
  // list is e d c b a; the first slice takes e and d, then e is deleted
  const got = await backup({
    between: async () => { await kv.lrem('recipe_ids', 0, 'e'); await kv.del('recipe:e', 'photo:e', 'photothumb:e'); },
  });
  for (const live of ['a', 'b', 'c', 'd']) assert.ok(got.includes(live), `${live} is in the backup`);
});

test('the same scenario with a bare numeric offset does lose one, which is why the cursor exists', async () => {
  const kv = await chest(['a', 'b', 'c', 'd', 'e']);
  const got = await backup({
    useCursor: false,
    between: async () => { await kv.lrem('recipe_ids', 0, 'e'); await kv.del('recipe:e', 'photo:e', 'photothumb:e'); },
  });
  assert.equal(['a', 'b', 'c', 'd'].every((id) => got.includes(id)), false, 'offset paging skips a live photo');
});

test('a recipe added between slices does not make the backup miss anything', async () => {
  const kv = await chest(['a', 'b', 'c', 'd', 'e']);
  const got = await backup({
    between: async () => {
      await kv.set('recipe:n', { id: 'n', title: 'n' });
      await kv.set('photo:n', 'Pn'); await kv.set('photothumb:n', 'Tn');
      await kv.lpush('recipe_ids', 'n');
    },
  });
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.ok(got.includes(id), `${id} is in the backup`);
  assert.equal(new Set(got).size, got.length, 'and nothing is sent twice');
});

test('a cursor whose recipe has since been deleted falls back to the offset instead of restarting', async () => {
  const kv = await chest(['a', 'b', 'c', 'd', 'e']);
  await kv.lrem('recipe_ids', 0, 'e');
  const res = await slice({ offset: '1', limit: '2', after: 'e' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.photos), ['c', 'b'], 'it carried on from the number');
});

test('a malformed cursor is ignored, not trusted', async () => {
  await chest(['a', 'b', 'c']);
  const res = await slice({ offset: '0', limit: '2', after: '../x:y' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.photos), ['c', 'b']);
});

test('the response still carries nextOffset for a client that has not been updated', async () => {
  await chest(['a', 'b', 'c', 'd']);
  const res = await slice({ offset: '0', limit: '2' });
  assert.equal(res.body.nextOffset, 2);
  assert.equal(res.body.done, false);
});

test('the backup script sends the cursor', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../apps-script/Backup.gs', import.meta.url), 'utf8');
  assert.match(src, /'&after=' \+ encodeURIComponent\(after\)/);
  assert.match(src, /after = slice\.nextAfter \|\| after;/);
});
