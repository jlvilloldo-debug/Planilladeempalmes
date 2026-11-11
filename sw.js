/* Guarda la app en el equipo para usarla sin conexión.
   Con conexión siempre se usa la versión publicada; la copia es el respaldo. */
const CACHE = 'planillas-empalme-v1';
const ARCHIVOS = ['./', 'index.html', 'js/arranque.js', 'js/app.js', 'icono.svg',
  'manifest.webmanifest', 'vendor/exceljs.min.js', 'vendor/jszip.min.js',
  'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r && r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
