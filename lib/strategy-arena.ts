import { CORRELATED_DIRECTION_RISK_CAP, MAX_NOTIONAL_TO_EQUITY, MIN_NET_REWARD_RISK, PORTFOLIO_MARGIN_CAP, PORTFOLIO_RISK_CAP,
  selectSafeLeverage, sizePaperPosition, type LiquidityRoute, type RangeStructure, type Side } from "./liquidity-core.ts";
import type { CandidateChannel, MarketRegimeCandidate, MarketRegimeKind, ResidentCandleStructure } from "./market-regime.ts";
import { ALL_REGIME_ENGINE_VERSION, ALL_REGIME_OFFLINE_VALIDATION, ALL_REGIME_STRATEGIES, ALL_REGIME_SYSTEM_NAME,
  type AllRegimeEnvironment } from "./all-regime-engine.ts";
import { classifyMarketState } from "./strategy-coverage.ts";
import { MARKET_PHASE_AUTHORITY, routeMarketApproved } from "./strategy-coverage-policy.ts";

export const STRATEGY_ARENA_VERSION = 12;
export const STRATEGY_INITIAL_EQUITY = 1_000;
export const PROMOTION_WIN_STREAK = 3;
export const PROMOTION_RECENT_WINDOW = 6;
export const PROMOTION_THREE_MAX_SPAN_MS = 24 * 60 * 60_000;
export const PROMOTION_SIX_MAX_SPAN_MS = 72 * 60 * 60_000;
export const PERFORMANCE_WINDOW = 12;
export const ARENA_FRICTION_RATE = 0.0014;
export const ARENA_MAX_SPREAD_RATE = 0.0012;
export const ARENA_MIN_VOLUME_24H_USD = 10_000_000;
export const ARENA_MAX_COST_SHARE = 0.25;
export const ARENA_QUOTE_STALE_MS = 5_000;
export const PORTFOLIO_TRADE_RISK_TARGET_USDT = 10;
export const MIN_PORTFOLIO_NOTIONAL_TO_EQUITY = 1;
export const PORTFOLIO_REALTIME_CAPACITY = 10;
export const MAX_PORTFOLIO_POSITIONS = null;
export const ARENA_MAX_OPEN = 240;
export const ARENA_HISTORY_LIMIT = 240;
export const REVERSE_TRIGGER_WINDOW = 6;
export const REVERSE_LOSS_STREAK = 3;
export const REVERSE_MAX_BREAK_EVEN_RATE = 0.85;
export const FAST_TARGET_NET_RR = 1.35;
export const STRUCTURE_TARGET_NET_RR = 1.6;
export const POLARITY_STREAK = 3;
export const POLARITY_MAX_SPAN_MS = 24 * 60 * 60_000;
export const SAME_STRATEGY_SYMBOL_COOLDOWN_MS = 30 * 60_000;

export type StrategyLane = "SHADOW" | "ACTIVE" | "SLEEPING";
export type TradeLane = "EFFECTIVE_SHADOW" | "PORTFOLIO";
export type StrategyOrientation = "NORMAL" | "REVERSE";
export type StrategyFamily = "FAST" | "TREND" | "RANGE" | "REVERSAL" | "POLAR";
export type EntryStyle = "CONFIRM" | "RETEST";
export type ExitProfile = "FAST" | "STRUCTURE";
export type ArenaOutcome = "TARGET" | "RUNNER_EXIT" | "STOP" | "TIMEOUT" | "THESIS_INVALID" | "EDGE_DECAY" | "RESET";
export type AdmissionTier = "NORMAL";

type Playbook = { id: string; name: string; family: StrategyFamily; channel: CandidateChannel;
  mechanism: "PATH_ENVIRONMENT"; description: string };

const channelForEnvironment = (environment: AllRegimeEnvironment): CandidateChannel => environment === "TREND" ? "TREND"
  : environment === "RANGE" ? "RANGE" : environment === "COMPRESSION" ? "COMPRESSION" : "ANOMALY";
const familyForEnvironment = (environment: AllRegimeEnvironment): StrategyFamily => environment === "TREND" ? "TREND"
  : environment === "RANGE" ? "RANGE" : environment === "COMPRESSION" ? "FAST" : "REVERSAL";
export const PLAYBOOKS: Playbook[] = ALL_REGIME_STRATEGIES.map((strategy) => ({ id: strategy.id, name: strategy.name,
  family: familyForEnvironment(strategy.environment), channel: channelForEnvironment(strategy.environment),
  mechanism: "PATH_ENVIRONMENT", description: strategy.description }));

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
  extremeSequenceVersion?: number; extremeSequenceBranch?: "FISSION" | "SNAPBACK";
  allRegimeVersion?: number; allRegimeEnvironment?: AllRegimeEnvironment;
  polarityAtEntry?: StrategyOrientation; polarityEvidence?: number[]; profitArmIsNotExit?: boolean;
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
  activeStopPrice?: number;
  profitArmedAt?: number | null;
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
export type RouteCheck = { id: string; eventId: string; strategyId: string; strategyName: string; symbol: string;
  observedAt: number; status: "FORMING" | "CHECKING" | "BLOCKED" | "OPEN"; blocker: string | null;
  side: Side | null; environment: AllRegimeEnvironment | null; score: number; reason: string | null };
export type BlockedCandidate = { id: string; eventId: string; strategyId: string; strategyName: string; symbol: string;
  blockedAt: number; side: Side; orientation: StrategyOrientation; environment: AllRegimeEnvironment;
  entryPrice: number; stopPrice: number; targetPrice: number; score: number;
  stage: "EXECUTION" | "AUTHORITY" | "ACCOUNT"; code: string; reason: string };

