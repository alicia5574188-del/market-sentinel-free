import type { SchedulerWorkerStatus } from "../../../lib/background-scheduler";
import { getHte31Dashboard } from "../../../lib/hte31-repository";
import type { Hte31ScanCompleted } from "../../../lib/hte31-scanner";
import { getRuntimeBindings } from "../../../lib/runtime-bindings";
import { requireApiAccount } from "../../api-auth";

export const dynamic = "force-dynamic";

const SCANNER_STALE_MS = 90_000;

type CleanScannerStub = {
  status(): Promise<SchedulerWorkerStatus>;
  readModel(): Promise<Hte31ScanCompleted | null>;
};

type CleanPositionStub = {
  status(): Promise<SchedulerWorkerStatus>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown HTE 3.1 runtime error";
}

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  const requestedAt = Date.now();
  const bindings = getRuntimeBindings();
  const scanner = bindings.MARKET_SCANNER?.getByName("market-scanner") as unknown as CleanScannerStub | undefined;
  const position = bindings.POSITION_MONITOR?.getByName("position-monitor") as unknown as CleanPositionStub | undefined;

  const errors: Record<string, string> = {};
  let scannerStatus: SchedulerWorkerStatus | null = null;
  let positionStatus: SchedulerWorkerStatus | null = null;
  let readModel: Hte31ScanCompleted | null = null;

  if (!scanner || !position) {
    errors.bindings = "HTE 3.1 Clean Durable Object bindings unavailable";
  } else {
    // The dashboard is deliberately observer-only. Opening the iPhone/web app
    // must never be required to start or heal market scanning. Cloudflare Cron
    // and Durable Object alarms are the only runtime drivers.
    const settled = await Promise.allSettled([
      scanner.status(),
      position.status(),
      scanner.readModel(),
    ]);
    if (settled[0].status === "fulfilled") scannerStatus = settled[0].value;
    else errors.scannerStatus = errorMessage(settled[0].reason);
    if (settled[1].status === "fulfilled") positionStatus = settled[1].value;
    else errors.positionStatus = errorMessage(settled[1].reason);
    if (settled[2].status === "fulfilled") readModel = settled[2].value;
    else errors.scannerReadModel = errorMessage(settled[2].reason);
  }

  let dashboard: Awaited<ReturnType<typeof getHte31Dashboard>> | null = null;
  try {
    dashboard = await getHte31Dashboard(requestedAt);
  } catch (error) {
    errors.dashboard = errorMessage(error);
  }

  const lastSuccessAt = scannerStatus?.lastSuccessAt ?? readModel?.observedAt ?? null;
  const scannerAgeMs = lastSuccessAt == null ? null : Math.max(0, requestedAt - lastSuccessAt);
  if (scannerAgeMs != null && scannerAgeMs > SCANNER_STALE_MS) {
    errors.scannerFreshness = `Clean Scanner 已 ${Math.round(scannerAgeMs / 1000)} 秒没有完成新评估`;
  }
  if (scannerStatus?.lastError) errors.scannerRuntime = scannerStatus.lastError;
  if (positionStatus?.lastError) errors.positionRuntime = positionStatus.lastError;

  return Response.json({
    version: "hte-3.1-clean",
    requestedAt,
    observedAt: lastSuccessAt ?? requestedAt,
    account: auth.account,
    scanner: {
      status: scannerStatus,
      ageMs: scannerAgeMs,
      readModel,
    },
    position: { status: positionStatus },
    market: readModel?.market ?? null,
    dashboard,
    degraded: Object.keys(errors).length > 0,
    errors,
  }, {
    headers: {
      "Cache-Control": "private, max-age=3, stale-while-revalidate=8",
      ...(Object.keys(errors).length ? { "X-Sentinel-Partial-Data": "1" } : {}),
    },
  });
}
