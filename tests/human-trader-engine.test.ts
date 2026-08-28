import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHumanTraderPool } from "../lib/human-trader-engine.ts";
import type { Strategy2Input } from "../lib/strategy-2-engine.ts";
import type { Candle } from "../lib/signal-engine.ts";

const observedAt = Date.UTC(2026, 7, 28, 6, 0, 0);

function baseCandles(count = 90): Candle[] {
  const rows: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    const close = 100 + i * 0.045 + Math.sin(i / 4) * 0.05;
    rows.push({
      time: Math.floor((observedAt - (count - i) * 300_000) / 1000),
      open: close - 0.02,
      high: close + 0.10,
      low: close - 0.11,
      close,
      volume: 1000 + (i % 5) * 40,
    });
  }
  return rows;
}

function input(candles5m: Candle[], patch: Partial<Strategy2Input> = {}): Strategy2Input {
  return {
    symbol: "SOL_USDT",
    observedAt,
    futuresPrice: candles5m.at(-1)?.close ?? 100,
    volumeUsd: 700_000_000,
    changePercentage: 4.2,
    fundingRate: 0.0001,
    openInterestChangePct: 1.1,
    spotCvdRatio: 0.05,
    orderBookImbalance: 0.06,
    liquidationImbalance: 0.02,
    multiTimeframeTrend: 0.72,
    benchmarkMomentum: 1.0,
    macroEventRisk: 0.1,
    dataQuality: 0.95,
    candles5m,
    crossSectionRank: 0.9,
    rotationVelocity: 0.04,
    marketAdvancingRatio: 0.58,
    marketDecliningRatio: 0.42,
    ...patch,
  };
}

function dennisBreakout() {
  const rows = baseCandles();
  const priorHigh = Math.max(...rows.slice(-23, -2).map((row) => row.high));
  const last = rows.at(-1)!;
  rows[rows.length - 1] = { ...last, open: priorHigh + 0.01, low: priorHigh - 0.05, close: priorHigh + 0.30, high: priorHigh + 0.36, volume: 2400 };
  return rows;
}

function turtleSoupFailure() {
  const rows = baseCandles();
  const anchorIndex = rows.length - 18;
  const anchor = rows[anchorIndex];
  const priorHigh = anchor.close + 0.75;
  rows[anchorIndex] = { ...anchor, high: priorHigh, close: priorHigh - 0.18, open: priorHigh - 0.25, low: priorHigh - 0.35, volume: 1450 };
  for (let index = anchorIndex + 1; index < rows.length - 2; index += 1) {
    const row = rows[index];
    const close = Math.min(row.close, priorHigh - 0.22);
    rows[index] = { ...row, open: close - 0.02, high: Math.min(row.high, priorHigh - 0.12), low: close - 0.12, close };
  }
  const sweep = rows.at(-2)!;
  const reclaim = rows.at(-1)!;
  rows[rows.length - 2] = { ...sweep, open: priorHigh - 0.05, low: priorHigh - 0.18, high: priorHigh + 0.18, close: priorHigh + 0.06, volume: 2500 };
  rows[rows.length - 1] = { ...reclaim, open: priorHigh + 0.02, high: priorHigh + 0.04, low: priorHigh - 0.34, close: priorHigh - 0.24, volume: 2200 };
  return rows;
}

test("Human Trader Engine always evaluates exactly three independent traders", () => {
  const signals = evaluateHumanTraderPool(input(baseCandles()));
  assert.equal(signals.length, 3);
  assert.deepEqual(signals.map((signal) => signal.strategyMeta.playbookId), [
    "HT1_DENNIS_TREND",
    "HT2_RASCHKE_PULLBACK",
    "HT3_TURTLE_SOUP",
  ]);
  assert.ok(signals.every((signal) => (signal.strategyMeta.supportingPlaybooks ?? []).length === 0));
  assert.ok(signals.every((signal) => (signal.strategyMeta.strategyConflict ?? 0) === 0));
});

test("Dennis only becomes ready after a completed close outside the old range", () => {
  const quiet = evaluateHumanTraderPool(input(baseCandles())).find((signal) => signal.strategyMeta.playbookId === "HT1_DENNIS_TREND")!;
  assert.notEqual(quiet.state, "ready");
  const rows = dennisBreakout();
  const triggered = evaluateHumanTraderPool(input(rows)).find((signal) => signal.strategyMeta.playbookId === "HT1_DENNIS_TREND")!;
  assert.equal(triggered.strategyMeta.triggerActive, true);
  assert.equal(triggered.state, "ready");
  assert.ok(triggered.entryPlan?.checks.some((check) => check.key === "dennis-breakout" && check.required && check.passed));
});

test("Turtle Soup requires mature sweep, deep reclaim, volume and multi-source reversal confirmation", () => {
  const rows = turtleSoupFailure();
  const soup = evaluateHumanTraderPool(input(rows, {
    multiTimeframeTrend: 0.05,
    spotCvdRatio: -0.03,
    orderBookImbalance: -0.05,
    changePercentage: 0.3,
  })).find((signal) => signal.strategyMeta.playbookId === "HT3_TURTLE_SOUP")!;
  assert.equal(soup.strategyMeta.triggerActive, true);
  assert.equal(soup.side, "SHORT");
  assert.equal(soup.state, "ready");
  assert.ok(soup.entryPlan?.checks.some((check) => check.key === "soup-mature" && check.passed));
  assert.ok(soup.entryPlan?.checks.some((check) => check.key === "soup-sweep" && check.passed));
  assert.ok(soup.entryPlan?.checks.some((check) => check.key === "soup-reclaim" && check.passed));
  assert.ok(soup.entryPlan?.checks.some((check) => check.key === "soup-volume" && check.passed));
  assert.ok(soup.entryPlan?.checks.some((check) => check.key === "soup-micro" && check.passed));
});

test("Turtle Soup rejects a shallow ordinary poke that the previous implementation would have accepted", () => {
  const rows = turtleSoupFailure();
  const prior = rows.slice(-32, -2);
  const priorHigh = Math.max(...prior.map((row) => row.high));
  const sweep = rows.at(-2)!;
  rows[rows.length - 2] = { ...sweep, high: priorHigh + 0.005, volume: 1200 };
  const soup = evaluateHumanTraderPool(input(rows, {
    multiTimeframeTrend: 0.05,
    spotCvdRatio: -0.03,
    orderBookImbalance: -0.05,
    changePercentage: 0.3,
  })).find((signal) => signal.strategyMeta.playbookId === "HT3_TURTLE_SOUP")!;
  assert.equal(soup.strategyMeta.triggerActive, false);
  assert.notEqual(soup.state, "ready");
});

test("emergency event risk blocks all three traders without fallbacks", () => {
  const signals = evaluateHumanTraderPool(input(dennisBreakout(), { macroEventRisk: 0.99 }));
  assert.ok(signals.every((signal) => signal.state === "blocked"));
  assert.ok(signals.every((signal) => signal.side === "WAIT"));
  assert.ok(signals.every((signal) => signal.blockers.includes("EMERGENCY_EVENT_RISK")));
});
