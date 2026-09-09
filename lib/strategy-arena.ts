import { CORRELATED_DIRECTION_RISK_CAP, MIN_NET_REWARD_RISK, PORTFOLIO_MARGIN_CAP, PORTFOLIO_RISK_CAP,
  selectSafeLeverage, sizePaperPosition, type LiquidityRoute, type RangeStructure, type Side } from "./liquidity-core.ts";
import type { CandidateChannel, MarketRegimeCandidate, MarketRegimeKind } from "./market-regime.ts";

export const STRATEGY_ARENA_VERSION = 3;
export const STRATEGY_INITIAL_EQUITY = 1_000;
export const PROBATION_MIN_EVENTS = 4;
export const VERIFIED_PAPER_EVENTS = 8;
export const VERIFIED_PAPER_SYMBOLS = 2;
export const PROBATION_PROFIT_FACTOR = 1;
export const VERIFIED_PROFIT_FACTOR = 1.15;
export const PAPER_DEMOTION_LOSSES = 2;
export const PAPER_RECENT_WINDOW = 6;
export const PERFORMANCE_WINDOW = 12;
export const ARENA_MAX_HOLD_MS = 45 * 60_000;
export const ARENA_FRICTION_RATE = 0.0012;
export const ARENA_MAX_SPREAD_RATE = 0.0012;
export const ARENA_MIN_VOLUME_24H_USD = 10_000_000;
export const ARENA_MAX_COST_SHARE = 0.25;
export const PORTFOLIO_MAX_OPEN = 3;
export const PORTFOLIO_MAX_PROBATION_OPEN = 1;
export const PROBATION_RISK_MULTIPLIER = 1 / 3;
export const ARENA_MAX_OPEN = 240;
export const ARENA_HISTORY_LIMIT = 240;

export type StrategyLane = "SHADOW" | "TRIAL" | "VERIFIED";
export type TradeLane = StrategyLane | "PORTFOLIO";
export type StrategyFamily = "TREND" | "RANGE" | "COMPRESSION" | "EVENT";
export type EntryStyle = "CONFIRM" | "RETEST";
export type ExitProfile = "FAST" | "STRUCTURE";
export type ArenaOutcome = "TARGET" | "STOP" | "TIMEOUT" | "RESET";
export type AdmissionTier = "PROBATION" | "NORMAL";

type Playbook = { id: string; name: string; family: StrategyFamily; channel: CandidateChannel; description: string };

export const PLAYBOOKS: Playbook[] = [
  { id: "steady_trend", name: "平稳趋势延续", family: "TREND", channel: "TREND", description: "方向效率稳定且未明显回撤时顺势。" },
  { id: "shallow_trend_pullback", name: "趋势浅回撤", family: "TREND", channel: "TREND", description: "趋势内浅回撤后恢复同向。" },
  { id: "deep_trend_reclaim", name: "趋势深回撤收复", family: "TREND", channel: "TREND", description: "趋势深回撤后重新收复并顺势。" },
  { id: "range_edge", name: "区间边缘反转", family: "RANGE", channel: "RANGE", description: "低效率震荡接近边缘时回到中枢。" },
  { id: "range_sweep_reclaim", name: "扫区间后收回", family: "RANGE", channel: "RANGE", description: "扫过区间边缘并重新收回。" },
  { id: "range_failed_break", name: "区间假突破", family: "RANGE", channel: "RANGE", description: "突破未被接受后反向回归。" },
  { id: "compression_break", name: "压缩释放突破", family: "COMPRESSION", channel: "COMPRESSION", description: "波幅压缩后出现方向释放。" },
  { id: "compression_retest", name: "压缩突破回踩", family: "COMPRESSION", channel: "COMPRESSION", description: "压缩突破后回踩守住再延续。" },
  { id: "compression_failed", name: "压缩假突破", family: "COMPRESSION", channel: "COMPRESSION", description: "压缩首次释放失败后反向。" },
  { id: "anomaly_follow", name: "异动延续", family: "EVENT", channel: "ANOMALY", description: "异动确认且资金未明显反向时延续。" },
  { id: "anomaly_pullback", name: "异动二次回撤", family: "EVENT", channel: "ANOMALY", description: "异动后的受控回撤再次顺势。" },
  { id: "anomaly_fade", name: "异动衰竭反转", family: "EVENT", channel: "ANOMALY", description: "异动回吐且流量支持消失时反向。" },
];

export type StrategyDefinition = Playbook & { entryStyle: EntryStyle; exitProfile: ExitProfile };
const entryLabel = (style: EntryStyle) => style === "CONFIRM" ? "确认" : "回踩";
const exitLabel = (profile: ExitProfile) => profile === "FAST" ? "快速" : "结构";

export const STRATEGY_CATALOG: StrategyDefinition[] = PLAYBOOKS.flatMap((playbook) =>
  (["CONFIRM", "RETEST"] as EntryStyle[]).flatMap((entryStyle) =>
    (["FAST", "STRUCTURE"] as ExitProfile[]).map((exitProfile) => ({
      ...playbook, id: `${playbook.id}:${entryStyle.toLowerCase()}:${exitProfile.toLowerCase()}`,
      name: `${playbook.name} · ${entryLabel(entryStyle)} · ${exitLabel(exitProfile)}`, entryStyle, exitProfile,
    }))));

export type ArenaTradeContext = {
  channel: CandidateChannel; regime: MarketRegimeKind; anomalyKind: MarketRegimeCandidate["anomalyKind"];
  entryStyle: EntryStyle; exitProfile: ExitProfile; candidateScore: number; trendRate: number;
  trendEfficiency: number; volatilityRatio: number; rangePosition: number; openInterestChangeRate: number;
  volume24hUsd: number; fundingRate: number; alignedFlow: number; confirmation: number; fakeoutRisk: number;
  rangeId: string | null; modeledCostRate: number; spreadRate: number; bidDepthUsd: number; askDepthUsd: number;
  structureSource: "ROUTE" | "RANGE" | "IMPULSE";
  grossRewardRate: number; structuralStopRate: number; netRewardRisk: number; costShare: number;
  empiricalExpectedReturnRate: number; empiricalProfitFactor: number; empiricalEvents: number;
};

