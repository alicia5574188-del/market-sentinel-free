const CACHE_NAME = "market-sentinel-shell-v4";
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
  if (event.request.method !== "GET") return;

  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;

  // API, auth and health requests must always use the network response directly.
  // Never fall back to cached HTML for JSON endpoints: that can leave the iOS PWA
  // showing stale positions while every live/Strategy 2.0 refresh fails.
  if (url.pathname.startsWith("/api/") || url.pathname === "/__health") return;

  const isNavigation = event.request.mode === "navigate";
  const isShellAsset = APP_SHELL.includes(url.pathname);
  if (!isNavigation && !isShellAsset) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      const transientEdgeFailure = isNavigation && (response.status === 429 || response.status >= 500);

      // Cloudflare 1102 (Worker exceeded resource limits) is returned as a real
      // HTTP error response, not a rejected fetch. The old network-first code
      // therefore displayed Cloudflare's error document and never reached the
      // catch fallback. Keep the last known-good application shell visible for
      // transient edge/resource failures; API reads have their own retry layer
      // and will refresh the live data as soon as the Worker recovers.
      if (transientEdgeFailure) {
        const cached = await caches.match("/");
        if (cached) {
          const headers = new Headers(cached.headers);
          headers.set("X-Sentinel-Navigation-Fallback", "1");
          return new Response(cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers,
          });
        }
      }

      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(isNavigation ? "/" : event.request, response.clone());
      }
      return response;
    } catch {
      const cached = isNavigation ? await caches.match("/") : await caches.match(event.request);
      if (cached) return cached;
      return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
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
  let target;
  try {
    target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  } catch {
    target = self.location.origin;
  }
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    return existing ? existing.focus().then(() => existing.navigate(target)) : clients.openWindow(target);
  }));
});
