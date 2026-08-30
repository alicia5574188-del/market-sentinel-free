import type { SchedulerWorkerStatus } from "../../../../lib/background-scheduler";
import { getHte31Dashboard } from "../../../../lib/hte31-repository";
import type { Hte31ScanCompleted } from "../../../../lib/hte31-scanner";
import { getRuntimeBindings } from "../../../../lib/runtime-bindings";
import { requireApiAccount } from "../../../api-auth";

export const dynamic = "force-dynamic";

type ScannerStub = {
  status(): Promise<SchedulerWorkerStatus>;
  readModel(): Promise<Hte31ScanCompleted | null>;
};

type PositionStub = {
  status(): Promise<SchedulerWorkerStatus>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown HTE 3.1 status error";
}

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;

  const observedAt = Date.now();
  const bindings = getRuntimeBindings();
  const scanner = bindings.MARKET_SCANNER?.getByName("market-scanner") as unknown as ScannerStub | undefined;
  const position = bindings.POSITION_MONITOR?.getByName("position-monitor") as unknown as PositionStub | undefined;
  const errors: Record<string, string> = {};

  const [dashboardResult, scannerResult, readModelResult, positionResult] = await Promise.allSettled([
    getHte31Dashboard(observedAt),
    scanner ? scanner.status() : Promise.resolve(null),
    scanner ? scanner.readModel() : Promise.resolve(null),
    position ? position.status() : Promise.resolve(null),
  ]);

  const dashboard = dashboardResult.status === "fulfilled" ? dashboardResult.value : null;
  const scannerStatus = scannerResult.status === "fulfilled" ? scannerResult.value : null;
  const readModel = readModelResult.status === "fulfilled" ? readModelResult.value : null;
  const positionStatus = positionResult.status === "fulfilled" ? positionResult.value : null;

  if (dashboardResult.status === "rejected") errors.dashboard = errorMessage(dashboardResult.reason);
  if (scannerResult.status === "rejected") errors.scanner = errorMessage(scannerResult.reason);
  if (readModelResult.status === "rejected") errors.readModel = errorMessage(readModelResult.reason);
  if (positionResult.status === "rejected") errors.position = errorMessage(positionResult.reason);
  if (!scanner || !position) errors.bindings = "HTE 3.1 Durable Object bindings unavailable";

  return Response.json({
    version: "hte-3.1-clean",
    observedAt,
    scanner: {
      state: scannerStatus?.state ?? null,
      lastRunAt: scannerStatus?.lastRunAt ?? null,
      lastSuccessAt: scannerStatus?.lastSuccessAt ?? readModel?.observedAt ?? null,
      nextRunAt: scannerStatus?.nextRunAt ?? null,
      lastError: scannerStatus?.lastError ?? null,
      phase: scannerStatus?.phase ?? null,
      circuitOpen: scannerStatus?.circuitOpen ?? false,
    },
    position: {
      state: positionStatus?.state ?? null,
      lastRunAt: positionStatus?.lastRunAt ?? null,
      lastSuccessAt: positionStatus?.lastSuccessAt ?? null,
      nextRunAt: positionStatus?.nextRunAt ?? null,
      lastError: positionStatus?.lastError ?? null,
    },
    paper: dashboard ? {
      equityUsdt: dashboard.account.equityUsdt,
      realizedPnlUsdt: dashboard.account.realizedPnlUsdt,
      unrealizedPnlUsdt: dashboard.account.unrealizedPnlUsdt,
      availableMarginUsdt: dashboard.account.availableMarginUsdt,
      openPositions: dashboard.openTrades.length,
      sampleCount: dashboard.stats.sampleCount,
      wins: dashboard.stats.wins,
      losses: dashboard.stats.losses,
      profitFactor: dashboard.stats.profitFactor,
      totalNetPnlUsdt: dashboard.stats.totalNetPnlUsdt,
      activity10m: dashboard.activity,
      governance: {
        state: dashboard.governance.state,
        riskMultiplier: dashboard.governance.riskMultiplier,
        lossStreak: dashboard.governance.lossStreak,
      },
    } : null,
    settings: dashboard?.settings ?? null,
    degraded: Object.keys(errors).length > 0,
    errors,
  }, {
    headers: { "Cache-Control": "private, max-age=3, stale-while-revalidate=8" },
  });
}
