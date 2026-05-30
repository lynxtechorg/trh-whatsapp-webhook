const CACHE = "trh-v1";
const PRECACHE = ["/app", "/trh-logo.png", "/manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ─── PUSH NOTIFICATIONS ───
self.addEventListener("push", e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || "New Message", {
      body: data.body || "You have a new WhatsApp message",
      icon: "/trh-logo.png",
      badge: "/trh-logo.png",
      tag: data.phone || "trh-msg",
      data: { phone: data.phone },
      vibrate: [200, 100, 200],
      requireInteraction: false,
    })
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window" }).then(list => {
      if (list.length) { list[0].focus(); return; }
      clients.openWindow("/app");
    })
  );
});