export type ArenaTrade = {
  id: string; strategyId: string; strategyName: string; family: StrategyFamily; lane: TradeLane; eventId: string;
  symbol: string; side: Side; status: "OPEN" | "CLOSED"; openedAt: number; closedAt: number | null;
  entryPrice: number; stopPrice: number; targetPrice: number; exitPrice: number | null; outcome: ArenaOutcome | null;
  grossReturnRate: number | null; netReturnRate: number | null; netPnl: number | null; notional: number;
  maxFavorableRate: number; maxAdverseRate: number; lastPrice: number; selectedForPortfolio: boolean;
  reason: string; context: ArenaTradeContext; admissionTier: AdmissionTier | null; plannedRisk: number;
  contracts: number; quantoMultiplier: number; leverage: number; margin: number; accountEquityAtOpen: number;
};

export type StrategyResult = { eventId: string; symbol: string; regime: MarketRegimeKind; channel: CandidateChannel;
  netReturnRate: number; won: boolean; resolvedAt: number };
export type StrategyScore = StrategyDefinition & {
  lane: StrategyLane; shadowResolved: number; shadowWins: number; shadowNetReturnRate: number;
  paperResolved: number; paperWins: number; paperNetReturnRate: number; paperEquity: number;
  consecutivePaperLosses: number; stageResults: number[]; stageEvents: string[]; stageSymbols: string[];
  recentResults: StrategyResult[]; transitions: number; lastTransitionAt: number | null;
};
export type PlaybookEventResult = { eventId: string; symbol: string; regime: MarketRegimeKind; channel: CandidateChannel;
  resolvedAt: number; variantResults: Record<string, number>; netReturnRate: number };
export type PerformanceEvidence = { events: number; wins: number; netReturnRate: number; meanReturnRate: number;
  conservativeReturnRate: number; profitFactor: number; regimeEvents: number };
export type ArenaTransition = { id: string; strategyId: string; strategyName: string; from: StrategyLane; to: StrategyLane; at: number; reason: string };
export type PortfolioCycleArchive = { number: number; ruleVersion: string; startedAt: number; endedAt: number;
  startingEquity: number; endingEquity: number; resolved: number; wins: number; grossPnl: number; costs: number; reason: string };

export type StrategyArenaState = {
  version: 3; startedAt: number; strategies: Record<string, StrategyScore>; playbookResults: Record<string, PlaybookEventResult[]>;
  open: Record<string, ArenaTrade>; portfolioOpen: Record<string, ArenaTrade>; portfolioEquity: number;
  portfolioResolved: number; portfolioWins: number; portfolioGrossPnl: number; portfolioCosts: number;
  portfolioCycle: number; portfolioCycleStartedAt: number; archivedPortfolioCycles: PortfolioCycleArchive[];
  recentShadow: ArenaTrade[]; recentPaper: ArenaTrade[]; recentPortfolio: ArenaTrade[];
  transitions: ArenaTransition[]; seenSignals: string[]; admissionRejects: Record<string, number>;
};

export type ArenaQuote = { midpoint: number; bestBid?: number; bestAsk?: number };
export type ArenaObservation = {
  candidate: MarketRegimeCandidate; midpoint: number; bestBid?: number; bestAsk?: number; alignedFlow: number;
  minuteNoiseRate: number; spreadRate: number; range15m: RangeStructure | null;
  confirmationBySide: Record<Side, number>; fakeoutBySide: Record<Side, number>; routes: LiquidityRoute[];
  bidDepthUsd?: number; askDepthUsd?: number; quantoMultiplier?: number; maintenanceRate?: number; leverageMax?: number; now: number;
};

type Signal = { strategyId: string; side: Side; stopPrice: number; targetPrice: number; quality: number; reason: string;
  structureSource: ArenaTradeContext["structureSource"] };
const opposite = (side: Side): Side => side === "LONG" ? "SHORT" : "LONG";
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const baseId = (strategyId: string) => strategyId.split(":")[0];
const regimeGroup = (regime: MarketRegimeKind) => regime === "TREND" || regime === "EXPANSION" ? "DIRECTIONAL" : regime;

function freshStrategy(definition: StrategyDefinition): StrategyScore {
  return { ...definition, lane: "SHADOW", shadowResolved: 0, shadowWins: 0, shadowNetReturnRate: 0,
    paperResolved: 0, paperWins: 0, paperNetReturnRate: 0, paperEquity: STRATEGY_INITIAL_EQUITY,
    consecutivePaperLosses: 0, stageResults: [], stageEvents: [], stageSymbols: [], recentResults: [],
    transitions: 0, lastTransitionAt: null };
}

export function initialStrategyArena(now = Date.now()): StrategyArenaState {
  return { version: STRATEGY_ARENA_VERSION, startedAt: now,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => [definition.id, freshStrategy(definition)])),
    playbookResults: Object.fromEntries(PLAYBOOKS.map((playbook) => [playbook.id, []])), open: {}, portfolioOpen: {},
    portfolioEquity: STRATEGY_INITIAL_EQUITY, portfolioResolved: 0, portfolioWins: 0, portfolioGrossPnl: 0,
    portfolioCosts: 0, portfolioCycle: 1, portfolioCycleStartedAt: now, archivedPortfolioCycles: [],
    recentShadow: [], recentPaper: [], recentPortfolio: [], transitions: [], seenSignals: [], admissionRejects: {} };
}

function legacyArchive(value: unknown, now: number): PortfolioCycleArchive[] {
  const old = value as Partial<StrategyArenaState> | null | undefined;
  if (!old || Number(old.portfolioResolved ?? 0) === 0 && Number(old.portfolioEquity ?? STRATEGY_INITIAL_EQUITY) === STRATEGY_INITIAL_EQUITY) return [];
  return [{ number: 1, ruleVersion: `v${String((old as { version?: number }).version ?? "legacy")}`,
    startedAt: Number(old.startedAt ?? now), endedAt: now, startingEquity: STRATEGY_INITIAL_EQUITY,
    endingEquity: Number(old.portfolioEquity ?? STRATEGY_INITIAL_EQUITY), resolved: Number(old.portfolioResolved ?? 0),
    wins: Number(old.portfolioWins ?? 0), grossPnl: Number(old.portfolioGrossPnl ?? 0), costs: Number(old.portfolioCosts ?? 0),
    reason: "规则升级归档" }];
}

