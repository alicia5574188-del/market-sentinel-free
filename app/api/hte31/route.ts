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
  return error instanceof Error ? error.message : "unknown HTE 3.1 runtime error";
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
      ? "HT3 暂不参与放宽影子验证"
      : `Near-Ready 影子完成 ${shadow.completed} / 观察中 ${shadow.pending} · PF ${fmtPf(shadow.profitFactor)} · Exp ${shadow.expectancyR >= 0 ? "+" : ""}${shadow.expectancyR.toFixed(2)}R${shadow.qualifiesForCalibration ? " · 已达到校准样本门槛" : " · 尚未达到 30 样本校准门槛"}`;
    guard.reason = `${guard.reason} · 1h 评估 ${hour.evaluations} / READY ${hour.ready} / Near-Ready ${hour.nearReady}${top ? ` · 常缺：${top}` : ""} · 最近：${near} · 6h READY ${sixHours.ready}/${sixHours.evaluations} · ${shadowText}`;
  }
  dashboard.governance.reason = `${dashboard.governance.reason} · 风险预算倍率 ${Math.round(dashboard.governance.riskMultiplier * 100)}%：新模拟单按账户权益约4%规划风险，并限制在3%–5%；TP2扣费后目标5%–20%，仓位与目标先调整，不能满足安全边界才拒绝。`;
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
