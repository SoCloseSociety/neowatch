// NEOWATCH service worker -- installable PWA shell cache.
// Strategy:
//   - hashed build assets (/assets/*): cache-first, stored only when the answer is a
//     real asset (2xx, same origin, not HTML: the SPA fallback answers a removed chunk
//     with index.html, which must never be cached as JavaScript);
//   - other static files (icons, art, fonts, manifest): network-first, cached copy
//     offline, same checks;
//   - real navigations (request.mode === 'navigate') to an app route: network-first,
//     the cached shell offline; only a 2xx text/html answer refreshes the shell;
//   - everything else (/api, the stream proxy, non-GET, cross-origin media, tv.html,
//     app.apk, robots.txt...) is never touched.
// The build's JS/CSS chunks (lazy pages included) are precached at install, so a deep
// link opened offline (/radios, /chaine/<id>) has its page, not the crash screen
// (WEB-12). The list is written at build (vite.config.ts), empty in dev.
// CACHE is build-stamped (__SW_VERSION__ replaced at build) so every deploy gets a new
// cache and `activate` purges the previous generation. The "v2" bump drops every
// cache written by the previous worker (it could hold HTML stored as a chunk).

const CACHE = 'neowatch-shell-v2-__SW_VERSION__';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png'];
const ASSETS = /*__SW_ASSETS__*/[];
const STATIC_RE = /\.(js|css|svg|png|webp|jpe?g|ico|webmanifest|woff2?)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // One missing optional file must not abort the whole install.
      .then((c) =>
        Promise.all([
          ...SHELL.map((u) => c.add(u).catch(() => {})),
          // Chunks: only a real asset is kept (never the SPA's index.html fallback).
          ...ASSETS.map((u) =>
            fetch(u)
              .then((res) => (cacheable(res) && !isHtml(res) ? c.put(u, res) : undefined))
              .catch(() => {})
          ),
        ])
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isHtml = (res) => (res.headers.get('content-type') || '').toLowerCase().includes('text/html');
// A response worth keeping: a full 2xx from our own origin (no opaque, no redirect, no 206).
const cacheable = (res) => !!res && res.ok && res.status === 200 && res.type === 'basic';

function put(key, res) {
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Never cache API calls, the stream proxy, or cross-origin media.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Range requests (media) go straight to the network.
  if (request.headers.has('range')) return;

  // Hashed build output: immutable, cache-first.
  if (url.pathname.startsWith('/assets/') && STATIC_RE.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (cacheable(res) && !isHtml(res)) put(request, res);
            return res;
          })
      )
    );
    return;
  }

  // Other static files: network-first, cached copy when offline.
  if (STATIC_RE.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (cacheable(res) && !isHtml(res)) put(request, res);
          return res;
        })
        .catch(() => caches.match(request).then((c) => c || Response.error()))
    );
    return;
  }

  // Only real navigations to an app route (no file extension: not tv.html, app.apk,
  // robots.txt, social-kit.html...). Everything else passes through untouched.
  if (request.mode !== 'navigate' || /\.[a-z0-9]+$/i.test(url.pathname)) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        // Only a real shell refreshes the offline copy (never a 502 page from a deploy).
        if (cacheable(res) && isHtml(res)) put('/index.html', res);
        return res;
      })
      .catch(() => caches.match('/index.html').then((c) => c || caches.match('/')).then((c) => c || Response.error()))
  );
});
