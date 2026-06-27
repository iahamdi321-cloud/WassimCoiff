/* Wassim Coiff — service worker (mode hors-ligne + mises à jour automatiques) */
const CACHE = "wassim-coiff-v4";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png",
  "./logo-mark.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Le DOCUMENT principal (index.html) -> RÉSEAU D'ABORD :
  // toujours la dernière version quand en ligne, sinon la copie hors-ligne.
  const isDoc = req.mode === "navigate" ||
    (url.origin === location.origin &&
      (url.pathname === "/" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html")));

  if (isDoc) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // Le reste (icônes, polices, librairies, Firebase) -> CACHE D'ABORD.
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        try {
          const cacheable = res && res.status === 200 &&
            (url.origin === location.origin ||
             url.host.indexOf("fonts.g") !== -1 ||
             url.host.indexOf("gstatic") !== -1 ||
             url.host.indexOf("jsdelivr") !== -1);
          if (cacheable) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
        } catch (_) {}
        return res;
      }).catch(() => {
        if (req.mode === "navigate") return caches.match("./index.html");
      });
    })
  );
});
