import { CORRELATED_DIRECTION_RISK_CAP, MIN_NET_REWARD_RISK, PORTFOLIO_MARGIN_CAP, PORTFOLIO_RISK_CAP,
  selectSafeLeverage, sizePaperPosition, type LiquidityRoute, type RangeStructure, type Side } from "./liquidity-core.ts";
import type { CandidateChannel, MarketRegimeCandidate, MarketRegimeKind } from "./market-regime.ts";

export const STRATEGY_ARENA_VERSION = 4;
export const STRATEGY_INITIAL_EQUITY = 1_000;
export const PROMOTION_WIN_STREAK = 3;
export const PROMOTION_RECENT_WINDOW = 6;
export const PAPER_DEMOTION_LOSSES = 3;
export const PAPER_RECENT_WINDOW = 6;
export const PERFORMANCE_WINDOW = 6;
export const ARENA_FRICTION_RATE = 0.0014;
export const ARENA_MAX_SPREAD_RATE = 0.0012;
export const ARENA_MIN_VOLUME_24H_USD = 10_000_000;
export const ARENA_MAX_COST_SHARE = 0.25;
export const ARENA_QUOTE_STALE_MS = 5_000;
export const PORTFOLIO_REALTIME_CAPACITY = 10;
export const ARENA_MAX_OPEN = 240;
export const ARENA_HISTORY_LIMIT = 240;

export type StrategyLane = "SHADOW" | "ACTIVE" | "SLEEPING";
export type TradeLane = "EFFECTIVE_SHADOW" | "PORTFOLIO";
export type StrategyFamily = "FAST" | "TREND" | "RANGE" | "REVERSAL";
export type EntryStyle = "CONFIRM" | "RETEST";
export type ExitProfile = "FAST" | "STRUCTURE";
export type ArenaOutcome = "TARGET" | "STOP" | "TIMEOUT" | "RESET";
export type AdmissionTier = "NORMAL";

type Playbook = { id: string; name: string; family: StrategyFamily; channel: CandidateChannel; description: string };

export const PLAYBOOKS: Playbook[] = [
  { id: "anomaly_follow", name: "异动延续", family: "FAST", channel: "ANOMALY", description: "异动确认且资金未明显反向时延续。" },
  { id: "compression_break", name: "压缩释放", family: "FAST", channel: "COMPRESSION", description: "波幅压缩后出现方向释放。" },
  { id: "steady_trend", name: "趋势延续", family: "TREND", channel: "TREND", description: "方向效率稳定且未明显回撤时顺势。" },
  { id: "shallow_trend_pullback", name: "趋势浅回撤", family: "TREND", channel: "TREND", description: "趋势内浅回撤后恢复同向。" },
  { id: "deep_trend_reclaim", name: "趋势深回撤", family: "TREND", channel: "TREND", description: "趋势深回撤后重新收复并顺势。" },
  { id: "compression_retest", name: "突破回踩", family: "TREND", channel: "COMPRESSION", description: "突破后回踩守住再延续。" },
  { id: "anomaly_pullback", name: "异动回撤延续", family: "TREND", channel: "ANOMALY", description: "异动后的受控回撤再次顺势。" },
  { id: "range_edge", name: "区间边缘", family: "RANGE", channel: "RANGE", description: "低效率震荡接近边缘时回到中枢。" },
  { id: "range_sweep_reclaim", name: "扫区间后收回", family: "RANGE", channel: "RANGE", description: "扫过区间边缘并重新收回。" },
  { id: "range_failed_break", name: "区间假突破", family: "REVERSAL", channel: "RANGE", description: "突破未被接受后反向回归。" },
  { id: "compression_failed", name: "压缩假突破", family: "REVERSAL", channel: "COMPRESSION", description: "压缩首次释放失败后反向。" },
  { id: "anomaly_fade", name: "异动衰竭反转", family: "REVERSAL", channel: "ANOMALY", description: "异动回吐且流量支持消失时反向。" },
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
  entryTrigger?: number; feeSlippageRate?: number; fundingCostRate?: number; maxHoldMs?: number; noProgressMs?: number;
};

export type ArenaTrade = {
  id: string; strategyId: string; strategyName: string; family: StrategyFamily; lane: TradeLane; eventId: string;
  symbol: string; side: Side; status: "OPEN" | "CLOSED"; openedAt: number; closedAt: number | null;
  entryPrice: number; stopPrice: number; targetPrice: number; exitPrice: number | null; outcome: ArenaOutcome | null;
  grossReturnRate: number | null; netReturnRate: number | null; netPnl: number | null; notional: number;
  maxFavorableRate: number; maxAdverseRate: number; lastPrice: number; selectedForPortfolio: boolean;
  reason: string; context: ArenaTradeContext; admissionTier: AdmissionTier | null; plannedRisk: number;
  contracts: number; quantoMultiplier: number; leverage: number; margin: number; accountEquityAtOpen: number;
  lastSoftEvidenceAt?: number | null;
};

export type StrategyResult = { eventId: string; symbol: string; regime: MarketRegimeKind; channel: CandidateChannel;
  netReturnRate: number; netPnl: number; won: boolean; resolvedAt: number };
