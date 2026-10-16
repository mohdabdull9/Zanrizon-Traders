/* DeepQr service worker: the app opens and the till sells without internet.
   App files and libraries come from the cache (refreshed in the background);
   live data (Supabase REST, Auth) always goes to the network. */
const VERSION = 'deepqr-6.0.0';
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./assets/deepqr-logo.svg", "./assets/icons/icon-192.png", "./css/app.css?v=6.0.0", "./js/config.js?v=6.0.0", "./js/core.js?v=6.0.0", "./js/scanner.js?v=6.0.0", "./js/pos.js?v=6.0.0", "./js/customers.js?v=6.0.0", "./js/stock.js?v=6.0.0", "./js/orders.js?v=6.0.0", "./js/catalog.js?v=6.0.0", "./js/portals.js?v=6.0.0", "./js/online.js?v=6.0.0", "./js/shop.js?v=6.0.0", "./js/offline.js?v=6.0.0", "./js/reports.js?v=6.0.0", "./js/business.js?v=6.0.0", "./js/portal.js?v=6.0.0"];
const LIBS = ["https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js", "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js", "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js", "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all([...SHELL, ...LIBS].map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => null)))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('deepqr-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const STATIC_HOSTS = /(^|\.)(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (/\/(rest|auth|realtime|functions)\/v1\//.test(u.pathname) || u.pathname.includes('/storage/v1/object/sign')) return;
  const photo = u.pathname.includes('/storage/v1/object/public/');
  if (!(u.origin === self.location.origin || STATIC_HOSTS.test(u.hostname) || photo)) return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); return res; })
      .catch(() => caches.match('./index.html').then(x => x || caches.match('./')).then(x => x || Response.error())));
    return;
  }
  e.respondWith(caches.match(r).then(hit => {
    const net = fetch(r).then(res => { if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(r, copy)); } return res; }).catch(() => hit || Response.error());
    return hit || net;
  }));
});
