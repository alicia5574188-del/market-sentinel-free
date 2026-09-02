export type Hte31ResearchTraderId =
  | "dennis_trend_r"
  | "raschke_pullback_r"
  | "turtle_soup_r"
  | "higher_timeframe_swing_r"
  | "range_rotation"
  | "compression_release"
  | "relative_strength"
  | "shallow_pullback";

export type Hte31ResearchStrategyId =
  | "ht1_breakout_acceptance"
  | "ht2_pullback_resume"
  | "ht3_failed_auction"
  | "ht5_swing_resume"
  | "ht6_range_rotation"
  | "ht7_compression_release"
  | "ht8_relative_strength"
  | "ht9_shallow_pullback";

export type Hte31ResearchCatalogItem = {
  traderId: Hte31ResearchTraderId;
  strategyId: Hte31ResearchStrategyId;
  code: string;
  label: string;
  family: "continuation" | "failure" | "range" | "volatility" | "rotation" | "swing";
  structureTimeframe: string;
  setupTimeframe: string;
  executionTimeframe: string;
  purpose: string;
};

export const HTE31_RESEARCH_STRATEGIES: readonly Hte31ResearchCatalogItem[] = [
  {
    traderId: "dennis_trend_r",
    strategyId: "ht1_breakout_acceptance",
    code: "HT1-R",
    label: "HT1-R Breakout Acceptance",
    family: "continuation",
    structureTimeframe: "1h",
    setupTimeframe: "15m",
    executionTimeframe: "5m",
    purpose: "把首次突破改成结构位突破后的接受/回测，而不是只等一根5m瞬时穿越。",
  },
  {
    traderId: "raschke_pullback_r",
    strategyId: "ht2_pullback_resume",
    code: "HT2-R",
    label: "HT2-R Pullback Resume",
    family: "continuation",
    structureTimeframe: "1h/15m",
    setupTimeframe: "15m",
    executionTimeframe: "5m",
    purpose: "保留趋势回踩的简单核心，只把强反向资金流作为否决，不要求所有微观数据同时配合。",
  },
  {
    traderId: "turtle_soup_r",
    strategyId: "ht3_failed_auction",
    code: "HT3-R",
    label: "HT3-R Failed Auction",
    family: "failure",
    structureTimeframe: "1h/15m",
    setupTimeframe: "15m",
    executionTimeframe: "5m",
    purpose: "比较突破推进、区间外接受和反向夺回力度，避免把刺破旧高低点机械定义成假突破。",
  },
  {
    traderId: "higher_timeframe_swing_r",
    strategyId: "ht5_swing_resume",
    code: "HT5-R",
    label: "HT5-R Higher-Timeframe Swing",
    family: "swing",
    structureTimeframe: "4h/1h",
    setupTimeframe: "1h/15m",
    executionTimeframe: "5m",
    purpose: "真正让4h/1h决定方向与Setup，5m只负责更好的成交，不用短线噪声推翻大周期。",
  },
  {
    traderId: "range_rotation",
    strategyId: "ht6_range_rotation",
    code: "HT6",
    label: "HT6 Range Rotation",
    family: "range",
    structureTimeframe: "1h/15m",
    setupTimeframe: "15m",
    executionTimeframe: "5m",
    purpose: "覆盖明确横盘中的上下沿拒绝与回归，不在区间中部交易。",
  },
  {
    traderId: "compression_release",
    strategyId: "ht7_compression_release",
    code: "HT7",
    label: "HT7 Compression Release",
    family: "volatility",
    structureTimeframe: "1h",
    setupTimeframe: "15m",
    executionTimeframe: "5m",
    purpose: "覆盖波动压缩后的有效离开与接受，避免只在趋势已走远后才追。",
  },
  {
    traderId: "relative_strength",
    strategyId: "ht8_relative_strength",
    code: "HT8",
    label: "HT8 Relative Strength",
    family: "rotation",
    structureTimeframe: "1h",
    setupTimeframe: "15m",
    executionTimeframe: "5m",
    purpose: "交易明显强于或弱于市场横截面的币种，使用回踩/反弹后的再启动而不是追普通涨跌。",
  },
  {
    traderId: "shallow_pullback",
    strategyId: "ht9_shallow_pullback",
    code: "HT9",
    label: "HT9 Shallow Pullback Continuation",
    family: "continuation",
    structureTimeframe: "1h/15m",
    setupTimeframe: "15m",
    executionTimeframe: "5m",
    purpose: "覆盖已经突破且趋势很强、但不给深回踩的浅整理续航行情。",
  },
] as const;

export const HTE31_RESEARCH_TRADER_IDS = HTE31_RESEARCH_STRATEGIES.map((item) => item.traderId) as Hte31ResearchTraderId[];

export function hte31ResearchCatalogItem(traderId: Hte31ResearchTraderId) {
  return HTE31_RESEARCH_STRATEGIES.find((item) => item.traderId === traderId)!;
}
