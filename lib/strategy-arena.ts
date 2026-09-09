import type { LiquidityRoute, RangeStructure, Side } from "./liquidity-core.ts";
import type { RadarCandidate } from "./market-radar.ts";

export const STRATEGY_ARENA_VERSION = 1;
export const STRATEGY_INITIAL_EQUITY = 1_000;
export const SHADOW_PROMOTION_SAMPLE = 6;
export const SHADOW_PROMOTION_WINS = 4;
export const PAPER_DEMOTION_LOSSES = 2;
export const ARENA_MAX_HOLD_MS = 45 * 60_000;
export const ARENA_FRICTION_RATE = 0.0018;

export type StrategyLane = "SHADOW" | "PAPER";
export type StrategyFamily = "MOMENTUM" | "PULLBACK" | "ORDER_FLOW" | "STRUCTURE" | "MEAN_REVERSION";
export type ArenaOutcome = "TARGET" | "STOP" | "TIMEOUT";

export type StrategyDefinition = {
  id: string;
  name: string;
  family: StrategyFamily;
  description: string;
};

export const STRATEGY_CATALOG: StrategyDefinition[] = [
  { id: "impulse_follow", name: "异动确认延续", family: "MOMENTUM", description: "两轮异动确认后顺势，避免过度延伸。" },
  { id: "new_money_follow", name: "新增持仓延续", family: "MOMENTUM", description: "价格与持仓量同向增加时顺势。" },
  { id: "shallow_pullback", name: "浅回撤续行", family: "PULLBACK", description: "回撤异动幅度一至四成后顺势。" },
  { id: "deep_pullback", name: "深回撤修复", family: "PULLBACK", description: "深回撤但尚未完全撤销异动时顺势。" },
  { id: "flow_follow", name: "主动资金同向", family: "ORDER_FLOW", description: "盘口与主动成交明显同向时跟随。" },
  { id: "flow_divergence", name: "资金背离反转", family: "ORDER_FLOW", description: "价格异动与主动资金明显背离时反向。" },
  { id: "accepted_breakout", name: "结构突破接受", family: "STRUCTURE", description: "结构确认高、假突破风险低时顺势。" },
  { id: "failed_breakout", name: "结构假突破", family: "STRUCTURE", description: "假突破风险高或失败突破路线出现时反向。" },
  { id: "exhaustion_fade", name: "极端异动衰竭", family: "MEAN_REVERSION", description: "高强度异动回吐且资金不再支持时反向。" },
  { id: "squeeze_fade", name: "挤仓回吐", family: "MEAN_REVERSION", description: "挤仓或爆仓推动后出现回吐时反向。" },
];

export type ArenaTrade = {
  id: string;
  strategyId: string;
  strategyName: string;
  family: StrategyFamily;
  lane: StrategyLane;
  eventId: string;
  symbol: string;
  side: Side;
  status: "OPEN" | "CLOSED";
  openedAt: number;
  closedAt: number | null;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  exitPrice: number | null;
  outcome: ArenaOutcome | null;
  grossReturnRate: number | null;
  netReturnRate: number | null;
  netPnl: number | null;
  reason: string;
};

export type StrategyScore = {
  id: string;
  name: string;
  family: StrategyFamily;
  description: string;
  lane: StrategyLane;
  shadowResolved: number;
  shadowWins: number;
  shadowNetReturnRate: number;
  paperResolved: number;
  paperWins: number;
  paperNetReturnRate: number;
  paperEquity: number;
  consecutivePaperLosses: number;
  stageResults: number[];
  transitions: number;
  lastTransitionAt: number | null;
};

export type ArenaTransition = {
  id: string;
  strategyId: string;
  strategyName: string;
  from: StrategyLane;
  to: StrategyLane;
  at: number;
  reason: string;
};

export type StrategyArenaState = {
  version: 1;
  startedAt: number;
  strategies: Record<string, StrategyScore>;
  open: Record<string, ArenaTrade>;
  recentShadow: ArenaTrade[];
  recentPaper: ArenaTrade[];
  transitions: ArenaTransition[];
  seenSignals: string[];
};

export type ArenaObservation = {
  candidate: RadarCandidate;
  midpoint: number;
  alignedFlow: number;
  minuteNoiseRate: number;
  range15m: RangeStructure | null;
  confirmationBySide: Record<Side, number>;
  fakeoutBySide: Record<Side, number>;
  routes: LiquidityRoute[];
  now: number;
};

