type SnapshotShape = {
  version: string;
  requestedAt: number;
  observedAt: number;
  scanner: { status: unknown; ageMs: number | null; readModel: unknown };
  position: { status: unknown };
  dashboard: { account: { epochStartedAt: number } } | null;
  market: unknown;
  twelveHourReview: unknown;
  staleSources?: string[];
  degraded: boolean;
  errors: Record<string, string>;
};

/** Display-only recovery. Never combine different strategy versions or epochs. */
export function retainDashboardSnapshot<T extends SnapshotShape>(previous: T | null, next: T): T {
  if (!next?.version || !Number.isFinite(next.requestedAt) || !Number.isFinite(next.observedAt)
    || !next.scanner || !next.position || !next.errors) throw new Error("运行数据格式不完整，保留最近可信快照");
  if (previous && next.requestedAt < previous.requestedAt) return previous;
  const compatible = previous?.version === next.version
    && (!next.dashboard || !previous.dashboard
      || next.dashboard.account.epochStartedAt === previous.dashboard.account.epochStartedAt);
  const fallback = compatible ? previous : null;
  const staleSources = new Set(next.staleSources ?? []);
  const errors = { ...next.errors };
  function retain<V>(key: string, value: V | null, old: V | null | undefined): V | null {
    if (value != null) return value;
    errors[key] ||= "数据暂未就绪";
    if (old != null) staleSources.add(key);
    return old ?? null;
  }
  const dashboard = retain("dashboard", next.dashboard, fallback?.dashboard);
  const readModel = retain("scannerReadModel", next.scanner.readModel, fallback?.scanner.readModel);
  const scannerStatus = retain("scannerStatus", next.scanner.status, fallback?.scanner.status);
  const positionStatus = retain("positionStatus", next.position.status, fallback?.position.status);
  let review = next.twelveHourReview;
  if (review == null && fallback?.twelveHourReview != null) {
    review = retain("twelveHourReview", review, fallback.twelveHourReview);
  }
  const retained = staleSources.has("scannerReadModel");
  const observedAt = retained && fallback ? Math.min(next.observedAt, fallback.observedAt) : next.observedAt;
  return {
    ...next,
    observedAt,
    dashboard,
    scanner: {
      ...next.scanner,
      status: scannerStatus,
      readModel,
      ageMs: retained ? Math.max(next.scanner.ageMs ?? 0, next.requestedAt - observedAt) : next.scanner.ageMs,
    },
    position: { status: positionStatus },
    market: next.market ?? (readModel ? fallback?.market ?? null : null),
    twelveHourReview: review,
    staleSources: [...staleSources],
    degraded: next.degraded || Object.keys(errors).length > 0,
    errors,
  } as T;
}
