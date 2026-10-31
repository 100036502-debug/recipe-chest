// Recipe Chest — service worker
const CACHE_NAME = 'recipe-chest-v18';
const OFFLINE_URL = '/offline.html';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
  '/css/app.css',
  '/js/theme.js',
  '/js/app.js',
  '/js/utils.js',
];

// Install: pre-cache the app shell. Each asset is added independently
// so one missing file can't break the whole install.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('Precache miss:', url, err.message);
          })
        )
      );
      // No skipWaiting() here: activating silently would reload the page
      // under the user (the app reloads on controllerchange) and could
      // wipe an in-progress upload queue. The new worker takes over only
      // when the user taps the update toast, which posts SKIP_WAITING.
    })
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: strategy per request type
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // 1. Never cache API requests, and never cache anything share related: the
  // links are revocable and must not survive in a cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/') || url.pathname === '/share.html') {
    return;
  }

  // 2. Navigation: network-first, fall back to cached shell then offline page
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/index.html').then((r) => r || caches.match(OFFLINE_URL))
      )
    );
    return;
  }

  // 3. App code (CSS/JS): network-first so a new deploy is used immediately.
  //     The cache is only the offline fallback.
  if (url.origin === self.location.origin &&
      (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/'))) {
    event.respondWith(
      fetch(request, { cache: 'no-cache' })
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match(OFFLINE_URL)))
    );
    return;
  }

  // 4. Same-origin static assets: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached || fetch(request).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return res;
        }).catch(() => caches.match(OFFLINE_URL))
      )
    );
  }
});

// Allow the page to trigger an immediate update
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
