import type { SchedulerWorkerStatus } from "../../../lib/background-scheduler";
import { boundedRead, type BoundedReadResult } from "../../../lib/bounded-read";
import { getHte31Diagnostics } from "../../../lib/hte31-diagnostics";
import { getHte31Dashboard } from "../../../lib/hte31-repository";
import type { Hte31ScanCompleted } from "../../../lib/hte31-scanner";
import { getRuntimeBindings } from "../../../lib/runtime-bindings";
import { requireApiViewer } from "../../api-auth";

export const dynamic = "force-dynamic";

const SCANNER_STALE_MS = 90_000;
const MAIN_READ_DEADLINE_MS = 2_500;
const DO_READ_DEADLINE_MS = 1_600;
const DIAGNOSTICS_READ_DEADLINE_MS = 4_000;
const DIAGNOSTICS_CACHE_MS = 60_000;
const DIAGNOSTICS_STALE_FALLBACK_MS = 5 * 60_000;

type Diagnostics = Awaited<ReturnType<typeof getHte31Diagnostics>>;
type Dashboard = Awaited<ReturnType<typeof getHte31Dashboard>>;
type CleanScannerStub = {
  status(): Promise<SchedulerWorkerStatus>;
  readModel(): Promise<Hte31ScanCompleted | null>;
};
type CleanPositionStub = { status(): Promise<SchedulerWorkerStatus> };
type ReadResult<T> = BoundedReadResult<T>;

let diagnosticsCache: { fetchedAt: number; value: Diagnostics } | null = null;
let lastGoodScannerStatus: SchedulerWorkerStatus | null = null;
let lastGoodPositionStatus: SchedulerWorkerStatus | null = null;
let lastGoodReadModel: Hte31ScanCompleted | null = null;
let lastGoodDashboard: Dashboard | null = null;

async function readCachedDiagnostics(now: number) {
  if (diagnosticsCache && now - diagnosticsCache.fetchedAt <= DIAGNOSTICS_CACHE_MS) return diagnosticsCache.value;
  try {
    const value = await getHte31Diagnostics(now);
    diagnosticsCache = { fetchedAt: now, value };
    return value;
  } catch (error) {
    if (diagnosticsCache && now - diagnosticsCache.fetchedAt <= DIAGNOSTICS_STALE_FALLBACK_MS) return diagnosticsCache.value;
    throw error;
  }
}

function biasText(value: "LONG" | "SHORT" | "NEUTRAL") {
  return value === "LONG" ? "偏多" : value === "SHORT" ? "偏空" : "方向中性";
}

function dashboardMarketView(readModel: Hte31ScanCompleted) {
  const market = readModel.market;
  const candidate = readModel.directCandidate;
  const pending = market.pendingLabel
    ? `检测到 ${market.pendingLabel}${market.pendingBias === "NEUTRAL" ? "" : market.pendingBias === "LONG" ? "偏多" : "偏空"}，确认 ${market.pendingConfirmations}/${market.requiredConfirmations}。`
    : market.transitionNote;
  return {
    bias: candidate.decision === "LONG" ? "LONG" as const : candidate.decision === "SHORT" ? "SHORT" as const : "NEUTRAL" as const,
    confidence: candidate.confidence,
    environment: market.label,
    headline: `${readModel.target.replace("_USDT", "")} · ${candidate.location} · ${candidate.decision === "WAIT" ? "等待" : candidate.decision === "LONG" ? "偏多" : "偏空"}`,
    reason: `${pending} 路径概率：上 ${candidate.paths.up.toFixed(1)}% / 下 ${candidate.paths.down.toFixed(1)}% / 震荡或失效 ${candidate.paths.rangeOrInvalid.toFixed(1)}%。`,
    strongDirection: candidate.decision !== "WAIT",
  };
}

function resolveReadResult<T>(
  key: string,
  result: ReadResult<T>,
  fallback: T | null,
  errors: Record<string, string>,
  staleSources: string[],
) {
  if (result.ok) return result.value;
  errors[key] = result.error;
  if (fallback != null) staleSources.push(key);
  return fallback;
}

