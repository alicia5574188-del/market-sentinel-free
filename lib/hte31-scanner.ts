import {
  getMarketExchange,
  type MarketAnalysisPacket,
  type MarketUniverseTicker,
} from "./exchange-market.ts";
import { recordHte31DiagnosticCycle } from "./hte31-diagnostics.ts";
import { evaluateHumanTraderPool } from "./hte31-human-trader-engine.ts";
import { evaluateAdvancedHumanTraders } from "./hte31-advanced-traders.ts";
import { evaluateHte31ResearchStrategies } from "./hte31-research-strategies.ts";
import { getGlobalRiskContext } from "./global-risk.ts";
import { GateHistoricalDataError } from "./gate-history.ts";
import { getHte31Dashboard, listHte31OpenTrades, recordHte31Evaluations } from "./hte31-repository.ts";
import type { Hte31Candle, Hte31Signal } from "./hte31-types.ts";
import { getSettings, type AppSettings } from "./settings-repository.ts";
import { buildResonanceMarketMemory, type ResonanceMarketMemory } from "./resonance-market.ts";
import { buildResonanceMarketView, type ResonanceMarketView } from "./resonance-brain.ts";
import { buildResonanceGlobalMarket, type ResonanceGlobalMarketState } from "./resonance-global-market.ts";
import { getResonanceSystemReview, type ResonanceSystemReview } from "./resonance-review.ts";
import { tryOpenResonanceTrade } from "./resonance-trading.ts";
import { buildHte31StrategyRouterDecision, type Hte31RouterDecision } from "./hte31-strategy-router.ts";

export type Hte31ScanPhase = "config" | "universe" | "deep" | "candles" | "evaluate";
export type Hte31MarketState = ResonanceGlobalMarketState;

export type Hte31ScanJob = {
  version: 3;
  id: string;
  phase: Hte31ScanPhase;
  startedAt: number;
  rotationOffset: number;
  attempts: Partial<Record<Hte31ScanPhase, number>>;
  previousMarket?: Hte31MarketState | null;
  settings?: AppSettings;
  coreSymbols?: string[];
  openSymbols?: string[];
  openPositions?: { symbol: string; traderId: string; side: "LONG" | "SHORT" }[];
  universe?: MarketUniverseTicker[];
  market?: Hte31MarketState;
  target?: MarketUniverseTicker;
  packet?: MarketAnalysisPacket;
  candles?: Hte31Candle[];
  memory?: ResonanceMarketMemory;
  previousMemory?: ResonanceMarketMemory | null;
  marketView?: ResonanceMarketView;
  review?: ResonanceSystemReview;
  signals?: Hte31Signal[];
  router?: Hte31RouterDecision;
  openedTradeId?: string | null;
  openReason?: string;
};

export type Hte31ScanCompleted = {
  observedAt: number;
  target: string;
  universe: MarketUniverseTicker[];
  market: Hte31MarketState;
  packet: MarketAnalysisPacket;
  memory: ResonanceMarketMemory;
  marketView: ResonanceMarketView;
  review: ResonanceSystemReview;
  signals: Hte31Signal[];
  router: Hte31RouterDecision;
  openedTradeId: string | null;
  openReason: string;
  settings: {
    scanEnabled: boolean;
    coreSymbols: string[];
    universeLimit: number;
    trialCapitalUsdt: number;
  };
};

export type Hte31ScanStep =
  | { kind: "progress"; job: Hte31ScanJob }
  | { kind: "paused"; observedAt: number }
  | { kind: "completed"; result: Hte31ScanCompleted };

const marketExchange = getMarketExchange();