type Signal = { strategyId: string; side: Side; targetRate: number; stopRate: number; reason: string };

const opposite = (side: Side): Side => side === "LONG" ? "SHORT" : "LONG";
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function initialStrategyArena(now = Date.now()): StrategyArenaState {
  return {
    version: STRATEGY_ARENA_VERSION,
    startedAt: now,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => [definition.id, {
      ...definition,
      lane: "SHADOW" as const,
      shadowResolved: 0,
      shadowWins: 0,
      shadowNetReturnRate: 0,
      paperResolved: 0,
      paperWins: 0,
      paperNetReturnRate: 0,
      paperEquity: STRATEGY_INITIAL_EQUITY,
      consecutivePaperLosses: 0,
      stageResults: [],
      transitions: 0,
      lastTransitionAt: null,
    }])),
    open: {},
    recentShadow: [],
    recentPaper: [],
    transitions: [],
    seenSignals: [],
  };
}

export function normalizeStrategyArena(value: StrategyArenaState | null | undefined, now = Date.now()): StrategyArenaState {
  const fresh = initialStrategyArena(now);
  if (!value || value.version !== STRATEGY_ARENA_VERSION) return fresh;
  return {
    ...fresh,
    ...value,
    strategies: Object.fromEntries(STRATEGY_CATALOG.map((definition) => {
      const prior = value.strategies?.[definition.id];
      return [definition.id, prior ? { ...fresh.strategies[definition.id], ...prior, ...definition } : fresh.strategies[definition.id]];
    })),
    open: value.open ?? {},
    recentShadow: (value.recentShadow ?? []).slice(-400),
    recentPaper: (value.recentPaper ?? []).slice(-400),
    transitions: (value.transitions ?? []).slice(-200),
    seenSignals: (value.seenSignals ?? []).slice(-1_000),
  };
}

function retraceRatio(candidate: RadarCandidate, midpoint: number) {
  const direction = candidate.side === "LONG" ? 1 : -1;
  const impulse = Math.max(Math.abs(candidate.moveRate), 0.0001);
  const extension = direction * (midpoint - candidate.referencePrice) / Math.max(candidate.referencePrice, 1e-9);
  return clamp(1 - extension / impulse, -0.5, 2);
}

function signals(input: ArenaObservation): Signal[] {
  const { candidate } = input;
  const retrace = retraceRatio(candidate, input.midpoint);
  const confirmation = input.confirmationBySide[candidate.side] ?? 0;
  const fakeout = input.fakeoutBySide[candidate.side] ?? 1;
  const noise = clamp(input.minuteNoiseRate, 0.0018, 0.006);
  const followStop = clamp(noise * 1.05, 0.0028, 0.0055);
  const fadeStop = clamp(noise * 0.95, 0.0026, 0.005);
  const output: Signal[] = [];
  const add = (strategyId: string, side: Side, targetRate: number, stopRate: number, reason: string) =>
    output.push({ strategyId, side, targetRate, stopRate, reason });

  if (candidate.confirmations >= 2 && candidate.strength >= 58 && retrace <= 0.2 && retrace >= -0.15)
    add("impulse_follow", candidate.side, Math.max(0.0065, followStop * 1.8), followStop, "异动两轮确认且未明显回吐");
  if (candidate.kind === "NEW_MONEY" && candidate.openInterestChangeRate >= 0.0002 && retrace <= 0.45)
    add("new_money_follow", candidate.side, Math.max(0.0068, followStop * 1.9), followStop, "价格与持仓量同向增加");
  if (retrace >= 0.12 && retrace <= 0.42 && input.alignedFlow >= -0.12)
    add("shallow_pullback", candidate.side, Math.max(0.0062, followStop * 1.8), followStop, "浅回撤后资金未明显反向");
  if (retrace > 0.42 && retrace <= 0.72 && input.alignedFlow >= 0.08)
    add("deep_pullback", candidate.side, Math.max(0.0068, followStop * 2), followStop, "深回撤后主动资金重新同向");
  if (input.alignedFlow >= 0.32 && retrace <= 0.55)
    add("flow_follow", candidate.side, Math.max(0.006, followStop * 1.75), followStop, "盘口与主动成交同向");
  if (input.alignedFlow <= -0.3 && retrace >= 0.15)
    add("flow_divergence", opposite(candidate.side), Math.max(0.0058, fadeStop * 1.7), fadeStop, "异动方向与主动资金背离");
  if (confirmation >= 0.65 && fakeout <= 0.35 && retrace <= 0.55)
    add("accepted_breakout", candidate.side, Math.max(0.0068, followStop * 1.9), followStop, "结构突破被盘口接受");
  if (fakeout >= 0.68 || input.routes.some((route) => route.kind === "FAILED_BREAKOUT_REVERSAL" && route.side === opposite(candidate.side)))
    add("failed_breakout", opposite(candidate.side), Math.max(0.006, fadeStop * 1.8), fadeStop, "结构显示假突破或失败收回");
  if (candidate.strength >= 78 && retrace >= 0.3 && input.alignedFlow <= 0.05)
    add("exhaustion_fade", opposite(candidate.side), Math.max(0.0058, fadeStop * 1.7), fadeStop, "极端异动开始回吐且资金支持消失");
  if (["SQUEEZE", "LIQUIDATION"].includes(candidate.kind) && retrace >= 0.25 && input.alignedFlow <= 0.12)
    add("squeeze_fade", opposite(candidate.side), Math.max(0.0058, fadeStop * 1.7), fadeStop, "挤仓推动后出现回吐");
  return output;
}

