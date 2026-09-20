const CACHE = 'weight-watch-v4';
const SHELL = ['./', './index.html', './style.css', './app.js?v=4', './timer.js', './icon.svg', './manifest.webmanifest'];
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('weight-watch-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Online navigation must discover releases even when an old shell is cached.
    if (event.request.mode === 'navigate') {
      try {
        const response = await fetch(event.request, { cache: 'no-cache' });
        if (response.ok) {
          await cache.put('./index.html', response.clone());
          return response;
        }
      } catch { /* fall back to the offline shell */ }
      return await cache.match('./index.html') || Response.error();
    }
    // Never let a previous page's cache override this release's assets.
    const cached = await cache.match(event.request);
    if (cached) return cached;
    return fetch(event.request);
  })());
});
