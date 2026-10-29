import test from 'node:test';
import assert from 'node:assert';

import { lookupDishImage, findDishImage, __cacheKey } from '../lib/image.js';
import { createFakeKv } from './helpers/fake-kv.js';

const ACCESS_KEY = 'test-access-key';

const PHOTO = {
  alt_description: 'a bowl of soup',
  urls: { regular: 'https://images.unsplash.com/photo-1?w=800', small: 'https://images.unsplash.com/photo-1?w=200' },
  links: {
    html: 'https://unsplash.com/photos/abc',
    download_location: 'https://api.unsplash.com/photos/abc/download',
  },
  user: { name: 'Ada', links: { html: 'https://unsplash.com/@ada' } },
};

function stubFetch({ results = [PHOTO], searchStatus = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, method: options.method || 'GET' });
    if (href.includes('/search/photos')) {
      return {
        status: searchStatus,
        ok: searchStatus >= 200 && searchStatus < 300,
        headers: { get: () => null },
        json: async () => ({ results }),
      };
    }
    return { status: 200, ok: true, json: async () => ({}), headers: { get: () => null } };
  };
  return {
    calls,
    searches: () => calls.filter((c) => c.url.includes('/search/photos')),
    pings: () => calls.filter((c) => c.url.includes('/download')),
    restore: () => { globalThis.fetch = original; },
  };
}

function withKey(fn) {
  const saved = process.env.UNSPLASH_ACCESS_KEY;
  process.env.UNSPLASH_ACCESS_KEY = ACCESS_KEY;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.UNSPLASH_ACCESS_KEY;
      else process.env.UNSPLASH_ACCESS_KEY = saved;
    });
}

test('the cache key ignores case, punctuation and accents', () => {
  assert.equal(__cacheKey('Crème Brûlée food'), __cacheKey('creme brulee FOOD'));
  assert.equal(__cacheKey("Chef's Soup food"), __cacheKey('chefs soup food'));
  assert.match(__cacheKey('Tomato Soup food'), /^imgcache:tomato-soup-food$/);
  assert.equal(__cacheKey('   '), '');
});

test('a miss searches once, stores the photo, and pings', () => withKey(async () => {
  const kv = createFakeKv();
  const net = stubFetch();
  try {
    const first = await lookupDishImage('Tomato Soup recipe', { kv });
    assert.equal(first.status, 'ok');
    assert.equal(first.image.alt, 'a bowl of soup');
    assert.equal(net.searches().length, 1);
    assert.equal(net.pings().length, 1, 'the download ping is part of a real search');
    assert.ok(await kv.get(__cacheKey('Tomato Soup food')), 'the found photo is stored');
  } finally { net.restore(); }
}));

test('a hit makes no search request but still pings', () => withKey(async () => {
  const kv = createFakeKv();
  await kv.set(__cacheKey('Tomato Soup food'), { image: { ...PHOTO.urls, url: PHOTO.urls.regular, downloadLocation: PHOTO.links.download_location, photographer: 'Ada', source: 'Unsplash' } });

  const net = stubFetch();
  try {
    const second = await lookupDishImage('tomato soup', { kv });
    assert.equal(second.status, 'ok');
    assert.equal(net.searches().length, 0, 'the whole point: no search request');
    assert.equal(net.pings().length, 1, 'Unsplash is still told the photo was used');
    assert.equal(second.image.url, PHOTO.urls.regular);
  } finally { net.restore(); }
}));

test('a similar title reuses the same entry', () => withKey(async () => {
  const kv = createFakeKv();
  const net = stubFetch();
  try {
    await lookupDishImage('Easy Tomato Soup', { kv });
    await lookupDishImage('tomato soup recipe', { kv });
    await lookupDishImage('TOMATO SOUP', { kv });
    assert.equal(net.searches().length, 1, 'three titles, one search');
  } finally { net.restore(); }
}));

test('a cached miss answers none without a request', () => withKey(async () => {
  const kv = createFakeKv();
  await kv.set(__cacheKey('Unicorn Stew food'), { none: true });

  const net = stubFetch();
  try {
    const result = await lookupDishImage('Unicorn Stew', { kv });
    assert.deepEqual(result, { image: null, status: 'none' });
    assert.equal(net.searches().length, 0);
    assert.equal(net.pings().length, 0);
  } finally { net.restore(); }
}));

test('an empty search result is cached as none', () => withKey(async () => {
  const kv = createFakeKv();
  const net = stubFetch({ results: [] });
  try {
    const first = await lookupDishImage('Nothing At All', { kv });
    assert.equal(first.status, 'none');
    const stored = await kv.get(__cacheKey('Nothing At All food'));
    assert.deepEqual(stored, { none: true });
  } finally { net.restore(); }
}));

test('rate limits and errors are never cached', () => withKey(async () => {
  const kv = createFakeKv();
  const limited = stubFetch({ searchStatus: 403 });
  try {
    const result = await lookupDishImage('Rate Limited Dish', { kv });
    assert.equal(result.status, 'rate_limited');
    assert.equal(await kv.get(__cacheKey('Rate Limited Dish food')), null, 'a limit is temporary');
  } finally { limited.restore(); }

  const broken = stubFetch({ searchStatus: 500 });
  try {
    const result = await lookupDishImage('Broken Dish', { kv });
    assert.equal(result.status, 'error');
    assert.equal(await kv.get(__cacheKey('Broken Dish food')), null);
  } finally { broken.restore(); }
}));

test('without a client nothing is cached and nothing breaks', () => withKey(async () => {
  const net = stubFetch();
  try {
    const first = await lookupDishImage('Tomato Soup');
    const second = await lookupDishImage('Tomato Soup');
    assert.equal(first.status, 'ok');
    assert.equal(second.status, 'ok');
    assert.equal(net.searches().length, 2, 'no kv means no sharing');
  } finally { net.restore(); }
}));

test('findDishImage still returns just the image', () => withKey(async () => {
  const kv = createFakeKv();
  const net = stubFetch();
  try {
    const image = await findDishImage('Tomato Soup', { kv });
    assert.equal(image.url, PHOTO.urls.regular);
    assert.equal(image.source, 'Unsplash');
  } finally { net.restore(); }
}));

test('a broken cache is a miss, not an import failure', () => withKey(async () => {
  const kv = {
    get: async () => { throw new Error('redis down'); },
    set: async () => { throw new Error('redis down'); },
  };
  const net = stubFetch();
  try {
    const result = await lookupDishImage('Tomato Soup', { kv });
    assert.equal(result.status, 'ok');
  } finally { net.restore(); }
}));
