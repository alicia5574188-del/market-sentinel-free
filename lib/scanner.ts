import { analyzeGateSymbol, fetchGatePositionQuotes, fetchGateUniverse, type GateAnalysisPacket, type UniverseTicker } from "./gate-client.ts";
import { getGlobalRiskContext, type GlobalRiskPacket } from "./global-risk.ts";
import { beginScan, completeScan, getAlertDashboard, getExperience, getPriorLong, getSettings, listOpenTrades, listOpenTradeSymbols, markNotified, markTradeNotification, processDecision, processPositionQuote, publicSettings, type LifecycleResult } from "./repository.ts";
import { notifyTradeLifecycle, type VapidConfig } from "./web-push.ts";
import { chooseBackgroundDeepUniverse } from "./background-selection.ts";

export function chooseDeepUniverse(universe: UniverseTicker[], coreSymbols: string[], openSymbols: string[], limit: number) {
  const selected: UniverseTicker[] = [];
  for (const symbol of [...openSymbols, ...coreSymbols]) {
    const ticker = universe.find((item) => item.symbol === symbol);
    if (ticker && !selected.some((item) => item.symbol === symbol)) selected.push(ticker);
  }
  const candidates = [...universe].sort((a, b) => Math.abs(b.coarseScore) - Math.abs(a.coarseScore));
  for (const ticker of candidates) {
    if (selected.length >= limit) break;
    if (!selected.some((item) => item.symbol === ticker.symbol)) selected.push(ticker);
  }
  return selected.slice(0, Math.max(limit, openSymbols.length));
}

export type MarketScanOptions = {
  profile?: "full" | "free-background";
  deepLimit?: number;
  rotationOffset?: number;
};

export async function getQuickScanner() {
  const settings = await getSettings();
  const coreSymbols = JSON.parse(settings.coreSymbolsJson) as string[];
  const [openSymbols, openTrades] = await Promise.all([listOpenTradeSymbols(), listOpenTrades()]);
  const [universe, context] = await Promise.all([
    fetchGateUniverse(settings.universeLimit, [...coreSymbols, ...openSymbols]),
    getGlobalRiskContext(),
  ]);
  return { observedAt: Date.now(), universe, context, openTrades, settings: publicSettings(settings) };
}

export async function refreshOpenPositions(vapidConfig?: VapidConfig | null, options: { includeDashboard?: boolean } = {}) {
  const includeDashboard = options.includeDashboard ?? true;
  const settings = await getSettings();
  const openTrades = await listOpenTrades();
  if (!openTrades.length) {
    return {
      status: "idle",
      observedAt: Date.now(),
      refreshed: 0,
      failures: [],
      notifications: { attempted: 0, delivered: 0 },
      dashboard: includeDashboard ? await getAlertDashboard(120) : undefined,
    };
  }

  const quotes = await fetchGatePositionQuotes(openTrades.map((trade) => trade.symbol));
  if (!quotes.length) throw new Error("Gate 未返回任何持仓实时价格，订单时间未更新。");
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const failures = openTrades.filter((trade) => !quoteBySymbol.has(trade.symbol)).map((trade) => ({ symbol: trade.symbol, error: "Gate 未返回该合约价格" }));
  const lifecycle: { symbol: string; result: LifecycleResult }[] = [];
  let attempted = 0;
  let delivered = 0;
  for (const trade of openTrades) {
    const quote = quoteBySymbol.get(trade.symbol);
    if (!quote) continue;
    const result = await processPositionQuote(quote, settings);
    lifecycle.push({ symbol: trade.symbol, result });
    if (result.shouldNotify && result.notification && result.trade && vapidConfig) {
      const push = await notifyTradeLifecycle(result.notification, result.trade, vapidConfig).catch(() => ({ attempted: 0, delivered: 0 }));
      attempted += push.attempted;
      delivered += push.delivered;
      if (push.delivered > 0) await markTradeNotification(result.trade.id, result.notification);
    }
  }
  return {
    status: failures.length ? "degraded" : "completed",
    observedAt: Math.max(...quotes.map((quote) => quote.observedAt)),
    refreshed: lifecycle.length,
    lifecycle,
    failures,
    notifications: { attempted, delivered },
    dashboard: includeDashboard ? await getAlertDashboard(120) : undefined,
  };
}

