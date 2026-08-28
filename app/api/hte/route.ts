import { ensureBackgroundSchedulers } from "../../../lib/background-scheduler";
import { getRuntimeBindings } from "../../../lib/runtime-bindings";
import { getAlertDashboard, getSettings, listOpenTrades, publicSettings } from "../../../lib/repository";
import { getStrategyLabDashboard } from "../../../lib/shadow-strategy-repository";
import { getLatestV2MarketContext, getV2StrategyPoolActivity, listRecentV2Opportunities, listRecentV2Warnings } from "../../../lib/sentinel-v2-repository";
import { getContractV2HistoryStats } from "../../../lib/dashboard-history-stats";
import { refreshOpenPositions } from "../../../lib/scanner";
import { recoverOverdueSimulationTimeouts } from "../../../lib/position-timeout-recovery";
import { requireApiAccount } from "../../api-auth";

export const dynamic = "force-dynamic";

const POSITION_UI_STALE_MS = 45_000;
const POSITION_SAFETY_REFRESH_GAP_MS = 30_000;
const SCANNER_STALE_MS = 150_000;
const OPPORTUNITY_FRESH_MS = 15 * 60_000;
let lastPositionSafetyRefreshAt = 0;
let positionSafetyPending: Promise<{ refreshed: number; failures: { symbol: string; error: string }[] }> | null = null;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "source unavailable";
}

async function refreshStaleOpenPositionsForSafety() {
  const openTrades = await listOpenTrades();
  const now = Date.now();
  const stale = openTrades.filter((trade) => now - trade.lastEvaluatedAt > POSITION_UI_STALE_MS);
  const overdue = openTrades.filter((trade) => now - trade.entryAt >= trade.maxHoldingMinutes * 60_000);
  const needsSafetyRefresh = [...new Set([...stale.map((trade) => trade.id), ...overdue.map((trade) => trade.id)])];
  if (!needsSafetyRefresh.length) return { triggered: false, stale: 0, overdue: 0, refreshed: 0, failures: [] as { symbol: string; error: string }[] };

  if (now - lastPositionSafetyRefreshAt < POSITION_SAFETY_REFRESH_GAP_MS) {
    return { triggered: false, stale: stale.length, overdue: overdue.length, refreshed: 0, failures: [] as { symbol: string; error: string }[] };
  }

  if (!positionSafetyPending) {
    lastPositionSafetyRefreshAt = now;
    positionSafetyPending = refreshOpenPositions(null, { includeDashboard: false })
      .then((result) => ({ refreshed: result.refreshed, failures: result.failures }))
      .finally(() => { positionSafetyPending = null; });
  }
  const result = await positionSafetyPending;
  return { triggered: true, stale: stale.length, overdue: overdue.length, ...result };
}

async function readScannerSnapshot() {
  const bindings = getRuntimeBindings();
  const scanner = bindings.MARKET_SCANNER?.getByName("market-scanner");
  if (scanner) {
    try {
      const snapshot = await scanner.readModel();
      if (snapshot) {
        return {
          ...snapshot,
          snapshotSource: "background_scanner" as const,
          snapshotAgeMs: Math.max(0, Date.now() - snapshot.observedAt),
        };
      }
    } catch {
      // The dashboard must stay usable even if the background read model is
      // temporarily unavailable. Fall back to D1-only state; safety management
      // of an already-open position is handled separately above.
    }
  }

  const [settings, openTrades, market] = await Promise.all([
    getSettings(),
    listOpenTrades(),
    getLatestV2MarketContext(),
  ]);
  return {
    observedAt: Date.now(),
    universe: [],
    context: null,
    v2: market,
    openTrades,
    settings: publicSettings(settings),
    snapshotSource: "d1_fallback" as const,
    snapshotAgeMs: null,
    error: "后台市场快照暂不可用；前台已降级为 D1 状态。已有持仓仍保留独立安全刷新，不会启动新币扫描。",
  };
}

