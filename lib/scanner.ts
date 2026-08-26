import { analyzeGateSymbol, fetchGateChartCandles, fetchGatePositionQuotes, fetchGateUniverse, type GateAnalysisPacket, type UniverseTicker } from "./gate-client.ts";
import { getGlobalRiskContext, type GlobalRiskPacket } from "./global-risk.ts";
import { beginScan, completeScan, getAlertDashboard, getSettings, listOpenTrades, listOpenTradeSymbols, markNotified, markTradeNotification, processPositionQuote, publicSettings, type LifecycleResult } from "./repository.ts";
import { notifyTradeLifecycle, type VapidConfig } from "./web-push.ts";
import { chooseBackgroundDeepUniverse } from "./background-selection.ts";
import { evaluateSentinelV2, type MarketBreadth } from "./sentinel-v2-engine.ts";
import { getLatestSentinelV2Context, getSentinelV2Pulse, saveSentinelV2Evaluation } from "./sentinel-v2-repository.ts";
import { decoratePacketWithSentinelV2, processShadowStrategies, retireLegacyShadowTrades } from "./shadow-strategy-repository.ts";

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

export function marketBreadthFromUniverse(universe: UniverseTicker[]): MarketBreadth | null {
  const valid = universe.filter((item) => Number.isFinite(item.changePercentage));
  if (!valid.length) return null;
  const advances = valid.filter((item) => item.changePercentage > 0).length;
  const declines = valid.filter((item) => item.changePercentage < 0).length;
  const strongAdvances = valid.filter((item) => item.changePercentage >= 2).length;
  const strongDeclines = valid.filter((item) => item.changePercentage <= -2).length;
  return {
    sampleSize: valid.length,
    advanceRatio: advances / valid.length,
    declineRatio: declines / valid.length,
    strongAdvanceRatio: strongAdvances / valid.length,
    strongDeclineRatio: strongDeclines / valid.length,
    averageChangePct: valid.reduce((sum, item) => sum + item.changePercentage, 0) / valid.length,
  };
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
  const [universe, context, sentinelV2] = await Promise.all([
    fetchGateUniverse(settings.universeLimit, [...coreSymbols, ...openSymbols]),
    getGlobalRiskContext(),
    getSentinelV2Pulse().catch(() => null),
  ]);
  return { observedAt: Date.now(), universe, context, sentinelV2, openTrades, settings: publicSettings(settings) };
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
  await retireLegacyShadowTrades();
  const openSymbols = await listOpenTradeSymbols();
  const [universe, context] = await Promise.all([
    fetchGateUniverse(settings.universeLimit, [...coreSymbols, ...openSymbols]),
    getGlobalRiskContext(),
  ]);
  const breadth = marketBreadthFromUniverse(universe);
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
  const growthLifecycle: {
    symbol: string;
    observedAt: number;
    opened: number;
    closed: number;
    evaluated: number;
    archived: number;
    selected: string | null;
    ready: number;
    watching: number;
    blocked: number;
    error: string | null;
  }[] = [];
  const failures: { symbol: string; error: string }[] = [];
  let delivered = 0;
  let attempted = 0;

  const deliverLifecycle = async (result: LifecycleResult) => {
    if (!result.shouldNotify || !result.notification || !result.trade || !vapidConfig) return;
    const push = await notifyTradeLifecycle(result.notification, result.trade, vapidConfig).catch(() => ({ attempted: 0, delivered: 0 }));
    attempted += push.attempted;
    delivered += push.delivered;
    if (push.delivered > 0) {
      await markTradeNotification(result.trade.id, result.notification);
      if (result.transitionId) await markNotified(result.transitionId);
    }
  };

  try {
    const results = await Promise.allSettled(targets.map(async (ticker) => {
      const packetPromise = analyzeGateSymbol(ticker.symbol, {
        global: context,
        alertStyle: settings.alertStyle,
        detail: "scan",
      });
      const growthCandlesPromise = fetchGateChartCandles(ticker.symbol, Date.now() - 18 * 60 * 60_000, Date.now())
        .then((candles) => ({ candles, error: null as string | null }))
        .catch((error) => ({
          candles: [],
          error: error instanceof Error ? error.message : "Sentinel V2 5m K 线读取失败",
        }));
      const previousPromise = getLatestSentinelV2Context(ticker.symbol).catch(() => null);
      const [packet, growthData, previousContext] = await Promise.all([packetPromise, growthCandlesPromise, previousPromise]);
      return { packet, growthCandles: growthData.candles, growthError: growthData.error, previousContext };
    }));

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "rejected") {
        failures.push({ symbol: targets[index].symbol, error: result.reason instanceof Error ? result.reason.message : "analysis failed" });
        continue;
      }

      const { packet, growthCandles, growthError, previousContext } = result.value;
      if (!growthCandles.length) {
        const message = growthError ?? "Sentinel V2 5m K 线为空";
        failures.push({ symbol: packet.symbol, error: `V2 扩展数据：${message}` });
        analyzed.push(packet);
        growthLifecycle.push({
          symbol: packet.symbol,
          observedAt: packet.observedAt,
          opened: 0,
          closed: 0,
          evaluated: 0,
          archived: 0,
          selected: null,
          ready: 0,
          watching: 0,
          blocked: 1,
          error: message,
        });
        continue;
      }

      const evaluation = evaluateSentinelV2({
        symbol: packet.symbol,
        observedAt: packet.observedAt,
        futuresPrice: packet.market.futuresPrice,
        volumeUsd: packet.market.volumeUsd,
        changePercentage: packet.market.changePercentage,
        fundingRate: packet.market.fundingRate,
        openInterestChangePct: packet.market.openInterestChangePct,
        spotCvdRatio: packet.market.spotCvdRatio,
        orderBookImbalance: packet.market.orderBookImbalance,
        liquidationImbalance: packet.market.liquidationImbalance,
        multiTimeframeTrend: packet.market.multiTimeframeTrend,
        benchmarkMomentum: context.benchmarkMomentum,
        macroEventRisk: packet.market.macroEventRisk,
        dataQuality: packet.decision.dataQuality,
        candles5m: growthCandles,
        breadth,
        previousContext,
      });
      await saveSentinelV2Evaluation(evaluation);
      const decoratedPacket = decoratePacketWithSentinelV2(packet, evaluation);
      analyzed.push(decoratedPacket);

      // V1 evaluateMarket remains a market-data parser only. It no longer calls
      // processDecision here, so only Sentinel V2 can create a new trade case.
      const growth = await processShadowStrategies(packet, evaluation, settings);
      if (growth.lifecycle) {
        lifecycle.push({ symbol: packet.symbol, result: growth.lifecycle });
        await deliverLifecycle(growth.lifecycle);
      }
      growthLifecycle.push({
        symbol: packet.symbol,
        observedAt: packet.observedAt,
        opened: growth.opened,
        closed: growth.closed,
        evaluated: growth.evaluated,
        archived: growth.archived,
        selected: growth.selected,
        ready: evaluation.opportunities.filter((opportunity) => opportunity.state === "TRADE").length,
        watching: evaluation.opportunities.filter((opportunity) => opportunity.state === "WATCH").length,
        blocked: evaluation.opportunities.filter((opportunity) => opportunity.state === "REJECT").length,
        error: null,
      });
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
      breadth,
      sentinelV2: await getSentinelV2Pulse().catch(() => null),
      analyzed,
      lifecycle,
      growthLifecycle,
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
