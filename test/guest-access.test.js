import test from 'node:test';
import { createHmac } from 'node:crypto';
import assert from 'node:assert';

import { makeSessionValue, getSession, hasValidSession, requireAuth, guestCode } from '../lib/auth.js';
import { makeRes, makeReq } from './helpers/fake-http.js';

const MEMBER = 'open-sesame';
const GUEST = 'just-looking';

function withEnv(env, fn) {
  const saved = {};
  for (const key of ['ACCESS_CODE', 'SESSION_SECRET', 'GUEST_CODE']) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const restore = () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  try {
    const out = fn();
    // An async body must keep the environment until it settles, not just until
    // the promise is created.
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

const MEMBER_ENV = { ACCESS_CODE: MEMBER, SESSION_SECRET: 'secret', GUEST_CODE: GUEST };
const GUEST_OFF_ENV = { ACCESS_CODE: MEMBER, SESSION_SECRET: 'secret', GUEST_CODE: undefined };

function cookies(token) {
  return { cookie: `rc_session=${token}` };
}

test('a member cookie carries an expiry, an epoch and a signature', () => {
  withEnv(MEMBER_ENV, () => {
    const token = makeSessionValue(MEMBER);
    assert.match(token, /^\d+\.\d+\.[0-9a-f]{64}$/);
    const session = getSession(makeReq({ headers: cookies(token) }));
    assert.equal(session.role, 'member');
    assert.equal(hasValidSession(makeReq({ headers: cookies(token) })), true);
  });
});

test('a cookie issued before the epoch existed still verifies, as epoch 0', () => {
  withEnv(MEMBER_ENV, () => {
    // The old shape: "<expiry>.<sig over code.expiry>", with no epoch segment.
    const expiry = Date.now() + 86400000;
    const legacy = `${expiry}.${createHmac('sha256', process.env.SESSION_SECRET).update(`${MEMBER}.${expiry}`).digest('hex')}`;
    const session = getSession(makeReq({ headers: cookies(legacy) }));
    assert.equal(session.role, 'member');
    assert.equal(session.epoch, 0, 'an old cookie counts as epoch 0');
  });
});

test('a guest cookie carries the guest mark and verifies separately', () => {
  withEnv(MEMBER_ENV, () => {
    const token = makeSessionValue(GUEST, undefined, 'guest');
    assert.match(token, /^\d+\.guest\.\d+\.[0-9a-f]{64}$/);
    const session = getSession(makeReq({ headers: cookies(token) }));
    assert.equal(session.role, 'guest');
  });
});

test('a member cookie cannot be turned into a guest cookie', () => {
  withEnv(MEMBER_ENV, () => {
    const member = makeSessionValue(MEMBER);
    const forged = member.replace(/^(\d+)\./, '$1.guest.');
    assert.equal(getSession(makeReq({ headers: cookies(forged) })), null);
  });
});

test('tampered and expired cookies are rejected', () => {
  withEnv(MEMBER_ENV, () => {
    const token = makeSessionValue(MEMBER);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    assert.equal(getSession(makeReq({ headers: cookies(tampered) })), null);

    const expired = makeSessionValue(MEMBER, Date.now() - 1000);
    assert.equal(getSession(makeReq({ headers: cookies(expired) })), null);
    assert.equal(getSession(makeReq({ headers: {} })), null);
  });
});

test('a guest cookie dies when GUEST_CODE is removed or changed', () => {
  const token = withEnv(MEMBER_ENV, () => makeSessionValue(GUEST, undefined, 'guest'));

  withEnv(GUEST_OFF_ENV, () => {
    assert.equal(guestCode(), '');
    assert.equal(getSession(makeReq({ headers: cookies(token) })), null);
  });

  withEnv({ ...MEMBER_ENV, GUEST_CODE: 'something-else' }, () => {
    assert.equal(getSession(makeReq({ headers: cookies(token) })), null);
  });

  withEnv(MEMBER_ENV, () => {
    assert.equal(getSession(makeReq({ headers: cookies(token) })).role, 'guest');
  });
});

test('GUEST_CODE equal to ACCESS_CODE is ignored', () => {
  withEnv({ ACCESS_CODE: MEMBER, SESSION_SECRET: 'secret', GUEST_CODE: MEMBER }, () => {
    assert.equal(guestCode(), '');
    const token = makeSessionValue(MEMBER, undefined, 'guest');
    assert.equal(getSession(makeReq({ headers: cookies(token) })), null);
  });
});

test('requireAuth answers for each role and method', async () => {
  await withEnv(MEMBER_ENV, async () => {
    const memberToken = makeSessionValue(MEMBER);
    const guestToken = makeSessionValue(GUEST, undefined, 'guest');

    const run = async (token, method, opts) => {
      const res = makeRes();
      const req = makeReq({ method, headers: token ? cookies(token) : {} });
      const allowed = await requireAuth(req, res, opts);
      return { allowed, status: res.statusCode, body: res.body };
    };

    // no session at all
    assert.equal((await run(null, 'GET')).status, 401);

    // a member may do everything
    assert.equal((await run(memberToken, 'GET')).allowed, true);
    assert.equal((await run(memberToken, 'POST')).allowed, true);
    assert.equal((await run(memberToken, 'DELETE', { memberOnly: true })).allowed, true);

    // a guest may read
    assert.equal((await run(guestToken, 'GET')).allowed, true);
    assert.equal((await run(guestToken, 'HEAD')).allowed, true);

    // but not write
    const write = await run(guestToken, 'POST');
    assert.equal(write.allowed, false);
    assert.equal(write.status, 403);
    assert.deepEqual(write.body, { error: 'View-only access' });

    // unless the route says so
    assert.equal((await run(guestToken, 'POST', { allowGuestWrite: true })).allowed, true);

    // and never on a member-only route
    const memberOnly = await run(guestToken, 'GET', { memberOnly: true });
    assert.equal(memberOnly.allowed, false);
    assert.equal(memberOnly.status, 403);
  });
});

test('a missing ACCESS_CODE is still a server error, not a 401', async () => {
  await withEnv({ ACCESS_CODE: undefined, SESSION_SECRET: 'secret' }, async () => {
    const res = makeRes();
    assert.equal(await requireAuth(makeReq({ method: 'GET', headers: {} }), res), false);
    assert.equal(res.statusCode, 500);
  });
});
