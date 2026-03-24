var CACHE = 'ndanae-v2';
var ASSETS = [
  './',
  './index.html',
  './rota-dashboard.html',
  './useful-info.html',
  './drug-calc.html',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
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
  /* Network first for JSON data, cache first for everything else */
  var url = e.request.url;
  if (url.indexOf('.json') > -1 && url.indexOf('version') === -1) {
    /* Data files: network first, fallback to cache */
    e.respondWith(
      fetch(e.request).then(function(r) {
        var clone = r.clone();
        caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        return r;
      }).catch(function() {
        return caches.match(e.request);
      })
    );
  } else {
    /* Static assets: cache first, fallback to network */
    e.respondWith(
      caches.match(e.request).then(function(r) {
        return r || fetch(e.request);
      })
    );
  }
});