export function normalizeStrategyArena(value: StrategyArenaState | null | undefined, now = Date.now()): StrategyArenaState {
  const fresh = initialStrategyArena(now);
  if (!value || Number((value as { version?: number }).version) !== STRATEGY_ARENA_VERSION)
    return { ...fresh, archivedPortfolioCycles: legacyArchive(value, now) };
  return { ...fresh, ...value,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => {
      const prior = value.strategies?.[definition.id];
      return [definition.id, prior ? { ...freshStrategy(definition), ...prior, ...definition,
        recentResults: (prior.recentResults ?? []).slice(-24) } : freshStrategy(definition)];
    })),
    playbookResults: Object.fromEntries(PLAYBOOKS.map((playbook) => [playbook.id,
      (value.playbookResults?.[playbook.id] ?? []).slice(-24)])),
    open: Object.fromEntries(Object.entries(value.open ?? {}).slice(-ARENA_MAX_OPEN)), portfolioOpen: value.portfolioOpen ?? {},
    recentShadow: (value.recentShadow ?? []).slice(-ARENA_HISTORY_LIMIT), recentPaper: (value.recentPaper ?? []).slice(-ARENA_HISTORY_LIMIT),
    recentPortfolio: (value.recentPortfolio ?? []).slice(-ARENA_HISTORY_LIMIT), transitions: (value.transitions ?? []).slice(-200),
    seenSignals: (value.seenSignals ?? []).slice(-2_000), archivedPortfolioCycles: (value.archivedPortfolioCycles ?? []).slice(-12),
    admissionRejects: value.admissionRejects ?? {} };
}

const directionalRangePosition = (candidate: MarketRegimeCandidate) => candidate.side === "LONG" ? candidate.rangePosition : 1 - candidate.rangePosition;
function anomalyRetrace(candidate: MarketRegimeCandidate, midpoint: number) {
  const direction = candidate.side === "LONG" ? 1 : -1;
  const impulse = Math.max(Math.abs(candidate.moveRate), 0.0001);
  const extension = direction * (midpoint - candidate.referencePrice) / Math.max(candidate.referencePrice, 1e-9);
  return clamp(1 - extension / impulse, -0.5, 2);
}

function basePlaybooks(input: ArenaObservation) {
  const candidate = input.candidate;
  const confirmation = input.confirmationBySide[candidate.side] ?? 0;
  const fakeout = input.fakeoutBySide[candidate.side] ?? 1;
  const position = directionalRangePosition(candidate);
  const retrace = anomalyRetrace(candidate, input.midpoint);
  const output: Array<{ playbookId: string; side: Side; reason: string; quality: number; retestReady: boolean }> = [];
  const add = (id: string, side: Side, reason: string, quality: number, retestReady = false) =>
    output.push({ playbookId: id, side, reason, quality: clamp(quality, 0, 1), retestReady });
  if (candidate.channel === "TREND") {
    if (candidate.trendEfficiency >= 0.55 && position >= 0.72 && input.alignedFlow >= -0.12)
      add("steady_trend", candidate.side, "平稳趋势效率稳定且资金未明显反向", candidate.trendEfficiency);
    if (position >= 0.48 && position < 0.78 && input.alignedFlow >= -0.05)
      add("shallow_trend_pullback", candidate.side, "趋势浅回撤后重新获得同向支持", (candidate.trendEfficiency + position) / 2, true);
    if (position >= 0.25 && position < 0.55 && input.alignedFlow >= 0.08)
      add("deep_trend_reclaim", candidate.side, "趋势深回撤后主动资金重新同向", (candidate.trendEfficiency + input.alignedFlow) / 2, true);
  }
  if (candidate.channel === "RANGE") {
    if (input.alignedFlow >= -0.18) add("range_edge", candidate.side, "低效率震荡到达区间边缘", 1 - candidate.trendEfficiency, true);
    const edgeRoute = input.routes.some((route) => route.kind === "EDGE_REJECTION" && route.side === candidate.side);
    if (edgeRoute || fakeout >= 0.56) add("range_sweep_reclaim", candidate.side, "区间边缘扫过后重新收回", Math.max(fakeout, 0.58), true);
    const failed = input.routes.some((route) => route.kind === "FAILED_BREAKOUT_REVERSAL" && route.side === candidate.side);
    if (failed || fakeout >= 0.68) add("range_failed_break", candidate.side, "区间突破未被接受并反向", Math.max(fakeout, 0.68), true);
  }
  if (candidate.channel === "COMPRESSION") {
    if (confirmation >= 0.58 && input.alignedFlow >= 0.08)
      add("compression_break", candidate.side, "压缩后盘口确认方向释放", (confirmation + input.alignedFlow) / 2);
    const retest = input.routes.some((route) => route.kind === "BREAKOUT_RETEST" && route.side === candidate.side);
    if (retest) add("compression_retest", candidate.side, "压缩突破后回踩原边界守住", confirmation, true);
    const reverse = opposite(candidate.side);
    if (fakeout >= 0.68 || input.routes.some((route) => route.kind === "FAILED_BREAKOUT_REVERSAL" && route.side === reverse))
      add("compression_failed", reverse, "压缩首次突破失败并反向", fakeout, true);
  }
  if (candidate.channel === "ANOMALY") {
    if (candidate.confirmations >= 2 && retrace <= 0.25 && retrace >= -0.15 && input.alignedFlow >= -0.12)
      add("anomaly_follow", candidate.side, "异动确认且尚未明显回吐", clamp(candidate.score / 100, 0, 1));
    if (retrace >= 0.15 && retrace <= 0.58 && input.alignedFlow >= -0.05)
      add("anomaly_pullback", candidate.side, "异动后受控回撤再次顺势", clamp(1 - retrace / 2, 0, 1), true);
    if ((retrace >= 0.3 && input.alignedFlow <= 0.05) || fakeout >= 0.7)
      add("anomaly_fade", opposite(candidate.side), "异动回吐且资金支持消失", Math.max(retrace / 2, fakeout), true);
  }
  return output;
}

function executableEntry(input: ArenaObservation, side: Side) {
  return side === "LONG" ? input.bestAsk ?? input.midpoint : input.bestBid ?? input.midpoint;
}

