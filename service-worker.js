// DLCR CRM Service Worker
const CACHE_NAME = 'dlcr-v1';

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(e) {
  // Let all requests pass through normally
  e.respondWith(fetch(e.request).catch(function() {
    return new Response('Offline', { status: 503 });
  }));
});
