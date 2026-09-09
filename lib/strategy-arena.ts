import type { LiquidityRoute, RangeStructure, Side } from "./liquidity-core.ts";
import type { CandidateChannel, MarketRegimeCandidate, MarketRegimeKind } from "./market-regime.ts";

export const STRATEGY_ARENA_VERSION = 2;
export const STRATEGY_INITIAL_EQUITY = 1_000;
export const TRIAL_PROMOTION_WINS = 1;
export const VERIFIED_PAPER_EVENTS = 12;
export const VERIFIED_PAPER_SYMBOLS = 4;
export const VERIFIED_PROFIT_FACTOR = 1.1;
export const PAPER_DEMOTION_LOSSES = 2;
export const ARENA_MAX_HOLD_MS = 45 * 60_000;
export const ARENA_FRICTION_RATE = 0.0018;
export const PORTFOLIO_MAX_OPEN = 3;
export const ARENA_MAX_OPEN = 240;
export const ARENA_HISTORY_LIMIT = 240;

export type StrategyLane = "SHADOW" | "TRIAL" | "VERIFIED";
export type TradeLane = StrategyLane | "PORTFOLIO";
export type StrategyFamily = "TREND" | "RANGE" | "COMPRESSION" | "EVENT";
export type EntryStyle = "CONFIRM" | "RETEST";
export type ExitProfile = "FAST" | "STRUCTURE";
export type ArenaOutcome = "TARGET" | "STOP" | "TIMEOUT";

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
  volume24hUsd: number; fundingRate: number;
  alignedFlow: number; confirmation: number; fakeoutRisk: number; rangeId: string | null; modeledCostRate: number;
};

export type ArenaTrade = {
  id: string; strategyId: string; strategyName: string; family: StrategyFamily; lane: TradeLane; eventId: string;
  symbol: string; side: Side; status: "OPEN" | "CLOSED"; openedAt: number; closedAt: number | null;
  entryPrice: number; stopPrice: number; targetPrice: number; exitPrice: number | null; outcome: ArenaOutcome | null;
  grossReturnRate: number | null; netReturnRate: number | null; netPnl: number | null; notional: number;
  maxFavorableRate: number; maxAdverseRate: number; lastPrice: number; selectedForPortfolio: boolean;
  reason: string; context: ArenaTradeContext;
};

export type StrategyScore = StrategyDefinition & {
  lane: StrategyLane; shadowResolved: number; shadowWins: number; shadowNetReturnRate: number;
  paperResolved: number; paperWins: number; paperNetReturnRate: number; paperEquity: number;
  consecutivePaperLosses: number; stageResults: number[]; stageEvents: string[]; stageSymbols: string[];
  transitions: number; lastTransitionAt: number | null;
};

export type ArenaTransition = { id: string; strategyId: string; strategyName: string; from: StrategyLane; to: StrategyLane; at: number; reason: string };

export type StrategyArenaState = {
  version: 2; startedAt: number; strategies: Record<string, StrategyScore>; open: Record<string, ArenaTrade>;
  portfolioOpen: Record<string, ArenaTrade>; portfolioEquity: number; recentShadow: ArenaTrade[];
  recentPaper: ArenaTrade[]; recentPortfolio: ArenaTrade[]; transitions: ArenaTransition[]; seenSignals: string[];
};

export type ArenaObservation = {
  candidate: MarketRegimeCandidate; midpoint: number; alignedFlow: number; minuteNoiseRate: number; spreadRate: number;
  range15m: RangeStructure | null; confirmationBySide: Record<Side, number>; fakeoutBySide: Record<Side, number>;
  routes: LiquidityRoute[]; now: number;
};

