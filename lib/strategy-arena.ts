import { CORRELATED_DIRECTION_RISK_CAP, MIN_NET_REWARD_RISK, PORTFOLIO_MARGIN_CAP, PORTFOLIO_RISK_CAP,
  selectSafeLeverage, sizePaperPosition, type LiquidityRoute, type RangeStructure, type Side } from "./liquidity-core.ts";
import type { CandidateChannel, MarketRegimeCandidate, MarketRegimeKind, ResidentCandleStructure } from "./market-regime.ts";

export const STRATEGY_ARENA_VERSION = 6;
export const STRATEGY_INITIAL_EQUITY = 1_000;
export const PROMOTION_WIN_STREAK = 3;
export const PROMOTION_RECENT_WINDOW = 6;
export const PROMOTION_THREE_MAX_SPAN_MS = 24 * 60 * 60_000;
export const PROMOTION_SIX_MAX_SPAN_MS = 72 * 60 * 60_000;
export const PAPER_DEMOTION_LOSSES = 3;
export const PAPER_RECENT_WINDOW = 6;
export const PERFORMANCE_WINDOW = 6;
export const ARENA_FRICTION_RATE = 0.0014;
export const ARENA_MAX_SPREAD_RATE = 0.0012;
export const ARENA_MIN_VOLUME_24H_USD = 10_000_000;
export const ARENA_MAX_COST_SHARE = 0.25;
export const ARENA_QUOTE_STALE_MS = 5_000;
export const MIN_PORTFOLIO_TRADE_RISK_USDT = 10;
export const PORTFOLIO_REALTIME_CAPACITY = 10;
export const ARENA_MAX_OPEN = 240;
export const ARENA_HISTORY_LIMIT = 240;
export const REVERSE_TRIGGER_WINDOW = 6;
export const REVERSE_STOP_MINIMUM = 3;
export const REVERSE_MAX_BREAK_EVEN_RATE = 0.85;
export const FAST_TARGET_NET_RR = 1.35;
export const STRUCTURE_TARGET_NET_RR = 1.6;

export type StrategyLane = "SHADOW" | "ACTIVE" | "SLEEPING";
export type TradeLane = "EFFECTIVE_SHADOW" | "PORTFOLIO";
export type StrategyOrientation = "NORMAL" | "REVERSE";
export type StrategyFamily = "FAST" | "TREND" | "RANGE" | "REVERSAL";
export type EntryStyle = "CONFIRM" | "RETEST";
export type ExitProfile = "FAST" | "STRUCTURE";
export type ArenaOutcome = "TARGET" | "STOP" | "TIMEOUT" | "RESET";
export type AdmissionTier = "NORMAL";

type Playbook = { id: string; name: string; family: StrategyFamily; channel: CandidateChannel; description: string };

export const PLAYBOOKS: Playbook[] = [
  { id: "anomaly_follow", name: "完成K线扩张延续", family: "FAST", channel: "ANOMALY", description: "已完成5分钟宽幅K线保持方向时延续。" },
  { id: "compression_break", name: "压缩释放", family: "FAST", channel: "COMPRESSION", description: "波幅压缩后出现方向释放。" },
  { id: "steady_trend", name: "趋势延续", family: "TREND", channel: "TREND", description: "方向效率稳定且未明显回撤时顺势。" },
  { id: "shallow_trend_pullback", name: "趋势浅回撤", family: "TREND", channel: "TREND", description: "趋势内浅回撤后恢复同向。" },
  { id: "deep_trend_reclaim", name: "趋势深回撤", family: "TREND", channel: "TREND", description: "趋势深回撤后重新收复并顺势。" },
  { id: "compression_retest", name: "突破回踩", family: "TREND", channel: "COMPRESSION", description: "突破后回踩守住再延续。" },
  { id: "anomaly_pullback", name: "扩张回撤延续", family: "TREND", channel: "ANOMALY", description: "完成K线扩张后的受控回撤再次顺势。" },
  { id: "range_edge", name: "区间边缘", family: "RANGE", channel: "RANGE", description: "低效率震荡接近边缘时回到中枢。" },
  { id: "range_sweep_reclaim", name: "扫区间后收回", family: "RANGE", channel: "RANGE", description: "扫过区间边缘并重新收回。" },
  { id: "range_failed_break", name: "区间假突破", family: "REVERSAL", channel: "RANGE", description: "突破未被接受后反向回归。" },
  { id: "compression_failed", name: "压缩假突破", family: "REVERSAL", channel: "COMPRESSION", description: "压缩首次释放失败后反向。" },
  { id: "anomaly_fade", name: "扩张衰竭反转", family: "REVERSAL", channel: "ANOMALY", description: "完成K线扩张回吐并出现失败确认时反向。" },
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
  structureSource: "ROUTE" | "RANGE" | "CANDLE_5M" | "IMPULSE";
  grossRewardRate: number; structuralStopRate: number; netRewardRisk: number; costShare: number;
  empiricalExpectedReturnRate: number; empiricalProfitFactor: number; empiricalEvents: number;
  originalTargetPrice?: number; targetAdapted?: boolean; targetEvidenceEvents?: number;
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
  attributedStrategyIds?: string[];
  orientation?: StrategyOrientation;
};

export type StrategyResult = { eventId: string; symbol: string; regime: MarketRegimeKind; channel: CandidateChannel;
  netReturnRate: number; netPnl: number; won: boolean; resolvedAt: number };
