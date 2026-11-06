import test from 'node:test';
import assert from 'node:assert';

import { normalizeIncomingRecipe } from '../lib/recipes.js';
import { createHandler as createShare } from '../lib/actions/share.js';
import { createHandler as createView } from '../lib/actions/share-view.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

function req(opts) {
  return makeReq({ method: 'GET', headers: { cookie: sessionCookie() }, ...opts });
}

async function call(handler, reqObj) {
  const res = makeRes();
  await handler(reqObj, res);
  return res;
}

test('a long source url survives normalizing, up to 2000 characters', () => {
  const url = 'https://example.com/' + 'a'.repeat(900);
  assert.equal(normalizeIncomingRecipe({ sourceUrl: url }).sourceUrl, url);
  const tooLong = 'https://example.com/' + 'a'.repeat(3000);
  assert.equal(normalizeIncomingRecipe({ sourceUrl: tooLong }).sourceUrl.length, 2000);
});

test('a source url that is not http(s) is dropped', () => {
  assert.equal(normalizeIncomingRecipe({ sourceUrl: 'javascript:alert(1)' }).sourceUrl, '');
  assert.equal(normalizeIncomingRecipe({ sourceUrl: 'data:text/html,hi' }).sourceUrl, '');
  assert.equal(normalizeIncomingRecipe({ sourceUrl: '' }).sourceUrl, '');
});

test('a share record without expiresAt is treated as expired', async () => {
  const kv = createFakeKv();
  await kv.set('recipe:r1', { id: 'r1', title: 'Soup', ingredients: ['water'] });
  await kv.set('share:' + 'a'.repeat(32), { recipeId: 'r1', createdAt: 1 });
  const res = await call(createView({ kv }), req({ query: { token: 'a'.repeat(32) } }));
  assert.equal(res.statusCode, 404);
});

test('a shorter share link never shortens the lifetime of the link index', async () => {
  const base = createFakeKv();
  const ttls = new Map();
  // The fake store keeps no expiry on sets, so track it here like Redis would.
  const kv = Object.assign(Object.create(base), {
    async ttl(key) {
      return key.startsWith('share_tokens:') ? (ttls.has(key) ? ttls.get(key) : -2) : base.ttl(key);
    },
    async expire(key, seconds) {
      if (key.startsWith('share_tokens:')) ttls.set(key, seconds);
      return base.expire(key, seconds);
    },
  });
  await base.set('recipe:r1', { id: 'r1', title: 'Soup', ingredients: ['water'] });

  const handler = createShare({ kv, now: () => 1000 });
  await call(handler, req({ method: 'POST', body: { id: 'r1', days: 90 } }));
  await call(handler, req({ method: 'POST', body: { id: 'r1', days: 7 } }));

  assert.equal(ttls.get('share_tokens:r1'), 90 * 86400);
});