function closeTrade(trade: ArenaTrade, exitPrice: number, outcome: ArenaOutcome, now: number) {
  const direction = trade.side === "LONG" ? 1 : -1;
  const grossReturnRate = direction * (exitPrice - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9);
  const netReturnRate = grossReturnRate - ARENA_FRICTION_RATE;
  return { ...trade, status: "CLOSED" as const, closedAt: now, exitPrice, outcome, grossReturnRate, netReturnRate,
    netPnl: STRATEGY_INITIAL_EQUITY * netReturnRate };
}

function transition(state: StrategyArenaState, score: StrategyScore, to: StrategyLane, now: number, reason: string) {
  if (score.lane === to) return;
  const from = score.lane;
  score.lane = to;
  score.stageResults = [];
  score.consecutivePaperLosses = 0;
  score.transitions += 1;
  score.lastTransitionAt = now;
  state.transitions.push({ id: `${score.id}:${now}:${to}`, strategyId: score.id, strategyName: score.name, from, to, at: now, reason });
  if (state.transitions.length > 200) state.transitions.shift();
}

function recordClosed(state: StrategyArenaState, trade: ArenaTrade) {
  const score = state.strategies[trade.strategyId];
  const value = trade.netReturnRate ?? 0;
  const won = value > 0;
  if (trade.lane === "SHADOW") {
    score.shadowResolved += 1;
    score.shadowWins += Number(won);
    score.shadowNetReturnRate += value;
    score.stageResults = [...score.stageResults, value].slice(-12);
    state.recentShadow.push(trade);
    if (state.recentShadow.length > 400) state.recentShadow.shift();
    const window = score.stageResults.slice(-SHADOW_PROMOTION_SAMPLE);
    const wins = window.filter((result) => result > 0).length;
    if (window.length >= SHADOW_PROMOTION_SAMPLE && wins >= SHADOW_PROMOTION_WINS
      && window.reduce((sum, result) => sum + result, 0) > 0) {
      transition(state, score, "PAPER", trade.closedAt ?? Date.now(), `最近${SHADOW_PROMOTION_SAMPLE}笔成本后${wins}胜且净收益为正`);
    }
  } else {
    score.paperResolved += 1;
    score.paperWins += Number(won);
    score.paperNetReturnRate += value;
    score.paperEquity = Math.max(0.01, score.paperEquity + (trade.netPnl ?? 0));
    score.consecutivePaperLosses = won ? 0 : score.consecutivePaperLosses + 1;
    score.stageResults = [...score.stageResults, value].slice(-12);
    state.recentPaper.push(trade);
    if (state.recentPaper.length > 400) state.recentPaper.shift();
    const recentSix = score.stageResults.slice(-6);
    const rollingNegative = recentSix.length === 6 && recentSix.reduce((sum, result) => sum + result, 0) <= 0;
    if (score.consecutivePaperLosses >= PAPER_DEMOTION_LOSSES || rollingNegative) {
      transition(state, score, "SHADOW", trade.closedAt ?? Date.now(), score.consecutivePaperLosses >= PAPER_DEMOTION_LOSSES
        ? "模拟连续亏损2笔" : "模拟最近6笔成本后净收益不再为正");
    }
  }
}