export type StrategyScore = StrategyDefinition & {
  lane: StrategyLane; enabled: boolean; shadowResolved: number; shadowWins: number; shadowNetReturnRate: number;
  paperResolved: number; paperWins: number; paperNetReturnRate: number; paperEquity: number;
  consecutivePaperLosses: number; stageResults: number[]; stageEvents: string[]; stageSymbols: string[];
  recentResults: StrategyResult[]; transitions: number; lastTransitionAt: number | null;
  paperResults: StrategyResult[]; demotedAt: number | null; lastTransitionReason: string;
};
export type PlaybookEventResult = { eventId: string; symbol: string; regime: MarketRegimeKind; channel: CandidateChannel;
  resolvedAt: number; variantResults: Record<string, number>; netReturnRate: number };
export type PerformanceEvidence = { events: number; wins: number; netReturnRate: number; meanReturnRate: number;
  conservativeReturnRate: number; profitFactor: number; regimeEvents: number };
export type ArenaTransition = { id: string; strategyId: string; strategyName: string; from: StrategyLane; to: StrategyLane; at: number; reason: string };
export type PortfolioCycleArchive = { number: number; ruleVersion: string; startedAt: number; endedAt: number;
  startingEquity: number; endingEquity: number; resolved: number; wins: number; grossPnl: number; costs: number; reason: string };

export type StrategyArenaState = {
  version: 4; startedAt: number; strategies: Record<string, StrategyScore>; playbookResults: Record<string, PlaybookEventResult[]>;
  open: Record<string, ArenaTrade>; portfolioOpen: Record<string, ArenaTrade>; portfolioEquity: number;
  portfolioResolved: number; portfolioWins: number; portfolioGrossPnl: number; portfolioCosts: number;
  portfolioCycle: number; portfolioCycleStartedAt: number; archivedPortfolioCycles: PortfolioCycleArchive[];
  recentShadow: ArenaTrade[]; recentPaper: ArenaTrade[]; recentPortfolio: ArenaTrade[];
  archivedPortfolioTrades: ArenaTrade[];
  transitions: ArenaTransition[]; seenSignals: string[]; admissionRejects: Record<string, number>;
  recentObservations: Array<{ id: string; eventId: string; strategyId: string; strategyName: string; symbol: string; observedAt: number; blocker: string }>;
  cutoverPending: boolean;
};

export type ArenaQuote = { midpoint: number; bestBid?: number; bestAsk?: number; observedAt?: number; fresh?: boolean; completedMinuteAt?: number };
export type ArenaObservation = {
  candidate: MarketRegimeCandidate; midpoint: number; bestBid?: number; bestAsk?: number; alignedFlow: number;
  minuteNoiseRate: number; spreadRate: number; range15m: RangeStructure | null;
  confirmationBySide: Record<Side, number>; fakeoutBySide: Record<Side, number>; routes: LiquidityRoute[];
  bidDepthUsd?: number; askDepthUsd?: number; quantoMultiplier?: number; maintenanceRate?: number; leverageMax?: number; now: number;
  dataFresh?: boolean; contractReady?: boolean; managementCapacity?: boolean;
  completedMinuteAt?: number;
};

type Signal = { strategyId: string; side: Side; entryTrigger: number; stopPrice: number; targetPrice: number; quality: number; reason: string;
  structureSource: ArenaTradeContext["structureSource"]; maxHoldMs: number; noProgressMs: number; executable: boolean };
const opposite = (side: Side): Side => side === "LONG" ? "SHORT" : "LONG";
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const baseId = (strategyId: string) => strategyId.split(":")[0];
const regimeGroup = (regime: MarketRegimeKind) => regime === "TREND" || regime === "EXPANSION" ? "DIRECTIONAL" : regime;

function freshStrategy(definition: StrategyDefinition): StrategyScore {
  return { ...definition, lane: "SHADOW", enabled: false, shadowResolved: 0, shadowWins: 0, shadowNetReturnRate: 0,
    paperResolved: 0, paperWins: 0, paperNetReturnRate: 0, paperEquity: STRATEGY_INITIAL_EQUITY,
    consecutivePaperLosses: 0, stageResults: [], stageEvents: [], stageSymbols: [], recentResults: [],
    paperResults: [], demotedAt: null, transitions: 0, lastTransitionAt: null, lastTransitionReason: "V4启动：等待新的有效影子结果" };
}