function preferredRoute(input: ArenaObservation, definition: StrategyDefinition, side: Side) {
  const kinds = definition.family === "RANGE" ? ["EDGE_REJECTION", "FAILED_BREAKOUT_REVERSAL"]
    : definition.entryStyle === "RETEST" ? ["BREAKOUT_RETEST", "EDGE_REJECTION", "FAILED_BREAKOUT_REVERSAL"]
      : ["LOCAL_BREAKOUT", "INTERNAL_ROTATION", "NODE_CONTINUATION"];
  return input.routes.filter((route) => route.side === side && kinds.includes(route.kind))
    .sort((left, right) => Number(right.executableNow) - Number(left.executableNow) || right.score - left.score)[0] ?? null;
}

function structuralGeometry(input: ArenaObservation, definition: StrategyDefinition, side: Side) {
  const entry = executableEntry(input, side);
  const direction = side === "LONG" ? 1 : -1;
  const route = preferredRoute(input, definition, side);
  if (route && direction * (entry - route.invalidation) > 0 && direction * (route.target - entry) > 0)
    return { stopPrice: route.invalidation, targetPrice: route.target, structureSource: "ROUTE" as const };
  const range = input.range15m;
  if (range) {
    const buffer = Math.max(entry * clamp(input.minuteNoiseRate * 0.45, 0.0008, 0.003), Math.abs(range.upper - range.lower) * 0.04);
    const stopPrice = side === "LONG" ? range.lower - buffer : range.upper + buffer;
    const targetPrice = definition.exitProfile === "FAST" ? range.midpoint : side === "LONG" ? range.upper : range.lower;
    if (direction * (entry - stopPrice) > 0 && direction * (targetPrice - entry) > 0)
      return { stopPrice, targetPrice, structureSource: "RANGE" as const };
  }
  if (definition.family === "EVENT") {
    const impulse = direction * (entry - input.candidate.referencePrice);
    if (impulse > entry * 0.001) return { stopPrice: input.candidate.referencePrice,
      targetPrice: entry + direction * impulse * (definition.exitProfile === "FAST" ? 0.55 : 0.9), structureSource: "IMPULSE" as const };
  }
  return null;
}

function signals(input: ArenaObservation): Signal[] {
  const output: Signal[] = [];
  for (const base of basePlaybooks(input)) {
    for (const definition of STRATEGY_CATALOG.filter((item) => item.id.startsWith(`${base.playbookId}:`))) {
      const sideFlow = base.side === input.candidate.side ? input.alignedFlow : -input.alignedFlow;
      const routeRetest = input.routes.some((route) => route.side === base.side
        && ["BREAKOUT_RETEST", "EDGE_REJECTION", "FAILED_BREAKOUT_REVERSAL"].includes(route.kind));
      const ready = definition.entryStyle === "CONFIRM" ? (input.confirmationBySide[base.side] ?? 0) >= 0.48 || sideFlow >= 0.12
        : routeRetest || base.retestReady && definition.family === "TREND" && Math.abs(input.candidate.rangePosition - 0.5) <= 0.28;
      const fakeout = input.fakeoutBySide[base.side] ?? 1;
      const geometry = structuralGeometry(input, definition, base.side);
      if (!ready || !geometry || fakeout > 0.82 && !base.playbookId.includes("failed") && !base.playbookId.includes("fade")) continue;
      output.push({ strategyId: definition.id, side: base.side, ...geometry,
        quality: clamp(base.quality * 0.6 + (input.confirmationBySide[base.side] ?? 0) * 0.25 + Math.max(0, sideFlow) * 0.15, 0, 1),
        reason: base.reason });
    }
  }
  return output;
}

function transition(state: StrategyArenaState, score: StrategyScore, to: StrategyLane, now: number, reason: string) {
  if (score.lane === to) return;
  const from = score.lane;
  score.lane = to; score.stageResults = []; score.stageEvents = []; score.stageSymbols = []; score.consecutivePaperLosses = 0;
  score.transitions += 1; score.lastTransitionAt = now;
  state.transitions.push({ id: `${score.id}:${now}:${to}`, strategyId: score.id, strategyName: score.name, from, to, at: now, reason });
  if (state.transitions.length > 200) state.transitions.shift();
}

function profitFactor(values: number[]) {
  const grossProfit = sum(values.filter((value) => value > 0));
  const grossLoss = Math.abs(sum(values.filter((value) => value <= 0)));
  return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
}

function evidence(values: Array<{ netReturnRate: number; regime: MarketRegimeKind }>, currentRegime?: MarketRegimeKind): PerformanceEvidence {
  const recent = values.slice(-PERFORMANCE_WINDOW);
  const weighted = recent.map((row, index) => ({ ...row, weight: Math.pow(0.86, recent.length - 1 - index) }));
  const totalWeight = sum(weighted.map((row) => row.weight));
  const mean = totalWeight ? sum(weighted.map((row) => row.netReturnRate * row.weight)) / totalWeight : 0;
  const regimeRows = currentRegime ? weighted.filter((row) => regimeGroup(row.regime) === regimeGroup(currentRegime)) : [];
  const regimeWeight = sum(regimeRows.map((row) => row.weight));
  const regimeMean = regimeWeight ? sum(regimeRows.map((row) => row.netReturnRate * row.weight)) / regimeWeight : mean;
  const adjustedMean = regimeRows.length >= 2 ? mean * 0.7 + regimeMean * 0.3 : mean;
  const dispersion = totalWeight ? sum(weighted.map((row) => Math.abs(row.netReturnRate - adjustedMean) * row.weight)) / totalWeight : 0;
  return { events: recent.length, wins: recent.filter((row) => row.netReturnRate > 0).length,
    netReturnRate: sum(recent.map((row) => row.netReturnRate)), meanReturnRate: adjustedMean,
    conservativeReturnRate: adjustedMean - dispersion * 0.1, profitFactor: profitFactor(recent.map((row) => row.netReturnRate)),
    regimeEvents: regimeRows.length };
}

function uniqueResults(results: StrategyResult[]) {
  const seen = new Set<string>();
  return [...results].sort((a, b) => b.resolvedAt - a.resolvedAt).filter((row) => !seen.has(row.eventId) && Boolean(seen.add(row.eventId)))
    .slice(0, PERFORMANCE_WINDOW).reverse();
}

