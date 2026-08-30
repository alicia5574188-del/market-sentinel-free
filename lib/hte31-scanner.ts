import { analyzeGateSymbol, fetchGateChartCandles, fetchGateUniverse, type GateAnalysisPacket, type UniverseTicker } from "./gate-client.ts";
import { recordHte31DiagnosticCycle } from "./hte31-diagnostics.ts";
import { evaluateHumanTraderPool } from "./hte31-human-trader-engine.ts";
import { getHte31Dashboard, listHte31OpenTrades, recordHte31Evaluations, tryOpenHte31Trade } from "./hte31-repository.ts";
import type { Hte31Candle, Hte31Signal } from "./hte31-types.ts";
import { getSettings, type AppSettings } from "./repository.ts";

export type Hte31ScanPhase = "config" | "universe" | "deep" | "candles" | "evaluate";

export type Hte31MarketState = {
  observedAt: number;
  label: "趋势主导" | "波动扩张" | "震荡轮动" | "低波压缩";
  permission: "GREEN" | "YELLOW";
  confidence: number;
  stability: number;
  transitionRisk: number;
  bias: "LONG" | "SHORT" | "NEUTRAL";
  advancingRatio: number;
  decliningRatio: number;
  medianChangePct: number;
  dispersionPct: number;
  benchmarkMomentum: number;
};

export type Hte31ScanJob = {
  version: 1;
  id: string;
  phase: Hte31ScanPhase;
  startedAt: number;
  rotationOffset: number;
  attempts: Partial<Record<Hte31ScanPhase, number>>;
  settings?: AppSettings;
  coreSymbols?: string[];
  openSymbols?: string[];
  universe?: UniverseTicker[];
  market?: Hte31MarketState;
  target?: UniverseTicker;
  packet?: GateAnalysisPacket;
  candles?: Hte31Candle[];
  signals?: Hte31Signal[];
  openedTradeId?: string | null;
  openReason?: string;
};