export async function GET(request: Request) {
  const auth = await requireApiViewer();
  if ("response" in auth) return auth.response;
  const requestedAt = Date.now();
  const view = new URL(request.url).searchParams.get("view");

  if (view === "strategies") {
    const result = await boundedRead("strategy_diagnostics", readCachedDiagnostics(requestedAt), DIAGNOSTICS_READ_DEADLINE_MS);
    return Response.json({
      version: "resonance-v6-strategy-center",
      requestedAt,
      diagnostics: result.ok ? result.value : diagnosticsCache?.value ?? null,
      degraded: !result.ok,
      errors: result.ok ? {} : { diagnostics: result.error },
    }, {
      headers: {
        "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
        ...(!result.ok ? { "X-Sentinel-Partial-Data": "1" } : {}),
      },
    });
  }

  const bindings = getRuntimeBindings();
  const scanner = bindings.MARKET_SCANNER?.getByName("market-scanner") as unknown as CleanScannerStub | undefined;
  const position = bindings.POSITION_MONITOR?.getByName("position-monitor") as unknown as CleanPositionStub | undefined;
  const errors: Record<string, string> = {};
  const staleSources: string[] = [];

  const unavailable = <T,>(label: string): Promise<ReadResult<T>> => Promise.resolve({ ok: false, error: `${label}_UNAVAILABLE` });
  const [scannerResult, positionResult, readModelResult, dashboardResult] = await Promise.all([
    scanner ? boundedRead("scanner_status", scanner.status(), DO_READ_DEADLINE_MS) : unavailable<SchedulerWorkerStatus>("scanner_status"),
    position ? boundedRead("position_status", position.status(), DO_READ_DEADLINE_MS) : unavailable<SchedulerWorkerStatus>("position_status"),
    scanner ? boundedRead("scanner_read_model", scanner.readModel(), DO_READ_DEADLINE_MS) : unavailable<Hte31ScanCompleted | null>("scanner_read_model"),
    boundedRead("dashboard", getHte31Dashboard(requestedAt), MAIN_READ_DEADLINE_MS),
  ]);

  const scannerStatus = resolveReadResult("scannerStatus", scannerResult, lastGoodScannerStatus, errors, staleSources);
  const positionStatus = resolveReadResult("positionStatus", positionResult, lastGoodPositionStatus, errors, staleSources);
  const readModel = resolveReadResult("scannerReadModel", readModelResult, lastGoodReadModel, errors, staleSources);
  const dashboard = resolveReadResult("dashboard", dashboardResult, lastGoodDashboard, errors, staleSources);
  if (scannerResult.ok) lastGoodScannerStatus = scannerResult.value;
  if (positionResult.ok) lastGoodPositionStatus = positionResult.value;
  if (readModelResult.ok && readModelResult.value) lastGoodReadModel = readModelResult.value;
  if (dashboardResult.ok) lastGoodDashboard = dashboardResult.value;

  const lastSuccessAt = scannerStatus?.lastSuccessAt ?? readModel?.observedAt ?? null;
  const scannerAgeMs = lastSuccessAt == null ? null : Math.max(0, requestedAt - lastSuccessAt);
  if (scannerAgeMs != null && scannerAgeMs > SCANNER_STALE_MS) errors.scannerFreshness = `Resonance Scanner 已 ${Math.round(scannerAgeMs / 1000)} 秒没有完成新评估`;
  if (scannerStatus?.lastError) errors.scannerRuntime = scannerStatus.lastError;
  if (positionStatus?.lastError) errors.positionRuntime = positionStatus.lastError;
  const displayReadModel = readModel ? { ...readModel, marketView: dashboardMarketView(readModel) } : null;

  return Response.json({
    version: "direct-market-brain-v1",
    requestedAt,
    observedAt: lastSuccessAt ?? requestedAt,
    account: auth.account,
    scanner: { status: scannerStatus, ageMs: scannerAgeMs, readModel: displayReadModel },
    position: { status: positionStatus },
    market: readModel?.market ?? null,
    asset: readModel ? { symbol: readModel.target, view: dashboardMarketView(readModel), candidate: readModel.directCandidate } : null,
    decisionChain: readModel ? {
      wholeMarket: readModel.market,
      symbol: readModel.target,
      symbolView: dashboardMarketView(readModel),
      directCandidate: readModel.directCandidate,
      openReason: readModel.openReason,
    } : null,
    dashboard,
    diagnostics: null,
    staleSources,
    degraded: Object.keys(errors).length > 0,
    errors,
  }, {
    headers: {
      "Cache-Control": "private, max-age=3, stale-while-revalidate=8",
      ...(Object.keys(errors).length ? { "X-Sentinel-Partial-Data": "1" } : {}),
    },
  });
}