export function initialStrategyArena(now = Date.now()): StrategyArenaState {
  return { version: STRATEGY_ARENA_VERSION, startedAt: now,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => [definition.id, freshStrategy(definition)])),
    playbookResults: Object.fromEntries(PLAYBOOKS.map((playbook) => [playbook.id, []])), open: {}, portfolioOpen: {},
    portfolioEquity: STRATEGY_INITIAL_EQUITY, portfolioResolved: 0, portfolioWins: 0, portfolioGrossPnl: 0,
    portfolioCosts: 0, portfolioCycle: 1, portfolioCycleStartedAt: now, archivedPortfolioCycles: [],
    recentShadow: [], recentPaper: [], recentPortfolio: [], archivedPortfolioTrades: [], transitions: [], seenSignals: [], admissionRejects: {},
    recentObservations: [], cutoverPending: false };
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
  if (!value) return fresh;
  if (Number((value as { version?: number }).version) !== STRATEGY_ARENA_VERSION) {
    const prior = value as unknown as Partial<StrategyArenaState>;
    const portfolioOpen = prior.portfolioOpen ?? {};
    if (!Object.keys(portfolioOpen).length) return { ...fresh, archivedPortfolioCycles: [
      ...(prior.archivedPortfolioCycles ?? []), ...legacyArchive(value, now),
    ].slice(-12), archivedPortfolioTrades: [
      ...(prior.archivedPortfolioTrades ?? []), ...(prior.recentPortfolio ?? []),
    ].slice(-ARENA_HISTORY_LIMIT) };
    return { ...fresh, portfolioOpen, portfolioEquity: Number(prior.portfolioEquity ?? STRATEGY_INITIAL_EQUITY),
      portfolioResolved: Number(prior.portfolioResolved ?? 0), portfolioWins: Number(prior.portfolioWins ?? 0),
      portfolioGrossPnl: Number(prior.portfolioGrossPnl ?? 0), portfolioCosts: Number(prior.portfolioCosts ?? 0),
      portfolioCycle: Number(prior.portfolioCycle ?? 1), portfolioCycleStartedAt: Number(prior.portfolioCycleStartedAt ?? now),
      recentPortfolio: (prior.recentPortfolio ?? []).slice(-ARENA_HISTORY_LIMIT),
      archivedPortfolioTrades: (prior.archivedPortfolioTrades ?? []).slice(-ARENA_HISTORY_LIMIT),
      archivedPortfolioCycles: (prior.archivedPortfolioCycles ?? []).slice(-12), cutoverPending: true };
  }
  return { ...fresh, ...value,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => {
      const prior = value.strategies?.[definition.id];
      return [definition.id, prior ? { ...freshStrategy(definition), ...prior, ...definition,
        recentResults: (prior.recentResults ?? []).slice(-24), paperResults: (prior.paperResults ?? []).slice(-24) } : freshStrategy(definition)];
    })),
    playbookResults: Object.fromEntries(PLAYBOOKS.map((playbook) => [playbook.id,
      (value.playbookResults?.[playbook.id] ?? []).slice(-24)])),
    open: Object.fromEntries(Object.entries(value.open ?? {}).slice(-ARENA_MAX_OPEN)), portfolioOpen: value.portfolioOpen ?? {},
    recentShadow: (value.recentShadow ?? []).slice(-ARENA_HISTORY_LIMIT), recentPaper: (value.recentPaper ?? []).slice(-ARENA_HISTORY_LIMIT),
    recentPortfolio: (value.recentPortfolio ?? []).slice(-ARENA_HISTORY_LIMIT),
    archivedPortfolioTrades: (value.archivedPortfolioTrades ?? []).slice(-ARENA_HISTORY_LIMIT), transitions: (value.transitions ?? []).slice(-200),
    seenSignals: (value.seenSignals ?? []).slice(-2_000), archivedPortfolioCycles: (value.archivedPortfolioCycles ?? []).slice(-12),
    admissionRejects: value.admissionRejects ?? {}, recentObservations: (value.recentObservations ?? []).slice(-ARENA_HISTORY_LIMIT),
    cutoverPending: Boolean(value.cutoverPending) };
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
      add("anomaly_follow", candidate.side, "异动确认且尚未明显回吐", clamp(candidate.score / 100, 0, 1), true);
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
    : definition.entryStyle === "RETEST" ? ["BREAKOUT_RETEST", "EDGE_REJECTION", "FAILED_BREAKOUT_REVERSAL", "LOCAL_BREAKOUT"]
      : ["LOCAL_BREAKOUT", "INTERNAL_ROTATION", "NODE_CONTINUATION"];
  return input.routes.filter((route) => route.side === side && kinds.includes(route.kind))
    .sort((left, right) => Number(right.executableNow) - Number(left.executableNow) || right.score - left.score)[0] ?? null;
}

function structuralGeometry(input: ArenaObservation, definition: StrategyDefinition, side: Side) {
  const entry = executableEntry(input, side);
  const direction = side === "LONG" ? 1 : -1;
  const route = preferredRoute(input, definition, side);
  if (route && direction * (entry - route.invalidation) > 0 && direction * (route.target - entry) > 0) {
    const risk = Math.abs(entry - route.invalidation);
    const entryTrigger = definition.entryStyle === "RETEST" ? route.entryTrigger : entry;
    const structuralDistance = direction * (route.target - entry);
    const fastDistance = Math.min(structuralDistance, Math.max(entry * ARENA_FRICTION_RATE + risk * 1.8, entry * 0.0028));
    return { entryTrigger, stopPrice: route.invalidation,
      targetPrice: entry + direction * (definition.exitProfile === "FAST" ? fastDistance : structuralDistance),
      structureSource: "ROUTE" as const, executable: route.executableNow };
  }
  const range = input.range15m;
  if (range) {
    const buffer = Math.max(entry * clamp(input.minuteNoiseRate * 0.45, 0.0008, 0.003), Math.abs(range.upper - range.lower) * 0.04);
    const stopPrice = side === "LONG" ? range.lower - buffer : range.upper + buffer;
    const targetPrice = definition.exitProfile === "FAST" ? range.midpoint : side === "LONG" ? range.upper : range.lower;
    if (direction * (entry - stopPrice) > 0 && direction * (targetPrice - entry) > 0)
      return { entryTrigger: definition.entryStyle === "RETEST" ? side === "LONG" ? range.lower : range.upper : entry,
        stopPrice, targetPrice, structureSource: "RANGE" as const, executable: true };
  }
  if (definition.channel === "ANOMALY") {
    const impulse = direction * (entry - input.candidate.referencePrice);
    if (impulse > entry * 0.001) return { entryTrigger: definition.entryStyle === "RETEST" ? entry - direction * impulse * 0.22 : entry,
      stopPrice: input.candidate.referencePrice,
      targetPrice: entry + direction * impulse * (definition.exitProfile === "FAST" ? 0.55 : 0.9),
      structureSource: "IMPULSE" as const, executable: input.candidate.confirmations >= 2 };
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
        : routeRetest || base.retestReady;
      const fakeout = input.fakeoutBySide[base.side] ?? 1;
      const geometry = structuralGeometry(input, definition, base.side);
      if (!ready || !geometry || fakeout > 0.82 && !base.playbookId.includes("failed") && !base.playbookId.includes("fade")) continue;
      const hold = definition.family === "FAST" ? { max: 15, noProgress: 8 }
        : definition.family === "RANGE" ? { max: 30, noProgress: 15 }
          : definition.family === "REVERSAL" ? { max: 30, noProgress: 10 } : { max: 60, noProgress: 30 };
      output.push({ strategyId: definition.id, side: base.side, ...geometry,
        maxHoldMs: (definition.exitProfile === "FAST" ? hold.noProgress : hold.max) * 60_000,
        noProgressMs: hold.noProgress * 60_000,
        quality: clamp(base.quality * 0.6 + (input.confirmationBySide[base.side] ?? 0) * 0.25 + Math.max(0, sideFlow) * 0.15, 0, 1),
        reason: base.reason });
    }
  }
  return output;
}