export type Hte31ScanCompleted = {
  observedAt: number;
  target: string;
  universe: UniverseTicker[];
  market: Hte31MarketState;
  packet: GateAnalysisPacket;
  signals: Hte31Signal[];
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function parseCoreSymbols(settings: AppSettings) {
  try {
    const parsed = JSON.parse(settings.coreSymbolsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function marketState(universe: UniverseTicker[], observedAt = Date.now()): Hte31MarketState {
  const changes = universe.map((row) => row.changePercentage).filter(Number.isFinite);
  const advancingRatio = universe.length ? universe.filter((row) => row.changePercentage > 0).length / universe.length : 0.5;
  const decliningRatio = universe.length ? universe.filter((row) => row.changePercentage < 0).length / universe.length : 0.5;
  const medianChangePct = median(changes);
  const dispersionPct = stdev(changes);
  const benchmarks = universe.filter((row) => row.symbol === "BTC_USDT" || row.symbol === "ETH_USDT");
  const benchmarkMomentum = benchmarks.length ? benchmarks.reduce((sum, row) => sum + row.changePercentage, 0) / benchmarks.length : medianChangePct;
  const participation = Math.max(advancingRatio, decliningRatio);
  const trendStrength = Math.abs(medianChangePct) + Math.abs(benchmarkMomentum) * 0.5;
  const label: Hte31MarketState["label"] = dispersionPct >= 5.5 ? "波动扩张"
    : trendStrength >= 2.2 && participation >= 0.62 ? "趋势主导"
      : dispersionPct <= 2.2 && Math.abs(medianChangePct) <= 0.9 ? "低波压缩" : "震荡轮动";
  const bias: Hte31MarketState["bias"] = advancingRatio >= 0.62 && benchmarkMomentum > 0 ? "LONG"
    : decliningRatio >= 0.62 && benchmarkMomentum < 0 ? "SHORT" : "NEUTRAL";
  const transitionRisk = clamp(Math.round((Math.abs(advancingRatio - decliningRatio) < 0.12 ? 38 : 16) + Math.min(35, dispersionPct * 4)), 8, 78);
  return {
    observedAt,
    label,
    permission: universe.length >= 12 ? "GREEN" : "YELLOW",
    confidence: clamp(Math.round(62 + Math.min(30, universe.length) * 0.7), 55, 92),
    stability: clamp(100 - transitionRisk, 22, 94),
    transitionRisk,
    bias,
    advancingRatio,
    decliningRatio,
    medianChangePct,
    dispersionPct,
    benchmarkMomentum,
  };
}

function chooseTarget(universe: UniverseTicker[], coreSymbols: string[], openSymbols: string[], rotationOffset: number) {
  const blocked = new Set(openSymbols);
  const eligible = universe.filter((row) => !blocked.has(row.symbol) && row.volumeUsd >= 12_000_000);
  if (!eligible.length) return universe.find((row) => !blocked.has(row.symbol)) ?? universe[0] ?? null;
  const phase = rotationOffset % 3;
  if (phase === 0) {
    return [...eligible].sort((a, b) => Math.abs(b.coarseScore) - Math.abs(a.coarseScore))[0];
  }
  if (phase === 1) {
    const core = coreSymbols.map((symbol) => eligible.find((row) => row.symbol === symbol)).filter((row): row is UniverseTicker => Boolean(row));
    if (core.length) return core[Math.floor(rotationOffset / 3) % core.length];
  }
  return eligible[Math.floor(rotationOffset / 3) % eligible.length];
}

function crossSectionRank(universe: UniverseTicker[], symbol: string) {
  const sorted = [...universe].sort((a, b) => a.changePercentage - b.changePercentage);
  const index = sorted.findIndex((row) => row.symbol === symbol);
  return index < 0 ? 0.5 : index / Math.max(1, sorted.length - 1);
}

export function createHte31ScanJob(rotationOffset: number): Hte31ScanJob {
  return {
    version: 1,
    id: crypto.randomUUID(),
    phase: "config",
    startedAt: Date.now(),
    rotationOffset,
    attempts: {},
  };
}

export function hte31PhaseLabel(phase: Hte31ScanPhase) {
  return ({
    config: "Clean 配置 / 持仓隔离",
    universe: "Gate Universe 粗扫",
    deep: "单币 Gate 深度分析",
    candles: "18h · 5m K线窗口",
    evaluate: "HT1 / HT2 / HT3 独立评估",
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
      },
    };
  }

  if (job.phase === "universe") {
    if (!job.settings || !job.coreSymbols || !job.openSymbols) throw new Error("Clean scan missing config state");
    const universe = await fetchGateUniverse(job.settings.universeLimit, job.coreSymbols);
    if (!universe.length) throw new Error("Gate Universe 返回空列表");
    const market = marketState(universe);
    const target = chooseTarget(universe, job.coreSymbols, job.openSymbols, job.rotationOffset);
    if (!target) throw new Error("Clean scan 没有可用深扫目标");
    return { kind: "progress", job: { ...job, phase: "deep", universe, market, target } };
  }

  if (job.phase === "deep") {
    if (!job.target || !job.market || !job.settings) throw new Error("Clean scan missing target state");
    const packet = await analyzeGateSymbol(job.target.symbol, {
      global: {
        benchmarkMomentum: job.market.benchmarkMomentum,
        macroEventRisk: null,
        macroEventLabel: null,
        optionsIvPercentile: null,
        etfFlowScore: null,
      },
      priorLongProbability: null,
      experience: undefined,
      alertStyle: job.settings.alertStyle,
      detail: "scan",
    });
    return { kind: "progress", job: { ...job, phase: "candles", packet } };
  }

  if (job.phase === "candles") {
    if (!job.target) throw new Error("Clean scan missing candle target");
    const now = Date.now();
    const candles = await fetchGateChartCandles(job.target.symbol, now - 18 * 60 * 60_000, now);
    if (candles.length < 34) throw new Error(`5m K线不足：${candles.length} 根`);
    return { kind: "progress", job: { ...job, phase: "evaluate", candles } };
  }

  if (job.phase === "evaluate") {
    if (!job.packet || !job.candles || !job.universe || !job.market || !job.settings || !job.target || !job.coreSymbols) {
      throw new Error("Clean scan evaluate state incomplete");
    }
    const packet = job.packet;
    const signals = evaluateHumanTraderPool({
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
      benchmarkMomentum: job.market.benchmarkMomentum,
      macroEventRisk: packet.market.macroEventRisk,
      dataQuality: packet.decision.dataQuality,
      candles5m: job.candles,
      crossSectionRank: crossSectionRank(job.universe, packet.symbol),
      rotationVelocity: 0,
      marketAdvancingRatio: job.market.advancingRatio,
      marketDecliningRatio: job.market.decliningRatio,
    });
    await recordHte31Evaluations(packet, signals);
    try {
      await recordHte31DiagnosticCycle(packet, signals, job.settings);
    } catch (error) {
      // Diagnostics and shadow learning are strictly auxiliary. They must never
      // prevent a valid Human Trader Setup from reaching the simulation ledger.
      console.error("HTE 3.1 diagnostic cycle failed", error instanceof Error ? error.message : "unknown diagnostic error");
    }
    const opened = await tryOpenHte31Trade(packet, signals, job.candles, job.settings);
    const result: Hte31ScanCompleted = {
      observedAt: Date.now(),
      target: packet.symbol,
      universe: job.universe,
      market: { ...job.market, observedAt: Date.now() },
      packet,
      signals,
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

  throw new Error(`Unexpected Clean scan phase: ${job.phase}`);
}

export async function getHte31RuntimeDashboard() {
  return getHte31Dashboard();
}
