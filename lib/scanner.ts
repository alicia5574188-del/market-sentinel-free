import { analyzeGateSymbol, fetchGateChartCandles, fetchGatePositionQuotes, fetchGateUniverse, type GateAnalysisPacket, type UniverseTicker } from "./gate-client.ts";
import { getGlobalRiskContext, type GlobalRiskPacket } from "./global-risk.ts";
import { beginScan, completeScan, getAlertDashboard, getExperience, getPriorLong, getSettings, listOpenTrades, listOpenTradeSymbols, markNotified, markTradeNotification, processDecision, processPositionQuote, publicSettings, type LifecycleResult } from "./repository.ts";
import { notifyTradeLifecycle, type VapidConfig } from "./web-push.ts";
import { chooseBackgroundDeepUniverse, type BackgroundMarketSnapshot } from "./background-selection.ts";
import { processShadowStrategies, retireLegacyShadowTrades } from "./shadow-strategy-repository.ts";
import { buildSentinelV2MarketContext } from "./sentinel-v2-core.ts";
import { evaluateSentinelV2Strategies, type Strategy2Opportunity } from "./sentinel-v2-strategy.ts";
import { getStrategy2ExperienceBook } from "./strategy-2-learning.ts";
import { getLatestV2MarketContext, saveV2MarketContext, saveV2Opportunities } from "./sentinel-v2-repository.ts";
import { syncV2OpenTradeTheses } from "./sentinel-v2-thesis.ts";

const DEEP_TARGET_CONCURRENCY = 2;

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

export type MarketScanOptions = { profile?: "full" | "free-background"; deepLimit?: number; rotationOffset?: number; previousMarketSnapshot?: BackgroundMarketSnapshot };

function legacyObservationOnly(packet: GateAnalysisPacket): GateAnalysisPacket {
  if (packet.decision.state !== "confirmed") return packet;
  const plan = packet.decision.entryPlan;
  return {
    ...packet,
    decision: {
      ...packet.decision,
      state: "pre_alert",
      stateLabel: "V2 底层观察",
      action: "旧版评分仅作为证据，等待 Sentinel Strategy 2.0 决策",
      thesis: `底层分析已确认，但不再拥有开仓权。${packet.decision.thesis}`,
      trigger: `STRATEGY 2.0 ENTRY AUTHORITY：${packet.decision.trigger}`,
      entryPlan: plan ? {
        ...plan,
        ready: false,
        checks: [
          ...plan.checks.filter((check) => check.key !== "sentinel-v2-entry-authority"),
          { key: "sentinel-v2-entry-authority", label: "Strategy 2.0 唯一开仓权", passed: false, required: true, detail: "旧版基础评分只作为 Strategy 2.0 输入，不能直接创建新订单" },
        ],
      } : null,
    },
  };
}

function crossSectionRanks(universe: UniverseTicker[]) {
  const sorted = [...universe].sort((a, b) => a.changePercentage - b.changePercentage);
  const denominator = Math.max(1, sorted.length - 1);
  return new Map(sorted.map((ticker, index) => [ticker.symbol, index / denominator]));
}

function rotationVelocity(ticker: UniverseTicker, previous: BackgroundMarketSnapshot | undefined) {
  const prior = previous?.[ticker.symbol];
  if (!prior) return 0;
  return (ticker.coarseScore - prior.coarseScore) * 0.7 + ((ticker.changePercentage - prior.changePercentage) / 3) * 0.3;
}