function transition(state: StrategyArenaState, score: StrategyScore, to: StrategyLane, now: number, reason: string) {
  if (score.lane === to) return;
  const from = score.lane;
  score.lane = to; score.enabled = to === "ACTIVE" || to === "SLEEPING" && score.enabled;
  score.transitions += 1; score.lastTransitionAt = now; score.lastTransitionReason = reason;
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
function eventIndex(eventId: string, size: number) {
  let hash = 0;
  for (const character of eventId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return size ? hash % size : 0;
}
function uniqueEventTrades(trades: ArenaTrade[]) {
  const seen = new Set<string>();
  return trades.filter((trade) => !seen.has(trade.eventId) && Boolean(seen.add(trade.eventId)));
}

export function playbookPerformance(state: StrategyArenaState, id: string, currentRegime?: MarketRegimeKind) {
  return evidence((state.playbookResults[id] ?? []).map((row) => ({ netReturnRate: row.netReturnRate, regime: row.regime })), currentRegime);
}
function strategyPerformance(score: StrategyScore, currentRegime?: MarketRegimeKind) {
  return evidence(uniqueResults(score.recentResults), currentRegime);
}
const rollingQualified = (values: number[]) => {
  const latest3 = values.slice(-PROMOTION_WIN_STREAK);
  if (latest3.length === PROMOTION_WIN_STREAK && latest3.every((value) => value > 0)) return "最新3笔独立有效影子订单连续盈利";
  const latest6 = values.slice(-PROMOTION_RECENT_WINDOW);
  return latest6.length === PROMOTION_RECENT_WINDOW && sum(latest6) > 0 ? "最新6笔独立有效影子订单成本后总收益为正" : null;
};

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

function promoteVariant(state: StrategyArenaState, score: StrategyScore, now: number) {
  if (score.enabled || score.lane === "SLEEPING") return;
  const afterDemotion = uniqueResults(score.recentResults).filter((row) => score.demotedAt == null || row.resolvedAt > score.demotedAt);
  const reason = rollingQualified(afterDemotion.map((row) => row.netPnl));
  if (reason) transition(state, score, "ACTIVE", now, reason);
}

function recordClosed(state: StrategyArenaState, trade: ArenaTrade) {
  const value = trade.netReturnRate ?? 0;
  const won = value > 0;
  if (trade.lane === "PORTFOLIO") {
    state.portfolioEquity = Math.max(0.01, state.portfolioEquity + (trade.netPnl ?? 0));
    state.portfolioResolved += 1; state.portfolioWins += Number(won);
    state.portfolioGrossPnl += trade.notional * (trade.grossReturnRate ?? 0);
    state.portfolioCosts += trade.notional * (trade.context.modeledCostRate + (trade.context.fundingCostRate ?? 0));
    state.recentPortfolio.push(trade); if (state.recentPortfolio.length > ARENA_HISTORY_LIMIT) state.recentPortfolio.shift();
    const score = state.cutoverPending ? undefined : state.strategies[trade.strategyId];
    if (score) {
      const result: StrategyResult = { eventId: trade.eventId, symbol: trade.symbol, regime: trade.context.regime,
        channel: trade.context.channel, netReturnRate: value, netPnl: trade.netPnl ?? 0, won, resolvedAt: trade.closedAt ?? trade.openedAt };
      score.paperResults = [...score.paperResults.filter((row) => row.eventId !== result.eventId), result].slice(-24);
      score.paperResolved += 1; score.paperWins += Number(won); score.paperNetReturnRate += value;
      const last3 = score.paperResults.slice(-PAPER_DEMOTION_LOSSES);
      const last6 = score.paperResults.slice(-PAPER_RECENT_WINDOW);
      const reason = last3.length === PAPER_DEMOTION_LOSSES && last3.every((row) => row.netPnl < 0)
        ? "最新3笔模拟订单连续亏损"
        : last6.length === PAPER_RECENT_WINDOW && sum(last6.map((row) => row.netPnl)) <= 0
          ? "最新6笔模拟订单成本后总收益不再为正" : null;
      if (reason && score.enabled) {
        score.enabled = false; score.demotedAt = result.resolvedAt;
        transition(state, score, "SHADOW", result.resolvedAt, `${reason}，退回影子并等待新的有效结果`);
      }
    }
    return;
  }
  if (state.recentShadow.some((row) => row.eventId === trade.eventId)) return;
  const score = state.strategies[trade.strategyId];
  if (!score) return;
  const result: StrategyResult = { eventId: trade.eventId, symbol: trade.symbol, regime: trade.context.regime,
    channel: trade.context.channel, netReturnRate: value, netPnl: trade.netPnl ?? 0, won, resolvedAt: trade.closedAt ?? trade.openedAt };
  score.recentResults = [...score.recentResults.filter((row) => row.eventId !== result.eventId), result].slice(-24);
  updatePlaybookResult(state, trade);
  if (trade.lane === "EFFECTIVE_SHADOW") {
    score.shadowResolved += 1; score.shadowWins += Number(won); score.shadowNetReturnRate += value;
    state.recentShadow.push(trade); if (state.recentShadow.length > ARENA_HISTORY_LIMIT) state.recentShadow.shift();
    promoteVariant(state, score, trade.closedAt ?? Date.now()); return;
  }
}

function quote(value: number | ArenaQuote, now?: number) {
  return typeof value === "number" ? { midpoint: value, bestBid: value, bestAsk: value, executable: true }
    : { midpoint: value.midpoint, bestBid: value.bestBid, bestAsk: value.bestAsk, completedMinuteAt: value.completedMinuteAt,
      executable: value.fresh !== false && value.bestBid != null && value.bestAsk != null
        && (now == null || value.observedAt == null || now - value.observedAt <= ARENA_QUOTE_STALE_MS) };
}
function closeTrade(trade: ArenaTrade, exitPrice: number, outcome: ArenaOutcome, now: number) {
  const direction = trade.side === "LONG" ? 1 : -1;
  const grossReturnRate = direction * (exitPrice - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9);
  const holdingFraction = Math.max(0, now - trade.openedAt) / (8 * 60 * 60_000);
  const fundingCostRate = Math.max(0, direction * trade.context.fundingRate) * holdingFraction;
  const netReturnRate = grossReturnRate - trade.context.modeledCostRate - fundingCostRate;
  return { ...trade, status: "CLOSED" as const, closedAt: now, exitPrice, outcome, grossReturnRate, netReturnRate,
    netPnl: trade.notional * netReturnRate, lastPrice: exitPrice, context: { ...trade.context, fundingCostRate } };
}
function advanceBook(state: StrategyArenaState, book: Record<string, ArenaTrade>, quotes: Record<string, number | ArenaQuote>, now: number) {
  for (const [id, trade] of Object.entries(book)) {
    const raw = quotes[trade.symbol]; if (raw == null) continue;
    const current = quote(raw, now); if (!current.executable) continue;
    const price = trade.side === "LONG" ? current.bestBid! : current.bestAsk!;
    if (!Number.isFinite(price) || price <= 0) continue;
    const direction = trade.side === "LONG" ? 1 : -1;
    const move = direction * (price - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9);
    trade.lastPrice = price; trade.maxFavorableRate = Math.max(trade.maxFavorableRate, move); trade.maxAdverseRate = Math.min(trade.maxAdverseRate, move);
    const stopped = trade.side === "LONG" ? price <= trade.stopPrice : price >= trade.stopPrice;
    const targeted = trade.side === "LONG" ? price >= trade.targetPrice : price <= trade.targetPrice;
    const age = now - trade.openedAt;
    const riskRate = Math.max(Math.abs(trade.entryPrice - trade.stopPrice) / trade.entryPrice, 1e-9);
    const softEvidence = current.completedMinuteAt != null && current.completedMinuteAt > trade.openedAt
      && current.completedMinuteAt !== trade.lastSoftEvidenceAt;
    if (softEvidence) trade.lastSoftEvidenceAt = current.completedMinuteAt!;
    const noProgress = softEvidence && age >= (trade.context.noProgressMs ?? 30 * 60_000)
      && trade.maxFavorableRate < riskRate * 0.35 && move < riskRate * 0.15;
    const timedOut = softEvidence && age >= (trade.context.maxHoldMs ?? 60 * 60_000);
    if (!stopped && !targeted && !noProgress && !timedOut) continue;
    const outcome: ArenaOutcome = stopped ? "STOP" : targeted ? "TARGET" : "TIMEOUT";
    const exitPrice = price;
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
    empiricalExpectedReturnRate: sample.conservativeReturnRate, empiricalProfitFactor: sample.profitFactor, empiricalEvents: sample.events,
    entryTrigger: signal.entryTrigger, feeSlippageRate: ARENA_FRICTION_RATE, fundingCostRate: 0,
    maxHoldMs: signal.maxHoldMs, noProgressMs: signal.noProgressMs };
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
    lastSoftEvidenceAt: null,
    context: tradeContext(input, definition, signal, sample), ...sizing } satisfies ArenaTrade;
}
const openRisk = (state: StrategyArenaState, side?: Side) => Object.values(state.portfolioOpen)
  .filter((trade) => !side || trade.side === side).reduce((total, trade) => total + trade.plannedRisk, 0);

function portfolioSizing(state: StrategyArenaState, input: ArenaObservation, signal: Signal) {
  const economics = geometryEconomics(input, signal);
  const sized = sizePaperPosition({ equity: state.portfolioEquity, entry: economics.entryPrice, invalidation: signal.stopPrice,
    feeBps: ARENA_FRICTION_RATE * 10_000, stressSlippageBps: 0, confidence: clamp(0.5 + signal.quality * 0.35, 0.5, 0.85),
    openRisk: openRisk(state), sameDirectionRisk: openRisk(state, signal.side) });
  const multiplier = Math.max(input.quantoMultiplier ?? 1, 1e-12);
  const contractNotional = economics.entryPrice * multiplier;
  const usedNotional = Object.values(state.portfolioOpen).reduce((total, trade) => total + trade.notional, 0);
  const remainingNotional = Math.max(0, state.portfolioEquity * 4 - usedNotional);
  let contracts = Math.floor(Math.min(sized.notional, remainingNotional) / Math.max(contractNotional, 1e-12));
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
    accountEquityAtOpen: state.portfolioEquity, admissionTier: "NORMAL" } satisfies TradeSizing;
}

