/* ZeroHour service worker: keeps the app shell available offline.
 * - App shell (HTML, JS, CSS, icon, manifest): cache-first, refreshed on each new build.
 * - release.json: always network. It must never be served stale from a cache here.
 * - r/*.bin: not intercepted. The app stores the student's own file in IndexedDB.
 * The cache version and precache list below are filled in by scripts/build-web.ts.
 */
const CACHE = 'zerohour-shell-__CACHE_VERSION__';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('zerohour-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname.replace(/^.*\//, '');
  if (path === 'release.json' || url.pathname.includes('/r/') || path === 'manifest.json') return; // network only

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() =>
        req.mode === 'navigate' ? caches.match('./index.html') : Response.error(),
      );
    }),
  );
});