export async function runMarketScan(vapidConfig?: VapidConfig | null, options: MarketScanOptions = {}) {
  const settings = await getSettings();
  const coreSymbols = JSON.parse(settings.coreSymbolsJson) as string[];
  if (!settings.scanEnabled) return { status: "paused", observedAt: Date.now(), analyzed: [], notifications: { attempted: 0, delivered: 0 } };
  const openSymbols = await listOpenTradeSymbols();
  const [universe, context] = await Promise.all([
    fetchGateUniverse(settings.universeLimit, [...coreSymbols, ...openSymbols]),
    getGlobalRiskContext(),
  ]);
  const scan = await beginScan(universe.length);
  const targets = options.profile === "free-background"
    ? chooseBackgroundDeepUniverse(
      universe,
      coreSymbols,
      openSymbols,
      options.deepLimit ?? 3,
      options.rotationOffset ?? 0,
    )
    : chooseDeepUniverse(universe, coreSymbols, openSymbols, options.deepLimit ?? settings.deepScanLimit);
  const analyzed: GateAnalysisPacket[] = [];
  const lifecycle: { symbol: string; result: LifecycleResult }[] = [];
  const failures: { symbol: string; error: string }[] = [];
  let delivered = 0;
  let attempted = 0;
  try {
    const results = await Promise.allSettled(targets.map(async (ticker) => {
      const [priorLongProbability, experience] = await Promise.all([getPriorLong(ticker.symbol), getExperience(ticker.symbol)]);
      return analyzeGateSymbol(ticker.symbol, {
        global: context,
        priorLongProbability,
        experience,
        alertStyle: settings.alertStyle,
        detail: "scan",
      });
    }));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "rejected") {
        failures.push({ symbol: targets[index].symbol, error: result.reason instanceof Error ? result.reason.message : "analysis failed" });
        continue;
      }
      const packet = result.value;
      analyzed.push(packet);
      const saved = await processDecision(packet, settings);
      lifecycle.push({ symbol: packet.symbol, result: saved });
      if (saved.shouldNotify && saved.notification && saved.trade && vapidConfig) {
        const push = await notifyTradeLifecycle(saved.notification, saved.trade, vapidConfig).catch(() => ({ attempted: 0, delivered: 0 }));
        attempted += push.attempted;
        delivered += push.delivered;
        if (push.delivered > 0) {
          await markTradeNotification(saved.trade.id, saved.notification);
          if (saved.transitionId) await markNotified(saved.transitionId);
        }
      }
    }
    const qualities = analyzed.map((packet) => packet.decision.dataQuality);
    await completeScan(scan.id, scan.startedAt, {
      status: failures.length ? "degraded" : "completed",
      deepScanned: analyzed.length,
      confirmedCount: lifecycle.filter((item) => item.result.kind === "opened").length,
      preAlertCount: analyzed.filter((packet) => packet.decision.state === "pre_alert").length,
      averageDataQuality: qualities.length ? qualities.reduce((sum, value) => sum + value, 0) / qualities.length : null,
      error: failures.length ? JSON.stringify(failures) : null,
    });
    return {
      status: failures.length ? "degraded" : "completed",
      observedAt: Date.now(),
      universe,
      context: context as GlobalRiskPacket,
      analyzed,
      lifecycle,
      failures,
      notifications: { attempted, delivered },
    };
  } catch (error) {
    await completeScan(scan.id, scan.startedAt, {
      status: "failed",
      deepScanned: analyzed.length,
      confirmedCount: lifecycle.filter((item) => item.result.kind === "opened").length,
      preAlertCount: analyzed.filter((packet) => packet.decision.state === "pre_alert").length,
      averageDataQuality: null,
      error: error instanceof Error ? error.message : "scan failed",
    });
    throw error;
  }
}
