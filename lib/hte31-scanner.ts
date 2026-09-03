import {
  getMarketExchange,
  type MarketAnalysisPacket,
  type MarketUniverseTicker,
} from "./exchange-market.ts";
import { buildDirectMarketCandidate } from "./direct-market-brain.ts";
import type { DirectMarketCandidate, DirectMarketRadarItem } from "./direct-market-types.ts";
import { chooseDirectMarketTarget, rankDirectMarketUniverse } from "./direct-market-universe.ts";
import { getGlobalRiskContext } from "./global-risk.ts";
import { getHte31Dashboard, listHte31OpenTrades } from "./hte31-repository.ts";
import type { Hte31Candle } from "./hte31-types.ts";
import { buildResonanceGlobalMarket, type ResonanceGlobalMarketState } from "./resonance-global-market.ts";
import { getSettings, type AppSettings } from "./settings-repository.ts";

export type Hte31ScanPhase = "config" | "universe" | "deep" | "candles" | "evaluate";
export type Hte31MarketState = ResonanceGlobalMarketState;

export type Hte31ScanJob = {
  version: 4;
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
  btcCandles?: Hte31Candle[];
  directCandidate?: DirectMarketCandidate;
  openedTradeId?: string | null;
  openReason?: string;
};

export type Hte31ScanCompleted = {
  observedAt: number;
  target: string;
  universe: MarketUniverseTicker[];
  market: Hte31MarketState;
  packet: MarketAnalysisPacket;
  directCandidate: DirectMarketCandidate;
  directRadar?: DirectMarketRadarItem[];
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

export function createHte31ScanJob(rotationOffset: number, previousMarket: Hte31MarketState | null = null): Hte31ScanJob {
  return {
    version: 4,
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
    universe: "轻扫成交额前十五",
    deep: "深扫当前候选",
    candles: "读取位置与多周期结构",
    evaluate: "判断方向、目标与失效",
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
    if (!job.settings) throw new Error("市场大脑缺少运行配置");
    const fetched = await marketExchange.fetchUniverse(Math.max(15, job.settings.universeLimit), []);
    const universe = rankDirectMarketUniverse(fetched);
    if (!universe.length) throw new Error(`${marketExchange.label} Universe 返回空列表`);
    const market = buildResonanceGlobalMarket(universe, job.previousMarket ?? null);
    const target = chooseDirectMarketTarget(universe, job.rotationOffset);
    if (!target) throw new Error("市场大脑没有可用深扫目标");
    return { kind: "progress", job: { ...job, phase: "deep", universe, market, target } };
  }

  if (job.phase === "deep") {
    if (!job.target || !job.market || !job.settings) throw new Error("市场大脑缺少深扫状态");
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
    if (!job.target || !job.packet) throw new Error("市场大脑缺少K线目标");
    const now = Date.now();
    const [candlesResult, btcCandlesResult] = await Promise.allSettled([
      marketExchange.fetchChartCandles(job.target.symbol, now - 18 * 60 * 60_000, now),
      job.target.symbol === "BTC_USDT"
        ? marketExchange.fetchChartCandles(job.target.symbol, now - 18 * 60 * 60_000, now)
        : marketExchange.fetchChartCandles("BTC_USDT", now - 18 * 60 * 60_000, now),
    ]);
    if (candlesResult.status === "rejected") throw candlesResult.reason;
    const candles = candlesResult.value;
    const btcCandles = btcCandlesResult.status === "fulfilled" ? btcCandlesResult.value : [];
    if (candles.length < 48) throw new Error(`5m K线不足：${candles.length} 根`);
    return { kind: "progress", job: { ...job, phase: "evaluate", candles, btcCandles } };
  }

  if (job.phase === "evaluate") {
    if (!job.packet || !job.candles || !job.btcCandles || !job.universe || !job.market || !job.settings || !job.target || !job.coreSymbols) {
      throw new Error("市场大脑评估状态不完整");
    }
    const volumeRank = job.universe.findIndex((row) => row.symbol === job.packet!.symbol) + 1;
    const directCandidate = buildDirectMarketCandidate({
      packet: job.packet,
      candles: job.candles,
      btcCandles: job.btcCandles,
      volumeRank: Math.max(1, volumeRank),
      batchId: `direct:${Math.floor(job.packet.observedAt / (3 * 60_000))}`,
    });
    return {
      kind: "completed",
      result: {
        observedAt: Date.now(),
        target: job.packet.symbol,
        universe: job.universe,
        market: { ...job.market, observedAt: Date.now() },
        packet: job.packet,
        directCandidate,
        openedTradeId: null,
        openReason: directCandidate.decision === "WAIT"
          ? directCandidate.counterEvidence[0] ?? "当前位置没有足够净优势"
          : "等待候选池完成横向择优",
        settings: {
          scanEnabled: job.settings.scanEnabled,
          coreSymbols: job.coreSymbols,
          universeLimit: 15,
          trialCapitalUsdt: job.settings.trialCapitalUsdt,
        },
      },
    };
  }

  throw new Error(`Unexpected market brain phase: ${job.phase}`);
}

export async function getHte31RuntimeDashboard() {
  return getHte31Dashboard();
}