export type StrategyScore = StrategyDefinition & {
  lane: StrategyLane; enabled: boolean; shadowResolved: number; shadowWins: number; shadowNetReturnRate: number;
  paperResolved: number; paperWins: number; paperNetReturnRate: number; paperEquity: number;
  consecutivePaperLosses: number; stageResults: number[]; stageEvents: string[]; stageSymbols: string[];
  recentResults: StrategyResult[]; transitions: number; lastTransitionAt: number | null;
  paperResults: StrategyResult[]; demotedAt: number | null; lastTransitionReason: string;
  reverseEnabled: boolean; reverseRecentResults: StrategyResult[]; reversePaperResults: StrategyResult[];
  reverseShadowResolved: number; reverseShadowWins: number; reverseShadowNetReturnRate: number;
  reversePaperResolved: number; reversePaperWins: number; reversePaperNetReturnRate: number;
  reverseDemotedAt: number | null; reverseLastTransitionAt: number | null; reverseLastTransitionReason: string;
};
export type PlaybookEventResult = { eventId: string; symbol: string; regime: MarketRegimeKind; channel: CandidateChannel;
  resolvedAt: number; variantResults: Record<string, number>; netReturnRate: number };
export type PerformanceEvidence = { events: number; wins: number; netReturnRate: number; meanReturnRate: number;
  conservativeReturnRate: number; profitFactor: number; regimeEvents: number };
export type ArenaTransition = { id: string; strategyId: string; strategyName: string; from: StrategyLane; to: StrategyLane; at: number; reason: string };
export type PortfolioCycleArchive = { number: number; ruleVersion: string; startedAt: number; endedAt: number;
  startingEquity: number; endingEquity: number; resolved: number; wins: number; grossPnl: number; costs: number; reason: string };

export type StrategyArenaState = {
  version: 6; startedAt: number; strategies: Record<string, StrategyScore>; playbookResults: Record<string, PlaybookEventResult[]>;
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
  candleStructure?: ResidentCandleStructure | null;
};

type Signal = { strategyId: string; side: Side; entryTrigger: number; stopPrice: number; targetPrice: number; quality: number; reason: string;
  orientation?: StrategyOrientation; originalTargetPrice?: number; targetAdapted?: boolean; targetEvidenceEvents?: number;
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
    paperResults: [], demotedAt: null, transitions: 0, lastTransitionAt: null, lastTransitionReason: "V4启动：等待新的有效影子结果",
    reverseEnabled: false, reverseRecentResults: [], reversePaperResults: [], reverseShadowResolved: 0,
    reverseShadowWins: 0, reverseShadowNetReturnRate: 0, reversePaperResolved: 0, reversePaperWins: 0,
    reversePaperNetReturnRate: 0, reverseDemotedAt: null, reverseLastTransitionAt: null,
    reverseLastTransitionReason: "反向路线尚未满足最近6笔逆向经济性验证" };
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
  const normalized = { ...fresh, ...value,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => {
      const prior = value.strategies?.[definition.id];
      return [definition.id, prior ? { ...freshStrategy(definition), ...prior, ...definition,
        recentResults: (prior.recentResults ?? []).slice(-24), paperResults: (prior.paperResults ?? []).slice(-24),
        reverseRecentResults: (prior.reverseRecentResults ?? []).slice(-24),
        reversePaperResults: (prior.reversePaperResults ?? []).slice(-24) } : freshStrategy(definition)];
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
  for (const score of Object.values(normalized.strategies)) { promoteStrategy(normalized, score, now); promoteReverse(score, now); }
  return normalized;
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
  const add = (id: string, side: Side, reason: string, quality: number, retestReady = false) => {
    if (!output.some((row) => row.playbookId === id && row.side === side))
      output.push({ playbookId: id, side, reason, quality: clamp(quality, 0, 1), retestReady });
  };
  if (candidate.channel === "TREND") {
    if (candidate.trendEfficiency >= 0.5 && position >= 0.68)
      add("steady_trend", candidate.side, "完成K线趋势效率稳定且方向保持", candidate.trendEfficiency);
    if (position >= 0.45 && position < 0.8)
      add("shallow_trend_pullback", candidate.side, "趋势浅回撤后完成K线重新同向", (candidate.trendEfficiency + position) / 2, true);
    if (position >= 0.22 && position < 0.58 && confirmation >= 0.48)
      add("deep_trend_reclaim", candidate.side, "趋势深回撤后重新收复结构", (candidate.trendEfficiency + confirmation) / 2, true);
    if (fakeout >= 0.7) add("range_failed_break", opposite(candidate.side), "趋势环境内的边界突破失败交叉验证", fakeout, true);
  }
  if (candidate.channel === "RANGE") {
    add("range_edge", candidate.side, "低效率震荡到达区间边缘", 1 - candidate.trendEfficiency, true);
    const edgeRoute = input.routes.some((route) => route.kind === "EDGE_REJECTION" && route.side === candidate.side);
    if (edgeRoute || fakeout >= 0.56) add("range_sweep_reclaim", candidate.side, "区间边缘扫过后重新收回", Math.max(fakeout, 0.58), true);
    const failed = input.routes.some((route) => route.kind === "FAILED_BREAKOUT_REVERSAL" && route.side === candidate.side);
    if (failed || fakeout >= 0.68) add("range_failed_break", candidate.side, "区间突破未被接受并反向", Math.max(fakeout, 0.68), true);
    if (confirmation >= 0.72 && fakeout <= 0.28)
      add("compression_break", candidate.side, "区间内方向确认增强，交叉验证释放策略", confirmation);
  }
  if (candidate.channel === "COMPRESSION") {
    if (confirmation >= 0.52) add("compression_break", candidate.side, "压缩后完成K线结构确认方向释放", confirmation);
    const retest = input.routes.some((route) => route.kind === "BREAKOUT_RETEST" && route.side === candidate.side);
    if (retest) add("compression_retest", candidate.side, "压缩突破后回踩原边界守住", confirmation, true);
    const reverse = opposite(candidate.side);
    if (fakeout >= 0.68 || input.routes.some((route) => route.kind === "FAILED_BREAKOUT_REVERSAL" && route.side === reverse))
      add("compression_failed", reverse, "压缩首次突破失败并反向", fakeout, true);
  }
  if (candidate.channel === "ANOMALY") {
    if (candidate.confirmations >= 2 && retrace <= 0.25 && retrace >= -0.15)
      add("anomaly_follow", candidate.side, "完成5分钟扩张K线确认且尚未明显回吐", clamp(candidate.score / 100, 0, 1), true);
    if (retrace >= 0.15 && retrace <= 0.58)
      add("anomaly_pullback", candidate.side, "完成K线扩张后受控回撤再次顺势", clamp(1 - retrace / 2, 0, 1), true);
    if (retrace >= 0.3 || fakeout >= 0.7)
      add("anomaly_fade", opposite(candidate.side), "完成K线扩张回吐并出现失败确认", Math.max(retrace / 2, fakeout), true);
    if (candidate.trendEfficiency >= 0.62)
      add("steady_trend", candidate.side, "扩张环境内保持高趋势效率，交叉验证趋势延续", candidate.trendEfficiency);
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
  const candle = input.candleStructure;
  if (candle) {
    const buffer = Math.max(entry * Math.max(input.minuteNoiseRate * 1.15, 0.0014), (candle.upper - candle.lower) * 0.035);
    const stopPrice = side === "LONG" ? candle.recentLower - buffer : candle.recentUpper + buffer;
    const risk = direction * (entry - stopPrice);
    if (risk > 0) {
      const rangeTarget = definition.exitProfile === "FAST" ? candle.midpoint : side === "LONG" ? candle.upper : candle.lower;
      const extension = definition.exitProfile === "FAST" ? risk * 1.9 : Math.max(risk * 2.7, (candle.upper - candle.lower) * 0.7);
      const targetPrice = definition.family === "RANGE" || definition.family === "REVERSAL"
        ? rangeTarget : entry + direction * extension;
      const retestDistance = Math.min(risk * 0.35, entry * 0.0025);
      if (direction * (targetPrice - entry) > 0) return {
        entryTrigger: definition.entryStyle === "RETEST" ? entry - direction * retestDistance : entry,
        stopPrice, targetPrice, structureSource: "CANDLE_5M" as const, executable: true,
      };
    }
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
      const routeRetest = input.routes.some((route) => route.side === base.side
        && ["BREAKOUT_RETEST", "EDGE_REJECTION", "FAILED_BREAKOUT_REVERSAL"].includes(route.kind));
      const ready = definition.entryStyle === "CONFIRM" ? (input.confirmationBySide[base.side] ?? 0) >= 0.48
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
        quality: clamp(base.quality * 0.72 + (input.confirmationBySide[base.side] ?? 0) * 0.28, 0, 1),
        reason: base.reason });
    }
  }
  return output;
}

