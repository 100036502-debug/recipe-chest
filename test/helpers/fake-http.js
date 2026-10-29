// Minimal request/response doubles so handler logic can be tested without a
// server. The response records the status, JSON body and headers so a test can
// assert on exactly what the browser would receive.
import { makeSessionValue } from '../../lib/auth.js';

export const TEST_ACCESS_CODE = 'test-access-code';
export const TEST_SESSION_SECRET = 'test-session-secret';

export function makeReq({ method = 'GET', query = {}, body = {}, headers = {}, cookie } = {}) {
  const merged = { ...headers };
  if (cookie) merged.cookie = cookie;
  return { method, query, body, headers: merged };
}

export function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    headersSent: false,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; res.headersSent = true; return res; },
    send(payload) { res.body = payload; res.headersSent = true; return res; },
    setHeader(key, value) { res.headers[String(key).toLowerCase()] = value; return res; },
    end(payload) { if (payload !== undefined) res.body = payload; res.headersSent = true; return res; },
  };
  return res;
}

// Sets the env the auth layer reads and returns a Cookie header value.
// `role` is accepted for future use: the app has no roles today.
export function sessionCookie(role = 'member') {
  process.env.ACCESS_CODE = TEST_ACCESS_CODE;
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  return `rc_session=${encodeURIComponent(makeSessionValue(TEST_ACCESS_CODE))}`;
}
