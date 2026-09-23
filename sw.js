// Service worker: keeps the app shell and last price data available offline.
// Bump VERSION on every deploy that changes cached files so old caches get cleared.

const VERSION = 'v2';
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
