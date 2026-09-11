import { CORRELATED_DIRECTION_RISK_CAP, MIN_NET_REWARD_RISK, PORTFOLIO_MARGIN_CAP, PORTFOLIO_RISK_CAP,
  selectSafeLeverage, sizePaperPosition, type LiquidityRoute, type RangeStructure, type Side } from "./liquidity-core.ts";
import type { CandidateChannel, MarketRegimeCandidate, MarketRegimeKind, ResidentCandleStructure } from "./market-regime.ts";
import { ADAPTIVE_DAILY_OBJECTIVE_RATE, ADAPTIVE_MIN_ANALOG_SAMPLES, ADAPTIVE_POLICY_VERSION,
  type AdaptiveMechanism, type AdaptivePolicyRecommendation } from "./adaptive-policy.ts";

export const STRATEGY_ARENA_VERSION = 8;
export const STRATEGY_INITIAL_EQUITY = 1_000;
export const PROMOTION_WIN_STREAK = 3;
export const PROMOTION_RECENT_WINDOW = 6;
export const PROMOTION_THREE_MAX_SPAN_MS = 24 * 60 * 60_000;
export const PROMOTION_SIX_MAX_SPAN_MS = 72 * 60 * 60_000;
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
export const REVERSE_LOSS_STREAK = 3;
export const REVERSE_MAX_BREAK_EVEN_RATE = 0.85;
export const FAST_TARGET_NET_RR = 1.35;
export const STRUCTURE_TARGET_NET_RR = 1.6;

export type StrategyLane = "SHADOW" | "ACTIVE" | "SLEEPING";
export type TradeLane = "EFFECTIVE_SHADOW" | "PORTFOLIO";
export type StrategyOrientation = "NORMAL" | "REVERSE";
export type StrategyFamily = "FAST" | "TREND" | "RANGE" | "REVERSAL";
export type EntryStyle = "CONFIRM" | "RETEST";
export type ExitProfile = "FAST" | "STRUCTURE";
export type ArenaOutcome = "TARGET" | "STOP" | "TIMEOUT" | "THESIS_INVALID" | "EDGE_DECAY" | "RESET";
export type AdmissionTier = "NORMAL";

type Playbook = { id: string; name: string; family: StrategyFamily; channel: CandidateChannel;
  mechanism: AdaptiveMechanism; description: string };

export const PLAYBOOKS: Playbook[] = [
  { id: "density_return", name: "低效边界回归", family: "RANGE", channel: "RANGE", mechanism: "RANGE_ROTATION",
    description: "路径效率低且价格偏离成交密集区时，验证回到状态中枢的完整收益路径。" },
  { id: "volatility_transition", name: "波动状态跃迁", family: "FAST", channel: "COMPRESSION", mechanism: "COMPRESSION_EXPANSION",
    description: "短期波幅相对基线发生跃迁时，同时验证释放方向与可承受持仓窗口。" },
  { id: "acceptance_failure", name: "边界接受失败", family: "REVERSAL", channel: "RANGE", mechanism: "FAILED_AUCTION",
    description: "价格探索局部边界后未能在边界外收盘接受，验证返回原价值区的路径。" },
  { id: "path_recovery", name: "路径恢复", family: "TREND", channel: "TREND", mechanism: "PULLBACK_RECOVERY",
    description: "主路径保持效率、短期逆向移动衰减后，验证原方向恢复的路径。" },
  { id: "directional_persistence", name: "方向持续性", family: "TREND", channel: "TREND", mechanism: "MOMENTUM_CONTINUATION",
    description: "连续收盘位移相对总路径保持高效率时，验证惯性还能覆盖完整成本的距离。" },
  { id: "boundary_acceptance", name: "边界有效接受", family: "FAST", channel: "ANOMALY", mechanism: "BREAKOUT_ACCEPTANCE",
    description: "收盘越过局部边界且回撤未否定接受时，验证边界外继续发现价格的路径。" },
];

