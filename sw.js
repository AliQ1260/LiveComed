// Service worker: keeps the app shell and last price data available offline.
// Bump VERSION on every deploy that changes cached files so old caches get cleared.

const VERSION = 'v3';
const SHELL_CACHE = `voltra-shell-${VERSION}`;
const DATA_CACHE = `voltra-data-${VERSION}`;
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// Third-party libraries (Tailwind, Chart.js, Font Awesome, Inter font) needed to render offline
const CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// ===== LIFECYCLE =====

// No skipWaiting() here: an updated worker waits until the page confirms the update
// (index.html posts SKIP_WAITING), so the app never swaps versions mid-use
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

// Delete caches from older versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => ![SHELL_CACHE, DATA_CACHE].includes(key))
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// User accepted the "New version available" prompt
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ===== REQUEST ROUTING =====

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.origin === location.origin) {
    // API calls (alerts config/subscribe) always go straight to the network
    if (url.pathname.startsWith('/api/')) return;

    // Pages: network-first so new deploys reach users; other assets: cache-first
    if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
      event.respondWith(networkFirst(request, SHELL_CACHE, request));
    } else {
      event.respondWith(cacheFirst(request));
    }
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (url.hostname === 'hourlypricing.comed.com') {
    // Drop the cache-busting param so each feed has one cache entry
    // (otherwise every poll adds a new entry and offline lookups never match)
    const keyUrl = new URL(url);
    keyUrl.searchParams.delete('_');
    event.respondWith(networkFirst(request, DATA_CACHE, keyUrl.toString()));
  }
});

// ===== PUSH NOTIFICATIONS =====

// Price alert sent by /api/alert-check
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data && event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Voltra', {
      body: data.body || 'Electricity prices have changed.',
      tag: data.tag || 'voltra-price', // Same tag: the all-clear replaces the red alert
      renotify: true,                   // Still buzz when replacing
      data: { url: data.url || './' }
    })
  );
});

// Tapping the notification opens Voltra (or focuses it if already open)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(self.location.origin));
      if (open) return open.focus();
      return self.clients.openWindow(target);
    })
  );
});

// The browser rotated this device's subscription - re-subscribe and tell the server, or alerts silently stop
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const config = await fetch('/api/config').then((r) => r.json());
    if (!config.vapidPublicKey) return;

    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
    });
    // No threshold here (the worker can't read the page's storage) - the server copies it from the old subscription
    await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        oldEndpoint: event.oldSubscription ? event.oldSubscription.endpoint : undefined
      })
    });
  })());
});

// VAPID keys are base64url; the Push API wants raw bytes
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

// ===== CACHE STRATEGIES =====

// Serve from cache, fetch and store on a miss
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  // Cross-origin <script>/<link> loads come back "opaque" (status 0) but are still usable
  if (response.ok || response.type === 'opaque') {
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

// Try the network, fall back to the last good copy when offline
async function networkFirst(request, cacheName, cacheKey) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw error;
  }
}
