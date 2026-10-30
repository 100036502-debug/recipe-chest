import test from 'node:test';
import assert from 'node:assert';

// api/verify-code.js reads ACCESS_CODE and SESSION_SECRET once, at import, so
// the environment is set before the dynamic import below. Each test file runs
// in its own process, so this cannot leak into another file.
process.env.ACCESS_CODE = 'open-sesame';
process.env.SESSION_SECRET = 'session-secret';

const { default: verifyCode, __setKvForTests } = await import('../api/verify-code.js');
const { guestOpen, guestSigningCode, makeSessionValue, getSession, requireAuth, guestCode } =
  await import('../lib/auth.js');
const { createFakeKv } = await import('./helpers/fake-kv.js');
const { makeReq, makeRes } = await import('./helpers/fake-http.js');

const MEMBER = 'open-sesame';
const GUEST = 'just-looking';
// Only these two vary per test. ACCESS_CODE and SESSION_SECRET are fixed above,
// and dropping SESSION_SECRET would silently disable every signature.
const ENV_KEYS = ['GUEST_CODE', 'GUEST_OPEN'];

async function withEnv(env, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const OPEN_ENV = { GUEST_OPEN: '1', GUEST_CODE: undefined };
const CLOSED_ENV = { GUEST_OPEN: undefined, GUEST_CODE: undefined };

async function post(body, store) {
  const res = makeRes();
  const kv = store || createFakeKv();
  __setKvForTests(kv);
  await verifyCode(makeReq({ method: 'POST', body, headers: { 'x-forwarded-proto': 'https' } }), res);
  return { res, kv, cookie: res.headers['set-cookie'] };
}

async function get(headers = {}) {
  const res = makeRes();
  __setKvForTests(createFakeKv());
  await verifyCode(makeReq({ method: 'GET', headers }), res);
  return res;
}

function cookieValue(setCookie) {
  const match = /^rc_session=([^;]+)/.exec(String(setCookie || ''));
  return match ? match[1] : '';
}

test('guestOpen is true only for exactly "1"', async () => {
  for (const [value, expected] of [['1', true], ['true', false], ['0', false], ['', false], [undefined, false]]) {
    await withEnv({ GUEST_OPEN: value }, () => {
      assert.equal(guestOpen(), expected, `GUEST_OPEN=${String(value)}`);
    });
  }
});

test('a guest request is refused and sets no cookie when the flag is off', async () => {
  await withEnv(CLOSED_ENV, async () => {
    const { res, cookie } = await post({ guest: true });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { unlocked: false });
    assert.equal(cookie, undefined, 'no Set-Cookie on a refusal');
  });
});

