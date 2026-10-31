import test from 'node:test';
import assert from 'node:assert';

process.env.EMAIL_IMPORT_SECRET = 'import-secret';
process.env.GROQ_API_KEY = 'test-key';
process.env.EMAIL_IMPORT_DAILY_LIMIT = '1';

const { default: importEmail } = await import('../api/import-email.js');
const { __setKvForTests } = await import('../lib/redis.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');

const auth = { authorization: 'Bearer import-secret' };

test('the importer stops at the daily cap', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);

  // The first request is allowed past the cap and fails later on the body, which
  // is fine: what matters is that the second one is refused by the counter.
  const first = makeRes();
  await importEmail(makeReq({ method: 'POST', headers: auth, body: {} }), first);
  assert.notEqual(first.statusCode, 429);

  const second = makeRes();
  await importEmail(makeReq({ method: 'POST', headers: auth, body: {} }), second);
  assert.equal(second.statusCode, 429);
  assert.match(String(second.body.error), /Daily email import limit/);
});

test('a counter outage lets the mail through instead of blocking it', async () => {
  __setKvForTests({
    incr: async () => { throw new Error('redis down'); },
    expire: async () => { throw new Error('redis down'); },
    ttl: async () => { throw new Error('redis down'); },
  });

  const res = makeRes();
  await importEmail(makeReq({ method: 'POST', headers: auth, body: {} }), res);
  assert.notEqual(res.statusCode, 429);
});

test('the wrong bearer secret is still refused before the counter runs', async () => {
  __setKvForTests(createFakeKv());
  const res = makeRes();
  await importEmail(makeReq({ method: 'POST', headers: { authorization: 'Bearer nope' }, body: {} }), res);
  assert.equal(res.statusCode, 401);
});
