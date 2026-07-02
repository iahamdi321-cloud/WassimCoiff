/* Wassim Coiff — service worker (hors-ligne + mises à jour + notifications push FCM) */

/* ===== Firebase Cloud Messaging : reçoit les notifications push ===== */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
try {
  firebase.initializeApp({
    apiKey: "AIzaSyBnZE79sUdRB8LNxjTT1nEv4my6z8f_fiI",
    authDomain: "wassim-coiff.firebaseapp.com",
    projectId: "wassim-coiff",
    storageBucket: "wassim-coiff.firebasestorage.app",
    messagingSenderId: "955136785150",
    appId: "1:955136785150:web:3a158aa29fa173ff4cc3af"
  });
  const messaging = firebase.messaging();
  // notification reçue quand l'app est FERMÉE / en arrière-plan
  messaging.onBackgroundMessage((payload) => {
    const d = payload.data || {};
    self.registration.showNotification(d.title || "\u2702\uFE0F Wassim Coiff", {
      body: d.body || "",
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: d.tag || "wassim-notif",
      data: { url: d.url || "./index.html" }
    });
  });
} catch (e) { /* messaging indisponible : l'app fonctionne quand même */ }

// clic sur la notification -> ouvre (ou ramène au premier plan) l'application
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

const CACHE = "wassim-coiff-v8";
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

self.addEventListener("message", (e) => { if (e.data === "skip") self.skipWaiting(); });

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