function portfolioAdmission(state: StrategyArenaState, input: ArenaObservation, signal: Signal, score: StrategyScore) {
  const economics = geometryEconomics(input, signal);
  const own = strategyPerformance(score, input.candidate.regime);
  const sample = own;
  const validStructure = signal.side === "LONG" ? economics.entryPrice > signal.stopPrice && economics.entryPrice < signal.targetPrice
    : economics.entryPrice < signal.stopPrice && economics.entryPrice > signal.targetPrice;
  const blocker = input.dataFresh === false ? "STALE" : input.contractReady === false ? "CONTRACT"
    : input.managementCapacity === false ? "DATA_CAPACITY" : !validStructure ? "STRUCTURE" : input.candidate.volume24hUsd < ARENA_MIN_VOLUME_24H_USD ? "LIQUIDITY"
    : input.spreadRate > ARENA_MAX_SPREAD_RATE ? "SPREAD" : economics.netRewardRisk < MIN_NET_REWARD_RISK ? "NET_RR"
      : economics.costShare > ARENA_MAX_COST_SHARE ? "COST_SHARE" : !score.enabled ? "INACTIVE" : null;
  if (blocker) { state.admissionRejects[blocker] = (state.admissionRejects[blocker] ?? 0) + 1; return null; }
  const sizing = portfolioSizing(state, input, signal);
  if (!sizing) { state.admissionRejects.SIZING = (state.admissionRejects.SIZING ?? 0) + 1; return null; }
  if (Math.min(input.bidDepthUsd ?? 0, input.askDepthUsd ?? 0) < Math.max(10_000, sizing.notional * 5)) {
    state.admissionRejects.DEPTH = (state.admissionRejects.DEPTH ?? 0) + 1; return null;
  }
  return { tier: "NORMAL" as const, sample, sizing };
}

