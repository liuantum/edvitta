// Minimal service worker: caches the app shell so the installed app opens fast. API calls always go to the network.
const CACHE = 'edvitta-v3';
const SHELL = ['/', '/styles.css', '/js/app.js', '/js/core.js', '/js/layout.js', '/js/common.js', '/js/parent.js', '/js/tutor.js', '/js/admin.js', '/js/features.js', '/js/ops.js', '/js/i18n.js', '/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
