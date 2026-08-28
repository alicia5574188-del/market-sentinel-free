import { analyzeGateSymbol, fetchGateChartCandles, fetchGateUniverse, type GateAnalysisPacket, type UniverseTicker } from "./gate-client.ts";
import { getGlobalRiskContext, type GlobalRiskPacket } from "./global-risk.ts";
import {
  beginScan,
  completeScan,
  getSettings,
  listOpenTrades,
  listOpenTradeSymbols,
  markNotified,
  markTradeNotification,
  publicSettings,
  type AppSettings,
  type LifecycleResult,
} from "./repository.ts";
import { chooseBackgroundDeepUniverse, type BackgroundMarketSnapshot } from "./background-selection.ts";
import { buildSentinelV2MarketContext } from "./sentinel-v2-core.ts";
import { evaluateSentinelV2Strategies, type Strategy2Opportunity } from "./sentinel-v2-strategy.ts";
import { getStrategy2ExperienceBook } from "./strategy-2-learning.ts";
import { getLatestV2MarketContext, saveV2MarketContext, saveV2Opportunities } from "./sentinel-v2-repository.ts";
import { processShadowStrategies } from "./shadow-strategy-repository.ts";
import { syncV2OpenTradeTheses } from "./sentinel-v2-thesis.ts";
import { notifyTradeLifecycle, type VapidConfig } from "./web-push.ts";
import type { Candle } from "./signal-engine.ts";

export type FreeMarketScanPhase = "bootstrap" | "global_context" | "market_context" | "gate_deep" | "candles" | "evaluate" | "finalize";

export type FreeMarketScanGrowthLifecycle = {
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
};

type OpenTrades = Awaited<ReturnType<typeof listOpenTrades>>;
type V2MarketContext = ReturnType<typeof buildSentinelV2MarketContext>;

export type FreeMarketScanJob = {
  version: 1;
  jobId: string;
  phase: FreeMarketScanPhase;
  startedAt: number;
  rotationOffset: number;
  previousMarketSnapshot: BackgroundMarketSnapshot;
  phaseAttempts: Partial<Record<FreeMarketScanPhase, number>>;
  retryAfter: number | null;
  settings?: AppSettings;
  coreSymbols?: string[];
  openSymbols?: string[];
  openTrades?: OpenTrades;
  universe?: UniverseTicker[];
  context?: GlobalRiskPacket;
  v2Market?: V2MarketContext;
  target?: UniverseTicker;
  packet?: GateAnalysisPacket;
  growthCandles?: Candle[];
  growthError?: string | null;
  opportunities?: Strategy2Opportunity[];
  lifecycle?: { symbol: string; result: LifecycleResult }[];
  growthLifecycle?: FreeMarketScanGrowthLifecycle[];
  failures?: { symbol: string; error: string }[];
  notifications?: { attempted: number; delivered: number };
};

export type FreeMarketScanResult = {
  status: "completed" | "degraded";
  observedAt: number;
  universe: UniverseTicker[];
  context: GlobalRiskPacket;
  v2: { market: V2MarketContext; opportunities: Strategy2Opportunity[] };
  analyzed: GateAnalysisPacket[];
  lifecycle: { symbol: string; result: LifecycleResult }[];
  growthLifecycle: FreeMarketScanGrowthLifecycle[];
  failures: { symbol: string; error: string }[];
  notifications: { attempted: number; delivered: number };
  openTrades: OpenTrades;
  settings: ReturnType<typeof publicSettings>;
};

export type FreeMarketScanStepResult =
  | { kind: "progress"; job: FreeMarketScanJob }
  | { kind: "paused"; observedAt: number }
  | { kind: "completed"; result: FreeMarketScanResult };

export function createFreeMarketScanJob(rotationOffset: number, previousMarketSnapshot: BackgroundMarketSnapshot): FreeMarketScanJob {
  return {
    version: 1,
    jobId: crypto.randomUUID(),
    phase: "bootstrap",
    startedAt: Date.now(),
    rotationOffset,
    previousMarketSnapshot,
    phaseAttempts: {},
    retryAfter: null,
    opportunities: [],
    lifecycle: [],
    growthLifecycle: [],
    failures: [],
    notifications: { attempted: 0, delivered: 0 },
  };
}

