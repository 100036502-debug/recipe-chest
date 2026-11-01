import test from 'node:test';
import assert from 'node:assert';

// S5: a Redis outage narrows the limiter to one instance, it does not remove it.

const { rateLimited, memoryLimited, __resetMemoryBuckets } = await import('../lib/rate-limit.js');

const brokenKv = {
  incr: async () => { throw new Error('redis down'); },
  expire: async () => { throw new Error('redis down'); },
  ttl: async () => { throw new Error('redis down'); },
};

const req = (ip) => ({ headers: { 'x-forwarded-for': ip } });

test('with Redis down the limit still applies per instance', async () => {
  __resetMemoryBuckets();
  const results = [];
  for (let i = 0; i < 12; i += 1) {
    results.push(await rateLimited(brokenKv, req('203.0.113.7'), 'login', 10, 900));
  }
  assert.equal(results.filter(Boolean).length, 2, 'the 11th and 12th are refused');
  assert.equal(results[9], false, 'the tenth is still allowed');
  assert.equal(results[10], true);
});

test('one address does not use up another address budget', async () => {
  __resetMemoryBuckets();
  for (let i = 0; i < 11; i += 1) await rateLimited(brokenKv, req('203.0.113.7'), 'login', 10, 900);
  assert.equal(await rateLimited(brokenKv, req('203.0.113.8'), 'login', 10, 900), false);
});

test('the window resets', () => {
  __resetMemoryBuckets();
  const now = 1_000_000;
  for (let i = 0; i < 10; i += 1) memoryLimited('login', 'ip', 10, 60, now);
  assert.equal(memoryLimited('login', 'ip', 10, 60, now + 1000), true);
  assert.equal(memoryLimited('login', 'ip', 10, 60, now + 61_000), false, 'a new window starts clean');
});

test('the fallback cannot grow without bound', () => {
  __resetMemoryBuckets();
  const now = 2_000_000;
  for (let i = 0; i < 6000; i += 1) memoryLimited('login', `ip-${i}`, 10, 60, now);
  // Still answering, and the oldest slots were reused rather than kept for ever.
  assert.equal(memoryLimited('login', 'ip-fresh', 10, 60, now), false);
});
