import test from 'node:test';
import assert from 'node:assert';

process.env.ACCESS_CODE = 'open-sesame';
process.env.SESSION_SECRET = 'session-secret';

const { default: verifyCode, __setKvForTests } = await import('../api/verify-code.js');
const { bumpCounter, getClientIp, failurePenalty, limits, rateLimited } = await import('../lib/rate-limit.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');

test('the counter always ends up with an expiry', async () => {
  const kv = createFakeKv();
  assert.equal(await bumpCounter(kv, 'k', 60), 1);
  assert.ok(await kv.ttl('k') > 0, 'the first bump sets a TTL');

  // A key that somehow lost its expiry is repaired on the next request rather
  // than locking the caller out for ever.
  await kv.set('k', 5); // no expiry
  assert.equal(await kv.ttl('k'), -1);
  assert.equal(await bumpCounter(kv, 'k', 60), 6);
  assert.ok(await kv.ttl('k') > 0, 'the TTL was restored');
});

test('the counter survives a ttl() that throws', async () => {
  const kv = createFakeKv();
  kv.ttl = async () => { throw new Error('ttl unavailable'); };
  assert.equal(await bumpCounter(kv, 'k', 60), 1);
  assert.equal(await bumpCounter(kv, 'k', 60), 2);
});

test('the client address prefers the headers only Vercel can set', () => {
  const withAll = {
    headers: {
      'x-vercel-forwarded-for': '198.51.100.7',
      'x-real-ip': '198.51.100.8',
      'x-forwarded-for': '198.51.100.9, 10.0.0.1',
    },
  };
  assert.equal(getClientIp(withAll), '198.51.100.7', 'the platform header wins');

  assert.equal(getClientIp({ headers: { 'x-real-ip': '198.51.100.8' } }), '198.51.100.8');
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' } }), '198.51.100.9');
  assert.equal(getClientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(getClientIp({ headers: {} }), 'unknown');
  assert.equal(getClientIp({ headers: { 'x-real-ip': 'bad ip; drop table' } }), 'badipdroptable');
});

test('the failure penalty only starts above the threshold', () => {
  const was = limits.failurePenaltyMs;
  limits.failurePenaltyMs = 40;
  try {
    assert.equal(failurePenalty(limits.globalFailureThreshold), 0);
    assert.equal(failurePenalty(limits.globalFailureThreshold + 1), 40);
  } finally {
    limits.failurePenaltyMs = was;
  }
});

async function wrongCode(kv, headers = { 'x-vercel-forwarded-for': '203.0.113.50' }) {
  __setKvForTests(kv);
  const res = makeRes();
  const started = Date.now();
  await verifyCode(makeReq({ method: 'POST', body: { code: 'nope' }, headers }), res);
  return { res, elapsed: Date.now() - started };
}

test('a pile of failures slows a wrong code down without locking anyone out', async () => {
  const kv = createFakeKv();
  await kv.set('verify_failures:global', limits.globalFailureThreshold + 5);
  await kv.expire('verify_failures:global', 3600);

  const was = limits.failurePenaltyMs;
  limits.failurePenaltyMs = 60;
  try {
    const { res, elapsed } = await wrongCode(kv);
    assert.equal(res.statusCode, 401, 'still a normal refusal, not a lockout');
    assert.ok(elapsed >= 55, `the answer was held back (${elapsed} ms)`);
    assert.equal(await kv.get('verify_failures:global'), limits.globalFailureThreshold + 6);
  } finally {
    limits.failurePenaltyMs = was;
  }
});

test('a correct code is never delayed, even with many failures', async () => {
  const kv = createFakeKv();
  await kv.set('verify_failures:global', 5000);
  await kv.expire('verify_failures:global', 3600);

  __setKvForTests(kv);
  const res = makeRes();
  await verifyCode(makeReq({
    method: 'POST',
    body: { code: 'open-sesame' },
    headers: { 'x-vercel-forwarded-for': '203.0.113.51' },
  }), res);
  assert.equal(res.statusCode, 200);
});

test('the per-IP attempt window keeps expiring', async () => {
  const kv = createFakeKv();
  await wrongCode(kv);
  const ttl = await kv.ttl('verify_attempts:203.0.113.50');
  assert.ok(ttl > 0 && ttl <= 900, `the attempt key expires within the window (${ttl})`);
});

test('rateLimited still fails open when Redis is down', async () => {
  const broken = { incr: async () => { throw new Error('down'); } };
  const over = await rateLimited(broken, { headers: {} }, 'test', 1);
  assert.equal(over, false);
});
