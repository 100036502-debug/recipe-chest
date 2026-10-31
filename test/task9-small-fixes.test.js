import test from 'node:test';
import assert from 'node:assert';

import { baseUrl } from '../lib/actions/share.js';
import { publicView } from '../lib/actions/share-view.js';

// ---- 9c: a share link must not be minted from a forged Host header ---------

function reqWithHost(host) {
  return { headers: { host, 'x-forwarded-host': host } };
}

function withEnv(env, fn) {
  const saved = {};
  for (const key of ['PUBLIC_BASE_URL', 'VERCEL_ENV', 'NODE_ENV']) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const PROD = { PUBLIC_BASE_URL: undefined, VERCEL_ENV: 'production', NODE_ENV: undefined };
const DEV = { PUBLIC_BASE_URL: undefined, VERCEL_ENV: undefined, NODE_ENV: undefined };

test('PUBLIC_BASE_URL wins over any host header', () => {
  withEnv({ ...DEV, PUBLIC_BASE_URL: 'https://chest.example.com/' }, () => {
    assert.equal(baseUrl(reqWithHost('evil.example')), 'https://chest.example.com');
  });
});

test('production without PUBLIC_BASE_URL falls back to a relative link', () => {
  withEnv(PROD, () => {
    assert.equal(baseUrl(reqWithHost('evil.example')), '');
  });
});

test('development may use the host header', () => {
  withEnv(DEV, () => {
    assert.equal(baseUrl(reqWithHost('localhost:3000')), 'https://localhost:3000');
  });
});

// ---- 9d: a shared photo may only come from Unsplash ------------------------

const RECIPE = { title: 'Pasta', ingredients: ['flour'], instructions: ['boil'] };

test('an Unsplash photo survives the whitelist', () => {
  const out = publicView({ ...RECIPE, image: { url: 'https://images.unsplash.com/photo-1.jpg' } }, false);
  assert.equal(out.image.url, 'https://images.unsplash.com/photo-1.jpg');
});

test('a photo from any other host is dropped', () => {
  const out = publicView({ ...RECIPE, image: { url: 'https://evil.example/x.jpg' } }, false);
  assert.equal(out.image.url, '');
});

test('a javascript: photo URL is dropped', () => {
  const out = publicView({ ...RECIPE, image: { url: 'javascript:alert(1)' } }, false);
  assert.equal(out.image.url, '');
});