export function playbookPerformance(state: StrategyArenaState, id: string, currentRegime?: MarketRegimeKind) {
  return evidence((state.playbookResults[id] ?? []).map((row) => ({ netReturnRate: row.netReturnRate, regime: row.regime })), currentRegime);
}
function strategyPerformance(score: StrategyScore, currentRegime?: MarketRegimeKind) {
  return evidence(uniqueResults(score.recentResults), currentRegime);
}
const probationQualified = (row: PerformanceEvidence) => row.events >= PROBATION_MIN_EVENTS && row.wins >= 2
  && row.netReturnRate > 0 && row.conservativeReturnRate > 0 && row.profitFactor >= PROBATION_PROFIT_FACTOR;
const verifiedQualified = (row: PerformanceEvidence) => row.events >= VERIFIED_PAPER_EVENTS && row.netReturnRate > 0
  && row.conservativeReturnRate > 0 && row.profitFactor >= VERIFIED_PROFIT_FACTOR;

function updatePlaybookResult(state: StrategyArenaState, trade: ArenaTrade) {
  const id = baseId(trade.strategyId);
  const rows = state.playbookResults[id] ?? (state.playbookResults[id] = []);
  let row = rows.find((item) => item.eventId === trade.eventId);
  if (!row) { row = { eventId: trade.eventId, symbol: trade.symbol, regime: trade.context.regime, channel: trade.context.channel,
    resolvedAt: trade.closedAt ?? trade.openedAt, variantResults: {}, netReturnRate: 0 }; rows.push(row); }
  row.variantResults[trade.strategyId] = trade.netReturnRate ?? 0;
  row.netReturnRate = sum(Object.values(row.variantResults)) / Math.max(1, Object.keys(row.variantResults).length);
  row.resolvedAt = Math.max(row.resolvedAt, trade.closedAt ?? trade.openedAt);
  rows.sort((a, b) => a.resolvedAt - b.resolvedAt);
  if (rows.length > 24) rows.splice(0, rows.length - 24);
}

function promoteBestVariant(state: StrategyArenaState, id: string, now: number, regime: MarketRegimeKind) {
  const siblings = Object.values(state.strategies).filter((score) => baseId(score.id) === id);
  if (siblings.some((score) => score.lane !== "SHADOW" || score.lastTransitionAt === now)) return;
  const aggregate = playbookPerformance(state, id, regime);
  if (!probationQualified(aggregate)) return;
  const winner = siblings.map((score) => ({ score, evidence: strategyPerformance(score, regime) }))
    .filter((row) => row.evidence.events >= 2 && row.evidence.netReturnRate > 0
      && (row.score.lastTransitionAt == null || (row.score.recentResults.at(-1)?.resolvedAt ?? 0) > row.score.lastTransitionAt))
    .sort((a, b) => b.evidence.conservativeReturnRate - a.evidence.conservativeReturnRate || b.evidence.profitFactor - a.evidence.profitFactor)[0];
  if (winner) transition(state, winner.score, "TRIAL", now, `${aggregate.events}个独立事件成本后为正，最佳真实变体进入小仓试用`);
}

function recordClosed(state: StrategyArenaState, trade: ArenaTrade) {
  const value = trade.netReturnRate ?? 0;
  const won = value > 0;
  if (trade.lane === "PORTFOLIO") {
    state.portfolioEquity = Math.max(0.01, state.portfolioEquity + (trade.netPnl ?? 0));
    state.portfolioResolved += 1; state.portfolioWins += Number(won);
    state.portfolioGrossPnl += trade.notional * (trade.grossReturnRate ?? 0);
    state.portfolioCosts += trade.notional * trade.context.modeledCostRate;
    state.recentPortfolio.push(trade); if (state.recentPortfolio.length > ARENA_HISTORY_LIMIT) state.recentPortfolio.shift();
    return;
  }
  const score = state.strategies[trade.strategyId];
  if (!score) return;
  const result: StrategyResult = { eventId: trade.eventId, symbol: trade.symbol, regime: trade.context.regime,
    channel: trade.context.channel, netReturnRate: value, won, resolvedAt: trade.closedAt ?? trade.openedAt };
  score.recentResults = [...score.recentResults.filter((row) => row.eventId !== result.eventId), result].slice(-24);
  updatePlaybookResult(state, trade);
  if (trade.lane === "SHADOW") {
    score.shadowResolved += 1; score.shadowWins += Number(won); score.shadowNetReturnRate += value;
    state.recentShadow.push(trade); if (state.recentShadow.length > ARENA_HISTORY_LIMIT) state.recentShadow.shift();
    promoteBestVariant(state, baseId(score.id), trade.closedAt ?? Date.now(), trade.context.regime); return;
  }
  score.paperResolved += 1; score.paperWins += Number(won); score.paperNetReturnRate += value;
  score.paperEquity = Math.max(0.01, score.paperEquity + (trade.netPnl ?? 0));
  score.consecutivePaperLosses = won ? 0 : score.consecutivePaperLosses + 1;
  score.stageResults = [...score.stageResults, value].slice(-PERFORMANCE_WINDOW);
  score.stageEvents = [...new Set([...score.stageEvents, trade.eventId])].slice(-PERFORMANCE_WINDOW);
  score.stageSymbols = [...new Set([...score.stageSymbols, trade.symbol])].slice(-PERFORMANCE_WINDOW);
  state.recentPaper.push(trade); if (state.recentPaper.length > ARENA_HISTORY_LIMIT) state.recentPaper.shift();
  const recentPaper = score.stageResults.slice(-PAPER_RECENT_WINDOW);
  if (score.consecutivePaperLosses >= PAPER_DEMOTION_LOSSES || recentPaper.length >= PAPER_RECENT_WINDOW && sum(recentPaper) <= 0)
    transition(state, score, "SHADOW", trade.closedAt ?? Date.now(), score.consecutivePaperLosses >= PAPER_DEMOTION_LOSSES
      ? "试用/正常模拟连续亏损2笔" : "最近6个独立结果成本后不再为正");
  else if (score.lane === "TRIAL" && score.stageEvents.length >= VERIFIED_PAPER_EVENTS
    && score.stageSymbols.length >= VERIFIED_PAPER_SYMBOLS && verifiedQualified(strategyPerformance(score, trade.context.regime)))
    transition(state, score, "VERIFIED", trade.closedAt ?? Date.now(), `达到${score.stageEvents.length}个独立事件，近期成本后期望与盈利因子达标`);
}