function effectiveShadowSizing(input: ArenaObservation, signal: Signal) {
  const economics = geometryEconomics(input, signal);
  const sized = sizePaperPosition({ equity: STRATEGY_INITIAL_EQUITY, entry: economics.entryPrice, invalidation: signal.stopPrice,
    feeBps: ARENA_FRICTION_RATE * 10_000, stressSlippageBps: 0, confidence: clamp(0.5 + signal.quality * 0.5, 0.5, 1),
    openRisk: 0, sameDirectionRisk: 0 });
  const multiplier = Math.max(input.quantoMultiplier ?? 0, 0);
  const contractNotional = economics.entryPrice * multiplier;
  const contracts = contractNotional > 0 ? Math.floor(sized.notional / contractNotional) : 0;
  if (contracts < 1) return null;
  const notional = contracts * contractNotional;
  const leverage = selectSafeLeverage({ notional, equity: STRATEGY_INITIAL_EQUITY, entry: economics.entryPrice,
    invalidation: signal.stopPrice, maintenanceRate: input.maintenanceRate, leverageMax: input.leverageMax });
  return { notional, plannedRisk: notional * (economics.structuralStopRate + ARENA_FRICTION_RATE), contracts,
    quantoMultiplier: multiplier, leverage: leverage.leverage, margin: leverage.margin,
    accountEquityAtOpen: STRATEGY_INITIAL_EQUITY, admissionTier: null } satisfies TradeSizing;
}

function effectiveShadowBlocker(input: ArenaObservation, signal: Signal, sizing: TradeSizing | null) {
  const economics = geometryEconomics(input, signal);
  const distanceFromTrigger = Math.abs(economics.entryPrice - signal.entryTrigger);
  const triggerTolerance = Math.max(Math.abs(economics.entryPrice - signal.stopPrice) * 0.65, economics.entryPrice * 0.0008);
  const stopOutsideNoise = economics.structuralStopRate >= Math.max(ARENA_FRICTION_RATE, input.minuteNoiseRate * 1.1);
  return input.dataFresh === false || input.bestBid == null || input.bestAsk == null ? "买一卖一或关键市场数据不新鲜"
    : input.contractReady === false || !(input.quantoMultiplier && input.quantoMultiplier > 0) ? "Gate合约信息不完整"
      : input.candidate.volume24hUsd < ARENA_MIN_VOLUME_24H_USD ? "24小时成交额不足"
        : input.spreadRate > ARENA_MAX_SPREAD_RATE ? "真实买一卖一价差过大"
          : !signal.executable ? "基础路线尚未达到真实可执行状态"
            : distanceFromTrigger > triggerTolerance ? "已经错过冻结的进场位置"
            : !stopOutsideNoise ? "止损仍位于正常分钟噪声内"
              : economics.netRewardRisk < MIN_NET_REWARD_RISK ? "目标扣完整成本后盈亏比不足"
                : economics.costShare > ARENA_MAX_COST_SHARE ? "目标不能覆盖手续费、价差和滑点"
                  : !sizing ? "Gate整数张数无法建立合格影子仓位"
                    : Math.min(input.bidDepthUsd ?? 0, input.askDepthUsd ?? 0) < Math.max(10_000, sizing.notional * 5)
                      ? "盘口双边深度不足" : null;
}

