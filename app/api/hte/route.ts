import { ensureBackgroundSchedulers } from "../../../lib/background-scheduler";
import { getRuntimeBindings } from "../../../lib/runtime-bindings";
import { getAlertDashboard, getSettings, listOpenTrades, publicSettings } from "../../../lib/repository";
import { getStrategyLabDashboard } from "../../../lib/shadow-strategy-repository";
import { getLatestV2MarketContext, listRecentV2Opportunities, listRecentV2Warnings } from "../../../lib/sentinel-v2-repository";
import { getContractV2HistoryStats } from "../../../lib/dashboard-history-stats";
import { refreshOpenPositions } from "../../../lib/scanner";
import { recoverOverdueSimulationTimeouts } from "../../../lib/position-timeout-recovery";
import { requireApiAccount } from "../../api-auth";

export const dynamic = "force-dynamic";

const POSITION_UI_STALE_MS = 45_000;
const POSITION_SAFETY_REFRESH_GAP_MS = 30_000;
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

  const observedAt = Date.now();
  let timeoutRecovery: Awaited<ReturnType<typeof recoverOverdueSimulationTimeouts>> | null = null;
  let timeoutRecoveryError = "";
  try {
    timeoutRecovery = await recoverOverdueSimulationTimeouts(observedAt);
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
  ] as const);

  const names = ["scanner", "market", "opportunities", "warnings", "traders", "orders", "stats", "background"] as const;
  const errors: Record<string, string> = {};
  results.forEach((result, index) => {
    if (result.status === "rejected") errors[names[index]] = errorMessage(result.reason);
  });
  if (timeoutRecoveryError) errors.timeoutRecovery = timeoutRecoveryError;
  if (timeoutRecovery?.failures.length) errors.timeoutRecovery = timeoutRecovery.failures.map((item) => `${item.symbol}: ${item.error}`).join("; ");
  if (positionSafetyError) errors.positionSafety = positionSafetyError;
  if (positionSafety?.failures.length) errors.positionSafety = positionSafety.failures.map((item) => `${item.symbol}: ${item.error}`).join("; ");

  const scanner = results[0].status === "fulfilled" ? results[0].value : null;
  const market = results[1].status === "fulfilled" ? results[1].value : scanner?.v2 ?? null;
  const opportunities = results[2].status === "fulfilled" ? results[2].value : [];
  const warnings = results[3].status === "fulfilled" ? results[3].value : [];
  const traders = results[4].status === "fulfilled" ? results[4].value : null;
  const rawOrders = results[5].status === "fulfilled" ? results[5].value : null;
  const startingCapitalUsdt = scanner?.settings?.trialCapitalUsdt ?? 1000;
  const orders = humanOnlyDashboard(rawOrders, startingCapitalUsdt);
  const stats = results[6].status === "fulfilled" ? results[6].value : null;
  const background = results[7].status === "fulfilled" ? results[7].value : null;
  const degraded = Object.keys(errors).length > 0 || Boolean(scanner?.error);

  return Response.json({
    version: "human-trader-3.0",
    observedAt,
    account: auth.account,
    scanner,
    market,
    opportunities,
    warnings,
    traders,
    orders,
    stats,
    background,
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