function quote(value: number | ArenaQuote) {
  return typeof value === "number" ? { midpoint: value, bestBid: value, bestAsk: value }
    : { midpoint: value.midpoint, bestBid: value.bestBid ?? value.midpoint, bestAsk: value.bestAsk ?? value.midpoint };
}
function closeTrade(trade: ArenaTrade, exitPrice: number, outcome: ArenaOutcome, now: number) {
  const direction = trade.side === "LONG" ? 1 : -1;
  const grossReturnRate = direction * (exitPrice - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9);
  const netReturnRate = grossReturnRate - trade.context.modeledCostRate;
  return { ...trade, status: "CLOSED" as const, closedAt: now, exitPrice, outcome, grossReturnRate, netReturnRate,
    netPnl: trade.notional * netReturnRate, lastPrice: exitPrice };
}
function advanceBook(state: StrategyArenaState, book: Record<string, ArenaTrade>, quotes: Record<string, number | ArenaQuote>, now: number) {
  for (const [id, trade] of Object.entries(book)) {
    const raw = quotes[trade.symbol]; if (raw == null) continue;
    const current = quote(raw); const price = trade.side === "LONG" ? current.bestBid : current.bestAsk;
    if (!Number.isFinite(price) || price <= 0) continue;
    const direction = trade.side === "LONG" ? 1 : -1;
    const move = direction * (price - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9);
    trade.lastPrice = price; trade.maxFavorableRate = Math.max(trade.maxFavorableRate, move); trade.maxAdverseRate = Math.min(trade.maxAdverseRate, move);
    const stopped = trade.side === "LONG" ? price <= trade.stopPrice : price >= trade.stopPrice;
    const targeted = trade.side === "LONG" ? price >= trade.targetPrice : price <= trade.targetPrice;
    const timedOut = now - trade.openedAt >= ARENA_MAX_HOLD_MS;
    if (!stopped && !targeted && !timedOut) continue;
    const outcome: ArenaOutcome = stopped ? "STOP" : targeted ? "TARGET" : "TIMEOUT";
    const exitPrice = stopped ? trade.stopPrice : targeted ? trade.targetPrice : price;
    delete book[id]; recordClosed(state, closeTrade(trade, exitPrice, outcome, now));
  }
}
export function advanceStrategyArena(input: { state: StrategyArenaState; quotes: Record<string, number | ArenaQuote>; now: number }) {
  const state = normalizeStrategyArena(input.state, input.now);
  advanceBook(state, state.open, input.quotes, input.now); advanceBook(state, state.portfolioOpen, input.quotes, input.now); return state;
}

function geometryEconomics(input: ArenaObservation, signal: Signal) {
  const entryPrice = executableEntry(input, signal.side);
  const grossRewardRate = Math.abs(signal.targetPrice - entryPrice) / Math.max(entryPrice, 1e-9);
  const structuralStopRate = Math.abs(entryPrice - signal.stopPrice) / Math.max(entryPrice, 1e-9);
  const netRewardRate = grossRewardRate - ARENA_FRICTION_RATE;
  const netRiskRate = structuralStopRate + ARENA_FRICTION_RATE;
  return { entryPrice, grossRewardRate, structuralStopRate, modeledCostRate: ARENA_FRICTION_RATE,
    netRewardRisk: netRewardRate / Math.max(netRiskRate, 1e-9), costShare: ARENA_FRICTION_RATE / Math.max(grossRewardRate, 1e-9) };
}
function tradeContext(input: ArenaObservation, definition: StrategyDefinition, signal: Signal, sample: PerformanceEvidence = evidence([])): ArenaTradeContext {
  const sideFlow = signal.side === input.candidate.side ? input.alignedFlow : -input.alignedFlow;
  const economics = geometryEconomics(input, signal);
  return { channel: input.candidate.channel, regime: input.candidate.regime, anomalyKind: input.candidate.anomalyKind,
    entryStyle: definition.entryStyle, exitProfile: definition.exitProfile, candidateScore: input.candidate.score,
    trendRate: input.candidate.trendRate, trendEfficiency: input.candidate.trendEfficiency,
    volatilityRatio: input.candidate.volatilityRatio, rangePosition: input.candidate.rangePosition,
    openInterestChangeRate: input.candidate.openInterestChangeRate, volume24hUsd: input.candidate.volume24hUsd,
    fundingRate: input.candidate.fundingRate, alignedFlow: sideFlow, confirmation: input.confirmationBySide[signal.side] ?? 0,
    fakeoutRisk: input.fakeoutBySide[signal.side] ?? 1, rangeId: input.range15m?.id ?? null,
    spreadRate: input.spreadRate, bidDepthUsd: input.bidDepthUsd ?? 0, askDepthUsd: input.askDepthUsd ?? 0,
    structureSource: signal.structureSource, ...economics,
    empiricalExpectedReturnRate: sample.conservativeReturnRate, empiricalProfitFactor: sample.profitFactor, empiricalEvents: sample.events };
}
type TradeSizing = { notional: number; plannedRisk: number; contracts: number; quantoMultiplier: number; leverage: number;
  margin: number; accountEquityAtOpen: number; admissionTier: AdmissionTier | null };
function openTrade(input: ArenaObservation, definition: StrategyDefinition, signal: Signal, lane: TradeLane,
  sizing: TradeSizing, selectedForPortfolio: boolean, sample?: PerformanceEvidence) {
  const entryPrice = executableEntry(input, signal.side);
  return { id: `${lane}:${definition.id}:${input.candidate.id}:${input.now}`, strategyId: definition.id,
    strategyName: definition.name, family: definition.family, lane, eventId: input.candidate.id, symbol: input.candidate.symbol,
    side: signal.side, status: "OPEN" as const, openedAt: input.now, closedAt: null, entryPrice,
    stopPrice: signal.stopPrice, targetPrice: signal.targetPrice, exitPrice: null, outcome: null,
    grossReturnRate: null, netReturnRate: null, netPnl: null,
    maxFavorableRate: 0, maxAdverseRate: 0, lastPrice: entryPrice, selectedForPortfolio, reason: signal.reason,
    context: tradeContext(input, definition, signal, sample), ...sizing } satisfies ArenaTrade;
}
const openRisk = (state: StrategyArenaState, side?: Side) => Object.values(state.portfolioOpen)
  .filter((trade) => !side || trade.side === side).reduce((total, trade) => total + trade.plannedRisk, 0);

