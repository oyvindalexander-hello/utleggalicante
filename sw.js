/* Mellomlagrer appskallet slik at appen åpner seg umiddelbart,
   også når Render-tjenesten har spunnet ned. Data hentes alltid fra nett. */

var CACHE = "utleggsoversikt-jentene-v1";

self.addEventListener("install", function(){
  self.skipWaiting();
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys()
      .then(function(keys){
        return Promise.all(keys.map(function(k){
          if(k !== CACHE) return caches.delete(k);
        }));
      })
      .then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch(err){ return; }
  if(url.origin !== self.location.origin) return;

  // Data og selve service workeren skal aldri mellomlagres.
  if(url.pathname.indexOf("/api/") === 0) return;
  if(url.pathname === "/sw.js") return;
  if(url.pathname === "/healthz") return;

  e.respondWith(
    caches.open(CACHE).then(function(cache){
      return cache.match(req).then(function(hit){
        var net = fetch(req).then(function(res){
          if(res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(function(){ return hit; });

        // Vis mellomlagret skall med en gang, og oppdater det i bakgrunnen.
        return hit || net;
      });
    })
  );
});
