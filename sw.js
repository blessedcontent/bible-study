// Daily Bible Study - Service Worker
// Cache strategy: Cache-first for studies, network-first for navigation

const CACHE_VERSION = 'dbs-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const STUDY_CACHE = `${CACHE_VERSION}-studies`;

// Static assets to pre-cache on install
const STATIC_ASSETS = [
  '/bible-study/',
  '/bible-study/manifest.json',
  '/bible-study/icons/icon-192x192.png',
  '/bible-study/icons/icon-512x512.png'
];

// Install: pre-cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('dbs-') && key !== STATIC_CACHE && key !== STUDY_CACHE)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for study HTML files, network-first for everything else
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Study HTML files (e.g., 2026-04-10.html) - cache first, fall back to network
  if (url.pathname.match(/\/bible-study\/\d{4}-\d{2}-\d{2}\.html$/)) {
    event.respondWith(
      caches.open(STUDY_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          // Return cached version immediately, but also update cache in background
          const networkFetch = fetch(event.request).then(response => {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => null);

          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // Google Fonts - cache first (they rarely change)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(STATIC_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          });
        })
      )
    );
    return;
  }

  // Everything else - network first, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses for offline fallback
        if (response.ok && url.pathname.startsWith('/bible-study/')) {
          const responseClone = response.clone();
          caches.open(STATIC_CACHE).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Handle messages from the app (for future use with push notifications)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