function portfolioSizing(state: StrategyArenaState, input: ArenaObservation, signal: Signal, tier: AdmissionTier) {
  const economics = geometryEconomics(input, signal);
  const sized = sizePaperPosition({ equity: state.portfolioEquity, entry: economics.entryPrice, invalidation: signal.stopPrice,
    feeBps: ARENA_FRICTION_RATE * 10_000, stressSlippageBps: 0, confidence: clamp(0.5 + signal.quality * 0.35, 0.5, 0.85),
    openRisk: openRisk(state), sameDirectionRisk: openRisk(state, signal.side) });
  const multiplier = Math.max(input.quantoMultiplier ?? 1, 1e-12);
  const contractNotional = economics.entryPrice * multiplier;
  let contracts = Math.floor(sized.notional * (tier === "PROBATION" ? PROBATION_RISK_MULTIPLIER : 1) / Math.max(contractNotional, 1e-12));
  if (contracts < 1) return null;
  let notional = contracts * contractNotional;
  let leverage = selectSafeLeverage({ notional, equity: state.portfolioEquity, entry: economics.entryPrice,
    invalidation: signal.stopPrice, maintenanceRate: input.maintenanceRate, leverageMax: input.leverageMax });
  const usedMargin = Object.values(state.portfolioOpen).reduce((total, trade) => total + trade.margin, 0);
  contracts = Math.min(contracts, Math.floor(Math.max(0, state.portfolioEquity * PORTFOLIO_MARGIN_CAP - usedMargin)
    * leverage.leverage / Math.max(contractNotional, 1e-12)));
  if (contracts < 1) return null;
  notional = contracts * contractNotional;
  leverage = selectSafeLeverage({ notional, equity: state.portfolioEquity, entry: economics.entryPrice,
    invalidation: signal.stopPrice, maintenanceRate: input.maintenanceRate, leverageMax: input.leverageMax });
  const plannedRisk = notional * (economics.structuralStopRate + ARENA_FRICTION_RATE);
  if (openRisk(state) + plannedRisk > state.portfolioEquity * PORTFOLIO_RISK_CAP + 1e-8
    || openRisk(state, signal.side) + plannedRisk > state.portfolioEquity * CORRELATED_DIRECTION_RISK_CAP + 1e-8
    || usedMargin + leverage.margin > state.portfolioEquity * PORTFOLIO_MARGIN_CAP + 1e-8) return null;
  return { notional, plannedRisk, contracts, quantoMultiplier: multiplier, leverage: leverage.leverage, margin: leverage.margin,
    accountEquityAtOpen: state.portfolioEquity, admissionTier: tier } satisfies TradeSizing;
}

function portfolioAdmission(state: StrategyArenaState, input: ArenaObservation, signal: Signal, score: StrategyScore) {
  const economics = geometryEconomics(input, signal);
  const aggregate = playbookPerformance(state, baseId(score.id), input.candidate.regime);
  const own = strategyPerformance(score, input.candidate.regime);
  const sample = own.events >= PROBATION_MIN_EVENTS ? own : aggregate;
  const tier: AdmissionTier = score.lane === "VERIFIED" && verifiedQualified(sample) ? "NORMAL" : "PROBATION";
  const validStructure = signal.side === "LONG" ? economics.entryPrice > signal.stopPrice && economics.entryPrice < signal.targetPrice
    : economics.entryPrice < signal.stopPrice && economics.entryPrice > signal.targetPrice;
  const blocker = !validStructure ? "STRUCTURE" : input.candidate.volume24hUsd < ARENA_MIN_VOLUME_24H_USD ? "LIQUIDITY"
    : input.spreadRate > ARENA_MAX_SPREAD_RATE ? "SPREAD" : economics.netRewardRisk < MIN_NET_REWARD_RISK ? "NET_RR"
      : economics.costShare > ARENA_MAX_COST_SHARE ? "COST_SHARE" : sample.conservativeReturnRate <= 0 ? "EXPECTANCY"
        : tier === "PROBATION" && !probationQualified(sample) ? "SAMPLES"
          : tier === "NORMAL" && !verifiedQualified(sample) ? "SAMPLES" : null;
  if (blocker) { state.admissionRejects[blocker] = (state.admissionRejects[blocker] ?? 0) + 1; return null; }
  const sizing = portfolioSizing(state, input, signal, tier);
  if (!sizing) { state.admissionRejects.SIZING = (state.admissionRejects.SIZING ?? 0) + 1; return null; }
  if (Math.min(input.bidDepthUsd ?? 0, input.askDepthUsd ?? 0) < Math.max(10_000, sizing.notional * 5)) {
    state.admissionRejects.DEPTH = (state.admissionRejects.DEPTH ?? 0) + 1; return null;
  }
  return { tier, sample, sizing };
}

export function observeStrategyArena(input: { state: StrategyArenaState; observation: ArenaObservation }) {
  const current = { midpoint: input.observation.midpoint, bestBid: input.observation.bestBid, bestAsk: input.observation.bestAsk };
  const state = advanceStrategyArena({ state: input.state, quotes: { [input.observation.candidate.symbol]: current }, now: input.observation.now });
  const promoted: Array<{ signal: Signal; definition: StrategyDefinition; score: StrategyScore }> = [];
  for (const signal of signals(input.observation)) {
    const score = state.strategies[signal.strategyId]; const definition = STRATEGY_CATALOG.find((row) => row.id === signal.strategyId);
    if (!score || !definition) continue;
    const signalKey = `${signal.strategyId}:${input.observation.candidate.id}`;
    const openKey = `${signal.strategyId}:${input.observation.candidate.symbol}`;
    if (state.seenSignals.includes(signalKey) || state.open[openKey] || Object.keys(state.open).length >= ARENA_MAX_OPEN) continue;
    const entry = executableEntry(input.observation, signal.side);
    const virtual: TradeSizing = { notional: STRATEGY_INITIAL_EQUITY,
      plannedRisk: STRATEGY_INITIAL_EQUITY * (Math.abs(entry - signal.stopPrice) / Math.max(entry, 1e-9) + ARENA_FRICTION_RATE),
      contracts: 0, quantoMultiplier: input.observation.quantoMultiplier ?? 1, leverage: 1, margin: STRATEGY_INITIAL_EQUITY,
      accountEquityAtOpen: STRATEGY_INITIAL_EQUITY, admissionTier: null };
    state.open[openKey] = openTrade(input.observation, definition, signal, score.lane, virtual, false);
    state.seenSignals.push(signalKey); if (state.seenSignals.length > 2_000) state.seenSignals.shift();
    if (score.lane !== "SHADOW") promoted.push({ signal, definition, score });
  }
  const symbol = input.observation.candidate.symbol;
  const portfolioSeenKey = `portfolio:${input.observation.candidate.id}`;
  const probationOpen = Object.values(state.portfolioOpen).filter((trade) => trade.admissionTier === "PROBATION").length;
  if (promoted.length && !state.portfolioOpen[symbol] && Object.keys(state.portfolioOpen).length < PORTFOLIO_MAX_OPEN
    && !state.seenSignals.includes(portfolioSeenKey)) {
    const candidates = promoted.map((row) => ({ ...row, admission: portfolioAdmission(state, input.observation, row.signal, row.score) }))
      .filter((row) => row.admission && (row.admission.tier === "NORMAL" || probationOpen < PORTFOLIO_MAX_PROBATION_OPEN))
      .sort((a, b) => Number(b.admission!.tier === "NORMAL") - Number(a.admission!.tier === "NORMAL")
        || b.admission!.sample.conservativeReturnRate - a.admission!.sample.conservativeReturnRate
        || b.admission!.sample.profitFactor - a.admission!.sample.profitFactor || b.signal.quality - a.signal.quality);
    const winner = candidates[0];
    if (winner?.admission) {
      state.portfolioOpen[symbol] = openTrade(input.observation, winner.definition, winner.signal, "PORTFOLIO",
        winner.admission.sizing, true, winner.admission.sample); state.seenSignals.push(portfolioSeenKey);
    }
  }
  return state;
}

