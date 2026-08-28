const CACHE_NAME = "market-sentinel-shell-v6";
const RECOVERY_URL = "/recovery.html";
const STATIC_SHELL = [RECOVERY_URL, "/sentinel-runtime-guard.js", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

async function recoveryResponse() {
  const cached = await caches.match(RECOVERY_URL);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("X-Sentinel-Navigation-Fallback", "recovery-v1");
    return new Response(cached.body, {
      status: 200,
      statusText: "OK",
      headers,
    });
  }
  return new Response("Market Sentinel is recovering. Please retry shortly.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;

  // API, auth and health requests must remain network-only. The recovery layer
  // is only for top-level navigation and never substitutes stale JSON/live data.
  if (url.pathname.startsWith("/api/") || url.pathname === "/__health") return;

  const isNavigation = event.request.mode === "navigate";
  if (!isNavigation) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { cache: "no-store" });
      const transientEdgeFailure = response.status === 429 || response.status >= 500;

      if (transientEdgeFailure) return recoveryResponse();
      return response;
    } catch {
      return recoveryResponse();
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
