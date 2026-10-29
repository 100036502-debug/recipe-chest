import test from 'node:test';
import assert from 'node:assert';

import { createHandler as createHealth } from '../lib/actions/health.js';
import { createHandler as createClientError } from '../lib/actions/client-error.js';
import { logInfo, logError } from '../lib/log.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

// Captures what a handler wrote to the console and parses the JSON lines back.
function captureConsole() {
  const lines = { log: [], error: [] };
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.log.push(args.join(' '));
  console.error = (...args) => lines.error.push(args.join(' '));
  return {
    lines,
    restore() { console.log = original.log; console.error = original.error; },
    parsed(kind) { return lines[kind].map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }); },
  };
}

const IP = { 'x-forwarded-for': '203.0.113.9' };

test.describe('api/health', () => {
  test('reports ok and reachable redis', async () => {
    const cap = captureConsole();
    const res = makeRes();
    await createHealth({ kv: createFakeKv() })(makeReq({ method: 'GET', headers: IP }), res);
    cap.restore();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, redis: true });
    assert.equal(res.headers['cache-control'], 'no-store');
    // Nothing beyond the two booleans may leak.
    assert.deepEqual(Object.keys(res.body).sort(), ['ok', 'redis']);
  });

  test('still answers ok when redis is down, with redis:false', async () => {
    const kv = createFakeKv();
    kv.ping = async () => { throw new Error('redis unreachable'); };
    const cap = captureConsole();
    const res = makeRes();
    await createHealth({ kv })(makeReq({ method: 'GET', headers: IP }), res);
    const errors = cap.parsed('error');
    cap.restore();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, redis: false });
    assert.equal(errors[0].event, 'health-redis-unreachable');
  });

  test('rejects methods other than GET', async () => {
    const cap = captureConsole();
    const res = makeRes();
    await createHealth({ kv: createFakeKv() })(makeReq({ method: 'POST', headers: IP }), res);
    cap.restore();
    assert.equal(res.statusCode, 405);
  });

  test('is limited to 60 checks a minute per ip', async () => {
    const cap = captureConsole();
    const kv = createFakeKv();
    const handler = createHealth({ kv });
    let last;
    for (let i = 0; i < 61; i++) {
      last = makeRes();
      await handler(makeReq({ method: 'GET', headers: IP }), last);
    }
    cap.restore();
    assert.equal(last.statusCode, 429);
  });

  test('a minute later the health limit has reset', async () => {
    const cap = captureConsole();
    const kv = createFakeKv();
    const handler = createHealth({ kv });
    for (let i = 0; i < 61; i++) await handler(makeReq({ method: 'GET', headers: IP }), makeRes());
    // Drop the counter the way the 60 second expiry would.
    await kv.del('rl:health:203.0.113.9');
    const res = makeRes();
    await handler(makeReq({ method: 'GET', headers: IP }), res);
    cap.restore();
    assert.equal(res.statusCode, 200);
  });
});