export type StrategyDefinition = Playbook & { entryStyle: EntryStyle; exitProfile: ExitProfile };
export const STRATEGY_CATALOG: StrategyDefinition[] = PLAYBOOKS.map((playbook) => ({
  ...playbook, entryStyle: "CONFIRM", exitProfile: "STRUCTURE",
}));

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
  adaptivePolicyVersion?: number; adaptiveMechanism?: string; adaptiveApproved?: boolean; adaptiveReason?: string;
  adaptiveHorizonMinutes?: number; adaptiveSamples?: number; adaptiveExpectationRate?: number;
  adaptiveConservativeRate?: number; adaptiveObjectiveScore?: number; adaptiveTargetReachRate?: number;
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
  reverseQualificationResults: StrategyResult[];
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
  version: 8; startedAt: number; strategies: Record<string, StrategyScore>; playbookResults: Record<string, PlaybookEventResult[]>;
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
  structureSource: ArenaTradeContext["structureSource"]; maxHoldMs: number; noProgressMs: number; executable: boolean;
  adaptivePolicy?: AdaptivePolicyRecommendation | null };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const baseId = (strategyId: string) => strategyId.split(":")[0];
const regimeGroup = (regime: MarketRegimeKind) => regime === "TREND" || regime === "EXPANSION" ? "DIRECTIONAL" : regime;

