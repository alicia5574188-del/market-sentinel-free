import type { SchedulerWorkerStatus } from "../../../lib/background-scheduler";
import { getHte31Diagnostics } from "../../../lib/hte31-diagnostics";
import { getHte31Dashboard } from "../../../lib/hte31-repository";
import type { Hte31ScanCompleted } from "../../../lib/hte31-scanner";
import { getRuntimeBindings } from "../../../lib/runtime-bindings";
import type { HumanTraderId } from "../../../lib/human-trader-engine";
import { requireApiAccount } from "../../api-auth";

export const dynamic = "force-dynamic";

const SCANNER_STALE_MS = 90_000;
const TRADERS: HumanTraderId[] = ["dennis_trend", "raschke_pullback", "turtle_soup"];

type CleanScannerStub = {
  status(): Promise<SchedulerWorkerStatus>;
  readModel(): Promise<Hte31ScanCompleted | null>;
};

type CleanPositionStub = {
  status(): Promise<SchedulerWorkerStatus>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown Resonance runtime error";
}

function fmtPf(value: number | null) {
  return value == null ? "--" : value >= 99 ? "∞" : value.toFixed(2);
}

function enrichDashboardDiagnostics(
  dashboard: Awaited<ReturnType<typeof getHte31Dashboard>>,
  diagnostics: Awaited<ReturnType<typeof getHte31Diagnostics>>,
) {
  for (const traderId of TRADERS) {
    const guard = dashboard.governance.traderGuards[traderId];
    const hour = diagnostics.windows.h1.traders[traderId];
    const sixHours = diagnostics.windows.h6.traders[traderId];
    const shadow = diagnostics.shadow[traderId];
    const top = hour.topFailures.slice(0, 2)
      .map((item) => `${item.label} ${Math.round(item.rate * 100)}%`)
      .join(" / ");
    const near = hour.nearest?.failed.length
      ? `${hour.nearest.symbol.replace("_USDT", "")} 还差 ${hour.nearest.failed.map((item) => item.label).join(" + ")}`
      : hour.nearest ? `${hour.nearest.symbol.replace("_USDT", "")} 已接近完整 Setup` : "暂无近似候选";
    const shadowText = traderId === "turtle_soup"
      ? "HT3 暂不参与旧 Near-Ready 校准"
      : `旧 Near-Ready 影子完成 ${shadow.completed} / 观察中 ${shadow.pending} · PF ${fmtPf(shadow.profitFactor)} · Exp ${shadow.expectancyR >= 0 ? "+" : ""}${shadow.expectancyR.toFixed(2)}R${shadow.qualifiesForCalibration ? " · 已达到校准样本门槛" : " · 尚未达到 30 样本校准门槛"}`;
    // The cognitive paper executor no longer consumes the legacy two-loss
    // cooldown guard. Keep the loss streak visible as evidence, but do not tell
    // the owner that paper learning is sleeping when it is still collecting and
    // diagnosing samples.
    if (guard.state === "COOLDOWN") {
      guard.state = "ACTIVE";
      guard.reason = `连续亏损 ${guard.lossStreak} 笔已交给认知复盘；模拟学习继续运行，不做机械时间冷却`;
    }
    guard.reason = `${guard.reason} · 1h 评估 ${hour.evaluations} / READY ${hour.ready} / Near-Ready ${hour.nearReady}${top ? ` · 常缺：${top}` : ""} · 最近：${near} · 6h READY ${sixHours.ready}/${sixHours.evaluations} · ${shadowText}`;
  }

  // Paper learning uses full nominal sizing unless a trade fails the real
  // structural/data/economic gates. The old account loss multiplier remains in
  // the legacy repository for compatibility, but it no longer controls new
  // Resonance paper entries.
  dashboard.governance.state = "NORMAL";
  dashboard.governance.riskMultiplier = 1;
  dashboard.governance.reason = "认知学习模式：连续亏损触发归因、挑战方案和影子验证；不再用两小时/六小时冷却或缩仓代替思考。";
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
    errors.bindings = "Resonance Durable Object bindings unavailable";
  } else {
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

  let diagnostics: Awaited<ReturnType<typeof getHte31Diagnostics>> | null = null;
  try {
    diagnostics = await getHte31Diagnostics(requestedAt);
    if (dashboard) enrichDashboardDiagnostics(dashboard, diagnostics);
  } catch (error) {
    errors.diagnostics = errorMessage(error);
  }

  const lastSuccessAt = scannerStatus?.lastSuccessAt ?? readModel?.observedAt ?? null;
  const scannerAgeMs = lastSuccessAt == null ? null : Math.max(0, requestedAt - lastSuccessAt);
  if (scannerAgeMs != null && scannerAgeMs > SCANNER_STALE_MS) {
    errors.scannerFreshness = `Resonance Scanner 已 ${Math.round(scannerAgeMs / 1000)} 秒没有完成新评估`;
  }
  if (scannerStatus?.lastError) errors.scannerRuntime = scannerStatus.lastError;
  if (positionStatus?.lastError) errors.positionRuntime = positionStatus.lastError;

  return Response.json({
    version: "resonance-v2-cognitive",
    requestedAt,
    observedAt: lastSuccessAt ?? requestedAt,
    account: auth.account,
    scanner: {
      status: scannerStatus,
      ageMs: scannerAgeMs,
      readModel,
    },
    position: { status: positionStatus },
    // Whole-market state is independent from the currently deep-scanned asset.
    market: readModel?.market ?? null,
    asset: readModel ? {
      symbol: readModel.target,
      view: readModel.marketView,
      memory: readModel.memory,
    } : null,
    decisionChain: readModel ? {
      wholeMarket: readModel.market,
      symbol: readModel.target,
      symbolView: readModel.marketView,
      historicalMemory: readModel.memory,
      latestReview: readModel.review,
      openReason: readModel.openReason,
    } : null,
    dashboard,
    diagnostics,
    degraded: Object.keys(errors).length > 0,
    errors,
  }, {
    headers: {
      "Cache-Control": "private, max-age=3, stale-while-revalidate=8",
      ...(Object.keys(errors).length ? { "X-Sentinel-Partial-Data": "1" } : {}),
    },
  });
}