export function advanceStrategyArena(input: { state: StrategyArenaState; quotes: Record<string, number>; now: number }) {
  const state = normalizeStrategyArena(input.state, input.now);
  for (const [id, trade] of Object.entries(state.open)) {
    const price = input.quotes[trade.symbol];
    if (!Number.isFinite(price) || price <= 0) continue;
    const stopped = trade.side === "LONG" ? price <= trade.stopPrice : price >= trade.stopPrice;
    const targeted = trade.side === "LONG" ? price >= trade.targetPrice : price <= trade.targetPrice;
    const timedOut = input.now - trade.openedAt >= ARENA_MAX_HOLD_MS;
    if (!stopped && !targeted && !timedOut) continue;
    const outcome: ArenaOutcome = stopped ? "STOP" : targeted ? "TARGET" : "TIMEOUT";
    const exitPrice = stopped ? trade.stopPrice : targeted ? trade.targetPrice : price;
    const closed = closeTrade(trade, exitPrice, outcome, input.now);
    delete state.open[id];
    recordClosed(state, closed);
  }
  return state;
}

export function observeStrategyArena(input: { state: StrategyArenaState; observation: ArenaObservation }) {
  const state = advanceStrategyArena({ state: input.state, quotes: { [input.observation.candidate.symbol]: input.observation.midpoint }, now: input.observation.now });
  for (const signal of signals(input.observation)) {
    const score = state.strategies[signal.strategyId];
    if (!score) continue;
    const signalKey = `${signal.strategyId}:${input.observation.candidate.id}`;
    const openKey = `${signal.strategyId}:${input.observation.candidate.symbol}`;
    if (state.seenSignals.includes(signalKey) || state.open[openKey]) continue;
    const direction = signal.side === "LONG" ? 1 : -1;
    state.open[openKey] = {
      id: `${signalKey}:${input.observation.now}`,
      strategyId: score.id,
      strategyName: score.name,
      family: score.family,
      lane: score.lane,
      eventId: input.observation.candidate.id,
      symbol: input.observation.candidate.symbol,
      side: signal.side,
      status: "OPEN",
      openedAt: input.observation.now,
      closedAt: null,
      entryPrice: input.observation.midpoint,
      stopPrice: input.observation.midpoint * (1 - direction * signal.stopRate),
      targetPrice: input.observation.midpoint * (1 + direction * signal.targetRate),
      exitPrice: null,
      outcome: null,
      grossReturnRate: null,
      netReturnRate: null,
      netPnl: null,
      reason: signal.reason,
    };
    state.seenSignals.push(signalKey);
    if (state.seenSignals.length > 1_000) state.seenSignals.shift();
  }
  return state;
}

export function arenaSummary(state: StrategyArenaState) {
  const strategies = Object.values(state.strategies).sort((left, right) => Number(right.lane === "PAPER") - Number(left.lane === "PAPER")
    || (right.stageResults.reduce((sum, value) => sum + value, 0) - left.stageResults.reduce((sum, value) => sum + value, 0)));
  const open = Object.values(state.open).sort((left, right) => right.openedAt - left.openedAt);
  return {
    version: state.version,
    startedAt: state.startedAt,
    catalogSize: STRATEGY_CATALOG.length,
    shadowCount: strategies.filter((strategy) => strategy.lane === "SHADOW").length,
    paperCount: strategies.filter((strategy) => strategy.lane === "PAPER").length,
    openShadow: open.filter((trade) => trade.lane === "SHADOW"),
    openPaper: open.filter((trade) => trade.lane === "PAPER"),
    strategies,
    recentShadow: state.recentShadow.slice(-100).reverse(),
    recentPaper: state.recentPaper.slice(-100).reverse(),
    transitions: state.transitions.slice(-100).reverse(),
    rules: { promotionSample: SHADOW_PROMOTION_SAMPLE, promotionWins: SHADOW_PROMOTION_WINS,
      demotionLosses: PAPER_DEMOTION_LOSSES, frictionRate: ARENA_FRICTION_RATE, maxHoldMs: ARENA_MAX_HOLD_MS },
  };
}