export type StrategyArenaState = {
  version: 12; startedAt: number; strategies: Record<string, StrategyScore>; playbookResults: Record<string, PlaybookEventResult[]>;
  open: Record<string, ArenaTrade>; portfolioOpen: Record<string, ArenaTrade>; portfolioEquity: number;
  portfolioResolved: number; portfolioWins: number; portfolioGrossPnl: number; portfolioCosts: number;
  portfolioCycle: number; portfolioCycleStartedAt: number; archivedPortfolioCycles: PortfolioCycleArchive[];
  recentShadow: ArenaTrade[]; recentPaper: ArenaTrade[]; recentPortfolio: ArenaTrade[];
  archivedPortfolioTrades: ArenaTrade[];
  transitions: ArenaTransition[]; seenSignals: string[]; admissionRejects: Record<string, number>;
  recentObservations: Array<{ id: string; eventId: string; strategyId: string; strategyName: string; symbol: string; observedAt: number; blocker: string }>;
  blockedCandidates: BlockedCandidate[];
  currentRouteChecks: Record<string, RouteCheck>;
  lastPortfolioCloses: Record<string, { closedAt: number; branch: AllRegimeEnvironment | null; eventId: string }>;
  cutoverPending: boolean;
};

export type ArenaQuote = { midpoint: number; bestBid?: number; bestAsk?: number; observedAt?: number; fresh?: boolean; completedMinuteAt?: number };
export type ArenaObservation = {
  candidate: MarketRegimeCandidate; midpoint: number; bestBid?: number; bestAsk?: number; alignedFlow: number;
  minuteNoiseRate: number; spreadRate: number; range15m: RangeStructure | null;
  confirmationBySide: Record<Side, number>; fakeoutBySide: Record<Side, number>; routes: LiquidityRoute[];
  bidDepthUsd?: number; askDepthUsd?: number; quantoMultiplier?: number; maintenanceRate?: number; leverageMax?: number; now: number;
  dataFresh?: boolean; contractReady?: boolean; managementCapacity?: boolean;
  globalOpportunityRank?: number; globalOpportunityCount?: number;
  completedMinuteAt?: number;
  candleStructure?: ResidentCandleStructure | null;
  globalBreadth?: number; globalMedianMove?: number; globalMarkets?: number;
};

type Signal = { strategyId: string; side: Side; entryTrigger: number; stopPrice: number; targetPrice: number; quality: number; reason: string;
  orientation?: StrategyOrientation; originalTargetPrice?: number; targetAdapted?: boolean; targetEvidenceEvents?: number;
  structureSource: ArenaTradeContext["structureSource"]; maxHoldMs: number; noProgressMs: number; executable: boolean;
  branch: AllRegimeEnvironment };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const baseId = (strategyId: string) => strategyId.split(":")[0];
const regimeGroup = (regime: MarketRegimeKind) => regime === "TREND" || regime === "EXPANSION" ? "DIRECTIONAL" : regime;

function freshStrategy(definition: StrategyDefinition): StrategyScore {
  const offlineApproved = ALL_REGIME_OFFLINE_VALIDATION[definition.id as keyof typeof ALL_REGIME_OFFLINE_VALIDATION].paperApproved;
  return { ...definition, lane: offlineApproved ? "ACTIVE" : "SHADOW", enabled: offlineApproved, shadowResolved: 0, shadowWins: 0, shadowNetReturnRate: 0,
    paperResolved: 0, paperWins: 0, paperNetReturnRate: 0, paperEquity: STRATEGY_INITIAL_EQUITY,
    consecutivePaperLosses: 0, stageResults: [], stageEvents: [], stageSymbols: [], recentResults: [],
    paperResults: [], demotedAt: null, transitions: 0, lastTransitionAt: null,
    lastTransitionReason: offlineApproved ? "30天20市场前后段成本后验证通过，先按冻结方向执行并由新影子结果换挡" : "历史前后段未同时为正，只观察不进入账户",
    reverseEnabled: false, reverseRecentResults: [], reversePaperResults: [], reverseQualificationResults: [], reverseShadowResolved: 0,
    reverseShadowWins: 0, reverseShadowNetReturnRate: 0, reversePaperResolved: 0, reversePaperWins: 0,
    reversePaperNetReturnRate: 0, reverseDemotedAt: null, reverseLastTransitionAt: null,
    reverseLastTransitionReason: "等待正常方向连续3次失败及同期反向影子验证" };
}

