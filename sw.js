var CACHE = 'ndanae-v1.2.03';
var ASSETS = [
  './',
  './index.html',
  './rota-dashboard.html',
  './useful-info.html',
  './drug-calc.html',
  './guidelines.html',
  './audit.html',
  './case-logger.html',
  './creative.html',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function(e) {
  /* Skip cache prefetch — network-first means cache is populated on demand */
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE; })
          .map(function(n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  /* Skip non-GET and chrome-extension requests */
  if (e.request.method !== 'GET' || url.indexOf('chrome-extension') >= 0) return;

  /* daily-rota.json: always network, never cache (changes frequently) */
  if (url.indexOf('daily-rota.json') >= 0) {
    e.respondWith(fetch(e.request));
    return;
  }

  /* Images: cache first (they rarely change) */
  if (url.match(/\.(png|jpg|webp|ico|svg)$/)) {
    e.respondWith(
      caches.match(e.request).then(function(r) {
        return r || fetch(e.request).then(function(resp) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
          return resp;
        });
      })
    );
    return;
  }

  /* Everything else (HTML, JS, CSS, JSON): network first, cache fallback */
  e.respondWith(
    fetch(e.request).then(function(r) {
      var clone = r.clone();
      caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
      return r;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});
