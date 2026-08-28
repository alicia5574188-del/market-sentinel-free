(() => {
  const w = window;
  if (w.__SENTINEL_RESILIENT_FETCH_INSTALLED__) return;

  const nativeFetch = w.fetch.bind(w);
  w.__SENTINEL_NATIVE_FETCH__ = nativeFetch;
  w.__SENTINEL_RESILIENT_FETCH_INSTALLED__ = true;

  const GLOBAL_START_GAP_MS = 500;
  const EDGE_CIRCUIT_MS = 15_000;
  const EXTENDED_EDGE_CIRCUIT_MS = 30_000;
  const MAX_CONCURRENT_READS = 2;
  const MAX_CONCURRENT_HEAVY_READS = 1;
  const DEFAULT_READ_TIMEOUT_MS = 8_000;
  const HEAVY_READ_TIMEOUT_MS = 15_000;

  const inFlight = new Map();
  const lastStartedAt = new Map();
  let startQueue = Promise.resolve();
  let nextStartAt = 0;
  let activeReads = 0;
  let activeHeavyReads = 0;
  const slotWaiters = [];
  let edgeCircuitUntil = 0;
  let recentEdgeFailures = 0;
  let lastEdgeFailureAt = 0;

  const wait = (ms) => new Promise((resolve) => w.setTimeout(resolve, ms));

  function info(input, init) {
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    try {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, w.location.href);
      if (url.origin !== w.location.origin) return null;
      if (!(url.pathname.startsWith("/api/") || url.pathname === "/__health")) return null;
      return { method, url };
    } catch {
      return null;
    }
  }

  function minimumIntervalMs(pathname) {
    if (pathname === "/api/market") return 30_000;
    if (pathname === "/api/v2") return 45_000;
    if (pathname === "/api/scanner") return 30_000;
    if (pathname === "/api/background") return 30_000;
    if (pathname === "/api/alerts") return 15_000;
    if (pathname === "/api/live/status") return 8_000;
    if (pathname === "/api/v2/learning-arena" || pathname === "/api/v2/playbook-diagnostics") return 5 * 60_000;
    if (pathname === "/api/chart") return 30_000;
    return 4_000;
  }

  function isHeavy(pathname) {
    // /api/market and /api/scanner are background read-model consumers in
    // Cloudflare production. They must never queue behind Strategy/D1 research
    // work or be treated as Gate-computation requests in the browser.
    return pathname === "/api/v2"
      || pathname === "/api/chart"
      || pathname === "/api/v2/learning-arena"
      || pathname === "/api/v2/playbook-diagnostics";
  }

  function timeoutMs(pathname) {
    return isHeavy(pathname) ? HEAVY_READ_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS;
  }

  async function waitForStartGap() {
    const scheduled = startQueue.then(async () => {
      const delay = Math.max(0, nextStartAt - Date.now());
      if (delay > 0) await wait(delay);
      nextStartAt = Date.now() + GLOBAL_START_GAP_MS;
    });
    startQueue = scheduled.catch(() => undefined);
    await scheduled;
  }

  async function waitForCircuit() {
    const delay = edgeCircuitUntil - Date.now();
    if (delay > 0) await wait(delay);
  }

  function openCircuit() {
    const now = Date.now();
    recentEdgeFailures = now - lastEdgeFailureAt < 60_000 ? recentEdgeFailures + 1 : 1;
    lastEdgeFailureAt = now;
    const hold = recentEdgeFailures >= 2 ? EXTENDED_EDGE_CIRCUIT_MS : EDGE_CIRCUIT_MS;
    edgeCircuitUntil = Math.max(edgeCircuitUntil, now + hold);
    try {
      w.dispatchEvent(new CustomEvent("sentinel:edge-pressure", { detail: { holdMs: hold, failures: recentEdgeFailures } }));
    } catch {}
  }

  function markRecovered() {
    if (!recentEdgeFailures) return;
    recentEdgeFailures = 0;
    edgeCircuitUntil = 0;
    try { w.dispatchEvent(new CustomEvent("sentinel:edge-recovered")); } catch {}
  }

  function canAcquire(heavy) {
    return activeReads < MAX_CONCURRENT_READS && (!heavy || activeHeavyReads < MAX_CONCURRENT_HEAVY_READS);
  }

  async function acquire(heavy) {
    if (!canAcquire(heavy)) {
      await new Promise((resolve) => slotWaiters.push({ heavy, resolve }));
    }
    activeReads += 1;
    if (heavy) activeHeavyReads += 1;
  }

  function release(heavy) {
    activeReads = Math.max(0, activeReads - 1);
    if (heavy) activeHeavyReads = Math.max(0, activeHeavyReads - 1);
    for (let index = 0; index < slotWaiters.length; index += 1) {
      const waiter = slotWaiters[index];
      if (!canAcquire(waiter.heavy)) continue;
      slotWaiters.splice(index, 1);
      waiter.resolve();
      break;
    }
  }

  async function fetchWithTimeout(input, init, milliseconds) {
    const controller = new AbortController();
    const sourceSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let timedOut = false;
    const relayAbort = () => controller.abort(sourceSignal?.reason);
    if (sourceSignal?.aborted) relayAbort();
    else sourceSignal?.addEventListener("abort", relayAbort, { once: true });
    const timer = w.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, milliseconds);
    try {
      return await nativeFetch(input, { ...init, cache: "no-store", signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new Error(`请求超时（${Math.round(milliseconds / 1000)}秒）`);
      throw error;
    } finally {
      w.clearTimeout(timer);
      sourceSignal?.removeEventListener("abort", relayAbort);
    }
  }

  function normalize(response, requestInfo) {
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/json")) return response;
    const ray = response.headers.get("cf-ray");
    return new Response(JSON.stringify({
      error: `${requestInfo.url.pathname} 返回了非 JSON 响应（HTTP ${response.status}）${ray ? ` · CF Ray ${ray}` : ""}，已触发负载保护并等待下一轮刷新`,
    }), {
      status: response.ok ? 502 : response.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  async function guardedRead(input, init, requestInfo) {
    const key = `${requestInfo.method}:${requestInfo.url.href}`;
    const existing = inFlight.get(key);
    if (existing) return (await existing).clone();

    const pending = (async () => {
      const minimumInterval = minimumIntervalMs(requestInfo.url.pathname);
      const sinceLast = Date.now() - (lastStartedAt.get(key) ?? 0);
      if (sinceLast < minimumInterval) await wait(minimumInterval - sinceLast);
      await waitForCircuit();
      await waitForStartGap();
      await waitForCircuit();

      const heavy = isHeavy(requestInfo.url.pathname);
      await acquire(heavy);
      try {
        lastStartedAt.set(key, Date.now());
        const response = await fetchWithTimeout(input, init, timeoutMs(requestInfo.url.pathname));
        if (response.status === 429 || response.status >= 500) {
          openCircuit();
          return normalize(response, requestInfo);
        }
        if (response.ok) markRecovered();
        return normalize(response, requestInfo);
      } catch (error) {
        openCircuit();
        throw error;
      } finally {
        release(heavy);
      }
    })();

    inFlight.set(key, pending);
    try {
      return (await pending).clone();
    } finally {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }
  }

  w.fetch = async (input, init) => {
    const requestInfo = info(input, init);
    if (!requestInfo || requestInfo.method !== "GET") return nativeFetch(input, init);
    const normalizedInput = input instanceof Request ? input : requestInfo.url.href;
    return guardedRead(normalizedInput, init, requestInfo);
  };

  function recoverFromAssetFailure(reason) {
    if (w.location.pathname === "/recovery.html") return;
    try { w.location.replace(`/recovery.html?reason=${encodeURIComponent(reason)}`); } catch {}
  }

  const fatalAssetPattern = /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Failed to load module script|Importing a module script failed/i;
  w.addEventListener("error", (event) => {
    const message = String(event?.message ?? event?.error?.message ?? "");
    if (fatalAssetPattern.test(message)) recoverFromAssetFailure("asset-load");
  });
  w.addEventListener("unhandledrejection", (event) => {
    const message = String(event?.reason?.message ?? event?.reason ?? "");
    if (fatalAssetPattern.test(message)) recoverFromAssetFailure("asset-load");
  });

  let blankSince = 0;
  w.setInterval(() => {
    if (document.hidden || w.location.pathname === "/recovery.html") {
      blankSince = 0;
      return;
    }
    const main = document.querySelector("main");
    const nav = document.querySelector(".bottom-nav");
    const visiblyMounted = Boolean(main || nav);
    if (visiblyMounted) {
      blankSince = 0;
      return;
    }
    if (!blankSince) blankSince = Date.now();
    if (Date.now() - blankSince >= 6_000) recoverFromAssetFailure("blank-shell");
  }, 2_000);
})();
