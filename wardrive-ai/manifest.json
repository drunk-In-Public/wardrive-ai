/**
 * Service Worker for WardDrive AI PWA
 * Caches app shell for offline use
 */

const CACHE_NAME = "wardrive-ai-v4";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/wigle-api.js",
  "/density-analyzer.js",
  "/route-planner.js",
  "/manifest.json",
];

// Install: cache app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for static assets, network-first for API calls
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache API proxies or external tiles
  if (
    url.pathname.startsWith("/wigle-proxy") ||
    url.pathname.startsWith("/osrm-proxy") ||
    url.hostname !== self.location.hostname
  ) {
    return; // Let browser handle it normally
  }

  // Cache-first for app shell
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
