import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAdvancedHumanTraders } from "../lib/hte31-advanced-traders.ts";
import type { Hte31Candle, Hte31Input } from "../lib/hte31-types.ts";

const observedAt = Date.UTC(2026, 7, 30, 10, 0, 0);

function candles(count = 90): Hte31Candle[] {
  const rows: Hte31Candle[] = [];
  for (let index = 0; index < count; index += 1) {
    const close = 100 + index * 0.035 + Math.sin(index / 5) * 0.04;
    rows.push({
      time: Math.floor((observedAt - (count - index) * 300_000) / 1000),
      open: close - 0.015,
      high: close + 0.09,
      low: close - 0.09,
      close,
      volume: 1200 + index % 4 * 50,
    });
  }
  return rows;
}

function baseInput(rows: Hte31Candle[], patch: Partial<Hte31Input> = {}): Hte31Input {
  return {
    symbol: "BTC_USDT",
    observedAt,
    futuresPrice: rows.at(-1)?.close ?? 100,
    volumeUsd: 2_000_000_000,
    changePercentage: 2.2,
    fundingRate: 0.0001,
    openInterestChangePct: 1.2,
    spotCvdRatio: 0.02,
    orderBookImbalance: 0.03,
    liquidationImbalance: 0,
    multiTimeframeTrend: 0.2,
    timeframeTrend15m: 0.2,
    timeframeTrend1h: 0.25,
    timeframeTrend4h: 0.35,
    benchmarkMomentum: 0.8,
    optionsIvPercentile: 0.55,
    macroEventRisk: 0.1,
    dataQuality: 0.94,
    candles5m: rows,
    crossSectionRank: 0.7,
    rotationVelocity: 0,
    marketAdvancingRatio: 0.58,
    marketDecliningRatio: 0.42,
    ...patch,
  };
}

function exhaustionRows() {
  const rows = candles();
  const previous = rows.at(-2)!;
  rows[rows.length - 1] = {
    ...rows.at(-1)!,
    open: previous.close + 0.30,
    high: previous.close + 0.62,
    low: previous.close - 0.13,
    close: previous.close - 0.06,
    volume: 2300,
  };
  return rows;
}

function swingRows() {
  const rows = candles();
  const before = rows.at(-3)!;
  rows[rows.length - 2] = {
    ...rows.at(-2)!,
    open: before.close + 0.02,
    high: before.close + 0.07,
    low: before.close - 0.18,
    close: before.close - 0.10,
  };
  const previous = rows.at(-2)!;
  rows[rows.length - 1] = {
    ...rows.at(-1)!,
    open: previous.close - 0.01,
    high: previous.high + 0.08,
    low: previous.low + 0.06,
    close: previous.high + 0.03,
    volume: 1800,
  };
  return rows;
}

test("HT4 requires crowding plus an actual failed continuation before reversing", () => {
  const rows = exhaustionRows();
  const [exhaustion] = evaluateAdvancedHumanTraders(baseInput(rows, {
    futuresPrice: rows.at(-1)!.close,
    timeframeTrend15m: 0.78,
    timeframeTrend1h: 0.04,
    timeframeTrend4h: -0.42,
    multiTimeframeTrend: 0.32,
    fundingRate: 0.00022,
    openInterestChangePct: 2.4,
    spotCvdRatio: -0.018,
    orderBookImbalance: -0.025,
    optionsIvPercentile: 0.83,
  }));
  assert.equal(exhaustion.strategyMeta.playbookId, "HT4_EXHAUSTION_ANTI_CROWD");
  assert.equal(exhaustion.side, "SHORT");
  assert.equal(exhaustion.strategyMeta.triggerActive, true);
  assert.equal(exhaustion.state, "ready");

  const noFailureRows = candles();
  const [noFailure] = evaluateAdvancedHumanTraders(baseInput(noFailureRows, {
    futuresPrice: noFailureRows.at(-1)!.close,
    timeframeTrend15m: 0.78,
    timeframeTrend1h: 0.04,
    timeframeTrend4h: -0.42,
    fundingRate: 0.00022,
    openInterestChangePct: 2.4,
    spotCvdRatio: -0.018,
    orderBookImbalance: -0.025,
    optionsIvPercentile: 0.83,
  }));
  assert.equal(noFailure.strategyMeta.triggerActive, false);
  assert.notEqual(noFailure.state, "ready");
});

test("HT5 lets 4h/1h choose direction while 15m/5m only time the pullback", () => {
  const rows = swingRows();
  const signals = evaluateAdvancedHumanTraders(baseInput(rows, {
    futuresPrice: rows.at(-1)!.close,
    timeframeTrend15m: -0.18,
    timeframeTrend1h: 0.48,
    timeframeTrend4h: 0.72,
    multiTimeframeTrend: 0.12,
    spotCvdRatio: 0.012,
    orderBookImbalance: 0.02,
    benchmarkMomentum: 0.5,
    marketAdvancingRatio: 0.55,
  }));
  const swing = signals.find((signal) => signal.strategyMeta.playbookId === "HT5_HIGHER_TIMEFRAME_SWING")!;
  assert.equal(swing.side, "LONG");
  assert.equal(swing.strategyMeta.triggerActive, true);
  assert.equal(swing.state, "ready");
  assert.ok(swing.entryPlan?.maxHoldingMinutes === 480);
  assert.ok(swing.entryPlan?.riskReward === 3);
});

test("emergency macro risk blocks both advanced traders", () => {
  const rows = exhaustionRows();
  const signals = evaluateAdvancedHumanTraders(baseInput(rows, {
    futuresPrice: rows.at(-1)!.close,
    timeframeTrend15m: 0.78,
    timeframeTrend1h: 0.04,
    timeframeTrend4h: -0.42,
    fundingRate: 0.0002,
    openInterestChangePct: 2,
    spotCvdRatio: -0.02,
    orderBookImbalance: -0.03,
    optionsIvPercentile: 0.8,
    macroEventRisk: 1,
  }));
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.state === "blocked"));
  assert.ok(signals.every((signal) => signal.side === "WAIT"));
  assert.ok(signals.every((signal) => signal.blockers.includes("EMERGENCY_EVENT_RISK")));
});
