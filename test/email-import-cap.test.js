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

test('the importer refuses once today is spent, before doing any work', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);

  const day = new Date().toISOString().slice(0, 10);
  await kv.set(`email_import_daily:${day}`, 1); // limit is 1 in this file

  const res = makeRes();
  await importEmail(makeReq({ method: 'POST', headers: auth, body: {} }), res);
  assert.equal(res.statusCode, 429);
  assert.match(String(res.body.error), /Daily email import limit/);
});

test('the cap counts AI calls, so a mail with PDFs costs more than one', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);

  // Four PDFs would be four calls: refused outright before any of them runs.
  const res = makeRes();
  await importEmail(makeReq({
    method: 'POST',
    headers: auth,
    body: { attachments: [1, 2, 3, 4].map((n) => ({ type: 'application/pdf', filename: `r${n}.pdf`, content: 'AA==' })) },
  }), res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body.error), /At most 3 PDFs/);

  const images = makeRes();
  await importEmail(makeReq({
    method: 'POST',
    headers: auth,
    body: { attachments: [1, 2, 3, 4].map((n) => ({ type: 'image/jpeg', filename: `p${n}.jpg`, content: 'AA==' })) },
  }), images);
  assert.equal(images.statusCode, 400);
  assert.match(String(images.body.error), /At most 3 images/);
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
