// Simple offline cache for PREDICTCUP 2026
const CACHE_NAME = 'predictcup-2026-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/i18n/en.json',
  '/i18n/ar.json',
  '/i18n/ku.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
