// NEOWATCH service worker -- installable PWA shell cache.
// Strategy: network-first for navigations (so deploys land on reload + the cached
// shell stays fresh), cache-first for hashed static assets, never touch /api or
// streams (always live). CACHE is build-stamped (__SW_VERSION__ replaced at build)
// so every deploy gets a new cache and `activate` purges the previous generation
// -- no stale shell after deploy, no unbounded cache growth.

const CACHE = 'neowatch-shell-__SW_VERSION__';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/hero.webp'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache API calls, the stream proxy, or cross-origin media.
  if (request.method !== 'GET' || url.pathname.startsWith('/api/') || url.origin !== self.location.origin) {
    return;
  }

  // Static assets (incl. WebP/JPG art): cache-first, then network (and cache it).
  if (/\.(js|css|svg|png|webp|jpe?g|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
            return res;
          })
      )
    );
    return;
  }

  // Navigations: network-first; refresh the cached shell on success so an offline
  // relaunch boots the latest HTML (whose hashed asset URLs are also cached).
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((c) => c || caches.match('/index.html')))
  );
});
