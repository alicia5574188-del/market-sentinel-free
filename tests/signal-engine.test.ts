import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMarket, type Candle, type MarketInputs } from "../lib/signal-engine.ts";

function candles(direction: 1 | -1): Candle[] {
  const start = 100;
  return Array.from({ length: 60 }, (_, index) => {
    const displacement = index * 0.08 + Math.sin(index * 0.9 + 3.2) * 0.45;
    const close = start + direction * displacement;
    const open = close - direction * 0.12;
    return {
      time: 1_700_000_000 + index * 300,
      open,
      high: Math.max(open, close) + 0.22,
      low: Math.min(open, close) - 0.22,
      close,
      volume: index === 59 ? 210 : 92 + (index % 7),
    };
  });
}

function fixture(direction: 1 | -1): MarketInputs {
  const series = candles(direction);
  const futuresPrice = series.at(-1)!.close;
  return {
    symbol: "SOL_USDT",
    observedAt: 1_700_020_000_000,
    futuresPrice,
    changePercentage: direction * 2.4,
    markPrice: futuresPrice - direction * 0.02,
    spotPrice: futuresPrice - direction * 0.06,
    fundingRate: direction * 0.00008,
    openInterestChangePct: 3.4,
    basisPct: direction * 0.05,
    spotCvdRatio: direction * 0.31,
    orderBookImbalance: direction * 0.24,
    benchmarkMomentum: direction * 2.1,
    multiTimeframeTrend: direction * 0.72,
    liquidationImbalance: direction * 0.38,
    optionsIvPercentile: 0.42,
    macroEventRisk: 0.08,
    candles: series,
    sourceAgesMs: {
      ticker: 1_500,
      candles: 15_000,
      spotTicker: 1_500,
      spotTrades: 2_400,
      orderBook: 1_800,
      contractStats: 90_000,
      benchmarks: 1_500,
    },
  };
}

test("多源同向时只在证据和新鲜度达标后确认 LONG", () => {
  const input = fixture(1);
  const result = evaluateMarket(input);
  assert.equal(result.state, "confirmed");
  assert.equal(result.side, "LONG");
  assert.ok(result.confidence >= 70);
  assert.ok(result.evidence.length >= 3);
  assert.ok(result.entryZone && result.entryZone[0] < result.entryZone[1]);
  assert.ok(result.invalidationPrice && result.invalidationPrice < input.futuresPrice);
  assert.equal(result.entryPlan?.ready, true);
  assert.ok(result.entryPlan?.checks.every((check) => check.passed));
  assert.equal(result.entryPlan?.riskReward, 2);
  assert.ok(result.entryPlan && result.entryPlan.takeProfit1Price > result.entryPlan.entryPrice);
  assert.ok(result.entryPlan && result.entryPlan.takeProfit2Price > result.entryPlan.takeProfit1Price);
});

test("同一组输入产生完全相同的决策", () => {
  const input = fixture(1);
  assert.deepEqual(evaluateMarket(input), evaluateMarket(structuredClone(input)));
});

test("关键数据过期时强制拦截，而不是沿用旧信号", () => {
  const input = fixture(1);
  input.sourceAgesMs = Object.fromEntries(Object.keys(input.sourceAgesMs).map((key) => [key, 10_000_000]));
  const result = evaluateMarket(input);
  assert.equal(result.state, "blocked");
  assert.equal(result.side, "WAIT");
  assert.equal(result.entryZone, null);
  assert.match(result.counterEvidence.map((item) => item.title).join(" "), /数据新鲜度/);
});

test("资金费率极端拥挤时，即使价格上涨也不追多", () => {
  const input = fixture(1);
  input.fundingRate = 0.0022;
  const result = evaluateMarket(input);
  assert.equal(result.state, "blocked");
  assert.equal(result.side, "WAIT");
  assert.match(result.counterEvidence.map((item) => `${item.title}${item.detail}`).join(" "), /资金费率/);
});

test("空头确认的失效价必须在当前价格上方", () => {
  const input = fixture(-1);
  const result = evaluateMarket(input);
  assert.equal(result.state, "confirmed");
  assert.equal(result.side, "SHORT");
  assert.ok(result.invalidationPrice && result.invalidationPrice > input.futuresPrice);
  assert.ok(result.entryPlan && result.entryPlan.takeProfit1Price < result.entryPlan.entryPrice);
  assert.ok(result.entryPlan && result.entryPlan.takeProfit2Price < result.entryPlan.takeProfit1Price);
});

test("方向很强但现货流没有确认时只预警，并明确列出缺失条件", () => {
  const input = fixture(1);
  input.spotCvdRatio = -0.02;
  const result = evaluateMarket(input);
  assert.equal(result.state, "pre_alert");
  assert.equal(result.entryPlan?.ready, false);
  assert.equal(result.entryPlan?.checks.find((check) => check.key === "spot-flow")?.passed, false);
  assert.match(result.trigger, /现货主动流确认/);
});

test("完整平仓经验会以收缩后的同币同方向分数参与下一次分析", () => {
  const positive = fixture(1);
  positive.experience = {
    LONG: { sampleCount: 20, wins: 14, losses: 6, bayesianWinRate: 0.68, averageNetPct: 0.62, averageMfePct: 1.1, averageMaePct: -0.38, profitFactor: 2.1, stopRate: 0.25 },
    SHORT: null,
  };
  const neutral = fixture(1);
  const learned = evaluateMarket(positive);
  const baseline = evaluateMarket(neutral);
  assert.ok(learned.directionalScore > baseline.directionalScore);
  assert.equal(learned.diagnostics.experienceSampleCount, 20);
  assert.ok(learned.diagnostics.experienceAdjustment > 0);
  assert.equal(learned.metrics.find((metric) => metric.key === "historical-edge")?.available, true);
});

