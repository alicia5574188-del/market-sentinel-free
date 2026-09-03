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

export const HTE31_STRATEGY_FAMILY_IDS = [
  "SF01",
  "SF02",
  "SF03",
  "SF04",
  "SF05",
  "SF06",
  "SF07",
  "SF08",
  "SF09",
] as const;

export type Hte31StrategyFamilyId = typeof HTE31_STRATEGY_FAMILY_IDS[number];
export type Hte31StrategyFamilyDefinition = {
  id: Hte31StrategyFamilyId;
  name: string;
  label: string;
  tags: readonly string[];
  traderIds: readonly Hte31TraderId[];
};

export type Hte31TraderDefinition = {
  id: Hte31TraderId;
  code: string;
  name: string;
  setup: string;
  lane: "paper";
  storyFamily: "trend" | "reversal" | "range" | "volatility" | "relative_strength";
  familyId: Hte31StrategyFamilyId;
  variantId: "BASE" | "ACCEPTED_RETEST" | "ADAPTIVE_DEPTH" | "FORCE_AWARE" | "REGIME_CONTEXT";
  variantName: string;
  tags: readonly string[];
};

export const HTE31_TRADER_DEFINITIONS: Hte31TraderDefinition[] = [
  { id: "dennis_trend", code: "HT1", name: "Dennis", setup: "趋势突破", lane: "paper", storyFamily: "trend", familyId: "SF01", variantId: "BASE", variantName: "基础", tags: ["趋势", "突破"] },
  { id: "raschke_pullback", code: "HT2", name: "Raschke", setup: "趋势回踩", lane: "paper", storyFamily: "trend", familyId: "SF02", variantId: "BASE", variantName: "基础", tags: ["趋势", "回踩"] },
  { id: "turtle_soup", code: "HT3", name: "Turtle Soup", setup: "假突破", lane: "paper", storyFamily: "reversal", familyId: "SF03", variantId: "BASE", variantName: "基础", tags: ["反转", "假突破"] },
  { id: "exhaustion_reversal", code: "HT4", name: "Exhaustion", setup: "反拥挤衰竭", lane: "paper", storyFamily: "reversal", familyId: "SF04", variantId: "BASE", variantName: "基础", tags: ["反转", "衰竭"] },
  { id: "higher_timeframe_swing", code: "HT5", name: "Swing", setup: "大周期结构", lane: "paper", storyFamily: "trend", familyId: "SF05", variantId: "BASE", variantName: "基础", tags: ["趋势", "大周期"] },
  { id: "dennis_trend_v2", code: "HT1-R", name: "Accepted Breakout", setup: "突破接受/回踩", lane: "paper", storyFamily: "trend", familyId: "SF01", variantId: "ACCEPTED_RETEST", variantName: "接受回踩", tags: ["趋势", "突破", "确认"] },
  { id: "raschke_pullback_v2", code: "HT2-R", name: "Adaptive Pullback", setup: "深浅回踩恢复", lane: "paper", storyFamily: "trend", familyId: "SF02", variantId: "ADAPTIVE_DEPTH", variantName: "自适应深度", tags: ["趋势", "回踩", "自适应"] },
  { id: "turtle_soup_v2", code: "HT3-R", name: "Failed Auction", setup: "量价力度假突破", lane: "paper", storyFamily: "reversal", familyId: "SF03", variantId: "FORCE_AWARE", variantName: "力度确认", tags: ["反转", "假突破", "量价"] },
  { id: "higher_timeframe_swing_v2", code: "HT5-R", name: "Swing Context", setup: "周期化大结构", lane: "paper", storyFamily: "trend", familyId: "SF05", variantId: "REGIME_CONTEXT", variantName: "环境上下文", tags: ["趋势", "大周期", "环境"] },
  { id: "range_rotation", code: "HT6", name: "Range Rotation", setup: "区间边缘轮动", lane: "paper", storyFamily: "range", familyId: "SF06", variantId: "BASE", variantName: "基础", tags: ["区间", "轮动"] },
  { id: "compression_expansion", code: "HT7", name: "Compression", setup: "压缩后真实扩张", lane: "paper", storyFamily: "volatility", familyId: "SF07", variantId: "BASE", variantName: "基础", tags: ["波动率", "压缩", "扩张"] },
  { id: "relative_strength", code: "HT8", name: "Relative Strength", setup: "横截面强弱", lane: "paper", storyFamily: "relative_strength", familyId: "SF08", variantId: "BASE", variantName: "基础", tags: ["相对强弱", "横截面"] },
  { id: "momentum_continuation", code: "HT9", name: "Momentum Continuation", setup: "浅回踩趋势延续", lane: "paper", storyFamily: "trend", familyId: "SF09", variantId: "BASE", variantName: "基础", tags: ["趋势", "动量", "延续"] },
];

export const HTE31_STRATEGY_FAMILIES: Hte31StrategyFamilyDefinition[] = [
  { id: "SF01", name: "趋势突破", label: "SF01 趋势突破", tags: ["趋势", "突破"], traderIds: ["dennis_trend", "dennis_trend_v2"] },
  { id: "SF02", name: "趋势回踩", label: "SF02 趋势回踩", tags: ["趋势", "回踩"], traderIds: ["raschke_pullback", "raschke_pullback_v2"] },
  { id: "SF03", name: "失败突破", label: "SF03 失败突破", tags: ["反转", "假突破"], traderIds: ["turtle_soup", "turtle_soup_v2"] },
  { id: "SF04", name: "衰竭反转", label: "SF04 衰竭反转", tags: ["反转", "衰竭"], traderIds: ["exhaustion_reversal"] },
  { id: "SF05", name: "大周期波段", label: "SF05 大周期波段", tags: ["趋势", "大周期"], traderIds: ["higher_timeframe_swing", "higher_timeframe_swing_v2"] },
  { id: "SF06", name: "区间轮动", label: "SF06 区间轮动", tags: ["区间", "轮动"], traderIds: ["range_rotation"] },
  { id: "SF07", name: "压缩扩张", label: "SF07 压缩扩张", tags: ["波动率", "扩张"], traderIds: ["compression_expansion"] },
  { id: "SF08", name: "相对强弱", label: "SF08 相对强弱", tags: ["横截面", "强弱"], traderIds: ["relative_strength"] },
  { id: "SF09", name: "动量延续", label: "SF09 动量延续", tags: ["趋势", "动量"], traderIds: ["momentum_continuation"] },
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

export function hte31StrategyFamilyDefinition(familyId: Hte31StrategyFamilyId) {
  return HTE31_STRATEGY_FAMILIES.find((item) => item.id === familyId)!;
}

export function hte31StrategyFamilyForTrader(traderId: Hte31TraderId) {
  return hte31StrategyFamilyDefinition(hte31TraderDefinition(traderId).familyId);
}

export function hte31CanonicalStrategyLabel(traderId: Hte31TraderId) {
  const trader = hte31TraderDefinition(traderId);
  const family = hte31StrategyFamilyDefinition(trader.familyId);
  return `${family.label} · ${trader.variantName} [${trader.code}]`;
}