export function resetStrategyArenaAccount(input: { state: StrategyArenaState; quotes: Record<string, ArenaQuote>; now: number; reason?: string }) {
  const state = normalizeStrategyArena(input.state, input.now);
  for (const [symbol, trade] of Object.entries(state.portfolioOpen)) {
    const raw = input.quotes[symbol]; if (!raw || !(raw.midpoint > 0)) throw new Error(`${symbol} 行情不新鲜，不能用旧价格重置模拟持仓`);
    const current = quote(raw); const exitPrice = trade.side === "LONG" ? current.bestBid : current.bestAsk;
    delete state.portfolioOpen[symbol]; recordClosed(state, closeTrade(trade, exitPrice, "RESET", input.now));
  }
  state.archivedPortfolioCycles.push({ number: state.portfolioCycle, ruleVersion: `v${STRATEGY_ARENA_VERSION}`,
    startedAt: state.portfolioCycleStartedAt, endedAt: input.now, startingEquity: STRATEGY_INITIAL_EQUITY,
    endingEquity: state.portfolioEquity, resolved: state.portfolioResolved, wins: state.portfolioWins,
    grossPnl: state.portfolioGrossPnl, costs: state.portfolioCosts, reason: input.reason ?? "手动重置" });
  state.archivedPortfolioCycles = state.archivedPortfolioCycles.slice(-12);
  state.portfolioCycle += 1; state.portfolioCycleStartedAt = input.now; state.portfolioEquity = STRATEGY_INITIAL_EQUITY;
  state.portfolioResolved = 0; state.portfolioWins = 0; state.portfolioGrossPnl = 0; state.portfolioCosts = 0;
  state.recentPortfolio = []; state.portfolioOpen = {}; return state;
}

export function arenaSummary(state: StrategyArenaState) {
  const strategies = Object.values(state.strategies).sort((a, b) => {
    const rank = (lane: StrategyLane) => lane === "VERIFIED" ? 2 : lane === "TRIAL" ? 1 : 0;
    return rank(b.lane) - rank(a.lane) || strategyPerformance(b).conservativeReturnRate - strategyPerformance(a).conservativeReturnRate;
  });
  const open = Object.values(state.open).sort((a, b) => b.openedAt - a.openedAt);
  return { version: state.version, startedAt: state.startedAt, catalogSize: STRATEGY_CATALOG.length, playbookCount: PLAYBOOKS.length,
    portfolioCycle: state.portfolioCycle, portfolioCycleStartedAt: state.portfolioCycleStartedAt,
    archivedPortfolioCycles: state.archivedPortfolioCycles.slice(-12).reverse(),
    shadowCount: strategies.filter((row) => row.lane === "SHADOW").length,
    trialCount: strategies.filter((row) => row.lane === "TRIAL").length,
    verifiedCount: strategies.filter((row) => row.lane === "VERIFIED").length,
    paperCount: strategies.filter((row) => row.lane !== "SHADOW").length,
    openShadow: open.filter((row) => row.lane === "SHADOW"), openPaper: open.filter((row) => row.lane !== "SHADOW"),
    portfolioOpen: Object.values(state.portfolioOpen).sort((a, b) => b.openedAt - a.openedAt),
    portfolioEquity: state.portfolioEquity, portfolioResolved: state.portfolioResolved, portfolioWins: state.portfolioWins,
    portfolioGrossPnl: state.portfolioGrossPnl, portfolioCosts: state.portfolioCosts, strategies,
    playbooks: PLAYBOOKS.map((row) => ({ ...row, evidence: playbookPerformance(state, row.id) })),
    recentShadow: state.recentShadow.slice(-100).reverse(), recentPaper: state.recentPaper.slice(-100).reverse(),
    recentPortfolio: state.recentPortfolio.slice(-100).reverse(), transitions: state.transitions.slice(-100).reverse(),
    admissionRejects: state.admissionRejects,
    rules: { probationEvents: PROBATION_MIN_EVENTS, verifiedEvents: VERIFIED_PAPER_EVENTS, verifiedSymbols: VERIFIED_PAPER_SYMBOLS,
      probationProfitFactor: PROBATION_PROFIT_FACTOR, verifiedProfitFactor: VERIFIED_PROFIT_FACTOR,
      demotionLosses: PAPER_DEMOTION_LOSSES, frictionFloorRate: ARENA_FRICTION_RATE, minNetRewardRisk: MIN_NET_REWARD_RISK,
      maxCostShare: ARENA_MAX_COST_SHARE, probationRiskMultiplier: PROBATION_RISK_MULTIPLIER,
      maxProbationOpen: PORTFOLIO_MAX_PROBATION_OPEN, maxHoldMs: ARENA_MAX_HOLD_MS } };
}
