import test from 'node:test';
import assert from 'node:assert';

import exportHandler, { __setKvForTests } from '../api/export.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { hasBearerSecret, makeSessionValue } from '../lib/auth.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

const SECRET = 'b'.repeat(48);

// An empty store: these tests are about who may call /api/export, not its contents.
const store = createFakeKv();
__setKvForTests(store);

async function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try { return await fn(); } finally {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function call(headers) {
  const res = makeRes();
  await exportHandler(makeReq({ method: 'GET', headers }), res);
  return res;
}

test('hasBearerSecret only accepts the exact secret', () => {
  assert.equal(hasBearerSecret(makeReq({ headers: { authorization: `Bearer ${SECRET}` } }), SECRET), true);
  assert.equal(hasBearerSecret(makeReq({ headers: { authorization: `Bearer ${SECRET}x` } }), SECRET), false);
  assert.equal(hasBearerSecret(makeReq({ headers: { authorization: `Bearer ${SECRET.slice(1)}` } }), SECRET), false);
  assert.equal(hasBearerSecret(makeReq({ headers: { authorization: SECRET } }), SECRET), false, 'the scheme is required');
  assert.equal(hasBearerSecret(makeReq({ headers: {} }), SECRET), false);
  assert.equal(hasBearerSecret(makeReq({ headers: { authorization: `Bearer ${SECRET}` } }), ''), false, 'an unset secret never matches');
  assert.equal(hasBearerSecret(makeReq({ headers: { authorization: 'Bearer ' } }), ''), false);
});

test('export accepts the backup secret', async () => {
  await withEnv({ BACKUP_SECRET: SECRET, ACCESS_CODE: 'code', SESSION_SECRET: 'session-secret' }, async () => {
    const res = await call({ authorization: `Bearer ${SECRET}` });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.recipes));
  });
});

test('export refuses a wrong or unset secret', async () => {
  await withEnv({ BACKUP_SECRET: SECRET, ACCESS_CODE: 'code', SESSION_SECRET: 'session-secret' }, async () => {
    assert.equal((await call({ authorization: `Bearer ${'c'.repeat(48)}` })).statusCode, 401);
    assert.equal((await call({})).statusCode, 401, 'no credentials at all');
  });

  await withEnv({ BACKUP_SECRET: '', ACCESS_CODE: 'code', SESSION_SECRET: 'session-secret' }, async () => {
    const res = await call({ authorization: 'Bearer ' });
    assert.equal(res.statusCode, 401, 'an empty secret is not a wildcard');
    const unset = await withEnv({ BACKUP_SECRET: undefined }, () => call({ authorization: 'Bearer ' }));
    assert.equal(unset.statusCode, 401);
  });
});

test('a member session still works, a guest session does not', async () => {
  await withEnv({ BACKUP_SECRET: SECRET, ACCESS_CODE: 'code', SESSION_SECRET: 'session-secret', GUEST_CODE: 'guest-code' }, async () => {
    const member = await call({ cookie: `rc_session=${makeSessionValue('code')}` });
    assert.equal(member.statusCode, 200);

    const guestValue = makeSessionValue('guest-code', undefined, 'guest');
    const guest = await call({ cookie: `rc_session=${guestValue}` });
    assert.equal(guest.statusCode, 403);
    assert.deepEqual(guest.body, { error: 'View-only access' });
  });
});

test('the secret is not a way around a wrong method', async () => {
  await withEnv({ BACKUP_SECRET: SECRET, ACCESS_CODE: 'code', SESSION_SECRET: 'session-secret' }, async () => {
    const res = makeRes();
    await exportHandler(makeReq({ method: 'DELETE', headers: { authorization: `Bearer ${SECRET}` } }), res);
    assert.equal(res.statusCode, 405);
  });
});
