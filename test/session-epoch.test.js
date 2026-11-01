import test from 'node:test';
import assert from 'node:assert';

// S4: a session can be revoked without rotating SESSION_SECRET.

process.env.ACCESS_CODE = 'open-sesame';
process.env.SESSION_SECRET = 'session-secret';

const { makeSessionValue, requireAuth, revokeAllSessions, SESSION_EPOCH_KEY } =
  await import('../lib/auth.js');
const { __setKvForTests } = await import('../lib/redis.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');

const cookieFor = (epoch) => ({ cookie: `rc_session=${makeSessionValue('open-sesame', undefined, 'member', epoch)}` });

test('a cookie at the current epoch is accepted', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);
  const res = makeRes();
  assert.equal(await requireAuth(makeReq({ method: 'GET', headers: cookieFor(0) }), res), true);
});

test('bumping the epoch ends every session issued before it', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);

  const oldCookie = cookieFor(0);
  assert.equal(await requireAuth(makeReq({ method: 'GET', headers: oldCookie }), makeRes()), true);

  assert.equal(await revokeAllSessions(kv), 1);
  assert.equal(await kv.get(SESSION_EPOCH_KEY), 1);

  const after = makeRes();
  assert.equal(await requireAuth(makeReq({ method: 'GET', headers: oldCookie }), after), false);
  assert.equal(after.statusCode, 401);
  assert.match(String(after.body.error), /Session has ended/);

  // a cookie minted after the bump works again
  assert.equal(await requireAuth(makeReq({ method: 'GET', headers: cookieFor(1) }), makeRes()), true);
});

test('a revocable cookie cannot be edited to claim a newer epoch', async () => {
  const kv = createFakeKv();
  __setKvForTests(kv);
  await revokeAllSessions(kv);

  const [expiry] = makeSessionValue('open-sesame', undefined, 'member', 0).split('.');
  const forged = `${expiry}.99.${'a'.repeat(64)}`;
  const res = makeRes();
  assert.equal(await requireAuth(makeReq({ method: 'GET', headers: { cookie: `rc_session=${forged}` } }), res), false);
  assert.equal(res.statusCode, 401);
});

test('a Redis outage fails open rather than logging the household out', async () => {
  __setKvForTests({
    get: async () => { throw new Error('redis down'); },
    incr: async () => { throw new Error('redis down'); },
  });
  const res = makeRes();
  assert.equal(await requireAuth(makeReq({ method: 'GET', headers: cookieFor(7) }), res), true,
    'availability wins over a revocation we cannot check');
});

test('guests are not exposed to the epoch check', async () => {
  __setKvForTests({ get: async () => 5, incr: async () => 6 });
  const guest = makeSessionValue('guest-code', undefined, 'guest', 0);
  process.env.GUEST_CODE = 'guest-code';
  try {
    assert.equal(await requireAuth(makeReq({ method: 'GET', headers: { cookie: `rc_session=${guest}` } }), makeRes()), true);
  } finally {
    delete process.env.GUEST_CODE;
  }
});