function parseCoreSymbols(settings: AppSettings) {
  try {
    const parsed = JSON.parse(settings.coreSymbolsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function chooseTarget(universe: MarketUniverseTicker[], coreSymbols: string[], openSymbols: string[], rotationOffset: number) {
  // Revisit one open symbol every fifth cycle so the unified brain can test
  // thesis invalidation and replacement without adding another Gate producer.
  if (openSymbols.length && rotationOffset % 5 === 4) {
    const openTarget = universe.find((row) => row.symbol === openSymbols[Math.floor(rotationOffset / 5) % openSymbols.length]);
    if (openTarget) return openTarget;
  }
  const blocked = new Set(openSymbols);
  const eligible = universe.filter((row) => !blocked.has(row.symbol) && row.volumeUsd >= 12_000_000);
  if (!eligible.length) return universe.find((row) => !blocked.has(row.symbol)) ?? universe[0] ?? null;

  const ranked = [...eligible].sort((a, b) => {
    const aScore = Math.abs(a.coarseScore) + Math.min(8, Math.abs(a.changePercentage)) * 0.08;
    const bScore = Math.abs(b.coarseScore) + Math.min(8, Math.abs(b.changePercentage)) * 0.08;
    return bScore - aScore;
  });
  const shortlist = ranked.slice(0, Math.min(6, ranked.length));
  const core = coreSymbols
    .map((symbol) => eligible.find((row) => row.symbol === symbol))
    .filter((row): row is MarketUniverseTicker => Boolean(row));
  if (rotationOffset % 4 === 3 && core.length) return core[Math.floor(rotationOffset / 4) % core.length];
  return shortlist[rotationOffset % shortlist.length] ?? ranked[0];
}

function crossSectionRank(universe: MarketUniverseTicker[], symbol: string) {
  const sorted = [...universe].sort((a, b) => a.changePercentage - b.changePercentage);
  const index = sorted.findIndex((row) => row.symbol === symbol);
  return index < 0 ? 0.5 : index / Math.max(1, sorted.length - 1);
}

function historicalFailure(error: unknown) {
  return error instanceof GateHistoricalDataError
    ? error.code
    : error instanceof Error ? error.message : "UPSTREAM_FAILURE";
}

export function createHte31ScanJob(rotationOffset: number, previousMarket: Hte31MarketState | null = null): Hte31ScanJob {
  return {
    version: 3,
    id: crypto.randomUUID(),
    phase: "config",
    startedAt: Date.now(),
    rotationOffset,
    attempts: {},
    previousMarket,
  };
}

export function hte31PhaseLabel(phase: Hte31ScanPhase) {
  return ({
    config: "读取运行配置",
    universe: "扫描整体市场",
    deep: "分析当前币种",
    candles: "读取历史与多周期结构",
    evaluate: "9个策略家族 / 13个变体统一评估与大脑选单",
  } satisfies Record<Hte31ScanPhase, string>)[phase];
}

export async function runHte31ScanStep(job: Hte31ScanJob): Promise<Hte31ScanStep> {
  if (job.phase === "config") {
    const settings = await getSettings();
    if (!settings.scanEnabled) return { kind: "paused", observedAt: Date.now() };
    const openTrades = await listHte31OpenTrades();
    return {
      kind: "progress",
      job: {
        ...job,
        phase: "universe",
        settings,
        coreSymbols: parseCoreSymbols(settings),
        openSymbols: openTrades.map((trade) => trade.symbol),
        openPositions: openTrades.map((trade) => ({ symbol: trade.symbol, traderId: trade.traderId, side: trade.side })),
      },
    };
  }

  if (job.phase === "universe") {
    if (!job.settings || !job.coreSymbols || !job.openSymbols) throw new Error("Resonance scan missing config state");
    const universe = await marketExchange.fetchUniverse(job.settings.universeLimit, [...new Set([...job.coreSymbols, ...job.openSymbols])]);
    if (!universe.length) throw new Error(`${marketExchange.label} Universe 返回空列表`);
    const market = buildResonanceGlobalMarket(universe, job.previousMarket ?? null);
    const target = chooseTarget(universe, job.coreSymbols, job.openSymbols, job.rotationOffset);
    if (!target) throw new Error("Resonance scan 没有可用深扫目标");
    return { kind: "progress", job: { ...job, phase: "deep", universe, market, target } };
  }

  if (job.phase === "deep") {
    if (!job.target || !job.market || !job.settings) throw new Error("Resonance scan missing target state");
    const globalRisk = await getGlobalRiskContext();
    const packet = await marketExchange.analyzeSymbol(job.target.symbol, {
      global: {
        benchmarkMomentum: globalRisk.benchmarkMomentum ?? job.market.benchmarkMomentum,
        macroEventRisk: globalRisk.macroEventRisk,
        macroEventLabel: globalRisk.macroEventLabel,
        optionsIvPercentile: globalRisk.optionsIvPercentile,
        etfFlowScore: globalRisk.etfFlowScore,
      },
      priorLongProbability: null,
      experience: undefined,
      alertStyle: job.settings.alertStyle,
      detail: "scan",
    });
    return { kind: "progress", job: { ...job, phase: "candles", packet } };
  }

  if (job.phase === "candles") {
    if (!job.target || !job.packet) throw new Error("Resonance scan missing candle target");
    const now = Date.now();
    const [candles, review, historical] = await Promise.all([
      marketExchange.fetchChartCandles(job.target.symbol, now - 18 * 60 * 60_000, now),
      getResonanceSystemReview(),
      Promise.allSettled([
        marketExchange.fetchHistoricalCandles(job.target.symbol, "1h", 720),
        marketExchange.fetchHistoricalCandles(job.target.symbol, "4h", 1_200),
        marketExchange.fetchHistoricalCandles(job.target.symbol, "1d", 1_800),
      ]),
    ]);
    if (candles.length < 34) throw new Error(`5m K线不足：${candles.length} 根`);
    const value = (index: number) => historical[index].status === "fulfilled" ? historical[index].value : [];
    const failure = (index: number) => historical[index].status === "rejected" ? historicalFailure(historical[index].reason) : undefined;
    const memory = buildResonanceMarketMemory({
      hourly: value(0),
      fourHour: value(1),
      daily: value(2),
      failures: { short: failure(0), swing: failure(1), cycle: failure(2) },
      previous: job.previousMemory,
      observedAt: now,
    });
    const marketView = buildResonanceMarketView(job.packet, memory);
    return { kind: "progress", job: { ...job, phase: "evaluate", candles, memory, marketView, review } };
  }

  if (job.phase === "evaluate") {
    if (!job.packet || !job.candles || !job.universe || !job.market || !job.settings || !job.target || !job.coreSymbols || !job.memory || !job.marketView || !job.review) {
      throw new Error("Resonance scan evaluate state incomplete");
    }
    const packet = job.packet;
    const commonInput = {
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
      timeframeTrend15m: packet.market.timeframeTrend15m,
      timeframeTrend1h: packet.market.timeframeTrend1h,
      timeframeTrend4h: packet.market.timeframeTrend4h,
      benchmarkMomentum: job.market.benchmarkMomentum,
      optionsIvPercentile: packet.market.optionsIvPercentile,
      macroEventRisk: packet.market.macroEventRisk,
      dataQuality: packet.decision.dataQuality,
      candles5m: job.candles,
      crossSectionRank: crossSectionRank(job.universe, packet.symbol),
      rotationVelocity: 0,
      marketAdvancingRatio: job.market.advancingRatio,
      marketDecliningRatio: job.market.decliningRatio,
    };
    const signals = [
      ...evaluateHumanTraderPool(commonInput),
      ...evaluateAdvancedHumanTraders(commonInput),
      ...evaluateHte31ResearchStrategies(commonInput),
    ];
    await recordHte31Evaluations(packet, signals);
    const activePosition = job.openPositions?.find((trade) => trade.symbol === packet.symbol) ?? null;
    let router: Hte31RouterDecision;
    try {
      router = await recordHte31DiagnosticCycle(packet, signals, activePosition);
    } catch (error) {
      console.error("Resonance diagnostic cycle failed", error instanceof Error ? error.message : "unknown diagnostic error");
      router = buildHte31StrategyRouterDecision({
        observedAt: packet.observedAt,
        symbol: packet.symbol,
        signals,
        evidence: [],
        activePosition,
      });
    }
    const opened = await tryOpenResonanceTrade(packet, signals, job.candles, job.settings, job.market, job.marketView, job.review, router);
    router = opened.router;
    const result: Hte31ScanCompleted = {
      observedAt: Date.now(),
      target: packet.symbol,
      universe: job.universe,
      market: { ...job.market, observedAt: Date.now() },
      packet,
      memory: job.memory,
      marketView: job.marketView,
      review: job.review,
      signals,
      router,
      openedTradeId: opened.opened?.id ?? null,
      openReason: opened.reason,
      settings: {
        scanEnabled: job.settings.scanEnabled,
        coreSymbols: job.coreSymbols,
        universeLimit: job.settings.universeLimit,
        trialCapitalUsdt: job.settings.trialCapitalUsdt,
      },
    };
    return { kind: "completed", result };
  }

  throw new Error(`Unexpected Resonance scan phase: ${job.phase}`);
}

export async function getHte31RuntimeDashboard() {
  return getHte31Dashboard();
}