function attainableTarget(state: StrategyArenaState, input: ArenaObservation, signal: Signal, definition: StrategyDefinition): Signal {
  const entry = executableEntry(input, signal.side);
  const direction = signal.side === "LONG" ? 1 : -1;
  const originalDistanceRate = direction * (signal.targetPrice - entry) / Math.max(entry, 1e-9);
  const stopRate = Math.abs(entry - signal.stopPrice) / Math.max(entry, 1e-9);
  if (!(originalDistanceRate > 0) || !(stopRate > 0)) return { ...signal, orientation: "NORMAL" };
  const desiredNetRr = definition.exitProfile === "FAST" ? FAST_TARGET_NET_RR : STRUCTURE_TARGET_NET_RR;
  const economicFloor = ARENA_FRICTION_RATE + MIN_NET_REWARD_RISK * (stopRate + ARENA_FRICTION_RATE);
  const profileCap = ARENA_FRICTION_RATE + desiredNetRr * (stopRate + ARENA_FRICTION_RATE);
  const prior = independentShadowTrades(state, signal.strategyId, "NORMAL");
  const favorable = prior.map((trade) => trade.maxFavorableRate).filter((value) => value > 0).sort((a, b) => a - b);
  const empirical = favorable.length >= 3 ? favorable[Math.floor((favorable.length - 1) * 0.6)] * 0.9 : Number.POSITIVE_INFINITY;
  const reachableCap = Math.max(economicFloor, Math.min(profileCap, empirical));
  const selectedDistanceRate = Math.min(originalDistanceRate, reachableCap);
  const targetPrice = entry * (1 + direction * selectedDistanceRate);
  return { ...signal, orientation: "NORMAL", originalTargetPrice: signal.targetPrice,
    targetPrice, targetAdapted: selectedDistanceRate + 1e-12 < originalDistanceRate,
    targetEvidenceEvents: prior.length,
    reason: selectedDistanceRate + 1e-12 < originalDistanceRate ? `${signal.reason}；目标按完整成本与历史可达性收敛` : signal.reason };
}