function freshStrategy(definition: StrategyDefinition): StrategyScore {
  return { ...definition, lane: "SHADOW", enabled: false, shadowResolved: 0, shadowWins: 0, shadowNetReturnRate: 0,
    paperResolved: 0, paperWins: 0, paperNetReturnRate: 0, paperEquity: STRATEGY_INITIAL_EQUITY,
    consecutivePaperLosses: 0, stageResults: [], stageEvents: [], stageSymbols: [], recentResults: [],
    paperResults: [], demotedAt: null, transitions: 0, lastTransitionAt: null, lastTransitionReason: "状态路径持续影子研究；不使用固定晋级规则",
    reverseEnabled: false, reverseRecentResults: [], reversePaperResults: [], reverseQualificationResults: [], reverseShadowResolved: 0,
    reverseShadowWins: 0, reverseShadowNetReturnRate: 0, reversePaperResolved: 0, reversePaperWins: 0,
    reversePaperNetReturnRate: 0, reverseDemotedAt: null, reverseLastTransitionAt: null,
    reverseLastTransitionReason: "旧版镜像反向已退出交易权威" };
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
  return [{ number: Number(old.portfolioCycle ?? 1), ruleVersion: `v${String((old as { version?: number }).version ?? "legacy")}`,
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
    if (!Object.keys(portfolioOpen).length) return { ...fresh,
      portfolioCycle: Number(prior.portfolioCycle ?? 1) + 1, portfolioCycleStartedAt: now,
      archivedPortfolioCycles: [
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
        reverseQualificationResults: (prior.reverseQualificationResults ?? []).slice(-REVERSE_TRIGGER_WINDOW),
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
  return normalized;
}

function executableEntry(input: ArenaObservation, side: Side) {
  return side === "LONG" ? input.bestAsk ?? input.midpoint : input.bestBid ?? input.midpoint;
}

function generatedGeometry(input: ArenaObservation, policy: AdaptivePolicyRecommendation) {
  const entry = executableEntry(input, policy.side);
  const sign = policy.side === "LONG" ? 1 : -1;
  return { entryTrigger: entry, stopPrice: entry * (1 - sign * policy.stopRate),
    targetPrice: entry * (1 + sign * policy.targetRate),
    structureSource: "CANDLE_5M" as ArenaTradeContext["structureSource"], executable: true };
}

function signals(input: ArenaObservation): Signal[] {
  if (!input.candidate.id.includes(":CANDLE5M:") || !input.candidate.adaptivePolicy) return [];
  return input.candidate.adaptivePolicy.recommendations.flatMap((policy) => {
    const definition = STRATEGY_CATALOG.find((item) => item.mechanism === policy.mechanism);
    // A profitable mechanism in another regime is not evidence for the current market.
    // The current completed-candle channel is the first selector; walk-forward evidence
    // may rank only the strategies designed for that channel.
    if (!definition || definition.channel !== input.candidate.channel) return [];
    const quality = clamp(0.5 + Math.max(0, policy.conservativeNetReturnRate) * 60
      + Math.min(policy.profitFactor, 2) * 0.08 + Math.min(policy.opportunityRatePerDay, 8) * 0.01, 0.5, 0.95);
    return [{ strategyId: definition.id, side: policy.side, ...generatedGeometry(input, policy),
      maxHoldMs: policy.horizonMinutes * 60_000,
      noProgressMs: Math.max(10, Math.round(policy.horizonMinutes * 0.6)) * 60_000,
      quality, reason: `状态路径直接生成：${definition.description}；${policy.reason}`,
      adaptivePolicy: policy }];
  });
}

function attainableTarget(state: StrategyArenaState, input: ArenaObservation, signal: Signal, definition: StrategyDefinition): Signal {
  void state; void input; void definition;
  return { ...signal, orientation: "NORMAL", originalTargetPrice: signal.targetPrice,
    targetAdapted: false, targetEvidenceEvents: signal.adaptivePolicy?.samples ?? 0 };
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
const geometryIdentity = (signal: Signal) => [signal.orientation ?? "NORMAL", signal.side,
  signal.entryTrigger, signal.stopPrice, signal.targetPrice, signal.maxHoldMs, signal.noProgressMs]
  .map((value) => typeof value === "number" ? value.toPrecision(12) : value).join(":");
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
type ShadowAuthorityDecision = { orientation: StrategyOrientation; reason: string; sample: StrategyResult[];
  reverseResults: StrategyResult[] };

function fullyCostedReverseResult(trade: ArenaTrade) {
  const netReturnRate = -(trade.grossReturnRate ?? 0) - trade.context.modeledCostRate
    - (trade.context.fundingCostRate ?? 0) - trade.context.spreadRate * 2;
  return { eventId: trade.eventId, symbol: trade.symbol, regime: trade.context.regime, channel: trade.context.channel,
    netReturnRate, netPnl: trade.notional * netReturnRate, won: netReturnRate > 0,
    resolvedAt: trade.closedAt ?? trade.openedAt } satisfies StrategyResult;
}

function syncReverseCounterfactuals(state: StrategyArenaState, score: StrategyScore) {
  const byEvent = new Map(uniqueResults(score.reverseQualificationResults).map((row) => [row.eventId, row]));
  for (const trade of independentShadowTrades(state, score.id, "NORMAL"))
    byEvent.set(trade.eventId, fullyCostedReverseResult(trade));
  for (const trade of independentShadowTrades(state, score.id, "REVERSE")) byEvent.set(trade.eventId, {
    eventId: trade.eventId, symbol: trade.symbol, regime: trade.context.regime, channel: trade.context.channel,
    netReturnRate: trade.netReturnRate ?? 0, netPnl: trade.netPnl ?? 0, won: (trade.netReturnRate ?? 0) > 0,
    resolvedAt: trade.closedAt ?? trade.openedAt,
  });
  const normalEvents = new Set(uniqueResults(score.recentResults).slice(-PROMOTION_RECENT_WINDOW).map((row) => row.eventId));
  score.reverseQualificationResults = [...byEvent.values()].filter((row) => normalEvents.has(row.eventId))
    .sort((a, b) => a.resolvedAt - b.resolvedAt).slice(-PROMOTION_RECENT_WINDOW);
}

function reverseRowsFor(normal: StrategyResult[], score: StrategyScore) {
  const byEvent = new Map(uniqueResults(score.reverseQualificationResults).map((row) => [row.eventId, row]));
  return normal.flatMap((row) => byEvent.get(row.eventId) ? [byEvent.get(row.eventId)!] : []);
}

function shadowAuthorityDecision(score: StrategyScore): ShadowAuthorityDecision | null {
  const results = uniqueResults(score.recentResults);
  const latest6 = results.slice(-PROMOTION_RECENT_WINDOW);
  const valid6 = latest6.length === PROMOTION_RECENT_WINDOW
    && latest6.at(-1)!.resolvedAt - latest6[0].resolvedAt <= PROMOTION_SIX_MAX_SPAN_MS;
  if (valid6) {
    const normalNet = sum(latest6.map((row) => row.netReturnRate));
    if (normalNet > 0) return { orientation: "NORMAL",
      reason: "最新6笔独立有效影子订单在72小时内成本后总收益为正；6笔窗口优先",
      sample: latest6, reverseResults: reverseRowsFor(latest6, score) };
    const reversed = reverseRowsFor(latest6, score);
    if (normalNet < 0 && reversed.length === latest6.length && sum(reversed.map((row) => row.netReturnRate)) > 0)
      return { orientation: "REVERSE",
        reason: "最新6笔正常影子成本后总收益为负，反向完整成本后为正；6笔窗口优先",
        sample: latest6, reverseResults: reversed };
    return null;
  }
  const latest3 = results.slice(-PROMOTION_WIN_STREAK);
  const valid3 = latest3.length === PROMOTION_WIN_STREAK
    && latest3.at(-1)!.resolvedAt - latest3[0].resolvedAt <= PROMOTION_THREE_MAX_SPAN_MS;
  if (!valid3) return null;
  if (latest3.every((row) => row.netReturnRate > 0)) return { orientation: "NORMAL",
    reason: "尚无有效6笔窗口；最新3笔独立有效影子订单在24小时内连续盈利",
    sample: latest3, reverseResults: reverseRowsFor(latest3, score) };
  const reversed = reverseRowsFor(latest3, score);
  return latest3.every((row) => row.netReturnRate < 0) && reversed.length === latest3.length
    && sum(reversed.map((row) => row.netReturnRate)) > 0
    ? { orientation: "REVERSE",
      reason: "尚无有效6笔窗口；最新3笔正常影子连续亏损且反向完整成本后为正",
      sample: latest3, reverseResults: reversed } : null;
}

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

function refreshShadowAuthority(state: StrategyArenaState, score: StrategyScore, now: number) {
  syncReverseCounterfactuals(state, score);
  const decision = shadowAuthorityDecision(score);
  if (decision?.orientation === "NORMAL") {
    if (score.reverseEnabled) {
      score.reverseEnabled = false; score.reverseLastTransitionAt = now;
      score.reverseLastTransitionReason = "最新影子权威窗口已选择正常路线；反向停止新增模拟，双向影子继续";
    }
    if (!score.enabled || score.lane !== "ACTIVE") transition(state, score, "ACTIVE", now, `${decision.reason}；正常路线参与下一次新信号`);
    else score.lastTransitionReason = `${decision.reason}；正常路线继续接受新模拟信号`;
    return;
  }
  if (decision?.orientation === "REVERSE") {
    if (score.enabled || score.lane === "ACTIVE") transition(state, score, "SHADOW", now,
      "最新影子权威窗口已选择反向路线；正常停止新增模拟，正常影子继续");
    if (!score.reverseEnabled) score.reverseLastTransitionAt = now;
    score.reverseEnabled = true;
    score.reverseLastTransitionReason = `${decision.reason}；反向路线参与下一次新信号`;
    return;
  }
  if (score.enabled || score.lane === "ACTIVE") transition(state, score, "SHADOW", now,
    "最新影子窗口不再满足正常启用条件；停止新增模拟，双向影子继续");
  if (score.reverseEnabled) {
    score.reverseEnabled = false; score.reverseLastTransitionAt = now;
    score.reverseLastTransitionReason = "最新影子窗口不再满足反向启用条件；停止新增模拟，双向影子继续";
  }
}

const attributionId = (strategyId: string, orientation: StrategyOrientation) => orientation === "REVERSE" ? `reverse|${strategyId}` : strategyId;
const parseAttribution = (value: string) => value.startsWith("reverse|")
  ? { strategyId: value.slice("reverse|".length), orientation: "REVERSE" as const }
  : { strategyId: value, orientation: "NORMAL" as const };

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
    }
    return;
  }
  const orientation = tradeOrientation(trade);
  if (state.recentShadow.some((row) => tradeOrientation(row) === orientation && row.eventId === trade.eventId
    && row.strategyId === trade.strategyId)) return;
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
      if (trade.context.adaptivePolicyVersion == null) {
        const reverseResult = fullyCostedReverseResult(trade);
        score.reverseQualificationResults = [...score.reverseQualificationResults.filter((row) => row.eventId !== result.eventId), reverseResult]
          .slice(-PROMOTION_RECENT_WINDOW);
      }
      score.shadowResolved += 1; score.shadowWins += Number(won); score.shadowNetReturnRate += value;
      updatePlaybookResult(state, trade);
    }
    state.recentShadow.push(trade); if (state.recentShadow.length > ARENA_HISTORY_LIMIT) state.recentShadow.shift();
    if (trade.context.adaptivePolicyVersion == null) refreshShadowAuthority(state, score, trade.closedAt ?? Date.now());
    else {
      score.enabled = false; score.reverseEnabled = false; score.lane = "SHADOW";
      score.lastTransitionReason = "当前完成K线状态走查直接决定模拟资格；影子结果仅用于复盘，不触发固定晋级";
    }
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
    const adaptive = trade.context.adaptivePolicyVersion != null;
    const outcome: ArenaOutcome = stopped ? "STOP" : targeted ? "TARGET"
      : noProgress && adaptive ? "THESIS_INVALID" : timedOut && adaptive ? "EDGE_DECAY" : "TIMEOUT";
    const exitPrice = price;
    delete book[id]; recordClosed(state, closeTrade(trade, exitPrice, outcome, now));
  }
}
export function advanceStrategyArena(input: { state: StrategyArenaState; quotes: Record<string, number | ArenaQuote>; now: number }) {
  const state = normalizeStrategyArena(input.state, input.now);
  advanceBook(state, state.open, input.quotes, input.now); advanceBook(state, state.portfolioOpen, input.quotes, input.now); return state;
}