type Signal = { strategyId: string; side: Side; targetRate: number; stopRate: number; quality: number; reason: string };
const opposite = (side: Side): Side => side === "LONG" ? "SHORT" : "LONG";
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function initialStrategyArena(now = Date.now()): StrategyArenaState {
  return {
    version: STRATEGY_ARENA_VERSION, startedAt: now,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => [definition.id, {
      ...definition, lane: "SHADOW" as const, shadowResolved: 0, shadowWins: 0, shadowNetReturnRate: 0,
      paperResolved: 0, paperWins: 0, paperNetReturnRate: 0, paperEquity: STRATEGY_INITIAL_EQUITY,
      consecutivePaperLosses: 0, stageResults: [], stageEvents: [], stageSymbols: [], transitions: 0, lastTransitionAt: null,
    }])),
    open: {}, portfolioOpen: {}, portfolioEquity: STRATEGY_INITIAL_EQUITY,
    recentShadow: [], recentPaper: [], recentPortfolio: [], transitions: [], seenSignals: [],
  };
}

export function normalizeStrategyArena(value: StrategyArenaState | null | undefined, now = Date.now()): StrategyArenaState {
  const fresh = initialStrategyArena(now);
  if (!value || value.version !== STRATEGY_ARENA_VERSION) return fresh;
  return {
    ...fresh, ...value,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => {
      const prior = value.strategies?.[definition.id];
      return [definition.id, prior ? { ...fresh.strategies[definition.id], ...prior, ...definition } : fresh.strategies[definition.id]];
    })),
    portfolioOpen: value.portfolioOpen ?? {},
    open: Object.fromEntries(Object.entries(value.open ?? {}).slice(-ARENA_MAX_OPEN)),
    recentShadow: (value.recentShadow ?? []).slice(-ARENA_HISTORY_LIMIT), recentPaper: (value.recentPaper ?? []).slice(-ARENA_HISTORY_LIMIT),
    recentPortfolio: (value.recentPortfolio ?? []).slice(-ARENA_HISTORY_LIMIT), transitions: (value.transitions ?? []).slice(-200),
    seenSignals: (value.seenSignals ?? []).slice(-2_000),
  };
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
  const add = (playbookId: string, side: Side, reason: string, quality: number, retestReady = false) =>
    output.push({ playbookId, side, reason, quality: clamp(quality, 0, 1), retestReady });
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

function signalGeometry(input: ArenaObservation, definition: StrategyDefinition, side: Side) {
  const noise = clamp(input.minuteNoiseRate, 0.0018, 0.006);
  const cost = Math.max(ARENA_FRICTION_RATE, 0.001 + input.spreadRate * 2);
  const stopRate = definition.exitProfile === "FAST" ? clamp(noise * 0.82, 0.0022, 0.0042) : clamp(noise * 1.08, 0.0028, 0.0062);
  const targetRate = definition.exitProfile === "FAST" ? Math.max(cost * 2.4, stopRate * 1.35) : Math.max(cost * 3.25, stopRate * 1.8);
  return { stopRate, targetRate, confirmation: input.confirmationBySide[side] ?? 0, fakeout: input.fakeoutBySide[side] ?? 1 };
}

