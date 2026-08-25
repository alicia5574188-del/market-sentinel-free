const CACHE_NAME = "market-sentinel-shell-v3";
const APP_SHELL = ["/", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok && (event.request.mode === "navigate" || APP_SHELL.includes(new URL(event.request.url).pathname))) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request.mode === "navigate" ? "/" : event.request, response.clone());
      }
      return response;
    } catch {
      return (await caches.match(event.request)) || (await caches.match("/"));
    }
  })());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text?.() }; }
  event.waitUntil(self.registration.showNotification(payload.title || "Market Sentinel", {
    body: payload.body || "新的市场条件已满足，打开查看证据与失效条件。",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: payload.tag || "market-sentinel-signal",
    renotify: true,
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    return existing ? existing.focus().then(() => existing.navigate(target)) : clients.openWindow(target);
  }));
});