export async function getQuickScanner() {
  const settings = await getSettings();
  const coreSymbols = JSON.parse(settings.coreSymbolsJson) as string[];
  const [openSymbols, openTrades] = await Promise.all([listOpenTradeSymbols(), listOpenTrades()]);
  const [universe, context, v2] = await Promise.all([
    fetchGateUniverse(settings.universeLimit, [...coreSymbols, ...openSymbols]),
    getGlobalRiskContext(),
    getLatestV2MarketContext(),
  ]);
  return { observedAt: Date.now(), universe, context, v2, openTrades, settings: publicSettings(settings) };
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
  const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const failures = openTrades.filter((trade) => !bySymbol.has(trade.symbol)).map((trade) => ({ symbol: trade.symbol, error: "Gate 未返回该合约价格" }));
  const lifecycle: { symbol: string; result: LifecycleResult }[] = [];
  let attempted = 0;
  let delivered = 0;

  for (const trade of openTrades) {
    const quote = bySymbol.get(trade.symbol);
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

async function analyzeTarget(ticker: UniverseTicker, context: Awaited<ReturnType<typeof getGlobalRiskContext>>, settings: Awaited<ReturnType<typeof getSettings>>) {
  const [priorLongProbability, experience] = await Promise.all([getPriorLong(ticker.symbol), getExperience(ticker.symbol)]);
  const packetPromise = analyzeGateSymbol(ticker.symbol, {
    global: context,
    priorLongProbability,
    experience,
    alertStyle: settings.alertStyle,
    detail: "scan",
  });
  const growthCandlesPromise = fetchGateChartCandles(ticker.symbol, Date.now() - 18 * 60 * 60_000, Date.now())
    .then((candles) => ({ candles, error: null as string | null }))
    .catch((error) => ({ candles: [], error: error instanceof Error ? error.message : "Strategy 2.0 5m K 线读取失败" }));
  const [packet, growthData] = await Promise.all([packetPromise, growthCandlesPromise]);
  return { packet, ticker, growthCandles: growthData.candles, growthError: growthData.error };
}

async function analyzeTargetsBounded(targets: UniverseTicker[], context: Awaited<ReturnType<typeof getGlobalRiskContext>>, settings: Awaited<ReturnType<typeof getSettings>>) {
  const results: PromiseSettledResult<Awaited<ReturnType<typeof analyzeTarget>>>[] = [];
  for (let offset = 0; offset < targets.length; offset += DEEP_TARGET_CONCURRENCY) {
    const batch = targets.slice(offset, offset + DEEP_TARGET_CONCURRENCY);
    results.push(...await Promise.allSettled(batch.map((ticker) => analyzeTarget(ticker, context, settings))));
  }
  return results;
}

export async function runMarketScan(vapidConfig?: VapidConfig | null, options: MarketScanOptions = {}) {
  const settings = await getSettings();
  const coreSymbols = JSON.parse(settings.coreSymbolsJson) as string[];
  if (!settings.scanEnabled) return { status: "paused", observedAt: Date.now(), analyzed: [], notifications: { attempted: 0, delivered: 0 } };
  await retireLegacyShadowTrades();

  const [openSymbols, initialOpenTrades] = await Promise.all([listOpenTradeSymbols(), listOpenTrades()]);
  const [universe, context, previousV2, experienceBook] = await Promise.all([
    fetchGateUniverse(settings.universeLimit, [...coreSymbols, ...openSymbols]),
    getGlobalRiskContext(),
    getLatestV2MarketContext(),
    getStrategy2ExperienceBook(),
  ]);
  const observedAt = Date.now();
  const v2Market = buildSentinelV2MarketContext({
    observedAt,
    universe,
    benchmarkMomentum: context.benchmarkMomentum,
    optionsIvPercentile: context.optionsIvPercentile,
    macroEventRisk: context.macroEventRisk,
    previous: previousV2,
  });
  await saveV2MarketContext(v2Market);
  await syncV2OpenTradeTheses(initialOpenTrades.map((trade) => ({
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    regime: trade.regime,
    entryThesis: trade.entryThesis,
    confidence: trade.confidence,
  })), v2Market);

  const scan = await beginScan(universe.length);
  const targets = options.profile === "free-background"
    ? chooseBackgroundDeepUniverse(universe, coreSymbols, openSymbols, options.deepLimit ?? 3, options.rotationOffset ?? 0, options.previousMarketSnapshot ?? {})
    : chooseDeepUniverse(universe, coreSymbols, openSymbols, options.deepLimit ?? settings.deepScanLimit);
  const ranks = crossSectionRanks(universe);
  const analyzed: GateAnalysisPacket[] = [];
  const lifecycle: { symbol: string; result: LifecycleResult }[] = [];
  const v2Opportunities: Strategy2Opportunity[] = [];
  const portfolioTrades = initialOpenTrades.map((trade) => ({ symbol: trade.symbol, side: trade.side, entryThesis: trade.entryThesis, regime: trade.regime }));
  const growthLifecycle: { symbol: string; observedAt: number; opened: number; closed: number; evaluated: number; archived: number; selected: string | null; ready: number; watching: number; blocked: number; error: string | null }[] = [];
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
    // Each deep symbol internally fans out to several Gate endpoints. Running all
    // targets at once caused Worker subrequest/CPU bursts and correlated 503s in
    // the foreground UI. Keep two symbols in flight at most; coverage is unchanged.
    const results = await analyzeTargetsBounded(targets, context, settings);

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "rejected") {
        failures.push({ symbol: targets[index].symbol, error: result.reason instanceof Error ? result.reason.message : "analysis failed" });
        continue;
      }
      const { packet, ticker, growthCandles, growthError } = result.value;
      analyzed.push(packet);
      const basePacket = openSymbols.includes(packet.symbol) ? packet : legacyObservationOnly(packet);
      const baseResult = await processDecision(basePacket, settings);
      lifecycle.push({ symbol: packet.symbol, result: baseResult });
      await deliverLifecycle(baseResult);

      if (growthCandles.length) {
        const v2 = evaluateSentinelV2Strategies({
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
          crossSectionRank: ranks.get(packet.symbol) ?? 0.5,
          rotationVelocity: rotationVelocity(ticker, options.previousMarketSnapshot),
          marketAdvancingRatio: v2Market.breadth.advancingRatio,
          marketDecliningRatio: v2Market.breadth.decliningRatio,
        }, { market: v2Market, openTrades: portfolioTrades, experienceBook });
        v2Opportunities.push(...v2.opportunities);
        await saveV2Opportunities(v2.opportunities);
        const growth = await processShadowStrategies(packet, growthCandles, v2.signals, settings);
        if (growth.lifecycle) {
          lifecycle.push({ symbol: packet.symbol, result: growth.lifecycle });
          await deliverLifecycle(growth.lifecycle);
          if (growth.lifecycle.kind === "opened" && growth.lifecycle.trade) {
            const opened = growth.lifecycle.trade;
            portfolioTrades.push({ symbol: opened.symbol, side: opened.side, entryThesis: opened.entryThesis, regime: opened.regime });
            await syncV2OpenTradeTheses([{
              id: opened.id,
              symbol: opened.symbol,
              side: opened.side,
              regime: opened.regime,
              entryThesis: opened.entryThesis,
              confidence: opened.confidence,
            }], v2Market);
          }
        }
        growthLifecycle.push({
          symbol: packet.symbol,
          observedAt: packet.observedAt,
          opened: growth.opened,
          closed: growth.closed,
          evaluated: growth.evaluated,
          archived: growth.archived,
          selected: growth.selected,
          ready: v2.signals.filter((signal) => signal.state === "ready").length,
          watching: v2.signals.filter((signal) => signal.state === "watching").length,
          blocked: v2.signals.filter((signal) => signal.state === "blocked").length,
          error: null,
        });
      } else {
        const message = growthError ?? "Strategy 2.0 5m K 线为空";
        failures.push({ symbol: packet.symbol, error: `Strategy 2.0 扩展数据：${message}` });
        growthLifecycle.push({ symbol: packet.symbol, observedAt: packet.observedAt, opened: 0, closed: 0, evaluated: 0, archived: 0, selected: null, ready: 0, watching: 0, blocked: 0, error: message });
      }
    }

    const qualities = analyzed.map((packet) => packet.decision.dataQuality);
    await completeScan(scan.id, scan.startedAt, {
      status: failures.length ? "degraded" : "completed",
      deepScanned: analyzed.length,
      confirmedCount: lifecycle.filter((item) => item.result.kind === "opened").length,
      preAlertCount: v2Opportunities.filter((opportunity) => opportunity.state === "WATCH").length,
      averageDataQuality: qualities.length ? qualities.reduce((sum, value) => sum + value, 0) / qualities.length : null,
      error: failures.length ? JSON.stringify(failures) : null,
    });
    return {
      status: failures.length ? "degraded" : "completed",
      observedAt: Date.now(),
      universe,
      context: context as GlobalRiskPacket,
      v2: { market: v2Market, opportunities: v2Opportunities },
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
      preAlertCount: v2Opportunities.filter((opportunity) => opportunity.state === "WATCH").length,
      averageDataQuality: null,
      error: error instanceof Error ? error.message : "scan failed",
    });
    throw error;
  }
}