export function initialStrategyArena(now = Date.now()): StrategyArenaState {
  return { version: STRATEGY_ARENA_VERSION, startedAt: now,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => [definition.id, freshStrategy(definition)])),
    playbookResults: Object.fromEntries(PLAYBOOKS.map((playbook) => [playbook.id, []])), open: {}, portfolioOpen: {},
    portfolioEquity: STRATEGY_INITIAL_EQUITY, portfolioResolved: 0, portfolioWins: 0, portfolioGrossPnl: 0,
    portfolioCosts: 0, portfolioCycle: 1, portfolioCycleStartedAt: now, archivedPortfolioCycles: [],
    recentShadow: [], recentPaper: [], recentPortfolio: [], archivedPortfolioTrades: [], transitions: [], seenSignals: [], admissionRejects: {},
    recentObservations: [], blockedCandidates: [], currentRouteChecks: {}, lastPortfolioCloses: {}, cutoverPending: false };
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
  const savedVersion = Number((value as { version?: number }).version);
  const migratingIntoV12 = savedVersion === 11;
  if (savedVersion !== STRATEGY_ARENA_VERSION && savedVersion !== 11) {
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
  const normalized = { ...fresh, ...value, version: 12 as const,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => {
      const prior = value.strategies?.[definition.id];
      const baseline = freshStrategy(definition);
      return [definition.id, prior ? { ...baseline, ...prior, ...definition,
        ...(migratingIntoV12 ? { lane: baseline.lane, enabled: baseline.enabled,
          lastTransitionReason: baseline.lastTransitionReason } : {}),
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
    blockedCandidates: (value.blockedCandidates ?? []).slice(-ARENA_HISTORY_LIMIT),
    currentRouteChecks: value.currentRouteChecks ?? {},
    lastPortfolioCloses: value.lastPortfolioCloses ?? {},
    cutoverPending: Boolean(value.cutoverPending) };
  return normalized;
}

function executableEntry(input: ArenaObservation, side: Side) {
  return side === "LONG" ? input.bestAsk ?? input.midpoint : input.bestBid ?? input.midpoint;
}

function signals(input: ArenaObservation): Signal[] {
  if (!input.candidate.id.includes(":CANDLE5M:")) return [];
  if ((input.globalMarkets ?? 0) < 12) return [];
  const breadth = input.globalBreadth ?? 0.5;
  const medianMove = input.globalMedianMove ?? 0;
  const state = classifyMarketState({ trendRate: input.candidate.trendRate,
    trendEfficiency: input.candidate.trendEfficiency, volatilityRatio: input.candidate.volatilityRatio,
    rangePosition: input.candidate.rangePosition, marketBreadth: breadth, marketMedianMove: medianMove });
  if (MARKET_PHASE_AUTHORITY[state.phase] === "WAIT") return [];
  return (input.candidate.allRegimeRoutes ?? []).flatMap((route): Signal[] => {
    const strategyId = route.strategyId;
    const side = route.side;
    const stopPrice = route.invalidationPrice;
    const targetPrice = route.profitArmPrice;
    const maxHoldMinutes = route.maxHoldMinutes;
    const noProgressMinutes = route.noProgressMinutes;
    if (!routeMarketApproved(route, { trendRate: input.candidate.trendRate,
      trendEfficiency: input.candidate.trendEfficiency, volatilityRatio: input.candidate.volatilityRatio,
      rangePosition: input.candidate.rangePosition, marketBreadth: breadth, marketMedianMove: medianMove })) return [];
    const reason = `${route.strategyName}·${state.phase}：${route.reason} 该入场状态格已通过纯加密历史前后段成本后验证。`;
    const sign = side === "LONG" ? 1 : -1;
    const riskRate = Math.abs(route.triggerPrice - stopPrice) / route.triggerPrice;
    const armRate = Math.abs(targetPrice - route.triggerPrice) / route.triggerPrice;
    return [{ strategyId, side, entryTrigger: route.triggerPrice,
      stopPrice: route.triggerPrice * (1 - sign * riskRate), targetPrice: route.triggerPrice * (1 + sign * armRate),
      structureSource: "CANDLE_5M", executable: true, branch: route.environment,
      maxHoldMs: maxHoldMinutes * 60_000, noProgressMs: noProgressMinutes * 60_000,
      quality: clamp(route.score / 100, 0.5, 0.98), reason }];
  });
}

function attainableTarget(state: StrategyArenaState, input: ArenaObservation, signal: Signal, definition: StrategyDefinition): Signal {
  void state; void input; void definition;
  return { ...signal, orientation: "NORMAL", originalTargetPrice: signal.targetPrice,
    targetAdapted: false, targetEvidenceEvents: 0 };
}

function mirroredSignal(input: ArenaObservation, signal: Signal): Signal {
  const normalEntry = executableEntry(input, signal.side);
  const side: Side = signal.side === "LONG" ? "SHORT" : "LONG";
  const entry = executableEntry(input, side);
  const stopRate = Math.abs(normalEntry - signal.stopPrice) / Math.max(normalEntry, 1e-9);
  const armRate = Math.abs(signal.targetPrice - normalEntry) / Math.max(normalEntry, 1e-9);
  const sign = side === "LONG" ? 1 : -1;
  return { ...signal, side, orientation: "REVERSE", entryTrigger: entry,
    stopPrice: entry * (1 - sign * stopRate), targetPrice: entry * (1 + sign * armRate),
    reason: `${signal.reason}；当前为同期镜像影子，不因正常方向失败而自动加仓` };
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
function uniqueEventTrades(trades: ArenaTrade[]) {
  const seen = new Set<string>();
  return trades.filter((trade) => {
    const key = `${tradeOrientation(trade)}:${trade.eventId}:${baseId(trade.strategyId)}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });
}

const tradeOrientation = (trade: Pick<ArenaTrade, "orientation">): StrategyOrientation => trade.orientation ?? "NORMAL";
export function playbookPerformance(state: StrategyArenaState, id: string, currentRegime?: MarketRegimeKind) {
  return evidence(uniqueLifecycleResults(state.playbookResults[id] ?? [])
    .map((row) => ({ netReturnRate: row.netReturnRate, regime: row.regime })), currentRegime);
}
function strategyPerformance(score: StrategyScore, currentRegime?: MarketRegimeKind) {
  return evidence(uniqueResults(score.recentResults), currentRegime);
}
type ShadowAuthorityDecision = { orientation: StrategyOrientation; reason: string; sample: StrategyResult[];
  reverseResults: StrategyResult[] };

function reverseRowsFor(normal: StrategyResult[], score: StrategyScore) {
  const byEvent = new Map(uniqueResults(score.reverseRecentResults).map((row) => [row.eventId, row]));
  return normal.flatMap((row) => byEvent.get(row.eventId) ? [byEvent.get(row.eventId)!] : []);
}

function shadowAuthorityDecision(score: StrategyScore): ShadowAuthorityDecision | null {
  const results = uniqueResults(score.recentResults);
  const latest3 = results.slice(-POLARITY_STREAK);
  const valid3 = latest3.length === POLARITY_STREAK
    && latest3.at(-1)!.resolvedAt - latest3[0].resolvedAt <= POLARITY_MAX_SPAN_MS;
  if (!valid3) return null;
  if (latest3.every((row) => row.netReturnRate > 0)) return { orientation: "NORMAL",
    reason: "最新3个同环境独立事件的正常影子均在完整成本后盈利",
    sample: latest3, reverseResults: reverseRowsFor(latest3, score) };
  const reversed = reverseRowsFor(latest3, score);
  const reverseEvidence = evidence(uniqueResults(score.reverseRecentResults));
  return latest3.every((row) => row.netReturnRate < 0) && reversed.length === latest3.length
    && reversed.every((row) => row.netReturnRate > 0)
    && reverseEvidence.meanReturnRate > 0 && reverseEvidence.profitFactor > 1
    ? { orientation: "REVERSE",
      reason: "最新3个正常影子连续亏损，且同事件的3个镜像影子均在完整成本后盈利",
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
  const decision = shadowAuthorityDecision(score);
  if (!decision && uniqueResults(score.recentResults).length < POLARITY_STREAK) return;
  if (decision?.orientation === "NORMAL") {
    if (score.reverseEnabled) {
      score.reverseEnabled = false; score.reverseLastTransitionAt = now;
      score.reverseLastTransitionReason = "该环境连续胜利选择正常路线；反向不进入账户，双向影子继续";
    }
    if (!score.enabled || score.lane !== "ACTIVE") transition(state, score, "ACTIVE", now, `${decision.reason}；顺极参与下一次新信号`);
    else score.lastTransitionReason = `${decision.reason}；正常路线继续接受新模拟信号`;
    return;
  }
  if (decision?.orientation === "REVERSE") {
    if (score.enabled || score.lane === "ACTIVE") transition(state, score, "SHADOW", now,
      "该环境连续失败选择镜像路线；正常不进入账户，双向影子继续");
    if (!score.reverseEnabled) score.reverseLastTransitionAt = now;
    score.reverseEnabled = true;
    score.reverseLastTransitionReason = `${decision.reason}；逆极参与下一次新信号`;
    return;
  }
  if (score.reverseEnabled) score.reverseLastTransitionReason = "混合结果保持上一次反向状态，等待新的连续胜负切换";
  else if (score.enabled) score.lastTransitionReason = "混合结果保持已验证正向状态，等待新的连续胜负切换";
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
    state.lastPortfolioCloses[trade.symbol] = { closedAt: trade.closedAt ?? trade.openedAt,
      branch: trade.context.allRegimeEnvironment ?? null, eventId: trade.eventId };
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
      refreshShadowAuthority(state, score, trade.closedAt ?? Date.now());
    } else {
      score.recentResults = [...score.recentResults.filter((row) => row.eventId !== result.eventId), result].slice(-24);
      score.shadowResolved += 1; score.shadowWins += Number(won); score.shadowNetReturnRate += value;
      updatePlaybookResult(state, trade);
      refreshShadowAuthority(state, score, trade.closedAt ?? Date.now());
    }
    state.recentShadow.push(trade); if (state.recentShadow.length > ARENA_HISTORY_LIMIT) state.recentShadow.shift();
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
function updateRunnerProtection(trade: ArenaTrade) {
  if (trade.profitArmedAt == null) return;
  const sign = trade.side === "LONG" ? 1 : -1;
  const riskRate = Math.max(Math.abs(trade.entryPrice - trade.stopPrice) / trade.entryPrice, 1e-9);
  const giveback = Math.max(riskRate, trade.maxFavorableRate * 0.45);
  const lockedRate = Math.max(trade.context.modeledCostRate + riskRate * 0.35, trade.maxFavorableRate - giveback);
  const proposed = trade.entryPrice * (1 + sign * lockedRate);
  trade.activeStopPrice = trade.side === "LONG"
    ? Math.max(trade.activeStopPrice ?? trade.stopPrice, proposed)
    : Math.min(trade.activeStopPrice ?? trade.stopPrice, proposed);
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
    const protection = trade.activeStopPrice ?? trade.stopPrice;
    const stopped = trade.side === "LONG" ? price <= protection : price >= protection;
    const targeted = trade.side === "LONG" ? price >= trade.targetPrice : price <= trade.targetPrice;
    const age = now - trade.openedAt;
    const riskRate = Math.max(Math.abs(trade.entryPrice - trade.stopPrice) / trade.entryPrice, 1e-9);
    const softEvidence = current.completedMinuteAt != null && current.completedMinuteAt > trade.openedAt
      && current.completedMinuteAt !== trade.lastSoftEvidenceAt;
    if (softEvidence) trade.lastSoftEvidenceAt = current.completedMinuteAt!;
    const noProgress = trade.profitArmedAt == null && softEvidence && age >= (trade.context.noProgressMs ?? 30 * 60_000)
      && trade.maxFavorableRate < riskRate * 0.35 && move < riskRate * 0.15;
    const timedOut = softEvidence && age >= (trade.context.maxHoldMs ?? 60 * 60_000);
    if (stopped) {
      delete book[id]; recordClosed(state, closeTrade(trade, price,
        trade.profitArmedAt == null ? "STOP" : "RUNNER_EXIT", now));
      continue;
    }
    if (targeted && trade.profitArmedAt == null) trade.profitArmedAt = now;
    updateRunnerProtection(trade);
    if (!noProgress && !timedOut) continue;
    const outcome: ArenaOutcome = noProgress ? "THESIS_INVALID" : "EDGE_DECAY";
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
    const protection = trade.activeStopPrice ?? trade.stopPrice;
    const stopped = trade.side === "LONG" ? input.candle.low <= protection : input.candle.high >= protection;
    const targeted = trade.side === "LONG" ? input.candle.high >= trade.targetPrice : input.candle.low <= trade.targetPrice;
    const age = input.candle.completedAt - trade.openedAt;
    const riskRate = Math.max(Math.abs(trade.entryPrice - trade.stopPrice) / trade.entryPrice, 1e-9);
    const closeMove = sign * (input.candle.close - trade.entryPrice) / trade.entryPrice;
    const noProgress = trade.profitArmedAt == null && age >= (trade.context.noProgressMs ?? 30 * 60_000)
      && trade.maxFavorableRate < riskRate * 0.35 && closeMove < riskRate * 0.15;
    const expired = age >= (trade.context.maxHoldMs ?? 60 * 60_000);
    // If one completed candle contains both the existing protection and profit arm, protection wins.
    if (stopped) {
      delete state.open[id]; recordClosed(state, closeTrade(trade, protection,
        trade.profitArmedAt == null ? "STOP" : "RUNNER_EXIT", input.candle.completedAt));
      continue;
    }
    if (targeted && trade.profitArmedAt == null) trade.profitArmedAt = input.candle.completedAt;
    updateRunnerProtection(trade);
    if (!noProgress && !expired) continue;
    const outcome: ArenaOutcome = noProgress ? "THESIS_INVALID" : "EDGE_DECAY";
    const exitPrice = input.candle.close;
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
    fakeoutRisk: input.fakeoutBySide[signal.side] ?? 1,
    rangeId: input.candidate.allRegimeRoutes?.find((route) => route.strategyId === signal.strategyId)?.structureId
      ?? input.range15m?.id ?? input.candleStructure?.id ?? null,
    spreadRate: input.spreadRate, bidDepthUsd: input.bidDepthUsd ?? 0, askDepthUsd: input.askDepthUsd ?? 0,
    structureSource: signal.structureSource, ...economics,
    empiricalExpectedReturnRate: sample.conservativeReturnRate, empiricalProfitFactor: sample.profitFactor, empiricalEvents: sample.events,
    entryTrigger: signal.entryTrigger, feeSlippageRate: ARENA_FRICTION_RATE, fundingCostRate: 0,
    originalTargetPrice: signal.originalTargetPrice, targetAdapted: signal.targetAdapted,
    targetEvidenceEvents: signal.targetEvidenceEvents,
    maxHoldMs: signal.maxHoldMs, noProgressMs: signal.noProgressMs,
    allRegimeVersion: ALL_REGIME_ENGINE_VERSION, allRegimeEnvironment: signal.branch,
    polarityAtEntry: signal.orientation ?? "NORMAL", polarityEvidence: [], profitArmIsNotExit: true };
}
type TradeSizing = { notional: number; plannedRisk: number; contracts: number; quantoMultiplier: number; leverage: number;
  margin: number; accountEquityAtOpen: number; admissionTier: AdmissionTier | null };
type PortfolioSizingResult = { sizing: TradeSizing | null; blocker: "MEANINGFUL_SIZE" | "SIZING" | null };

function depthAdjustedSizing(input: ArenaObservation, signal: Signal, sizing: TradeSizing) {
  const economics = geometryEconomics(input, signal);
  const contractNotional = economics.entryPrice * sizing.quantoMultiplier;
  const smallerBookSide = Math.min(input.bidDepthUsd ?? 0, input.askDepthUsd ?? 0);
  // The retained book proves that this contract is executable; it must not
  // haircut a small, risk-sized derivatives account to an arbitrary percentage
  // of one transient five-level snapshot.
  if (!(contractNotional > 0) || smallerBookSide + 1e-8 < contractNotional) return null;
  return sizing;
}
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
    lastSoftEvidenceAt: null, activeStopPrice: signal.stopPrice, profitArmedAt: null, attributedStrategyIds, orientation,
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

function portfolioSizing(state: StrategyArenaState, input: ArenaObservation, signal: Signal): PortfolioSizingResult {
  const economics = geometryEconomics(input, signal);
  const sized = sizePaperPosition({ equity: state.portfolioEquity, entry: economics.entryPrice, invalidation: signal.stopPrice,
    feeBps: ARENA_FRICTION_RATE * 10_000, stressSlippageBps: 0, confidence: clamp(0.5 + signal.quality * 0.35, 0.5, 0.85),
    openRisk: openRisk(state), sameDirectionRisk: openRisk(state, signal.side) });
  const multiplier = Math.max(input.quantoMultiplier ?? 1, 1e-12);
  const contractNotional = economics.entryPrice * multiplier;
  const usedNotional = Object.values(state.portfolioOpen).reduce((total, trade) => total + trade.notional, 0);
  const remainingNotional = Math.max(0, state.portfolioEquity * MAX_NOTIONAL_TO_EQUITY - usedNotional);
  let contracts = Math.floor(Math.min(sized.notional, remainingNotional) / Math.max(contractNotional, 1e-12));
  if (contracts < 1) return { sizing: null, blocker: "SIZING" };
  let notional = contracts * contractNotional;
  if (notional + 1e-8 < state.portfolioEquity * MIN_PORTFOLIO_NOTIONAL_TO_EQUITY) {
    return { sizing: null, blocker: "MEANINGFUL_SIZE" };
  }
  let leverage = selectSafeLeverage({ notional, equity: state.portfolioEquity, entry: economics.entryPrice,
    invalidation: signal.stopPrice, maintenanceRate: input.maintenanceRate, leverageMax: input.leverageMax });
  const usedMargin = Object.values(state.portfolioOpen).reduce((total, trade) => total + trade.margin, 0);
  contracts = Math.min(contracts, Math.floor(Math.max(0, state.portfolioEquity * PORTFOLIO_MARGIN_CAP - usedMargin)
    * leverage.leverage / Math.max(contractNotional, 1e-12)));
  if (contracts < 1) return { sizing: null, blocker: "SIZING" };
  notional = contracts * contractNotional;
  if (notional + 1e-8 < state.portfolioEquity * MIN_PORTFOLIO_NOTIONAL_TO_EQUITY) {
    return { sizing: null, blocker: "MEANINGFUL_SIZE" };
  }
  leverage = selectSafeLeverage({ notional, equity: state.portfolioEquity, entry: economics.entryPrice,
    invalidation: signal.stopPrice, maintenanceRate: input.maintenanceRate, leverageMax: input.leverageMax });
  const plannedRisk = notional * (economics.structuralStopRate + ARENA_FRICTION_RATE);
  if (openRisk(state) + plannedRisk > state.portfolioEquity * PORTFOLIO_RISK_CAP + 1e-8
    || openRisk(state, signal.side) + plannedRisk > state.portfolioEquity * CORRELATED_DIRECTION_RISK_CAP + 1e-8
    || usedMargin + leverage.margin > state.portfolioEquity * PORTFOLIO_MARGIN_CAP + 1e-8) {
    return { sizing: null, blocker: "SIZING" };
  }
  return { sizing: { notional, plannedRisk, contracts, quantoMultiplier: multiplier, leverage: leverage.leverage,
    margin: leverage.margin, accountEquityAtOpen: state.portfolioEquity, admissionTier: "NORMAL" }, blocker: null };
}

function portfolioAdmission(state: StrategyArenaState, input: ArenaObservation, signal: Signal, score: StrategyScore) {
  const economics = geometryEconomics(input, signal);
  const source = signal.orientation === "REVERSE" ? score.reverseRecentResults : score.recentResults;
  const streak = uniqueResults(source).slice(-POLARITY_STREAK);
  const sample = evidence(streak.map((row) => ({ netReturnRate: row.netReturnRate, regime: row.regime })), input.candidate.regime);
  const lastClose = state.lastPortfolioCloses[input.candidate.symbol];
  const inSameBranchCooldown = lastClose && lastClose.branch === signal.branch
    && input.now - lastClose.closedAt < SAME_STRATEGY_SYMBOL_COOLDOWN_MS;
  const economicGeometry = economics.netRewardRisk >= MIN_NET_REWARD_RISK && economics.costShare <= ARENA_MAX_COST_SHARE;
  const validStructure = signal.side === "LONG" ? economics.entryPrice > signal.stopPrice && economics.entryPrice < signal.targetPrice
    : economics.entryPrice < signal.stopPrice && economics.entryPrice > signal.targetPrice;
  const blocker = input.dataFresh === false ? "STALE" : input.contractReady === false ? "CONTRACT"
    : input.managementCapacity === false ? "DATA_CAPACITY" : !validStructure ? "STRUCTURE" : input.candidate.volume24hUsd < ARENA_MIN_VOLUME_24H_USD ? "LIQUIDITY"
    : input.spreadRate > ARENA_MAX_SPREAD_RATE ? "SPREAD" : !economicGeometry ? "NET_ECONOMICS"
      : inSameBranchCooldown ? "SYMBOL_COOLDOWN"
        : null;
  if (blocker) { state.admissionRejects[blocker] = (state.admissionRejects[blocker] ?? 0) + 1;
    return { admission: null, blocker }; }
  const accountSizing = portfolioSizing(state, input, signal);
  if (!accountSizing.sizing) { const sizingBlocker = accountSizing.blocker ?? "SIZING";
    state.admissionRejects[sizingBlocker] = (state.admissionRejects[sizingBlocker] ?? 0) + 1;
    return { admission: null, blocker: sizingBlocker }; }
  const sizing = depthAdjustedSizing(input, signal, accountSizing.sizing);
  if (!sizing) {
    state.admissionRejects.DEPTH = (state.admissionRejects.DEPTH ?? 0) + 1;
    return { admission: null, blocker: "DEPTH" };
  }
  return { admission: { tier: "NORMAL" as const, sample, sizing }, blocker: null };
}

const admissionBlockerText = (blocker: string) => ({
  STALE: "盘口或关键周期数据不新鲜", CONTRACT: "Gate合约信息不完整", DATA_CAPACITY: "持仓保护市场尚未全部具备新鲜盘口",
  STRUCTURE: "进场、止损和盈利臂的方向关系无效", LIQUIDITY: "24小时成交额低于账户执行下限",
  SPREAD: "真实买一卖一价差超过成本上限", NET_ECONOMICS: "扣除手续费与滑点后的盈亏结构不足",
  SYMBOL_COOLDOWN: "同币同分支刚完成交易，正在避免重复追单", SIZING: "Gate整数张数或账户风险额度不足",
  MEANINGFUL_SIZE: "结构止损过宽或剩余额度不足，按风险计算的名义价值低于账户权益1倍",
  DEPTH: "盘口容量连一张Gate合约都无法承载",
}[blocker] ?? blocker);

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
  const sizing = { notional, plannedRisk: notional * (economics.structuralStopRate + ARENA_FRICTION_RATE), contracts,
    quantoMultiplier: multiplier, leverage: leverage.leverage, margin: leverage.margin,
    accountEquityAtOpen: STRATEGY_INITIAL_EQUITY, admissionTier: null } satisfies TradeSizing;
  return depthAdjustedSizing(input, signal, sizing);
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
                  : !sizing ? "盘口容量连一张Gate合约都无法承载" : null;
}

export function applyStrategySleepStates(state: StrategyArenaState, _availableChannels: Set<CandidateChannel>, now: number) {
  for (const score of Object.values(state.strategies)) refreshShadowAuthority(state, score, now);
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
  const setRouteCheck = (definition: StrategyDefinition, signal: Signal | null, status: RouteCheck["status"], blocker: string | null) => {
    const key = `${input.observation.candidate.symbol}:${definition.id}`;
    state.currentRouteChecks[key] = { id: key, eventId: input.observation.candidate.id, strategyId: definition.id,
      strategyName: definition.name, symbol: input.observation.candidate.symbol, observedAt: input.observation.now,
      status, blocker, side: signal?.side ?? null, environment: signal?.branch ?? null,
      score: signal ? Math.round(signal.quality * 100) : input.observation.candidate.score,
      reason: signal?.reason ?? null };
  };
  const recordObservation = (definition: StrategyDefinition, blocker: string) => {
    const id = `observation:${definition.id}:${input.observation.candidate.id}`;
    const prior = state.recentObservations.find((row) => row.id === id);
    if (prior) { prior.blocker = blocker; prior.observedAt = input.observation.now; return; }
    state.recentObservations.push({ id, eventId: input.observation.candidate.id,
      strategyId: definition.id, strategyName: definition.name, symbol: input.observation.candidate.symbol,
      observedAt: input.observation.now, blocker });
    state.recentObservations = state.recentObservations.slice(-ARENA_HISTORY_LIMIT);
  };
  const recordBlockedCandidate = (definition: StrategyDefinition, signal: Signal,
    stage: BlockedCandidate["stage"], code: string, reason: string) => {
    const orientation = signal.orientation ?? "NORMAL";
    const id = `blocked:${definition.id}:${orientation}:${input.observation.candidate.id}`;
    const candidate: BlockedCandidate = { id, eventId: input.observation.candidate.id,
      strategyId: definition.id, strategyName: definition.name, symbol: input.observation.candidate.symbol,
      blockedAt: input.observation.now, side: signal.side, orientation, environment: signal.branch,
      entryPrice: executableEntry(input.observation, signal.side), stopPrice: signal.stopPrice,
      targetPrice: signal.targetPrice, score: Math.round(signal.quality * 100), stage, code, reason };
    const prior = state.blockedCandidates.findIndex((row) => row.id === id);
    if (prior >= 0) state.blockedCandidates[prior] = candidate;
    else state.blockedCandidates.push(candidate);
    state.blockedCandidates = state.blockedCandidates.slice(-ARENA_HISTORY_LIMIT);
  };
  for (const definition of STRATEGY_CATALOG.filter((row) => row.channel === input.observation.candidate.channel)) {
    if (!generatedSignals.some((signal) => signal.strategyId === definition.id)) {
      setRouteCheck(definition, null, "FORMING", "当前完整5分钟路径尚未形成获准执行的进场结构");
      recordObservation(definition, "当前环境内尚未形成完整且可执行的触发路线");
    }
  }
  const executable: Array<{ signal: Signal; definition: StrategyDefinition; score: StrategyScore; sizing: TradeSizing }> = [];
  for (const normalSignal of generatedSignals) {
    const score = state.strategies[normalSignal.strategyId]; const definition = STRATEGY_CATALOG.find((row) => row.id === normalSignal.strategyId);
    if (!score || !definition) continue;
    setRouteCheck(definition, normalSignal, "CHECKING", "路线已形成，正在核对实时盘口、成本和账户容量");
    const portfolioTrade = state.portfolioOpen[input.observation.candidate.symbol];
    if (portfolioTrade?.eventId === input.observation.candidate.id && portfolioTrade.strategyId === normalSignal.strategyId) {
      setRouteCheck(definition, { ...normalSignal, side: portfolioTrade.side, reason: portfolioTrade.reason }, "OPEN", "模拟账户已成交并进入实时保护");
      continue;
    }
    const overlappingVariantTrade = Object.values(state.open).find((trade) => trade.lane === "EFFECTIVE_SHADOW"
      && tradeOrientation(trade) === "NORMAL" && trade.symbol === input.observation.candidate.symbol
      && trade.strategyId === normalSignal.strategyId);
    if (overlappingVariantTrade) {
      setRouteCheck(definition, normalSignal, "BLOCKED", "同币同策略的上一条路线仍在完整生命周期内");
      recordObservation(definition, "同币种的同环境路线仍在完整生命周期内，本次不重复建立影子");
      if (score.enabled) recordBlockedCandidate(definition, normalSignal, "ACCOUNT", "DUPLICATE_LIFECYCLE",
        "同币同策略的上一条路线仍在完整生命周期内");
      continue;
    }
    for (const signal of [normalSignal, mirroredSignal(input.observation, normalSignal)]) {
      const orientation = signal.orientation ?? "NORMAL";
      const effectiveEventKey = `effective:${orientation.toLowerCase()}:${signal.strategyId}:${input.observation.candidate.id}`;
      const openKey = `${signal.strategyId}:${orientation}:${input.observation.candidate.symbol}`;
      const eventAlreadyExecuted = state.seenSignals.includes(effectiveEventKey)
        || Object.values(state.open).some((trade) => tradeOrientation(trade) === orientation
          && trade.eventId === input.observation.candidate.id && trade.strategyId === signal.strategyId)
        || state.recentShadow.some((trade) => tradeOrientation(trade) === orientation
          && trade.eventId === input.observation.candidate.id && trade.strategyId === signal.strategyId);
      if (eventAlreadyExecuted || state.open[openKey] || Object.keys(state.open).length >= ARENA_MAX_OPEN) {
        const reason = eventAlreadyExecuted ? "本完成段已经执行过，不重复追单" : state.open[openKey]
          ? "同币同策略路线仍在完整生命周期内" : "影子生命周期容量已满";
        if (orientation === "NORMAL") setRouteCheck(definition, signal, "BLOCKED", reason);
        if ((orientation === "NORMAL" && score.enabled) || (orientation === "REVERSE" && score.reverseEnabled)) {
          recordBlockedCandidate(definition, signal, "ACCOUNT", eventAlreadyExecuted ? "EVENT_ALREADY_HANDLED"
            : state.open[openKey] ? "DUPLICATE_LIFECYCLE" : "SHADOW_CAPACITY", reason);
        }
        continue;
      }
      const virtual = effectiveShadowSizing(input.observation, signal);
      const blocker = effectiveShadowBlocker(input.observation, signal, virtual);
      if (blocker || !virtual) {
        if (orientation === "NORMAL") setRouteCheck(definition, signal, "BLOCKED", blocker ?? "当前路线不能真实执行");
        recordObservation(definition, blocker ?? "当前环境路线不能真实执行");
        if ((orientation === "NORMAL" && score.enabled) || (orientation === "REVERSE" && score.reverseEnabled)) {
          recordBlockedCandidate(definition, signal, "EXECUTION", "EXECUTION_CHECK", blocker ?? "当前路线不能真实执行");
        }
        continue;
      }
      executable.push({ signal, definition, score, sizing: virtual });
    }
  }
  type OpenedShadow = typeof executable[number] & { orientation: StrategyOrientation; shadow: ArenaTrade };
  const opened: OpenedShadow[] = [];
  for (const row of executable) {
    if (Object.keys(state.open).length >= ARENA_MAX_OPEN) break;
    const orientation = row.signal.orientation ?? "NORMAL";
    const openKey = `${row.signal.strategyId}:${orientation}:${input.observation.candidate.symbol}`;
    const shadow = openTrade(input.observation, row.definition, row.signal, "EFFECTIVE_SHADOW", row.sizing, false);
    state.open[openKey] = shadow;
    state.seenSignals.push(`effective:${orientation.toLowerCase()}:${row.signal.strategyId}:${input.observation.candidate.id}`);
    opened.push({ ...row, orientation, shadow });
    if (orientation === "NORMAL") setRouteCheck(row.definition, row.signal, "CHECKING", "盘口与成本检查已通过，正在核对账户准入");
  }
  while (state.seenSignals.length > 2_000) state.seenSignals.shift();
  const symbol = input.observation.candidate.symbol;
  const portfolioSeenKey = `portfolio:${input.observation.candidate.id}`;
  const active = opened.filter((row) => row.orientation === "NORMAL" ? row.score.enabled : row.score.reverseEnabled);
  if (active.length && !state.portfolioOpen[symbol] && !state.seenSignals.includes(portfolioSeenKey)) {
    const assessed = active.map((row) => ({ ...row,
      decision: portfolioAdmission(state, input.observation, row.signal, row.score) }));
    const candidates = assessed.filter((row) => row.decision.admission)
      .sort((a, b) => b.decision.admission!.sample.conservativeReturnRate - a.decision.admission!.sample.conservativeReturnRate
        || b.decision.admission!.sample.profitFactor - a.decision.admission!.sample.profitFactor || b.signal.quality - a.signal.quality);
    const winner = candidates[0];
    if (winner?.decision.admission) {
      const polarity = winner.orientation === "REVERSE" ? winner.score.reverseRecentResults : winner.score.recentResults;
      winner.shadow.context.polarityEvidence = uniqueResults(polarity).slice(-POLARITY_STREAK)
        .map((row) => row.netReturnRate);
      state.portfolioOpen[symbol] = cloneShadowForPortfolio(winner.shadow, winner.decision.admission.sizing, winner.decision.admission.sample);
      state.seenSignals.push(portfolioSeenKey);
      setRouteCheck(winner.definition, winner.signal, "OPEN", "模拟账户已成交并进入实时保护");
      for (const row of assessed.filter((item) => item !== winner)) {
        const reason = `同币同完成段由${winner.definition.name}的账户优先级接管`;
        setRouteCheck(row.definition, row.signal, "BLOCKED", reason);
        recordBlockedCandidate(row.definition, row.signal, "ACCOUNT", "ACCOUNT_PRIORITY", reason);
      }
    } else {
      for (const row of assessed.filter((item) => item.decision.blocker)) {
        const blocker = admissionBlockerText(row.decision.blocker!);
        setRouteCheck(row.definition, row.signal, "BLOCKED", blocker);
        recordObservation(row.definition, `已形成${row.signal.side === "LONG" ? "做多" : "做空"}路线；最终阻塞：${blocker}`);
        recordBlockedCandidate(row.definition, row.signal, "ACCOUNT", row.decision.blocker!, blocker);
      }
    }
  } else if (opened.length && !active.length) {
    setRouteCheck(opened[0].definition, opened[0].signal, "BLOCKED", "策略方向尚未获得当前连续胜负状态授权");
    recordObservation(opened[0].definition, "双向影子继续运行；尚未形成连续3胜的顺极或连续3败且镜像全胜的逆极");
    recordBlockedCandidate(opened[0].definition, opened[0].signal, "AUTHORITY", "POLARITY_NOT_AUTHORIZED",
      "路线已通过执行检查，但策略方向尚未获得当前连续胜负状态授权");
  } else if (opened.length && state.portfolioOpen[symbol]) {
    setRouteCheck(opened[0].definition, opened[0].signal, "BLOCKED", "该币已有账户持仓，当前路线仅继续影子观察");
  } else if (opened.length && state.seenSignals.includes(portfolioSeenKey)) {
    setRouteCheck(opened[0].definition, opened[0].signal, "BLOCKED", "本完成段已经完成账户准入判断，不重复追单");
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
    blockedCandidates: state.blockedCandidates.slice(-100).reverse(),
    portfolioOpen: Object.values(state.portfolioOpen).sort((a, b) => b.openedAt - a.openedAt),
    portfolioEquity: state.portfolioEquity, portfolioResolved: state.portfolioResolved, portfolioWins: state.portfolioWins,
    portfolioGrossPnl: state.portfolioGrossPnl, portfolioCosts: state.portfolioCosts, strategies: strategySummaries,
    playbooks: PLAYBOOKS.map((row) => ({ ...row, evidence: playbookPerformance(state, row.id) })),
    offlineValidation: ALL_REGIME_OFFLINE_VALIDATION,
    recentShadow: uniqueEventTrades(state.recentShadow.slice(-100).reverse()), recentPaper: state.recentPaper.slice(-100).reverse(),
    recentPortfolio: state.recentPortfolio.slice(-100).reverse(), archivedPortfolioTrades: state.archivedPortfolioTrades.slice(-100).reverse(),
    transitions: state.transitions.slice(-100).reverse(),
    admissionRejects: state.admissionRejects,
    currentRouteChecks: Object.values(state.currentRouteChecks).sort((left, right) => right.observedAt - left.observedAt).slice(0, 30),
    cutoverPending: state.cutoverPending,
    rules: { extremeSequenceAuthority: false, strategyName: ALL_REGIME_SYSTEM_NAME,
      generatedRouteAuthority: false, legacyStrategyAuthority: false, paperCycleResetOnCutover: false,
      frictionFloorRate: ARENA_FRICTION_RATE, minNetRewardRisk: MIN_NET_REWARD_RISK,
      maxCostShare: ARENA_MAX_COST_SHARE, singleTradeRiskMin: 0.01, singleTradeRiskMax: 0.02,
      portfolioRiskCap: PORTFOLIO_RISK_CAP, correlatedRiskCap: CORRELATED_DIRECTION_RISK_CAP,
      marginCap: PORTFOLIO_MARGIN_CAP, maxNotionalMultiple: MAX_NOTIONAL_TO_EQUITY, realtimeCapacity: PORTFOLIO_REALTIME_CAPACITY,
      maxPortfolioPositions: MAX_PORTFOLIO_POSITIONS,
      minimumPortfolioRiskUsdt: 0, targetPortfolioRiskUsdt: PORTFOLIO_TRADE_RISK_TARGET_USDT,
      empiricalCostFloorRate: ARENA_FRICTION_RATE,
      authorityWindowPriority: "STATE_CONDITIONED_EXPECTANCY", paperEvaluation: true,
      exactShadowClone: true, normalShadowAlwaysOn: true, reverseShadowAlwaysOn: true,
      streakLength: POLARITY_STREAK, streakMaxSpanMs: POLARITY_MAX_SPAN_MS,
      sameBranchSymbolCooldownMs: SAME_STRATEGY_SYMBOL_COOLDOWN_MS,
      profitArmIsExit: false, dailyObjectiveRate: 0.10, dailyObjectiveIsQuota: false } };
}
