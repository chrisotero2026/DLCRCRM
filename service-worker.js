// ══════════════════════════════════════════════════════
//  JARVIS SERVICE WORKER — PWA Cache + Push Notifications
//  Versión: 1.0
// ══════════════════════════════════════════════════════

const CACHE_NAME = 'jarvis-v1';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// ── Install: cache archivos esenciales ──
self.addEventListener('install', function(event) {
  console.log('[Jarvis SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CACHE_URLS).catch(function(err) {
        console.log('[Jarvis SW] Cache parcial:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: limpia caches viejos ──
self.addEventListener('activate', function(event) {
  console.log('[Jarvis SW] Activating...');
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// ── Fetch: sirve desde cache si está disponible ──
self.addEventListener('fetch', function(event) {
  // Solo cachea GET requests al mismo origen
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  // Firebase y APIs externas: siempre network
  if (event.request.url.includes('firebase') ||
      event.request.url.includes('firestore') ||
      event.request.url.includes('googleapis') ||
      event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) {
        // Sirve cache y actualiza en background
        fetch(event.request).then(function(response) {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, response);
            });
          }
        }).catch(function() {});
        return cached;
      }
      // No está en cache: fetch normal
      return fetch(event.request).then(function(response) {
        if (!response || response.status !== 200) return response;
        var responseClone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, responseClone);
        });
        return response;
      }).catch(function() {
        // Offline fallback
        return caches.match('/index.html');
      });
    })
  );
});

// ── Push Notifications ──
self.addEventListener('push', function(event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch(e) {
    data = { title: 'Jarvis', body: event.data ? event.data.text() : 'Nueva notificación' };
  }

  var title   = data.title || 'Jarvis CRM';
  var options = {
    body:    data.body    || 'Tienes una nueva notificación',
    icon:    data.icon    || '/icon-192.png',
    badge:   '/icon-192.png',
    tag:     data.tag     || 'jarvis-notification',
    data:    data.url     || '/',
    vibrate: [200, 100, 200],
    actions: data.actions || [
      { action: 'open',    title: '📂 Abrir Jarvis' },
      { action: 'dismiss', title: '✕ Cerrar' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification click ──
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  if (event.action === 'dismiss') return;

  var url = event.notification.data || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // Si ya hay una ventana de Jarvis abierta, enfócala
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NOTIFICATION_CLICK', url: url });
          return;
        }
      }
      // Si no hay ventana, abre una nueva
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

// ── Background sync (para cuando vuelve el internet) ──
self.addEventListener('sync', function(event) {
  if (event.tag === 'jarvis-sync') {
    console.log('[Jarvis SW] Background sync triggered');
  }
});

console.log('[Jarvis SW] Service Worker loaded ✅');
