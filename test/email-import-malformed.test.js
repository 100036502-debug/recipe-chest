import test from 'node:test';
import assert from 'node:assert';

// The mail script retries a 5xx as transient, and each retry costs AI calls, so
// a malformed payload has to be answered as the sender's mistake (4xx) and never
// as a crash (500).

process.env.EMAIL_IMPORT_SECRET = 'import-secret';
process.env.GROQ_API_KEY = 'test-key';
process.env.EMAIL_IMPORT_DAILY_LIMIT = '50';

const { default: importEmail } = await import('../api/import-email.js');
const { __setKvForTests } = await import('../lib/redis.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');

const auth = { authorization: 'Bearer import-secret' };

async function send(body) {
  __setKvForTests(createFakeKv());
  const res = makeRes();
  await importEmail(makeReq({ method: 'POST', headers: auth, body }), res);
  return res;
}

test('an attachment whose type is a number is skipped, not a crash', async () => {
  const res = await send({ attachments: [{ type: 42, filename: 'x', content: 'AA==' }] });
  assert.notEqual(res.statusCode, 500);
  assert.equal(res.statusCode, 422, 'nothing to extract is the sender\'s outcome');
});

test('null, string and array entries in attachments are ignored', async () => {
  const res = await send({ attachments: [null, 'x', 7, [], undefined, true] });
  assert.equal(res.statusCode, 422);
});

test('an object as a filename or content is ignored rather than thrown on', async () => {
  const res = await send({
    attachments: [
      { type: 'application/pdf', filename: { a: 1 }, content: { b: 2 } },
      { type: 'image/png', filename: ['x'], content: 12345 },
    ],
  });
  assert.equal(res.statusCode, 422);
});

test('attachments that is not an array at all is treated as none', async () => {
  const res = await send({ attachments: { type: 'application/pdf' } });
  assert.equal(res.statusCode, 422);
});

test('a PDF is recognised by its file name when the type is missing', async () => {
  // Four of them trips the per-request cap before any AI call, which proves the
  // name was understood without needing the model.
  const four = [1, 2, 3, 4].map((n) => ({ filename: `R${n}.PDF`, content: 'AA==' }));
  const res = await send({ attachments: four });
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body.error), /At most 3 PDFs/);
});

test('the secret is still required', async () => {
  __setKvForTests(createFakeKv());
  const res = makeRes();
  await importEmail(makeReq({ method: 'POST', headers: {}, body: {} }), res);
  assert.equal(res.statusCode, 401);
});