function humanOnlyDashboard(dashboard: Awaited<ReturnType<typeof getAlertDashboard>> | null, startingCapitalUsdt: number) {
  if (!dashboard) return null;
  const trades = dashboard.trades.filter((trade) => trade.regime.startsWith("S2|HT"));
  const openTrades = trades.filter((trade) => trade.status === "holding");
  const closedTrades = trades.filter((trade) => trade.status === "closed");
  const realizedPnlUsdt = closedTrades.reduce((sum, trade) => sum + (trade.netPnlUsdt ?? 0), 0);
  const unrealizedPnlUsdt = openTrades.reduce((sum, trade) => sum + trade.unrealizedNetUsdt, 0);
  const realizedBalanceUsdt = startingCapitalUsdt + realizedPnlUsdt;
  const equityUsdt = realizedBalanceUsdt + unrealizedPnlUsdt;
  const usedMarginUsdt = openTrades.reduce((sum, trade) => sum + trade.marginUsdt, 0);
  return {
    ...dashboard,
    alerts: [],
    memories: [],
    trades,
    openTrades,
    archivedCount: 0,
    account: {
      startingCapitalUsdt,
      realizedPnlUsdt,
      unrealizedPnlUsdt,
      realizedBalanceUsdt,
      equityUsdt,
      usedMarginUsdt,
      availableMarginUsdt: Math.max(0, equityUsdt - usedMarginUsdt),
    },
  };
}

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;

  const requestedAt = Date.now();
  let timeoutRecovery: Awaited<ReturnType<typeof recoverOverdueSimulationTimeouts>> | null = null;
  let timeoutRecoveryError = "";
  try {
    timeoutRecovery = await recoverOverdueSimulationTimeouts(requestedAt);
  } catch (error) {
    timeoutRecoveryError = errorMessage(error);
  }

  let positionSafety: Awaited<ReturnType<typeof refreshStaleOpenPositionsForSafety>> | null = null;
  let positionSafetyError = "";
  try {
    positionSafety = await refreshStaleOpenPositionsForSafety();
  } catch (error) {
    positionSafetyError = errorMessage(error);
  }

  const results = await Promise.allSettled([
    readScannerSnapshot(),
    getLatestV2MarketContext(),
    listRecentV2Opportunities(48),
    listRecentV2Warnings(12),
    getStrategyLabDashboard(),
    getAlertDashboard(80),
    getContractV2HistoryStats(),
    ensureBackgroundSchedulers(),
    getV2StrategyPoolActivity(10 * 60_000),
  ] as const);

  const names = ["scanner", "market", "opportunities", "warnings", "traders", "orders", "stats", "background", "activity"] as const;
  const errors: Record<string, string> = {};
  results.forEach((result, index) => {
    if (result.status === "rejected") errors[names[index]] = errorMessage(result.reason);
  });
  if (timeoutRecoveryError) errors.timeoutRecovery = timeoutRecoveryError;
  if (timeoutRecovery?.failures.length) errors.timeoutRecovery = timeoutRecovery.failures.map((item) => `${item.symbol}: ${item.error}`).join("; ");
  if (positionSafetyError) errors.positionSafety = positionSafetyError;
  if (positionSafety?.failures.length) errors.positionSafety = positionSafety.failures.map((item) => `${item.symbol}: ${item.error}`).join("; ");

  const background = results[7].status === "fulfilled" ? results[7].value : null;
  const rawScanner = results[0].status === "fulfilled" ? results[0].value : null;
  const scannerAgeMs = rawScanner?.observedAt ? Math.max(0, requestedAt - rawScanner.observedAt) : null;
  const schedulerLastError = background?.scanner?.lastError?.trim() || null;
  const schedulerAttemptAgeMs = background?.scanner?.lastRunAt ? Math.max(0, requestedAt - background.scanner.lastRunAt) : null;
  const schedulerPhase = background?.scanner?.phase?.trim() || null;
  const schedulerPhaseAttempt = background?.scanner?.phaseAttempt ?? 0;
  const schedulerCircuitOpen = background?.scanner?.circuitOpen ?? false;
  const schedulerRetryAfter = background?.scanner?.retryAfter ?? null;
  if (scannerAgeMs != null && scannerAgeMs > SCANNER_STALE_MS) {
    errors.scannerFreshness = `后台市场扫描已经 ${Math.round(scannerAgeMs / 1000)} 秒没有成功生成新快照`;
    if (schedulerLastError) errors.scannerRuntime = schedulerLastError;
  }
  const phaseDetail = schedulerPhase
    ? ` 当前恢复阶段：${schedulerPhase}${schedulerPhaseAttempt ? ` · 尝试 ${schedulerPhaseAttempt}/3` : ""}.${schedulerCircuitOpen && schedulerRetryAfter ? ` 已熔断至 ${new Date(schedulerRetryAfter).toISOString()}，不会从头无限重启。` : ""}`
    : "";
  const staleScannerDetail = scannerAgeMs != null && scannerAgeMs > SCANNER_STALE_MS
    ? `后台市场扫描已滞后 ${Math.round(scannerAgeMs / 1000)} 秒；页面刷新本身正常，但行情深扫不是最新。${schedulerAttemptAgeMs != null ? ` 调度器最后尝试在 ${Math.round(schedulerAttemptAgeMs / 1000)} 秒前。` : ""}${phaseDetail}${schedulerLastError ? ` 最近扫描错误：${schedulerLastError.slice(0, 240)}` : ""}`
    : null;
  const scanner = rawScanner ? {
    ...rawScanner,
    snapshotAgeMs: scannerAgeMs,
    ...(staleScannerDetail && !rawScanner.error ? { error: staleScannerDetail } : {}),
  } : null;

  const rawMarket = results[1].status === "fulfilled" ? results[1].value : scanner?.v2 ?? null;
  const rawOpportunities = results[2].status === "fulfilled" ? results[2].value : [];
  const opportunities = rawOpportunities.filter((item) => requestedAt - item.observedAt <= OPPORTUNITY_FRESH_MS);
  const warnings = results[3].status === "fulfilled" ? results[3].value : [];
  const traders = results[4].status === "fulfilled" ? results[4].value : null;
  const rawOrders = results[5].status === "fulfilled" ? results[5].value : null;
  const startingCapitalUsdt = scanner?.settings?.trialCapitalUsdt ?? 1000;
  const orders = humanOnlyDashboard(rawOrders, startingCapitalUsdt);
  const stats = results[6].status === "fulfilled" ? results[6].value : null;
  const activity = results[8].status === "fulfilled" ? results[8].value : null;

  if (activity && activity.evaluations === 0 && scannerAgeMs != null && scannerAgeMs <= SCANNER_STALE_MS) {
    errors.strategyActivity = "后台市场快照仍新鲜，但过去 10 分钟没有任何 Human Trader 深度评估；需要检查深扫链路。";
  }

  const activityLine = activity
    ? `10分钟 HTE：${activity.symbols} 个币进入深扫 · 三交易员评估 ${activity.evaluations} 次 · TRADE ${activity.states.trade} / WATCH ${activity.states.watch} / REJECT ${activity.states.reject}`
    : "10分钟 HTE 活动统计暂不可用";
  const traderLine = traders?.strategies?.length
    ? `交易员：${traders.strategies.map((strategy) => `${strategy.label.split(" ")[0]} ${strategy.guard?.state ?? (strategy.mode === "active" ? "ACTIVE" : "GUARDED")}`).join(" · ")}`
    : "交易员状态暂不可用";
  const market = rawMarket ? {
    ...rawMarket,
    topDrivers: [activityLine, traderLine, ...(rawMarket.topDrivers ?? [])].slice(0, 5),
  } : null;

  const degraded = Object.keys(errors).length > 0 || Boolean(scanner?.error);
  const responseObservedAt = scanner?.snapshotSource === "background_scanner" && scanner.observedAt
    ? scanner.observedAt
    : requestedAt;

  return Response.json({
    version: "human-trader-3.0",
    observedAt: responseObservedAt,
    requestObservedAt: requestedAt,
    account: auth.account,
    scanner,
    market,
    opportunities,
    warnings,
    traders,
    orders,
    stats,
    background,
    activity,
    timeoutRecovery,
    positionSafety,
    degraded,
    errors,
  }, {
    headers: {
      "Cache-Control": "private, max-age=5, stale-while-revalidate=15",
      ...(degraded ? { "X-Sentinel-Partial-Data": "1" } : {}),
    },
  });
}