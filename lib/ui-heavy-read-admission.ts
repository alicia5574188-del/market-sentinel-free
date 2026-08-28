type HeavyUiReadLease = {
  release: () => void;
};

type ActiveLease = {
  id: number;
  label: string;
  startedAt: number;
};

const STALE_LEASE_MS = 30_000;
let nextLeaseId = 1;
let activeLease: ActiveLease | null = null;

/**
 * Prevent foreground observability endpoints from running expensive work in
 * parallel inside the same Worker isolate. This gate is deliberately limited
 * to read-only UI routes; execution, reconciliation and mutations never enter
 * this queue.
 *
 * If a Worker invocation is terminated before finally{} can release the lease,
 * a 30s stale-lease cutoff prevents the isolate from remaining permanently
 * locked.
 */
export function acquireHeavyUiRead(label: string, now = Date.now()): HeavyUiReadLease | null {
  if (activeLease && now - activeLease.startedAt > STALE_LEASE_MS) activeLease = null;
  if (activeLease) return null;

  const lease: ActiveLease = { id: nextLeaseId++, label, startedAt: now };
  activeLease = lease;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (activeLease?.id === lease.id) activeLease = null;
    },
  };
}

export function heavyUiReadBusyResponse(route: string) {
  return Response.json({
    mode: "degraded",
    error: `${route} 正在执行另一项重型只读刷新，已主动削峰并等待下一轮，而不是继续挤压 Worker 资源`,
    loadShed: true,
    observedAt: Date.now(),
  }, {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": "5",
      "X-Sentinel-Load-Shed": "1",
    },
  });
}
