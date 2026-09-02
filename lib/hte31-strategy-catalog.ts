import type { Hte31Signal, Hte31StrategyId } from "./hte31-types.ts";

export const HTE31_CONTROL_TRADER_IDS = [
  "dennis_trend",
  "raschke_pullback",
  "turtle_soup",
  "exhaustion_reversal",
  "higher_timeframe_swing",
] as const;

export const HTE31_RESEARCH_TRADER_IDS = [
  "dennis_trend_v2",
  "raschke_pullback_v2",
  "turtle_soup_v2",
  "higher_timeframe_swing_v2",
  "range_rotation",
  "compression_expansion",
  "relative_strength",
  "momentum_continuation",
] as const;

export const HTE31_ALL_TRADER_IDS = [
  ...HTE31_CONTROL_TRADER_IDS,
  ...HTE31_RESEARCH_TRADER_IDS,
] as const;

export type Hte31ControlTraderId = typeof HTE31_CONTROL_TRADER_IDS[number];
export type Hte31ResearchTraderId = typeof HTE31_RESEARCH_TRADER_IDS[number];
export type Hte31TraderId = typeof HTE31_ALL_TRADER_IDS[number];

export type Hte31TraderDefinition = {
  id: Hte31TraderId;
  code: string;
  name: string;
  setup: string;
  lane: "control" | "research";
  storyFamily: "trend" | "reversal" | "range" | "volatility" | "relative_strength";
};

export const HTE31_TRADER_DEFINITIONS: Hte31TraderDefinition[] = [
  { id: "dennis_trend", code: "HT1", name: "Dennis", setup: "趋势突破", lane: "control", storyFamily: "trend" },
  { id: "raschke_pullback", code: "HT2", name: "Raschke", setup: "趋势回踩", lane: "control", storyFamily: "trend" },
  { id: "turtle_soup", code: "HT3", name: "Turtle Soup", setup: "假突破", lane: "control", storyFamily: "reversal" },
  { id: "exhaustion_reversal", code: "HT4", name: "Exhaustion", setup: "反拥挤衰竭", lane: "control", storyFamily: "reversal" },
  { id: "higher_timeframe_swing", code: "HT5", name: "Swing", setup: "大周期结构", lane: "control", storyFamily: "trend" },
  { id: "dennis_trend_v2", code: "HT1-R", name: "Accepted Breakout", setup: "突破接受/回踩", lane: "research", storyFamily: "trend" },
  { id: "raschke_pullback_v2", code: "HT2-R", name: "Adaptive Pullback", setup: "深浅回踩恢复", lane: "research", storyFamily: "trend" },
  { id: "turtle_soup_v2", code: "HT3-R", name: "Failed Auction", setup: "量价力度假突破", lane: "research", storyFamily: "reversal" },
  { id: "higher_timeframe_swing_v2", code: "HT5-R", name: "Swing Context", setup: "周期化大结构", lane: "research", storyFamily: "trend" },
  { id: "range_rotation", code: "HT6", name: "Range Rotation", setup: "区间边缘轮动", lane: "research", storyFamily: "range" },
  { id: "compression_expansion", code: "HT7", name: "Compression", setup: "压缩后真实扩张", lane: "research", storyFamily: "volatility" },
  { id: "relative_strength", code: "HT8", name: "Relative Strength", setup: "横截面强弱", lane: "research", storyFamily: "relative_strength" },
  { id: "momentum_continuation", code: "HT9", name: "Momentum Continuation", setup: "浅回踩趋势延续", lane: "research", storyFamily: "trend" },
];

const TRADER_BY_STRATEGY: Record<Hte31StrategyId, Hte31TraderId> = {
  trend_breakout: "dennis_trend",
  trend_pullback: "raschke_pullback",
  failed_breakout: "turtle_soup",
  trend_exhaustion_reversal: "exhaustion_reversal",
  higher_timeframe_swing: "higher_timeframe_swing",
  trend_breakout_challenger: "dennis_trend_v2",
  trend_pullback_challenger: "raschke_pullback_v2",
  failed_breakout_challenger: "turtle_soup_v2",
  higher_timeframe_swing_challenger: "higher_timeframe_swing_v2",
  range_rotation: "range_rotation",
  compression_expansion: "compression_expansion",
  relative_strength: "relative_strength",
  momentum_continuation: "momentum_continuation",
};

export function hte31TraderIdForStrategy(strategyId: Hte31StrategyId): Hte31TraderId {
  return TRADER_BY_STRATEGY[strategyId];
}

export function hte31TraderIdForSignal(signal: Hte31Signal): Hte31TraderId {
  return hte31TraderIdForStrategy(signal.strategyId);
}

export function isHte31ResearchSignal(signal: Hte31Signal) {
  return signal.strategyMeta.executionLane === "research";
}

export function hte31TraderDefinition(traderId: Hte31TraderId) {
  return HTE31_TRADER_DEFINITIONS.find((item) => item.id === traderId)!;
}