function reversedSignal(input: ArenaObservation, signal: Signal): Signal {
  const side = opposite(signal.side);
  return { ...signal, side, orientation: "REVERSE", entryTrigger: executableEntry(input, side),
    stopPrice: signal.targetPrice, targetPrice: signal.stopPrice, originalTargetPrice: signal.stopPrice,
    targetAdapted: false, reason: `反向验证：${signal.reason}` };
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

function lifecycleKey(row: { eventId: string; regime: MarketRegimeKind }) {
  const eventAt = Number(row.eventId.match(/:(\d{13})(?=:|$)/)?.[1]);
  return Number.isFinite(eventAt) ? `${regimeGroup(row.regime)}:${Math.floor(eventAt / (5 * 60_000))}` : row.eventId;
}
function uniqueLifecycleResults<T extends { eventId: string; regime: MarketRegimeKind; resolvedAt: number }>(results: T[]) {
  const seenEvents = new Set<string>();
  const seenLifecycles = new Set<string>();
  return [...results].sort((a, b) => b.resolvedAt - a.resolvedAt).filter((row) => {
    const lifecycle = lifecycleKey(row);
    if (seenEvents.has(row.eventId) || seenLifecycles.has(lifecycle)) return false;
    seenEvents.add(row.eventId); seenLifecycles.add(lifecycle); return true;
  })
    .slice(0, PERFORMANCE_WINDOW).reverse();
}
function uniqueResults(results: StrategyResult[]) {
  return uniqueLifecycleResults(results);
}
function eventIndex(eventId: string, size: number) {
  let hash = 0;
  for (const character of eventId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return size ? hash % size : 0;
}
function uniqueEventTrades(trades: ArenaTrade[]) {
  const seen = new Set<string>();
  return trades.filter((trade) => {
    const key = `${tradeOrientation(trade)}:${trade.eventId}:${baseId(trade.strategyId)}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });
}

const tradeOrientation = (trade: Pick<ArenaTrade, "orientation">): StrategyOrientation => trade.orientation ?? "NORMAL";
function independentShadowTrades(state: StrategyArenaState, strategyId: string, orientation: StrategyOrientation) {
  return uniqueLifecycleResults(state.recentShadow.filter((trade) => trade.status === "CLOSED"
    && trade.strategyId === strategyId && tradeOrientation(trade) === orientation)
    .map((trade) => ({ ...trade, regime: trade.context.regime, resolvedAt: trade.closedAt ?? trade.openedAt })));
}

export function playbookPerformance(state: StrategyArenaState, id: string, currentRegime?: MarketRegimeKind) {
  return evidence(uniqueLifecycleResults(state.playbookResults[id] ?? [])
    .map((row) => ({ netReturnRate: row.netReturnRate, regime: row.regime })), currentRegime);
}
function strategyPerformance(score: StrategyScore, currentRegime?: MarketRegimeKind) {
  return evidence(uniqueResults(score.recentResults), currentRegime);
}
function reversePerformance(score: StrategyScore, currentRegime?: MarketRegimeKind) {
  return evidence(uniqueResults(score.reverseRecentResults), currentRegime);
}
const rollingQualified = (results: Array<{ netReturnRate: number; resolvedAt: number }>) => {
  const latest3 = results.slice(-PROMOTION_WIN_STREAK);
  if (latest3.length === PROMOTION_WIN_STREAK && latest3.every((row) => row.netReturnRate > 0)
    && latest3.at(-1)!.resolvedAt - latest3[0].resolvedAt <= PROMOTION_THREE_MAX_SPAN_MS)
    return "最新3笔独立有效影子订单在24小时内连续盈利";
  const latest6 = results.slice(-PROMOTION_RECENT_WINDOW);
  return latest6.length === PROMOTION_RECENT_WINDOW && sum(latest6.map((row) => row.netReturnRate)) > 0
    && latest6.at(-1)!.resolvedAt - latest6[0].resolvedAt <= PROMOTION_SIX_MAX_SPAN_MS
    ? "最新6笔独立有效影子订单在72小时内成本后总收益为正" : null;
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

function promoteStrategy(state: StrategyArenaState, score: StrategyScore, now: number) {
  if (score.enabled) return;
  const results = uniqueResults(score.recentResults.filter((row) => row.resolvedAt > (score.demotedAt ?? 0)));
  const reason = rollingQualified(results);
  if (!reason) return;
  transition(state, score, "ACTIVE", now, `${reason}；只启用这个已验证执行变体`);
}

function promoteReverse(score: StrategyScore, now: number) {
  if (score.reverseEnabled) return;
  const results = uniqueResults(score.reverseRecentResults.filter((row) => row.resolvedAt > (score.reverseDemotedAt ?? 0)));
  const reason = rollingQualified(results);
  if (!reason) return;
  score.reverseEnabled = true; score.reverseLastTransitionAt = now;
  score.reverseLastTransitionReason = `${reason}；反向路线只参与下一次新信号，正常影子继续运行`;
}

const attributionId = (strategyId: string, orientation: StrategyOrientation) => orientation === "REVERSE" ? `reverse|${strategyId}` : strategyId;
const parseAttribution = (value: string) => value.startsWith("reverse|")
  ? { strategyId: value.slice("reverse|".length), orientation: "REVERSE" as const }
  : { strategyId: value, orientation: "NORMAL" as const };

function reverseEligibility(state: StrategyArenaState, score: StrategyScore) {
  const normal = independentShadowTrades(state, score.id, "NORMAL").slice(-REVERSE_TRIGGER_WINDOW);
  if (normal.length < REVERSE_TRIGGER_WINDOW) return null;
  if (score.reverseDemotedAt != null && (normal.at(-1)?.closedAt ?? 0) <= score.reverseDemotedAt) return null;
  const stops = normal.filter((trade) => trade.outcome === "STOP").length;
  const gross = sum(normal.map((trade) => trade.grossReturnRate ?? 0));
  const net = sum(normal.map((trade) => trade.netReturnRate ?? 0));
  const modeledReverseNet = sum(normal.map((trade) => -(trade.grossReturnRate ?? 0)
    - trade.context.modeledCostRate - (trade.context.fundingCostRate ?? 0) - trade.context.spreadRate));
  return stops >= REVERSE_STOP_MINIMUM && gross < 0 && net < 0 && modeledReverseNet > 0
    ? { events: normal.length, stops, modeledReverseNet } : null;
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
    const attributedIds = state.cutoverPending ? [] : trade.attributedStrategyIds?.length
      ? [...new Set(trade.attributedStrategyIds)] : [trade.strategyId];
    for (const attributedId of attributedIds) {
      const { strategyId, orientation } = parseAttribution(attributedId);
      const score = state.strategies[strategyId];
      if (!score) continue;
      const result: StrategyResult = { eventId: trade.eventId, symbol: trade.symbol, regime: trade.context.regime,
        channel: trade.context.channel, netReturnRate: value, netPnl: trade.netPnl ?? 0, won, resolvedAt: trade.closedAt ?? trade.openedAt };
      if (orientation === "REVERSE") {
        score.reversePaperResults = [...score.reversePaperResults.filter((row) => row.eventId !== result.eventId), result].slice(-24);
        score.reversePaperResolved += 1; score.reversePaperWins += Number(won); score.reversePaperNetReturnRate += value;
      } else {
        score.paperResults = [...score.paperResults.filter((row) => row.eventId !== result.eventId), result].slice(-24);
        score.paperResolved += 1; score.paperWins += Number(won); score.paperNetReturnRate += value;
      }
      const independentPaper = uniqueResults(orientation === "REVERSE" ? score.reversePaperResults : score.paperResults);
      const last3 = independentPaper.slice(-PAPER_DEMOTION_LOSSES);
      const last6 = independentPaper.slice(-PAPER_RECENT_WINDOW);
      const reason = last3.length === PAPER_DEMOTION_LOSSES && last3.every((row) => row.netPnl < 0)
        ? `${orientation === "REVERSE" ? "反向" : "基础"}策略最新3笔模拟订单连续亏损`
        : last6.length === PAPER_RECENT_WINDOW && sum(last6.map((row) => row.netPnl)) <= 0
          ? "最新6笔模拟订单成本后总收益不再为正" : null;
      if (reason && orientation === "REVERSE" && score.reverseEnabled) {
        const resolvedAt = trade.closedAt ?? trade.openedAt;
        score.reverseEnabled = false; score.reverseDemotedAt = resolvedAt; score.reverseLastTransitionAt = resolvedAt;
        score.reverseLastTransitionReason = `${reason}，反向路线退回影子；正常路线的影子验证不停止`;
      } else if (reason && orientation === "NORMAL" && score.enabled) {
        const resolvedAt = trade.closedAt ?? trade.openedAt;
        score.enabled = false; score.demotedAt = resolvedAt;
        transition(state, score, "SHADOW", resolvedAt, `${reason}，这个执行变体退回影子并等待新的有效结果`);
      }
    }
    return;
  }
  const orientation = tradeOrientation(trade);
  if (state.recentShadow.some((row) => tradeOrientation(row) === orientation && row.eventId === trade.eventId
    && baseId(row.strategyId) === baseId(trade.strategyId))) return;
  const score = state.strategies[trade.strategyId];
  if (!score) return;
  const result: StrategyResult = { eventId: trade.eventId, symbol: trade.symbol, regime: trade.context.regime,
    channel: trade.context.channel, netReturnRate: value, netPnl: trade.netPnl ?? 0, won, resolvedAt: trade.closedAt ?? trade.openedAt };
  if (trade.lane === "EFFECTIVE_SHADOW") {
    if (orientation === "REVERSE") {
      score.reverseRecentResults = [...score.reverseRecentResults.filter((row) => row.eventId !== result.eventId), result].slice(-24);
      score.reverseShadowResolved += 1; score.reverseShadowWins += Number(won); score.reverseShadowNetReturnRate += value;
    } else {
      score.recentResults = [...score.recentResults.filter((row) => row.eventId !== result.eventId), result].slice(-24);
      score.shadowResolved += 1; score.shadowWins += Number(won); score.shadowNetReturnRate += value;
      updatePlaybookResult(state, trade);
    }
    state.recentShadow.push(trade); if (state.recentShadow.length > ARENA_HISTORY_LIMIT) state.recentShadow.shift();
    if (orientation === "REVERSE") promoteReverse(score, trade.closedAt ?? Date.now());
    else promoteStrategy(state, score, trade.closedAt ?? Date.now());
    return;
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
    fakeoutRisk: input.fakeoutBySide[signal.side] ?? 1, rangeId: input.range15m?.id ?? input.candleStructure?.id ?? null,
    spreadRate: input.spreadRate, bidDepthUsd: input.bidDepthUsd ?? 0, askDepthUsd: input.askDepthUsd ?? 0,
    structureSource: signal.structureSource, ...economics,
    empiricalExpectedReturnRate: sample.conservativeReturnRate, empiricalProfitFactor: sample.profitFactor, empiricalEvents: sample.events,
    entryTrigger: signal.entryTrigger, feeSlippageRate: ARENA_FRICTION_RATE, fundingCostRate: 0,
    originalTargetPrice: signal.originalTargetPrice, targetAdapted: signal.targetAdapted,
    targetEvidenceEvents: signal.targetEvidenceEvents,
    maxHoldMs: signal.maxHoldMs, noProgressMs: signal.noProgressMs };
}
type TradeSizing = { notional: number; plannedRisk: number; contracts: number; quantoMultiplier: number; leverage: number;
  margin: number; accountEquityAtOpen: number; admissionTier: AdmissionTier | null };
function openTrade(input: ArenaObservation, definition: StrategyDefinition, signal: Signal, lane: TradeLane,
  sizing: TradeSizing, selectedForPortfolio: boolean, sample?: PerformanceEvidence, attributedStrategyIds?: string[]) {
  const entryPrice = executableEntry(input, signal.side);
  const orientation = signal.orientation ?? "NORMAL";
  return { id: `${lane}:${orientation}:${definition.id}:${input.candidate.id}:${input.now}`, strategyId: definition.id,
    strategyName: definition.name, family: definition.family, lane, eventId: input.candidate.id, symbol: input.candidate.symbol,
    side: signal.side, status: "OPEN" as const, openedAt: input.now, closedAt: null, entryPrice,
    stopPrice: signal.stopPrice, targetPrice: signal.targetPrice, exitPrice: null, outcome: null,
    grossReturnRate: null, netReturnRate: null, netPnl: null,
    maxFavorableRate: 0, maxAdverseRate: 0, lastPrice: entryPrice, selectedForPortfolio, reason: signal.reason,
    lastSoftEvidenceAt: null, attributedStrategyIds, orientation,
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
  if (plannedRisk + 1e-8 < MIN_PORTFOLIO_TRADE_RISK_USDT
    || openRisk(state) + plannedRisk > state.portfolioEquity * PORTFOLIO_RISK_CAP + 1e-8
    || openRisk(state, signal.side) + plannedRisk > state.portfolioEquity * CORRELATED_DIRECTION_RISK_CAP + 1e-8
    || usedMargin + leverage.margin > state.portfolioEquity * PORTFOLIO_MARGIN_CAP + 1e-8) return null;
  return { notional, plannedRisk, contracts, quantoMultiplier: multiplier, leverage: leverage.leverage, margin: leverage.margin,
    accountEquityAtOpen: state.portfolioEquity, admissionTier: "NORMAL" } satisfies TradeSizing;
}

function portfolioAdmission(state: StrategyArenaState, input: ArenaObservation, signal: Signal, score: StrategyScore,
  orientation: StrategyOrientation = "NORMAL") {
  const economics = geometryEconomics(input, signal);
  const own = orientation === "REVERSE" ? reversePerformance(score, input.candidate.regime) : strategyPerformance(score, input.candidate.regime);
  const sample = own;
  const enabled = orientation === "REVERSE" ? score.reverseEnabled : score.enabled;
  const reverseBreakEvenRate = (economics.structuralStopRate + ARENA_FRICTION_RATE)
    / Math.max(economics.structuralStopRate + economics.grossRewardRate, 1e-9);
  const economicGeometry = orientation === "REVERSE"
    ? economics.grossRewardRate > ARENA_FRICTION_RATE * 2 && economics.costShare <= 0.5
      && reverseBreakEvenRate <= REVERSE_MAX_BREAK_EVEN_RATE
    : economics.netRewardRisk >= MIN_NET_REWARD_RISK && economics.costShare <= ARENA_MAX_COST_SHARE;
  const validStructure = signal.side === "LONG" ? economics.entryPrice > signal.stopPrice && economics.entryPrice < signal.targetPrice
    : economics.entryPrice < signal.stopPrice && economics.entryPrice > signal.targetPrice;
  const blocker = input.dataFresh === false ? "STALE" : input.contractReady === false ? "CONTRACT"
    : input.managementCapacity === false ? "DATA_CAPACITY" : !validStructure ? "STRUCTURE" : input.candidate.volume24hUsd < ARENA_MIN_VOLUME_24H_USD ? "LIQUIDITY"
    : input.spreadRate > ARENA_MAX_SPREAD_RATE ? "SPREAD" : !economicGeometry ? "NET_ECONOMICS"
      : !enabled ? "INACTIVE"
        : sample.events < PROMOTION_WIN_STREAK ? "EMPIRICAL_SAMPLE"
          : sample.conservativeReturnRate <= economics.modeledCostRate ? "EMPIRICAL_COST" : null;
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
  const reverseBreakEvenRate = (economics.structuralStopRate + ARENA_FRICTION_RATE)
    / Math.max(economics.structuralStopRate + economics.grossRewardRate, 1e-9);
  const economicGeometry = signal.orientation === "REVERSE"
    ? economics.grossRewardRate > ARENA_FRICTION_RATE * 2 && economics.costShare <= 0.5
      && reverseBreakEvenRate <= REVERSE_MAX_BREAK_EVEN_RATE
    : economics.netRewardRisk >= MIN_NET_REWARD_RISK && economics.costShare <= ARENA_MAX_COST_SHARE;
  return input.dataFresh === false || input.bestBid == null || input.bestAsk == null ? "买一卖一或关键市场数据不新鲜"
    : input.contractReady === false || !(input.quantoMultiplier && input.quantoMultiplier > 0) ? "Gate合约信息不完整"
      : input.candidate.volume24hUsd < ARENA_MIN_VOLUME_24H_USD ? "24小时成交额不足"
        : input.spreadRate > ARENA_MAX_SPREAD_RATE ? "真实买一卖一价差过大"
          : !signal.executable ? "基础路线尚未达到真实可执行状态"
            : distanceFromTrigger > triggerTolerance ? "已经错过冻结的进场位置"
            : !stopOutsideNoise ? "止损仍位于正常分钟噪声内"
              : !economicGeometry ? "目标扣完整成本后不具备可执行经济性"
                  : !sizing ? "Gate整数张数无法建立合格影子仓位"
                    : Math.min(input.bidDepthUsd ?? 0, input.askDepthUsd ?? 0) < Math.max(10_000, sizing.notional * 5)
                      ? "盘口双边深度不足" : null;
}

export function applyStrategySleepStates(state: StrategyArenaState, _availableChannels: Set<CandidateChannel>, now: number) {
  for (const score of Object.values(state.strategies)) {
    if (!score.enabled) {
      if (score.lane !== "SHADOW") transition(state, score, "SHADOW", now, "尚未启用，持续跨币种和市场环境影子验证");
    } else if (score.lane !== "ACTIVE") {
      transition(state, score, "ACTIVE", now, "已验证执行变体保持启用；市场缺席只代表当前没有信号");
    }
  }
  return state;
}

export function observeStrategyArena(input: { state: StrategyArenaState; observation: ArenaObservation }) {
  const current = { midpoint: input.observation.midpoint, bestBid: input.observation.bestBid, bestAsk: input.observation.bestAsk,
    completedMinuteAt: input.observation.completedMinuteAt };
  const state = advanceStrategyArena({ state: input.state, quotes: { [input.observation.candidate.symbol]: current }, now: input.observation.now });
  const generatedSignals = signals(input.observation).map((signal) => {
    const definition = STRATEGY_CATALOG.find((row) => row.id === signal.strategyId)!;
    return attainableTarget(state, input.observation, signal, definition);
  });
  const generatedIds = new Set(generatedSignals.map((signal) => signal.strategyId));
  const compatible = Object.values(state.strategies).filter((score) => generatedIds.has(score.id));
  if (compatible.some((score) => score.enabled)) {
    for (const score of compatible) {
      if (score.enabled && score.lane === "SLEEPING") transition(state, score, "ACTIVE", input.observation.now,
        "完整5分钟结构出现适用行情，恢复启用");
    }
  }
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
  const executable: Array<{ signal: Signal; definition: StrategyDefinition; score: StrategyScore; sizing: TradeSizing }> = [];
  for (const signal of generatedSignals) {
    const score = state.strategies[signal.strategyId]; const definition = STRATEGY_CATALOG.find((row) => row.id === signal.strategyId);
    if (!score || !definition) continue;
    const playbookId = baseId(signal.strategyId);
    const overlappingPlaybookTrade = Object.values(state.open).find((trade) => trade.lane === "EFFECTIVE_SHADOW"
      && tradeOrientation(trade) === "NORMAL"
      && trade.symbol === input.observation.candidate.symbol && baseId(trade.strategyId) === playbookId);
    if (overlappingPlaybookTrade) {
      recordObservation(definition, `同币种的${overlappingPlaybookTrade.strategyName}基础策略已有有效影子持仓，本信号仅观察`);
      continue;
    }
    const effectiveEventKey = `effective:${playbookId}:${input.observation.candidate.id}`;
    const signalKey = `${signal.strategyId}:${input.observation.candidate.id}`;
    const openKey = `${signal.strategyId}:${input.observation.candidate.symbol}`;
    const eventAlreadyExecuted = state.seenSignals.includes(effectiveEventKey)
      || Object.values(state.open).some((trade) => tradeOrientation(trade) === "NORMAL"
        && trade.eventId === input.observation.candidate.id && baseId(trade.strategyId) === playbookId)
      || state.recentShadow.some((trade) => tradeOrientation(trade) === "NORMAL"
        && trade.eventId === input.observation.candidate.id && baseId(trade.strategyId) === playbookId);
    if (eventAlreadyExecuted || state.seenSignals.includes(signalKey) || state.open[openKey] || Object.keys(state.open).length >= ARENA_MAX_OPEN) continue;
    const virtual = effectiveShadowSizing(input.observation, signal);
    const blocker = effectiveShadowBlocker(input.observation, signal, virtual);
    if (blocker || !virtual) {
      recordObservation(definition, blocker ?? "当前路线不能真实执行");
      continue;
    }
    executable.push({ signal, definition, score, sizing: virtual });
  }
  const byPlaybook = new Map<string, typeof executable>();
  for (const row of executable) {
    const id = baseId(row.signal.strategyId);
    byPlaybook.set(id, [...(byPlaybook.get(id) ?? []), row]);
  }
  for (const [playbookId, rows] of byPlaybook) {
    if (Object.keys(state.open).length >= ARENA_MAX_OPEN) break;
    const learningPool = [...rows].sort((left, right) => left.definition.id.localeCompare(right.definition.id));
    const winner = learningPool[eventIndex(`${input.observation.candidate.id}:${playbookId}`, learningPool.length)];
    if (!winner) continue;
    const openKey = `${winner.signal.strategyId}:${input.observation.candidate.symbol}`;
    state.open[openKey] = openTrade(input.observation, winner.definition, winner.signal, "EFFECTIVE_SHADOW", winner.sizing, false);
    state.seenSignals.push(`effective:${playbookId}:${input.observation.candidate.id}`, `${winner.signal.strategyId}:${input.observation.candidate.id}`);
    const reverseCase = reverseEligibility(state, winner.score);
    const reverse = reverseCase ? reversedSignal(input.observation, winner.signal) : null;
    const reverseKey = `reverse:${winner.signal.strategyId}:${input.observation.candidate.symbol}`;
    const reverseSeenKey = `effective:reverse:${playbookId}:${input.observation.candidate.id}`;
    if (reverse && reverseCase && !state.open[reverseKey] && !state.seenSignals.includes(reverseSeenKey)
      && Object.keys(state.open).length < ARENA_MAX_OPEN) {
      const reverseSizing = effectiveShadowSizing(input.observation, reverse);
      const reverseBlocker = effectiveShadowBlocker(input.observation, reverse, reverseSizing);
      if (reverseSizing && !reverseBlocker) {
        state.open[reverseKey] = openTrade(input.observation, winner.definition, reverse, "EFFECTIVE_SHADOW", reverseSizing, false);
        state.seenSignals.push(reverseSeenKey);
        winner.score.reverseLastTransitionReason = `最近${reverseCase.events}笔正常影子含${reverseCase.stops}次止损，反向成本后测算${(reverseCase.modeledReverseNet * 100).toFixed(2)}%；开始独立反向影子`;
        winner.score.reverseLastTransitionAt = input.observation.now;
      } else if (reverseBlocker) recordObservation(winner.definition, `反向路线仅观察：${reverseBlocker}`);
    }
    while (state.seenSignals.length > 2_000) state.seenSignals.shift();
    for (const row of rows.filter((item) => item.signal.strategyId !== winner.signal.strategyId))
      recordObservation(row.definition, `同一基础策略和市场事件已由${winner.definition.name}执行有效影子，本变体仅观察`);
  }
  const symbol = input.observation.candidate.symbol;
  const portfolioSeenKey = `portfolio:${input.observation.candidate.id}`;
  type PortfolioCandidate = typeof executable[number] & { orientation: StrategyOrientation };
  const active: PortfolioCandidate[] = [];
  for (const row of executable) {
    if (row.score.enabled && row.score.lane === "ACTIVE") active.push({ ...row, orientation: "NORMAL" });
    if (row.score.reverseEnabled) {
      const reverse = reversedSignal(input.observation, row.signal);
      const sizing = effectiveShadowSizing(input.observation, reverse);
      if (!effectiveShadowBlocker(input.observation, reverse, sizing) && sizing)
        active.push({ ...row, signal: reverse, sizing, orientation: "REVERSE" });
    }
  }
  if (active.length && !state.portfolioOpen[symbol] && !state.seenSignals.includes(portfolioSeenKey)) {
    const activeByPlaybook = new Map<string, PortfolioCandidate[]>();
    for (const row of active) {
      const id = `${row.orientation}:${baseId(row.signal.strategyId)}`;
      activeByPlaybook.set(id, [...(activeByPlaybook.get(id) ?? []), row]);
    }
    const representatives = [...activeByPlaybook.values()].map((rows) => [...rows].sort((left, right) =>
      (right.orientation === "REVERSE" ? reversePerformance(right.score, input.observation.candidate.regime)
        : strategyPerformance(right.score, input.observation.candidate.regime)).conservativeReturnRate
        - (left.orientation === "REVERSE" ? reversePerformance(left.score, input.observation.candidate.regime)
          : strategyPerformance(left.score, input.observation.candidate.regime)).conservativeReturnRate
      || right.signal.quality - left.signal.quality || left.definition.id.localeCompare(right.definition.id))[0]);
    const candidates = representatives.map((row) => ({ ...row,
      admission: portfolioAdmission(state, input.observation, row.signal, row.score, row.orientation) }))
      .filter((row) => row.admission)
      .sort((a, b) => b.admission!.sample.conservativeReturnRate - a.admission!.sample.conservativeReturnRate
        || b.admission!.sample.profitFactor - a.admission!.sample.profitFactor || b.signal.quality - a.signal.quality);
    const winner = candidates[0];
    if (winner?.admission) {
      const attributedStrategyIds = candidates.filter((row) => row.signal.side === winner.signal.side)
        .map((row) => attributionId(row.signal.strategyId, row.orientation));
      state.portfolioOpen[symbol] = openTrade(input.observation, winner.definition, winner.signal, "PORTFOLIO",
        winner.admission.sizing, true, winner.admission.sample, attributedStrategyIds); state.seenSignals.push(portfolioSeenKey);
    }
  }
  return state;
}

export function resetStrategyArenaAccount(input: { state: StrategyArenaState; quotes: Record<string, ArenaQuote>; now: number; reason?: string }) {
  const state = normalizeStrategyArena(input.state, input.now);
  const archivedRuleVersion = state.cutoverPending ? "legacy" : `v${STRATEGY_ARENA_VERSION}`;
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
  const strategySummaries = strategies.map((score) => ({ ...score,
    recentResults: uniqueResults(score.recentResults), paperResults: uniqueResults(score.paperResults),
    reverseRecentResults: uniqueResults(score.reverseRecentResults), reversePaperResults: uniqueResults(score.reversePaperResults) }));
  const open = uniqueEventTrades(Object.values(state.open).sort((a, b) => b.openedAt - a.openedAt));
  return { version: state.version, startedAt: state.startedAt, catalogSize: STRATEGY_CATALOG.length, playbookCount: PLAYBOOKS.length,
    portfolioCycle: state.portfolioCycle, portfolioCycleStartedAt: state.portfolioCycleStartedAt,
    archivedPortfolioCycles: state.archivedPortfolioCycles.slice(-12).reverse(),
    shadowCount: strategies.filter((row) => row.lane === "SHADOW").length,
    activeCount: strategies.filter((row) => row.lane === "ACTIVE").length,
    reverseActiveCount: strategies.filter((row) => row.reverseEnabled).length,
    sleepingCount: strategies.filter((row) => row.lane === "SLEEPING").length,
    trialCount: 0, verifiedCount: strategies.filter((row) => row.lane === "ACTIVE").length,
    paperCount: strategies.filter((row) => row.enabled || row.reverseEnabled).length,
    openShadow: open, openPaper: [], observationShadow: state.recentObservations.slice(-100).reverse(),
    portfolioOpen: Object.values(state.portfolioOpen).sort((a, b) => b.openedAt - a.openedAt),
    portfolioEquity: state.portfolioEquity, portfolioResolved: state.portfolioResolved, portfolioWins: state.portfolioWins,
    portfolioGrossPnl: state.portfolioGrossPnl, portfolioCosts: state.portfolioCosts, strategies: strategySummaries,
    playbooks: PLAYBOOKS.map((row) => ({ ...row, evidence: playbookPerformance(state, row.id) })),
    recentShadow: uniqueEventTrades(state.recentShadow.slice(-100).reverse()), recentPaper: state.recentPaper.slice(-100).reverse(),
    recentPortfolio: state.recentPortfolio.slice(-100).reverse(), archivedPortfolioTrades: state.archivedPortfolioTrades.slice(-100).reverse(),
    transitions: state.transitions.slice(-100).reverse(),
    admissionRejects: state.admissionRejects, cutoverPending: state.cutoverPending,
    rules: { promotionWinStreak: PROMOTION_WIN_STREAK, promotionWindow: PROMOTION_RECENT_WINDOW,
      demotionLosses: PAPER_DEMOTION_LOSSES, frictionFloorRate: ARENA_FRICTION_RATE, minNetRewardRisk: MIN_NET_REWARD_RISK,
      maxCostShare: ARENA_MAX_COST_SHARE, singleTradeRiskMin: 0.01, singleTradeRiskMax: 0.02,
      portfolioRiskCap: PORTFOLIO_RISK_CAP, correlatedRiskCap: CORRELATED_DIRECTION_RISK_CAP,
      marginCap: PORTFOLIO_MARGIN_CAP, maxNotionalMultiple: 4, realtimeCapacity: PORTFOLIO_REALTIME_CAPACITY,
      minimumPortfolioRiskUsdt: MIN_PORTFOLIO_TRADE_RISK_USDT, empiricalCostFloorRate: ARENA_FRICTION_RATE,
      reverseTriggerWindow: REVERSE_TRIGGER_WINDOW, reverseStopMinimum: REVERSE_STOP_MINIMUM,
      reverseMaxBreakEvenRate: REVERSE_MAX_BREAK_EVEN_RATE,
      normalShadowAlwaysOn: true, fastTargetNetRewardRisk: FAST_TARGET_NET_RR,
      structureTargetNetRewardRisk: STRUCTURE_TARGET_NET_RR } };
}