test.describe('api/client-error', () => {
  const long = 'x'.repeat(2000);

  test('logs a trimmed report and returns 204', async () => {
    const cap = captureConsole();
    const res = makeRes();
    await createClientError({ kv: createFakeKv() })(
      makeReq({
        method: 'POST',
        cookie: sessionCookie(),
        headers: IP,
        body: {
          message: long,
          source: long,
          url: long,
          stack: 'y'.repeat(2000),
          line: 42,
          col: 7,
        },
      }),
      res
    );
    const errors = cap.parsed('error');
    cap.restore();

    assert.equal(res.statusCode, 204);
    assert.equal(errors.length, 1);
    const entry = errors[0];
    assert.equal(entry.level, 'error');
    assert.equal(entry.event, 'client-error');
    assert.equal(entry.message.length, 500, 'message is truncated to 500');
    assert.equal(entry.stack.length, 1500, 'stack is truncated to 1500');
    assert.equal(entry.source.length, 500);
    assert.equal(entry.url.length, 500);
    assert.equal(entry.line, 42);
    assert.equal(entry.col, 7);
    assert.ok(entry.t, 'has a timestamp');
  });

  test('drops fields that are not strings', async () => {
    const cap = captureConsole();
    const res = makeRes();
    await createClientError({ kv: createFakeKv() })(
      makeReq({
        method: 'POST',
        cookie: sessionCookie(),
        headers: IP,
        body: { message: { evil: true }, source: 12, url: ['a'], stack: null, line: 'not a number', col: {} },
      }),
      res
    );
    const entry = cap.parsed('error')[0];
    cap.restore();

    assert.equal(res.statusCode, 204);
    assert.equal(entry.message, 'Unknown client error');
    assert.equal(entry.source, '');
    assert.equal(entry.url, '');
    assert.equal(entry.stack, undefined);
    assert.equal(entry.line, 0);
    assert.equal(entry.col, 0);
  });

  test('rejects a request with no session', async () => {
    delete process.env.ACCESS_CODE;
    delete process.env.SESSION_SECRET;
    const cap = captureConsole();
    const res = makeRes();
    await createClientError({ kv: createFakeKv() })(
      makeReq({ method: 'POST', headers: IP, body: { message: 'boom' } }),
      res
    );
    cap.restore();
    assert.equal(res.statusCode, 500);
  });

  test('rejects a bad cookie', async () => {
    sessionCookie();
    const cap = captureConsole();
    const res = makeRes();
    await createClientError({ kv: createFakeKv() })(
      makeReq({ method: 'POST', headers: IP, cookie: 'rc_session=123.forged', body: { message: 'boom' } }),
      res
    );
    cap.restore();
    assert.equal(res.statusCode, 401);
  });

  test('is limited to 20 reports an hour per ip', async () => {
    const kv = createFakeKv();
    const handler = createClientError({ kv });
    const cookie = sessionCookie();
    const cap = captureConsole();
    let last;
    for (let i = 0; i < 21; i++) {
      last = makeRes();
      await handler(makeReq({ method: 'POST', cookie, headers: IP, body: { message: 'boom ' + i } }), last);
    }
    const logged = cap.lines.error.length;
    cap.restore();
    assert.equal(last.statusCode, 429);
    assert.equal(logged, 20, 'only the first 20 reports are logged');
  });

  test('rejects methods other than POST', async () => {
    const cap = captureConsole();
    const res = makeRes();
    await createClientError({ kv: createFakeKv() })(makeReq({ method: 'GET', headers: IP }), res);
    cap.restore();
    assert.equal(res.statusCode, 405);
  });
});

test.describe('lib/log', () => {
  test('logInfo writes one JSON line', () => {
    const cap = captureConsole();
    logInfo('recipe-saved', { id: 'r1', count: 2 });
    const entry = cap.parsed('log')[0];
    cap.restore();

    assert.equal(entry.level, 'info');
    assert.equal(entry.event, 'recipe-saved');
    assert.equal(entry.id, 'r1');
    assert.equal(entry.count, 2);
    assert.ok(!Number.isNaN(Date.parse(entry.t)));
    assert.equal(cap.lines.log.length, 1, 'exactly one line');
  });

  test('logError carries message and a truncated stack', () => {
    const cap = captureConsole();
    const err = new Error('kaboom');
    err.stack = 'z'.repeat(3000);
    logError('boom', err, { route: '/api/recipes' });
    const entry = cap.parsed('error')[0];
    cap.restore();

    assert.equal(entry.level, 'error');
    assert.equal(entry.message, 'kaboom');
    assert.equal(entry.stack.length, 1500);
    assert.equal(entry.route, '/api/recipes');
  });

  test('never logs credentials', () => {
    const cap = captureConsole();
    logError('login', new Error('bad code'), {
      cookie: 'rc_session=secret-value',
      token: 'abc',
      ACCESS_CODE: 'hunter2',
      password: 'hunter2',
      session: 'x',
      ok: 'kept',
    });
    const entry = cap.parsed('error')[0];
    const raw = cap.lines.error[0];
    cap.restore();

    assert.equal(entry.cookie, '[redacted]');
    assert.equal(entry.token, '[redacted]');
    assert.equal(entry.ACCESS_CODE, '[redacted]');
    assert.equal(entry.password, '[redacted]');
    assert.equal(entry.session, '[redacted]');
    assert.equal(entry.ok, 'kept');
    assert.ok(!raw.includes('hunter2'), 'the access code must not appear');
    assert.ok(!raw.includes('secret-value'), 'the cookie must not appear');
  });

  test('accepts a plain message and an object with message/stack', () => {
    const cap = captureConsole();
    logError('plain', 'just a string');
    logError('from-object', { message: 'nested', stack: 'trace' });
    const [first, second] = cap.parsed('error');
    cap.restore();

    assert.equal(first.message, 'just a string');
    assert.equal(second.message, 'nested');
    assert.equal(second.stack, 'trace');
  });
});
