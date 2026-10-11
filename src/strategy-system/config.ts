export const CONFIG = {
  slowLayer: {
    hysteresis: { enterDying: -0.6, exitDying: 0.3 },
    minDwellMs: 30 * 60 * 1000,
    weights: {
      priceStructure: 0.35,
      volume: 0.2,
      derivatives: 0.2,
      crossMarket: 0.15,
      sentiment: 0.1,
    },
  },
  fastLayer: {
    atrMultiplier: 2.0,
    consecutiveCloses: 3,
    volumeMultiplier: 3.0,
  },
  // 结构区间不含正在走的事件 K。含进去的话，高低点被当前 K 自己抬走，
  // 假突破和破位两个条件都永不成立。
  range: {
    lookback: 50,
    shelfExclude: 3,
    breakoutExclude: 2,
  },
  position: {
    fakeBreakoutNotional: 500,
    trendNotional: 800,
  },
  loopIntervalMs: 5000,
  minCandles1h: 50,
};