test("贝叶斯先验只平滑更新，不会覆盖新的多源证据", () => {
  const bearishPrior = fixture(1);
  bearishPrior.priorLongProbability = 0.12;
  const neutralPrior = fixture(1);
  neutralPrior.priorLongProbability = 0.5;
  const bearishResult = evaluateMarket(bearishPrior);
  const neutralResult = evaluateMarket(neutralPrior);
  assert.ok(bearishResult.posteriorLong < neutralResult.posteriorLong);
  assert.ok(bearishResult.posteriorLong > bearishPrior.priorLongProbability);
  assert.equal(bearishResult.side, "LONG");
});

test("高影响宏观事件临近时硬拦截确认信号", () => {
  const input = fixture(1);
  input.macroEventRisk = 0.9;
  input.macroEventLabel = "CPI";
  const result = evaluateMarket(input);
  assert.equal(result.state, "blocked");
  assert.equal(result.side, "WAIT");
  assert.match(result.counterEvidence.map((item) => item.detail).join(" "), /CPI/);
});

test("缺少 ETF 数据时明确标记且不参与评分", () => {
  const input = fixture(1);
  input.etfFlowScore = null;
  const result = evaluateMarket(input);
  const metric = result.metrics.find((item) => item.key === "etf-flow");
  assert.equal(metric?.available, false);
  assert.match(metric?.detail ?? "", /不参与评分/);
});

test("当前尚未结束的 5m K 线不会参与收盘、RSI 或成交量确认", () => {
  const baselineInput = fixture(1);
  const baseline = evaluateMarket(baselineInput);
  const withLiveCandle = fixture(1);
  withLiveCandle.candles.push({
    time: withLiveCandle.observedAt / 1000 - 60,
    open: withLiveCandle.futuresPrice,
    high: withLiveCandle.futuresPrice * 1.12,
    low: withLiveCandle.futuresPrice * 0.88,
    close: withLiveCandle.futuresPrice * 0.90,
    volume: 99_999,
  });
  const result = evaluateMarket(withLiveCandle);
  assert.equal(result.diagnostics.excludedIncompleteCandle, true);
  assert.equal(result.diagnostics.lastCompletedCandleAt, baseline.diagnostics.lastCompletedCandleAt);
  assert.equal(result.diagnostics.rsi14, baseline.diagnostics.rsi14);
  assert.equal(result.diagnostics.volumeRatio, baseline.diagnostics.volumeRatio);
  assert.equal(result.entryPlan?.checks.find((check) => check.key === "closed-candle-trigger")?.passed, true);
});

test("完整 K 线量能低于门槛时不能创建订单", () => {
  const input = fixture(1);
  input.candles.at(-1)!.volume = 20;
  const result = evaluateMarket(input);
  assert.notEqual(result.state, "confirmed");
  assert.equal(result.entryPlan?.checks.find((check) => check.key === "volume-confirmation")?.passed, false);
  assert.match(result.trigger, /完整 K 线量能/);
});

test("HYPE、PUMP、BEAT 这类极端清算后追单会被硬性进场检查拦下", () => {
  const cases = [
    { symbol: "HYPE_USDT", direction: 1 as const, change: 4.72, liquidation: 0.926 },
    { symbol: "PUMP_USDT", direction: 1 as const, change: 7.70, liquidation: 0.970 },
    { symbol: "BEAT_USDT", direction: -1 as const, change: -6.77, liquidation: -0.818 },
  ];
  for (const sample of cases) {
    const input = fixture(sample.direction);
    input.symbol = sample.symbol;
    input.changePercentage = sample.change;
    input.liquidationImbalance = sample.liquidation;
    const result = evaluateMarket(input);
    assert.notEqual(result.state, "confirmed", sample.symbol);
    assert.equal(result.entryPlan?.checks.find((check) => check.key === "liquidation-exhaustion")?.passed, false, sample.symbol);
    assert.match(result.counterEvidence.map((item) => `${item.title}${item.detail}`).join(" "), /清算挤压耗竭/, sample.symbol);
  }
});

test("RSI 进入耗竭区或价格偏离 EMA9 过远时不再追多", () => {
  const input = fixture(1);
  const startIndex = input.candles.length - 18;
  const start = input.candles[startIndex - 1].close;
  for (let index = startIndex; index < input.candles.length; index += 1) {
    const close = start + (index - startIndex + 1) * 0.72;
    input.candles[index] = {
      ...input.candles[index],
      open: close - 0.24,
      high: close + 0.18,
      low: close - 0.32,
      close,
    };
  }
  input.futuresPrice = input.candles.at(-1)!.close;
  input.markPrice = input.futuresPrice;
  input.spotPrice = input.futuresPrice;
  input.changePercentage = 5.1;
  const result = evaluateMarket(input);
  assert.notEqual(result.state, "confirmed");
  assert.ok((result.diagnostics.rsi14 ?? 0) > 72);
  assert.equal(result.entryPlan?.checks.find((check) => check.key === "anti-chase")?.passed, false);
  assert.match(result.counterEvidence.map((item) => item.title).join(" "), /动量已过热|入场位置过远/);
});