function signals(input: ArenaObservation): Signal[] {
  const output: Signal[] = [];
  for (const base of basePlaybooks(input)) {
    for (const definition of STRATEGY_CATALOG.filter((item) => item.id.startsWith(`${base.playbookId}:`))) {
      const geometry = signalGeometry(input, definition, base.side);
      const sideFlow = base.side === input.candidate.side ? input.alignedFlow : -input.alignedFlow;
      const entryReady = definition.entryStyle === "CONFIRM" ? geometry.confirmation >= 0.48 || sideFlow >= 0.12
        : base.retestReady || input.routes.some((route) => route.side === base.side && ["BREAKOUT_RETEST", "EDGE_REJECTION", "FAILED_BREAKOUT_REVERSAL"].includes(route.kind));
      if (!entryReady || geometry.fakeout > 0.82 && !base.playbookId.includes("failed") && !base.playbookId.includes("fade")) continue;
      output.push({ strategyId: definition.id, side: base.side, targetRate: geometry.targetRate, stopRate: geometry.stopRate,
        quality: clamp(base.quality * 0.6 + geometry.confirmation * 0.25 + Math.max(0, sideFlow) * 0.15, 0, 1), reason: base.reason });
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

function recordClosed(state: StrategyArenaState, trade: ArenaTrade) {
  const value = trade.netReturnRate ?? 0;
  const won = value > 0;
  if (trade.lane === "PORTFOLIO") {
    state.portfolioEquity = Math.max(0.01, state.portfolioEquity + (trade.netPnl ?? 0));
    state.recentPortfolio.push(trade);
    if (state.recentPortfolio.length > ARENA_HISTORY_LIMIT) state.recentPortfolio.shift();
    return;
  }
  const score = state.strategies[trade.strategyId];
  if (!score) return;
  if (trade.lane === "SHADOW") {
    score.shadowResolved += 1; score.shadowWins += Number(won); score.shadowNetReturnRate += value;
    state.recentShadow.push(trade);
    if (state.recentShadow.length > ARENA_HISTORY_LIMIT) state.recentShadow.shift();
    if (won) transition(state, score, "TRIAL", trade.closedAt ?? Date.now(), "首笔成本后盈利影子结果，进入试用模拟");
    return;
  }
  score.paperResolved += 1; score.paperWins += Number(won); score.paperNetReturnRate += value;
  score.paperEquity = Math.max(0.01, score.paperEquity + (trade.netPnl ?? 0));
  score.consecutivePaperLosses = won ? 0 : score.consecutivePaperLosses + 1;
  score.stageResults = [...score.stageResults, value].slice(-24);
  score.stageEvents = [...new Set([...score.stageEvents, trade.eventId])].slice(-24);
  score.stageSymbols = [...new Set([...score.stageSymbols, trade.symbol])].slice(-12);
  state.recentPaper.push(trade);
  if (state.recentPaper.length > ARENA_HISTORY_LIMIT) state.recentPaper.shift();
  if (score.consecutivePaperLosses >= PAPER_DEMOTION_LOSSES) {
    transition(state, score, "SHADOW", trade.closedAt ?? Date.now(), "试用/稳定模拟连续亏损2笔");
  } else if (score.lane === "TRIAL" && score.stageEvents.length >= VERIFIED_PAPER_EVENTS
    && score.stageSymbols.length >= VERIFIED_PAPER_SYMBOLS && sum(score.stageResults) > 0
    && profitFactor(score.stageResults) >= VERIFIED_PROFIT_FACTOR) {
    transition(state, score, "VERIFIED", trade.closedAt ?? Date.now(), `覆盖${score.stageEvents.length}个独立事件和${score.stageSymbols.length}个币，成本后质量达标`);
  }
}

function progressTrade(trade: ArenaTrade, price: number) {
  const direction = trade.side === "LONG" ? 1 : -1;
  const move = direction * (price - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9);
  trade.lastPrice = price; trade.maxFavorableRate = Math.max(trade.maxFavorableRate, move); trade.maxAdverseRate = Math.min(trade.maxAdverseRate, move);
}

function closeTrade(trade: ArenaTrade, exitPrice: number, outcome: ArenaOutcome, now: number) {
  const direction = trade.side === "LONG" ? 1 : -1;
  const grossReturnRate = direction * (exitPrice - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9);
  const netReturnRate = grossReturnRate - trade.context.modeledCostRate;
  return { ...trade, status: "CLOSED" as const, closedAt: now, exitPrice, outcome, grossReturnRate, netReturnRate,
    netPnl: trade.notional * netReturnRate, lastPrice: exitPrice };
}

function advanceBook(state: StrategyArenaState, book: Record<string, ArenaTrade>, quotes: Record<string, number>, now: number) {
  for (const [id, trade] of Object.entries(book)) {
    const price = quotes[trade.symbol];
    if (!Number.isFinite(price) || price <= 0) continue;
    progressTrade(trade, price);
    const stopped = trade.side === "LONG" ? price <= trade.stopPrice : price >= trade.stopPrice;
    const targeted = trade.side === "LONG" ? price >= trade.targetPrice : price <= trade.targetPrice;
    const timedOut = now - trade.openedAt >= ARENA_MAX_HOLD_MS;
    if (!stopped && !targeted && !timedOut) continue;
    const outcome: ArenaOutcome = stopped ? "STOP" : targeted ? "TARGET" : "TIMEOUT";
    const exitPrice = stopped ? trade.stopPrice : targeted ? trade.targetPrice : price;
    const closed = closeTrade(trade, exitPrice, outcome, now);
    delete book[id]; recordClosed(state, closed);
  }
}

export function advanceStrategyArena(input: { state: StrategyArenaState; quotes: Record<string, number>; now: number }) {
  const state = normalizeStrategyArena(input.state, input.now);
  advanceBook(state, state.open, input.quotes, input.now); advanceBook(state, state.portfolioOpen, input.quotes, input.now);
  return state;
}

function tradeContext(input: ArenaObservation, definition: StrategyDefinition, side: Side): ArenaTradeContext {
  const sideFlow = side === input.candidate.side ? input.alignedFlow : -input.alignedFlow;
  return {
    channel: input.candidate.channel, regime: input.candidate.regime, anomalyKind: input.candidate.anomalyKind,
    entryStyle: definition.entryStyle, exitProfile: definition.exitProfile, candidateScore: input.candidate.score,
    trendRate: input.candidate.trendRate, trendEfficiency: input.candidate.trendEfficiency,
    volatilityRatio: input.candidate.volatilityRatio, rangePosition: input.candidate.rangePosition,
    openInterestChangeRate: input.candidate.openInterestChangeRate, volume24hUsd: input.candidate.volume24hUsd,
    fundingRate: input.candidate.fundingRate, alignedFlow: sideFlow,
    confirmation: input.confirmationBySide[side] ?? 0, fakeoutRisk: input.fakeoutBySide[side] ?? 1,
    rangeId: input.range15m?.id ?? null, modeledCostRate: Math.max(ARENA_FRICTION_RATE, 0.001 + input.spreadRate * 2),
  };
}

function openTrade(input: ArenaObservation, definition: StrategyDefinition, signal: Signal, lane: TradeLane, notional: number, selectedForPortfolio: boolean) {
  const direction = signal.side === "LONG" ? 1 : -1;
  return {
    id: `${lane}:${definition.id}:${input.candidate.id}:${input.now}`, strategyId: definition.id, strategyName: definition.name,
    family: definition.family, lane, eventId: input.candidate.id, symbol: input.candidate.symbol, side: signal.side,
    status: "OPEN" as const, openedAt: input.now, closedAt: null, entryPrice: input.midpoint,
    stopPrice: input.midpoint * (1 - direction * signal.stopRate), targetPrice: input.midpoint * (1 + direction * signal.targetRate),
    exitPrice: null, outcome: null, grossReturnRate: null, netReturnRate: null, netPnl: null, notional,
    maxFavorableRate: 0, maxAdverseRate: 0, lastPrice: input.midpoint, selectedForPortfolio,
    reason: signal.reason, context: tradeContext(input, definition, signal.side),
  } satisfies ArenaTrade;
}

export function observeStrategyArena(input: { state: StrategyArenaState; observation: ArenaObservation }) {
  const state = advanceStrategyArena({ state: input.state, quotes: { [input.observation.candidate.symbol]: input.observation.midpoint }, now: input.observation.now });
  const openedSimulation: Array<{ signal: Signal; definition: StrategyDefinition; score: StrategyScore }> = [];
  for (const signal of signals(input.observation)) {
    const score = state.strategies[signal.strategyId];
    const definition = STRATEGY_CATALOG.find((item) => item.id === signal.strategyId);
    if (!score || !definition) continue;
    const signalKey = `${signal.strategyId}:${input.observation.candidate.id}`;
    const openKey = `${signal.strategyId}:${input.observation.candidate.symbol}`;
    if (state.seenSignals.includes(signalKey) || state.open[openKey] || Object.keys(state.open).length >= ARENA_MAX_OPEN) continue;
    state.open[openKey] = openTrade(input.observation, definition, signal, score.lane, STRATEGY_INITIAL_EQUITY, false);
    state.seenSignals.push(signalKey);
    if (state.seenSignals.length > 2_000) state.seenSignals.shift();
    if (score.lane !== "SHADOW") openedSimulation.push({ signal, definition, score });
  }
  const symbol = input.observation.candidate.symbol;
  const portfolioSeenKey = `portfolio:${input.observation.candidate.id}`;
  if (openedSimulation.length && !state.portfolioOpen[symbol] && Object.keys(state.portfolioOpen).length < PORTFOLIO_MAX_OPEN
    && !state.seenSignals.includes(portfolioSeenKey)) {
    const winner = openedSimulation.sort((left, right) => Number(right.score.lane === "VERIFIED") - Number(left.score.lane === "VERIFIED")
      || right.score.paperNetReturnRate - left.score.paperNetReturnRate || right.signal.quality - left.signal.quality)[0];
    state.portfolioOpen[symbol] = openTrade(input.observation, winner.definition, winner.signal, "PORTFOLIO", Math.max(1, state.portfolioEquity * 0.3), true);
    state.seenSignals.push(portfolioSeenKey);
  }
  return state;
}

export function arenaSummary(state: StrategyArenaState) {
  const strategies = Object.values(state.strategies).sort((left, right) => {
    const rank = (lane: StrategyLane) => lane === "VERIFIED" ? 2 : lane === "TRIAL" ? 1 : 0;
    return rank(right.lane) - rank(left.lane) || right.paperNetReturnRate - left.paperNetReturnRate || right.shadowNetReturnRate - left.shadowNetReturnRate;
  });
  const open = Object.values(state.open).sort((left, right) => right.openedAt - left.openedAt);
  return {
    version: state.version, startedAt: state.startedAt, catalogSize: STRATEGY_CATALOG.length, playbookCount: PLAYBOOKS.length,
    shadowCount: strategies.filter((strategy) => strategy.lane === "SHADOW").length,
    trialCount: strategies.filter((strategy) => strategy.lane === "TRIAL").length,
    verifiedCount: strategies.filter((strategy) => strategy.lane === "VERIFIED").length,
    paperCount: strategies.filter((strategy) => strategy.lane !== "SHADOW").length,
    openShadow: open.filter((trade) => trade.lane === "SHADOW"), openPaper: open.filter((trade) => trade.lane !== "SHADOW"),
    portfolioOpen: Object.values(state.portfolioOpen).sort((left, right) => right.openedAt - left.openedAt),
    portfolioEquity: state.portfolioEquity, strategies,
    recentShadow: state.recentShadow.slice(-100).reverse(), recentPaper: state.recentPaper.slice(-100).reverse(),
    recentPortfolio: state.recentPortfolio.slice(-100).reverse(), transitions: state.transitions.slice(-100).reverse(),
    rules: { trialPromotionWins: TRIAL_PROMOTION_WINS, verifiedEvents: VERIFIED_PAPER_EVENTS,
      verifiedSymbols: VERIFIED_PAPER_SYMBOLS, verifiedProfitFactor: VERIFIED_PROFIT_FACTOR,
      demotionLosses: PAPER_DEMOTION_LOSSES, frictionFloorRate: ARENA_FRICTION_RATE, maxHoldMs: ARENA_MAX_HOLD_MS },
  };
}