export function advanceStrategyShadowsFromCompletedCandle(input: { state: StrategyArenaState; symbol: string;
  candle: { high: number; low: number; close: number; completedAt: number } }) {
  const state = normalizeStrategyArena(input.state, input.candle.completedAt);
  for (const [id, trade] of Object.entries(state.open)) {
    if (trade.symbol !== input.symbol || input.candle.completedAt <= trade.openedAt) continue;
    const sign = trade.side === "LONG" ? 1 : -1;
    const favorable = trade.side === "LONG" ? (input.candle.high - trade.entryPrice) / trade.entryPrice
      : (trade.entryPrice - input.candle.low) / trade.entryPrice;
    const adverse = trade.side === "LONG" ? (input.candle.low - trade.entryPrice) / trade.entryPrice
      : (trade.entryPrice - input.candle.high) / trade.entryPrice;
    trade.maxFavorableRate = Math.max(trade.maxFavorableRate, favorable);
    trade.maxAdverseRate = Math.min(trade.maxAdverseRate, adverse);
    trade.lastPrice = input.candle.close;
    const stopped = trade.side === "LONG" ? input.candle.low <= trade.stopPrice : input.candle.high >= trade.stopPrice;
    const targeted = trade.side === "LONG" ? input.candle.high >= trade.targetPrice : input.candle.low <= trade.targetPrice;
    const age = input.candle.completedAt - trade.openedAt;
    const riskRate = Math.max(Math.abs(trade.entryPrice - trade.stopPrice) / trade.entryPrice, 1e-9);
    const closeMove = sign * (input.candle.close - trade.entryPrice) / trade.entryPrice;
    const noProgress = age >= (trade.context.noProgressMs ?? 30 * 60_000)
      && trade.maxFavorableRate < riskRate * 0.35 && closeMove < riskRate * 0.15;
    const expired = age >= (trade.context.maxHoldMs ?? 60 * 60_000);
    if (!stopped && !targeted && !noProgress && !expired) continue;
    const adaptive = trade.context.adaptivePolicyVersion != null;
    // A completed candle that contains both levels is deliberately settled stop-first.
    const outcome: ArenaOutcome = stopped ? "STOP" : targeted ? "TARGET"
      : noProgress && adaptive ? "THESIS_INVALID" : expired && adaptive ? "EDGE_DECAY" : "TIMEOUT";
    const exitPrice = stopped ? trade.stopPrice : targeted ? trade.targetPrice : input.candle.close;
    delete state.open[id]; recordClosed(state, closeTrade(trade, exitPrice, outcome, input.candle.completedAt));
  }
  return state;
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
    maxHoldMs: signal.maxHoldMs, noProgressMs: signal.noProgressMs,
    adaptivePolicyVersion: signal.adaptivePolicy ? input.candidate.adaptivePolicy?.version : undefined,
    adaptiveMechanism: signal.adaptivePolicy?.mechanism, adaptiveApproved: signal.adaptivePolicy?.approved,
    adaptiveReason: signal.adaptivePolicy?.reason, adaptiveHorizonMinutes: signal.adaptivePolicy?.horizonMinutes,
    adaptiveSamples: signal.adaptivePolicy?.samples,
    adaptiveExpectationRate: signal.adaptivePolicy?.netExpectationRate,
    adaptiveConservativeRate: signal.adaptivePolicy?.conservativeNetReturnRate,
    adaptiveObjectiveScore: signal.adaptivePolicy?.objectiveScore,
    adaptiveTargetReachRate: signal.adaptivePolicy?.targetReachRate };
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
function cloneShadowForPortfolio(shadow: ArenaTrade, sizing: TradeSizing, sample: PerformanceEvidence) {
  const context = { ...shadow.context, empiricalExpectedReturnRate: sample.conservativeReturnRate,
    empiricalProfitFactor: sample.profitFactor, empiricalEvents: sample.events };
  Object.assign(shadow, sizing); shadow.context = { ...context };
  return { ...shadow, id: shadow.id.replace(/^EFFECTIVE_SHADOW:/, "PORTFOLIO:"), lane: "PORTFOLIO" as const,
    selectedForPortfolio: true, attributedStrategyIds: [attributionId(shadow.strategyId, tradeOrientation(shadow))],
    context: { ...context } } satisfies ArenaTrade;
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

function portfolioAdmission(state: StrategyArenaState, input: ArenaObservation, signal: Signal) {
  const economics = geometryEconomics(input, signal);
  const adaptive = signal.adaptivePolicy;
  if (!adaptive) return null;
  const sample = { events: adaptive.samples, wins: adaptive.wins,
    netReturnRate: adaptive.netExpectationRate * adaptive.samples, meanReturnRate: adaptive.netExpectationRate,
    conservativeReturnRate: adaptive.conservativeNetReturnRate, profitFactor: adaptive.profitFactor,
    regimeEvents: adaptive.samples };
  const economicGeometry = economics.netRewardRisk >= MIN_NET_REWARD_RISK && economics.costShare <= ARENA_MAX_COST_SHARE;
  const validStructure = signal.side === "LONG" ? economics.entryPrice > signal.stopPrice && economics.entryPrice < signal.targetPrice
    : economics.entryPrice < signal.stopPrice && economics.entryPrice > signal.targetPrice;
  const blocker = input.dataFresh === false ? "STALE" : input.contractReady === false ? "CONTRACT"
    : input.managementCapacity === false ? "DATA_CAPACITY" : !validStructure ? "STRUCTURE" : input.candidate.volume24hUsd < ARENA_MIN_VOLUME_24H_USD ? "LIQUIDITY"
    : input.spreadRate > ARENA_MAX_SPREAD_RATE ? "SPREAD" : !economicGeometry ? "NET_ECONOMICS"
      : !adaptive.approved || adaptive.samples < ADAPTIVE_MIN_ANALOG_SAMPLES
        || adaptive.conservativeNetReturnRate <= 0 ? "EXPECTANCY" : null;
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
  const economicGeometry = economics.netRewardRisk >= MIN_NET_REWARD_RISK && economics.costShare <= ARENA_MAX_COST_SHARE;
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
    score.enabled = false; score.reverseEnabled = false;
    if (score.lane !== "SHADOW") transition(state, score, "SHADOW", now, "状态路径由当前走查结果直接授权，不保留旧策略启用状态");
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
    const overlappingVariantTrade = Object.values(state.open).find((trade) => trade.lane === "EFFECTIVE_SHADOW"
      && tradeOrientation(trade) === "NORMAL" && trade.symbol === input.observation.candidate.symbol
      && trade.strategyId === signal.strategyId);
    if (overlappingVariantTrade) {
      recordObservation(definition, `同币种的这个执行变体已有有效影子持仓，本信号仅观察`);
      continue;
    }
    const effectiveEventKey = `effective:normal:${signal.strategyId}:${input.observation.candidate.id}`;
    const legacyEffectiveEventKey = `effective:${baseId(signal.strategyId)}:${input.observation.candidate.id}`;
    const signalKey = `${signal.strategyId}:${input.observation.candidate.id}`;
    const openKey = `${signal.strategyId}:${input.observation.candidate.symbol}`;
    const eventAlreadyExecuted = state.seenSignals.includes(effectiveEventKey) || state.seenSignals.includes(legacyEffectiveEventKey)
      || Object.values(state.open).some((trade) => tradeOrientation(trade) === "NORMAL"
        && trade.eventId === input.observation.candidate.id && trade.strategyId === signal.strategyId)
      || state.recentShadow.some((trade) => tradeOrientation(trade) === "NORMAL"
        && trade.eventId === input.observation.candidate.id && trade.strategyId === signal.strategyId);
    if (eventAlreadyExecuted || state.seenSignals.includes(signalKey) || state.open[openKey] || Object.keys(state.open).length >= ARENA_MAX_OPEN) continue;
    const virtual = effectiveShadowSizing(input.observation, signal);
    const blocker = effectiveShadowBlocker(input.observation, signal, virtual);
    if (blocker || !virtual) {
      recordObservation(definition, blocker ?? "当前路线不能真实执行");
      continue;
    }
    executable.push({ signal, definition, score, sizing: virtual });
  }
  type OpenedShadow = typeof executable[number] & { orientation: StrategyOrientation; shadow: ArenaTrade };
  const opened: OpenedShadow[] = [];
  const distinctGeometry = new Set<string>();
  for (const row of [...executable].sort((a, b) => a.definition.id.localeCompare(b.definition.id))) {
    if (Object.keys(state.open).length >= ARENA_MAX_OPEN) break;
    const playbookId = baseId(row.signal.strategyId);
    const normalGeometry = `${playbookId}:${geometryIdentity(row.signal)}`;
    if (distinctGeometry.has(normalGeometry)) {
      recordObservation(row.definition, "同一基础策略存在完全相同的冻结参数，本重复变体仅观察且不重复计分");
      continue;
    }
    distinctGeometry.add(normalGeometry);
    const openKey = `${row.signal.strategyId}:${input.observation.candidate.symbol}`;
    const shadow = openTrade(input.observation, row.definition, row.signal, "EFFECTIVE_SHADOW", row.sizing, false);
    state.open[openKey] = shadow;
    state.seenSignals.push(`effective:normal:${row.signal.strategyId}:${input.observation.candidate.id}`,
      `${row.signal.strategyId}:${input.observation.candidate.id}`);
    opened.push({ ...row, orientation: "NORMAL", shadow });

  }
  while (state.seenSignals.length > 2_000) state.seenSignals.shift();
  const symbol = input.observation.candidate.symbol;
  const portfolioSeenKey = `portfolio:${input.observation.candidate.id}`;
  const active = opened.filter((row) => row.orientation === "NORMAL" && row.signal.adaptivePolicy?.approved);
  if (active.length && !state.portfolioOpen[symbol] && !state.seenSignals.includes(portfolioSeenKey)) {
    const candidates = active.map((row) => ({ ...row,
      admission: portfolioAdmission(state, input.observation, row.signal) }))
      .filter((row) => row.admission)
      .sort((a, b) => (b.signal.adaptivePolicy?.objectiveScore ?? 0) - (a.signal.adaptivePolicy?.objectiveScore ?? 0)
        || b.admission!.sample.conservativeReturnRate - a.admission!.sample.conservativeReturnRate
        || b.admission!.sample.profitFactor - a.admission!.sample.profitFactor || b.signal.quality - a.signal.quality);
    const winner = candidates[0];
    if (winner?.admission) {
      state.portfolioOpen[symbol] = cloneShadowForPortfolio(winner.shadow, winner.admission.sizing, winner.admission.sample);
      state.seenSignals.push(portfolioSeenKey);
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
    reverseRecentResults: uniqueResults(score.reverseRecentResults), reversePaperResults: uniqueResults(score.reversePaperResults),
    reverseQualificationResults: uniqueResults(score.reverseQualificationResults) }));
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
    rules: { generatedRouteAuthority: true, legacyStrategyAuthority: false, paperCycleResetOnCutover: true,
      frictionFloorRate: ARENA_FRICTION_RATE, minNetRewardRisk: MIN_NET_REWARD_RISK,
      maxCostShare: ARENA_MAX_COST_SHARE, singleTradeRiskMin: 0.01, singleTradeRiskMax: 0.02,
      portfolioRiskCap: PORTFOLIO_RISK_CAP, correlatedRiskCap: CORRELATED_DIRECTION_RISK_CAP,
      marginCap: PORTFOLIO_MARGIN_CAP, maxNotionalMultiple: 4, realtimeCapacity: PORTFOLIO_REALTIME_CAPACITY,
      minimumPortfolioRiskUsdt: MIN_PORTFOLIO_TRADE_RISK_USDT, empiricalCostFloorRate: ARENA_FRICTION_RATE,
      authorityWindowPriority: "CURRENT_STATE_WALK_FORWARD", paperEvaluation: false,
      exactShadowClone: true, normalShadowAlwaysOn: true,
      adaptivePolicyVersion: ADAPTIVE_POLICY_VERSION, adaptiveMinimumAnalogSamples: ADAPTIVE_MIN_ANALOG_SAMPLES,
      dailyObjectiveRate: ADAPTIVE_DAILY_OBJECTIVE_RATE, dailyObjectiveIsQuota: false } };
}