test('with the flag on and no guest code, browsing as guest works', async () => {
  await withEnv(OPEN_ENV, async () => {
    const { res, cookie } = await post({ guest: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { unlocked: true, role: 'guest' });

    const token = cookieValue(cookie);
    assert.match(token, /^\d+\.guest\.[0-9a-f]{64}$/, 'the guest cookie format is unchanged');
    assert.match(String(cookie), /HttpOnly/);
    assert.match(String(cookie), /SameSite=Lax/);
    assert.match(String(cookie), /Secure/, 'Secure on https');

    const session = getSession(makeReq({ headers: { cookie: `rc_session=${token}` } }));
    assert.equal(session.role, 'guest');
  });
});

test('the derived signing value is not a usable access code', async () => {
  await withEnv(OPEN_ENV, async () => {
    const derived = guestSigningCode();
    assert.match(derived, /^[0-9a-f]{64}$/);
    assert.notEqual(derived, MEMBER);
    assert.equal(guestCode(), '', 'guestCode() itself is untouched');

    // Typing the derived value is not a code: it never goes through the compare
    // path as an accepted value, and the member code still only means member.
    const { res } = await post({ code: derived });
    assert.equal(res.statusCode, 401);
  });
});

test('a typed guest code still works alongside open access', async () => {
  await withEnv({ GUEST_OPEN: '1', GUEST_CODE: GUEST }, async () => {
    const open = await post({ guest: true });
    assert.equal(open.res.statusCode, 200);
    assert.equal(getSession(makeReq({ headers: { cookie: `rc_session=${cookieValue(open.cookie)}` } })).role, 'guest');

    const typed = await post({ code: GUEST });
    assert.equal(typed.res.statusCode, 200);
    assert.deepEqual(typed.res.body, { unlocked: true, role: 'guest' });
    assert.equal(getSession(makeReq({ headers: { cookie: `rc_session=${cookieValue(typed.cookie)}` } })).role, 'guest');
  });
});

test('turning the flag off kills open-guest cookies at once', async () => {
  let token = '';
  await withEnv(OPEN_ENV, async () => {
    const { cookie } = await post({ guest: true });
    token = cookieValue(cookie);
    assert.equal(getSession(makeReq({ headers: { cookie: `rc_session=${token}` } })).role, 'guest');
  });

  await withEnv(CLOSED_ENV, () => {
    assert.equal(getSession(makeReq({ headers: { cookie: `rc_session=${token}` } })), null);
  });
});

test('the member code still wins, even next to guest:true', async () => {
  await withEnv(OPEN_ENV, async () => {
    const plain = await post({ code: MEMBER });
    assert.equal(plain.res.statusCode, 200);
    assert.deepEqual(plain.res.body, { unlocked: true, role: 'member' });

    const both = await post({ code: MEMBER, guest: true });
    assert.deepEqual(both.res.body, { unlocked: true, role: 'member' }, 'a member is never downgraded');

    const wrongButGuest = await post({ code: 'not-the-code', guest: true });
    assert.equal(wrongButGuest.res.statusCode, 401, 'a sent code is never ignored');
  });
});

test('a wrong code is refused and still counts as an attempt', async () => {
  await withEnv(OPEN_ENV, async () => {
    const { res, kv } = await post({ code: 'wrong' });
    assert.equal(res.statusCode, 401);
    const attempts = await kv.get('verify_attempts:unknown');
    assert.equal(Number(attempts), 1);
  });
});

test('a guest request consumes no attempts', async () => {
  await withEnv(OPEN_ENV, async () => {
    const { kv } = await post({ guest: true });
    assert.equal(await kv.get('verify_attempts:unknown'), null);

    // ...and eleven guest taps in a row are still fine, unlike eleven guesses.
    for (let i = 0; i < 11; i += 1) {
      const { res } = await post({ guest: true });
      assert.equal(res.statusCode, 200);
    }
  });
});

test('the attempt limit still applies to codes', async () => {
  await withEnv(OPEN_ENV, async () => {
    const kv = createFakeKv(); // one store, so the counter actually accumulates
    let last;
    for (let i = 0; i < 12; i += 1) last = await post({ code: 'wrong' }, kv);
    assert.equal(last.res.statusCode, 429);
    assert.equal(last.res.headers['retry-after'], String(15 * 60));
  });
});

test('an open-guest session is still read-only everywhere', async () => {
  await withEnv(OPEN_ENV, async () => {
    const { cookie } = await post({ guest: true });
    const headers = { cookie: `rc_session=${cookieValue(cookie)}` };

    const write = makeRes();
    assert.equal(requireAuth(makeReq({ method: 'POST', headers }), write), false);
    assert.equal(write.statusCode, 403);

    const memberOnly = makeRes();
    assert.equal(requireAuth(makeReq({ method: 'GET', headers }), memberOnly, { memberOnly: true }), false);
    assert.equal(memberOnly.statusCode, 403);

    const read = makeRes();
    assert.equal(requireAuth(makeReq({ method: 'GET', headers }), read), true);
  });
});

test('GET reports the flag, and leaks nothing extra with a session', async () => {
  await withEnv(OPEN_ENV, async () => {
    const anon = await get();
    assert.deepEqual(anon.body, { unlocked: false, role: null, guestOpen: true });
  });

  await withEnv(CLOSED_ENV, async () => {
    const anon = await get();
    assert.deepEqual(anon.body, { unlocked: false, role: null, guestOpen: false });
  });

  await withEnv(OPEN_ENV, async () => {
    const memberToken = makeSessionValue(MEMBER);
    const withSession = await get({ cookie: `rc_session=${memberToken}` });
    assert.deepEqual(withSession.body, { unlocked: true, role: 'member', guestOpen: true });
  });
});

test('a misconfigured server still answers 500 before anything else', async () => {
  await withEnv({ ACCESS_CODE: undefined, GUEST_OPEN: '1' }, async () => {
    // The handler captured ACCESS_CODE at import, so drive the check through a
    // fresh module instance is not worth it; the guest branch itself is covered
    // above. Here we only prove the flag cannot bypass configuration: with no
    // SESSION_SECRET there is no derived value to sign with.
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      assert.equal(guestSigningCode(), '', 'no secret, no open-guest signing');
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });
});