export function applyStrategySleepStates(state: StrategyArenaState, availableChannels: Set<CandidateChannel>, now: number) {
  for (const score of Object.values(state.strategies)) {
    const matching = availableChannels.has(score.channel);
    if (!matching && score.lane !== "SLEEPING") transition(state, score, "SLEEPING", now, "当前市场环境不匹配，休眠且保留最近成绩");
    else if (matching && score.lane === "SLEEPING") transition(state, score, score.enabled ? "ACTIVE" : "SHADOW", now,
      score.enabled ? "适用市场环境重新出现，恢复启用" : "适用市场环境重新出现，继续影子验证");
  }
  return state;
}

export function observeStrategyArena(input: { state: StrategyArenaState; observation: ArenaObservation }) {
  const current = { midpoint: input.observation.midpoint, bestBid: input.observation.bestBid, bestAsk: input.observation.bestAsk,
    completedMinuteAt: input.observation.completedMinuteAt };
  const state = advanceStrategyArena({ state: input.state, quotes: { [input.observation.candidate.symbol]: current }, now: input.observation.now });
  const promoted: Array<{ signal: Signal; definition: StrategyDefinition; score: StrategyScore }> = [];
  const generatedSignals = signals(input.observation);
  const recordObservation = (definition: StrategyDefinition, blocker: string) => {
    const id = `observation:${definition.id}:${input.observation.candidate.id}`;
    if (state.recentObservations.some((row) => row.id === id)) return;
    state.recentObservations.push({ id, eventId: input.observation.candidate.id,
      strategyId: definition.id, strategyName: definition.name, symbol: input.observation.candidate.symbol,
      observedAt: input.observation.now, blocker });
    state.recentObservations = state.recentObservations.slice(-ARENA_HISTORY_LIMIT);
  };
  for (const definition of STRATEGY_CATALOG.filter((row) => row.channel === input.observation.candidate.channel)) {
    if (!generatedSignals.some((signal) => signal.strategyId === definition.id))
      recordObservation(definition, "当前环境内尚未形成完整且可执行的触发路线");
  }
  const effectiveEventKey = `effective:${input.observation.candidate.id}`;
  const legacyEventSuffix = `:${input.observation.candidate.id}`;
  const eventAlreadyExecuted = state.seenSignals.includes(effectiveEventKey)
    || state.seenSignals.some((key) => !key.startsWith("portfolio:") && key.endsWith(legacyEventSuffix))
    || Object.values(state.open).some((trade) => trade.eventId === input.observation.candidate.id)
    || state.recentShadow.some((trade) => trade.eventId === input.observation.candidate.id);
  const overlappingSymbolTrade = Object.values(state.open).find((trade) =>
    trade.lane === "EFFECTIVE_SHADOW" && trade.symbol === input.observation.candidate.symbol);
  const executable: Array<{ signal: Signal; definition: StrategyDefinition; score: StrategyScore; sizing: TradeSizing }> = [];
  for (const signal of generatedSignals) {
    const score = state.strategies[signal.strategyId]; const definition = STRATEGY_CATALOG.find((row) => row.id === signal.strategyId);
    if (!score || !definition) continue;
    if (overlappingSymbolTrade) {
      recordObservation(definition, `同币种已有${overlappingSymbolTrade.strategyName}有效影子持仓，本信号仅观察`);
      continue;
    }
    const signalKey = `${signal.strategyId}:${input.observation.candidate.id}`;
    const openKey = `${signal.strategyId}:${input.observation.candidate.symbol}`;
    if (eventAlreadyExecuted || state.seenSignals.includes(signalKey) || state.open[openKey] || Object.keys(state.open).length >= ARENA_MAX_OPEN) continue;
    const virtual = effectiveShadowSizing(input.observation, signal);
    const blocker = effectiveShadowBlocker(input.observation, signal, virtual);
    if (blocker || !virtual) {
      recordObservation(definition, blocker ?? "当前路线不能真实执行");
      continue;
    }
    executable.push({ signal, definition, score, sizing: virtual });
  }
  const active = executable.filter((row) => row.score.enabled && row.score.lane === "ACTIVE")
    .sort((left, right) => strategyPerformance(right.score, input.observation.candidate.regime).conservativeReturnRate
      - strategyPerformance(left.score, input.observation.candidate.regime).conservativeReturnRate
      || right.signal.quality - left.signal.quality || left.definition.id.localeCompare(right.definition.id));
  const winner = active[0] ?? executable[eventIndex(input.observation.candidate.id, executable.length)];
  if (winner) {
    const openKey = `${winner.signal.strategyId}:${input.observation.candidate.symbol}`;
    state.open[openKey] = openTrade(input.observation, winner.definition, winner.signal, "EFFECTIVE_SHADOW", winner.sizing, false);
    state.seenSignals.push(effectiveEventKey, `${winner.signal.strategyId}:${input.observation.candidate.id}`);
    while (state.seenSignals.length > 2_000) state.seenSignals.shift();
    for (const row of executable.filter((item) => item.signal.strategyId !== winner.signal.strategyId))
      recordObservation(row.definition, `同一市场事件已由${winner.definition.name}执行有效影子，本变体仅观察`);
    if (winner.score.enabled && winner.score.lane === "ACTIVE") promoted.push(winner);
  }
  const symbol = input.observation.candidate.symbol;
  const portfolioSeenKey = `portfolio:${input.observation.candidate.id}`;
  if (promoted.length && !state.portfolioOpen[symbol] && !state.seenSignals.includes(portfolioSeenKey)) {
    const candidates = promoted.map((row) => ({ ...row, admission: portfolioAdmission(state, input.observation, row.signal, row.score) }))
      .filter((row) => row.admission)
      .sort((a, b) => b.admission!.sample.conservativeReturnRate - a.admission!.sample.conservativeReturnRate
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
  const archivedRuleVersion = state.cutoverPending ? "v3" : `v${STRATEGY_ARENA_VERSION}`;
  for (const [symbol, trade] of Object.entries(state.portfolioOpen)) {
    const raw = input.quotes[symbol]; if (!raw || !(raw.midpoint > 0)) throw new Error(`${symbol} 行情不新鲜，不能用旧价格重置模拟持仓`);
    const current = quote(raw, input.now); const exitPrice = trade.side === "LONG" ? current.bestBid : current.bestAsk;
    if (!current.executable) throw new Error(`${symbol} 行情不新鲜，不能用旧价格重置模拟持仓`);
    if (!(exitPrice && exitPrice > 0)) throw new Error(`${symbol} 买一卖一不完整，不能结算模拟持仓`);
    delete state.portfolioOpen[symbol]; recordClosed(state, closeTrade(trade, exitPrice, "RESET", input.now));
  }
  state.archivedPortfolioCycles.push({ number: state.portfolioCycle, ruleVersion: archivedRuleVersion,
    startedAt: state.portfolioCycleStartedAt, endedAt: input.now, startingEquity: STRATEGY_INITIAL_EQUITY,
    endingEquity: state.portfolioEquity, resolved: state.portfolioResolved, wins: state.portfolioWins,
    grossPnl: state.portfolioGrossPnl, costs: state.portfolioCosts, reason: input.reason ?? "手动重置" });
  state.archivedPortfolioCycles = state.archivedPortfolioCycles.slice(-12);
  state.portfolioCycle += 1; state.portfolioCycleStartedAt = input.now; state.portfolioEquity = STRATEGY_INITIAL_EQUITY;
  state.portfolioResolved = 0; state.portfolioWins = 0; state.portfolioGrossPnl = 0; state.portfolioCosts = 0;
  state.archivedPortfolioTrades = [...state.archivedPortfolioTrades, ...state.recentPortfolio].slice(-ARENA_HISTORY_LIMIT);
  state.recentPortfolio = []; state.portfolioOpen = {}; state.cutoverPending = false; return state;
}

export function arenaSummary(state: StrategyArenaState) {
  const strategies = Object.values(state.strategies).sort((a, b) => {
    const rank = (lane: StrategyLane) => lane === "ACTIVE" ? 2 : lane === "SLEEPING" ? 1 : 0;
    return rank(b.lane) - rank(a.lane) || strategyPerformance(b).conservativeReturnRate - strategyPerformance(a).conservativeReturnRate;
  });
  const open = uniqueEventTrades(Object.values(state.open).sort((a, b) => b.openedAt - a.openedAt));
  return { version: state.version, startedAt: state.startedAt, catalogSize: STRATEGY_CATALOG.length, playbookCount: PLAYBOOKS.length,
    portfolioCycle: state.portfolioCycle, portfolioCycleStartedAt: state.portfolioCycleStartedAt,
    archivedPortfolioCycles: state.archivedPortfolioCycles.slice(-12).reverse(),
    shadowCount: strategies.filter((row) => row.lane === "SHADOW").length,
    activeCount: strategies.filter((row) => row.lane === "ACTIVE").length,
    sleepingCount: strategies.filter((row) => row.lane === "SLEEPING").length,
    trialCount: 0, verifiedCount: strategies.filter((row) => row.lane === "ACTIVE").length,
    paperCount: strategies.filter((row) => row.enabled).length,
    openShadow: open, openPaper: [], observationShadow: state.recentObservations.slice(-100).reverse(),
    portfolioOpen: Object.values(state.portfolioOpen).sort((a, b) => b.openedAt - a.openedAt),
    portfolioEquity: state.portfolioEquity, portfolioResolved: state.portfolioResolved, portfolioWins: state.portfolioWins,
    portfolioGrossPnl: state.portfolioGrossPnl, portfolioCosts: state.portfolioCosts, strategies,
    playbooks: PLAYBOOKS.map((row) => ({ ...row, evidence: playbookPerformance(state, row.id) })),
    recentShadow: uniqueEventTrades(state.recentShadow.slice(-100).reverse()), recentPaper: state.recentPaper.slice(-100).reverse(),
    recentPortfolio: state.recentPortfolio.slice(-100).reverse(), archivedPortfolioTrades: state.archivedPortfolioTrades.slice(-100).reverse(),
    transitions: state.transitions.slice(-100).reverse(),
    admissionRejects: state.admissionRejects, cutoverPending: state.cutoverPending,
    rules: { promotionWinStreak: PROMOTION_WIN_STREAK, promotionWindow: PROMOTION_RECENT_WINDOW,
      demotionLosses: PAPER_DEMOTION_LOSSES, frictionFloorRate: ARENA_FRICTION_RATE, minNetRewardRisk: MIN_NET_REWARD_RISK,
      maxCostShare: ARENA_MAX_COST_SHARE, singleTradeRiskMin: 0.01, singleTradeRiskMax: 0.02,
      portfolioRiskCap: PORTFOLIO_RISK_CAP, correlatedRiskCap: CORRELATED_DIRECTION_RISK_CAP,
      marginCap: PORTFOLIO_MARGIN_CAP, maxNotionalMultiple: 4, realtimeCapacity: PORTFOLIO_REALTIME_CAPACITY } };
}