export function freeMarketScanPhaseLabel(phase: FreeMarketScanPhase) {
  return ({
    bootstrap: "读取设置 / Universe 粗扫",
    global_context: "Global Risk / 宏观上下文",
    market_context: "Market Regime / 深扫目标准备",
    gate_deep: "单币 Gate 深度分析",
    candles: "18h · 5m K线窗口",
    evaluate: "Human Trader 三交易员评估 / 订单生命周期",
    finalize: "扫描结果提交",
  } satisfies Record<FreeMarketScanPhase, string>)[phase];
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (value == null) throw new Error(`Free scan state missing ${name}`);
  return value;
}

function parseCoreSymbols(settings: AppSettings) {
  try {
    const parsed = JSON.parse(settings.coreSymbolsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
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

async function deliverLifecycle(result: LifecycleResult, vapidConfig?: VapidConfig | null) {
  if (!result.shouldNotify || !result.notification || !result.trade || !vapidConfig) return { attempted: 0, delivered: 0 };
  const push = await notifyTradeLifecycle(result.notification, result.trade, vapidConfig).catch(() => ({ attempted: 0, delivered: 0 }));
  if (push.delivered > 0) {
    await markTradeNotification(result.trade.id, result.notification);
    if (result.transitionId) await markNotified(result.transitionId);
  }
  return push;
}

export async function runFreeMarketScanStep(job: FreeMarketScanJob, vapidConfig?: VapidConfig | null): Promise<FreeMarketScanStepResult> {
  if (job.phase === "bootstrap") {
    const settings = await getSettings();
    if (!settings.scanEnabled) return { kind: "paused", observedAt: Date.now() };
    const coreSymbols = parseCoreSymbols(settings);
    const openSymbols = await listOpenTradeSymbols();
    const openTrades = await listOpenTrades();
    const universe = await fetchGateUniverse(settings.universeLimit, [...coreSymbols, ...openSymbols]);
    return {
      kind: "progress",
      job: { ...job, phase: "global_context", settings, coreSymbols, openSymbols, openTrades, universe, retryAfter: null },
    };
  }

  if (job.phase === "global_context") {
    const context = await getGlobalRiskContext();
    return { kind: "progress", job: { ...job, phase: "market_context", context, retryAfter: null } };
  }

  if (job.phase === "market_context") {
    const universe = requireValue(job.universe, "universe");
    const context = requireValue(job.context, "context");
    const coreSymbols = requireValue(job.coreSymbols, "coreSymbols");
    const openSymbols = requireValue(job.openSymbols, "openSymbols");
    const openTrades = requireValue(job.openTrades, "openTrades");
    const previousV2 = await getLatestV2MarketContext();
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
    if (openTrades.length) {
      await syncV2OpenTradeTheses(openTrades.map((trade) => ({
        id: trade.id,
        symbol: trade.symbol,
        side: trade.side,
        regime: trade.regime,
        entryThesis: trade.entryThesis,
        confidence: trade.confidence,
      })), v2Market);
    }
    const target = chooseBackgroundDeepUniverse(
      universe,
      coreSymbols,
      openSymbols,
      1,
      job.rotationOffset,
      job.previousMarketSnapshot,
    )[0];
    if (!target) {
      return {
        kind: "progress",
        job: {
          ...job,
          phase: "finalize",
          v2Market,
          failures: [...(job.failures ?? []), { symbol: "MARKET", error: "Universe 中没有可用深扫目标" }],
          retryAfter: null,
        },
      };
    }
    return { kind: "progress", job: { ...job, phase: "gate_deep", v2Market, target, retryAfter: null } };
  }

  if (job.phase === "gate_deep") {
    const target = requireValue(job.target, "target");
    const context = requireValue(job.context, "context");
    const settings = requireValue(job.settings, "settings");
    const packet = await analyzeGateSymbol(target.symbol, {
      global: context,
      priorLongProbability: null,
      experience: undefined,
      alertStyle: settings.alertStyle,
      detail: "scan",
    });
    return { kind: "progress", job: { ...job, phase: "candles", packet, retryAfter: null } };
  }

  if (job.phase === "candles") {
    const target = requireValue(job.target, "target");
    try {
      const growthCandles = await fetchGateChartCandles(target.symbol, Date.now() - 18 * 60 * 60_000, Date.now());
      return { kind: "progress", job: { ...job, phase: "evaluate", growthCandles, growthError: null, retryAfter: null } };
    } catch (error) {
      const growthError = error instanceof Error ? error.message : "Human Trader 5m K 线读取失败";
      return { kind: "progress", job: { ...job, phase: "evaluate", growthCandles: [], growthError, retryAfter: null } };
    }
  }

  if (job.phase === "evaluate") {
    const packet = requireValue(job.packet, "packet");
    const ticker = requireValue(job.target, "target");
    const context = requireValue(job.context, "context");
    const settings = requireValue(job.settings, "settings");
    const universe = requireValue(job.universe, "universe");
    const v2Market = requireValue(job.v2Market, "v2Market");
    const growthCandles = job.growthCandles ?? [];
    const failures = [...(job.failures ?? [])];
    const lifecycle = [...(job.lifecycle ?? [])];
    const growthLifecycle = [...(job.growthLifecycle ?? [])];
    let openTrades = [...requireValue(job.openTrades, "openTrades")];
    let opportunities = [...(job.opportunities ?? [])];
    let notifications = { ...(job.notifications ?? { attempted: 0, delivered: 0 }) };

    if (!growthCandles.length) {
      const message = job.growthError ?? "Human Trader 5m K 线为空";
      failures.push({ symbol: packet.symbol, error: `Human Trader 扩展数据：${message}` });
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
        blocked: 0,
        error: message,
      });
      return {
        kind: "progress",
        job: { ...job, phase: "finalize", failures, lifecycle, growthLifecycle, opportunities, notifications, openTrades, retryAfter: null },
      };
    }

    const experienceBook = await getStrategy2ExperienceBook();
    const ranks = crossSectionRanks(universe);
    const portfolioTrades = openTrades.map((trade) => ({
      symbol: trade.symbol,
      side: trade.side,
      entryThesis: trade.entryThesis,
      regime: trade.regime,
    }));
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
      rotationVelocity: rotationVelocity(ticker, job.previousMarketSnapshot),
      marketAdvancingRatio: v2Market.breadth.advancingRatio,
      marketDecliningRatio: v2Market.breadth.decliningRatio,
    }, { market: v2Market, openTrades: portfolioTrades, experienceBook });

    opportunities = v2.opportunities;
    await saveV2Opportunities(v2.opportunities);
    const growth = await processShadowStrategies(packet, growthCandles, v2.signals, settings);
    if (growth.lifecycle) {
      lifecycle.push({ symbol: packet.symbol, result: growth.lifecycle });
      const push = await deliverLifecycle(growth.lifecycle, vapidConfig);
      notifications = {
        attempted: notifications.attempted + push.attempted,
        delivered: notifications.delivered + push.delivered,
      };
      if (growth.lifecycle.kind === "opened" && growth.lifecycle.trade) {
        const opened = growth.lifecycle.trade;
        if (!openTrades.some((trade) => trade.id === opened.id)) openTrades = [opened, ...openTrades];
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
    return {
      kind: "progress",
      job: { ...job, phase: "finalize", failures, lifecycle, growthLifecycle, opportunities, notifications, openTrades, retryAfter: null },
    };
  }

  const settings = requireValue(job.settings, "settings");
  const universe = requireValue(job.universe, "universe");
  const context = requireValue(job.context, "context");
  const v2Market = requireValue(job.v2Market, "v2Market");
  const failures = job.failures ?? [];
  const lifecycle = job.lifecycle ?? [];
  const opportunities = job.opportunities ?? [];
  const analyzed = job.packet ? [job.packet] : [];
  const qualities = analyzed.map((packet) => packet.decision.dataQuality);
  const scan = await beginScan(universe.length);
  await completeScan(scan.id, job.startedAt, {
    status: failures.length ? "degraded" : "completed",
    deepScanned: analyzed.length,
    confirmedCount: lifecycle.filter((item) => item.result.kind === "opened").length,
    preAlertCount: opportunities.filter((opportunity) => opportunity.state === "WATCH").length,
    averageDataQuality: qualities.length ? qualities.reduce((sum, value) => sum + value, 0) / qualities.length : null,
    error: failures.length ? JSON.stringify(failures) : null,
  });
  return {
    kind: "completed",
    result: {
      status: failures.length ? "degraded" : "completed",
      observedAt: Date.now(),
      universe,
      context,
      v2: { market: v2Market, opportunities },
      analyzed,
      lifecycle,
      growthLifecycle: job.growthLifecycle ?? [],
      failures,
      notifications: job.notifications ?? { attempted: 0, delivered: 0 },
      openTrades: requireValue(job.openTrades, "openTrades"),
      settings: publicSettings(settings),
    },
  };
}
