import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSentinelV2, type Candle, type SentinelV2Input } from "../lib/sentinel-v2-engine.ts";

const FIVE_MINUTES = 5 * 60_000;

function candles(options: { direction?: number; oldRange?: number; recentRange?: number; breakout?: "up" | "down" | null } = {}) {
  const direction = options.direction ?? 0.15;
  const oldRange = options.oldRange ?? 1.5;
  const recentRange = options.recentRange ?? 1.0;
  const now = 1_800_000_000_000;
  const result: Candle[] = [];
  let price = 100;
  for (let index = 0; index < 80; index += 1) {
    const range = index < 45 ? oldRange : recentRange;
    const drift = direction + Math.sin(index / 4) * range * 0.08;
    const open = price;
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + range * 0.35;
    const low = Math.min(open, close) - range * 0.35;
    result.push({ time: now - (80 - index) * FIVE_MINUTES, open, high, low, close, volume: 1000 + index * 3 });
    price = close;
  }
  if (options.breakout) {
    const previous = result.at(-2)!;
    const last = result.at(-1)!;
    const delta = options.breakout === "up" ? recentRange * 1.8 : -recentRange * 1.8;
    last.open = previous.close;
    last.close = previous.close + delta;
    last.high = Math.max(last.open, last.close) + recentRange * 0.2;
    last.low = Math.min(last.open, last.close) - recentRange * 0.2;
    last.volume = 2600;
  }
  return { result, now };
}

function baseInput(overrides: Partial<SentinelV2Input> = {}): SentinelV2Input {
  const generated = candles();
  return {
    symbol: "BTC_USDT",
    observedAt: generated.now + FIVE_MINUTES,
    futuresPrice: generated.result.at(-1)!.close,
    volumeUsd: 2_000_000_000,
    changePercentage: 3,
    fundingRate: 0.0001,
    openInterestChangePct: 1.2,
    spotCvdRatio: 0.08,
    orderBookImbalance: 0.10,
    liquidationImbalance: 0.05,
    multiTimeframeTrend: 0.72,
    benchmarkMomentum: 2.2,
    macroEventRisk: 0.1,
    dataQuality: 0.95,
    candles5m: generated.result,
    breadth: {
      sampleSize: 50,
      advanceRatio: 0.70,
      declineRatio: 0.30,
      strongAdvanceRatio: 0.36,
      strongDeclineRatio: 0.08,
      averageChangePct: 2.1,
    },
    ...overrides,
  };
}

test("V2 identifies a healthy bullish environment without forcing a trade", () => {
  const evaluation = evaluateSentinelV2(baseInput());
  assert.equal(evaluation.context.directionBias, "LONG");
  assert.ok(["bull_trend", "expansion"].includes(evaluation.context.regime));
  assert.ok(["GREEN", "BLUE", "YELLOW"].includes(evaluation.context.permission));
  assert.ok(evaluation.opportunities.some((item) => item.playbookId === "trend_pullback"));
});

test("V2 fails closed when data quality is unsafe", () => {
  const evaluation = evaluateSentinelV2(baseInput({ dataQuality: 0.45 }));
  assert.equal(evaluation.context.permission, "RED");
  assert.equal(evaluation.primaryOpportunity?.state, "REJECT");
  assert.ok(evaluation.primaryOpportunity?.rejectReasons.includes("DATA_UNSAFE"));
});

test("V2 emergency macro risk blocks new entries", () => {
  const evaluation = evaluateSentinelV2(baseInput({ macroEventRisk: 0.96 }));
  assert.equal(evaluation.context.permission, "RED");
  assert.equal(evaluation.primaryOpportunity?.state, "REJECT");
});

test("V2 raises breadth and flow warnings when internals oppose an uptrend", () => {
  const evaluation = evaluateSentinelV2(baseInput({
    spotCvdRatio: -0.12,
    orderBookImbalance: -0.15,
    openInterestChangePct: 5.5,
    breadth: {
      sampleSize: 60,
      advanceRatio: 0.25,
      declineRatio: 0.75,
      strongAdvanceRatio: 0.05,
      strongDeclineRatio: 0.45,
      averageChangePct: -2.4,
    },
  }));
  const types = new Set(evaluation.context.warnings.map((warning) => warning.type));
  assert.ok(types.has("breadth_shock"));
  assert.ok(types.has("spot_flow"));
  assert.ok(evaluation.context.transitionRisk >= 35);
});

test("V2 exposes compression breakout as a separate core playbook", () => {
  const generated = candles({ direction: 0.01, oldRange: 2.2, recentRange: 0.25, breakout: "up" });
  const evaluation = evaluateSentinelV2(baseInput({
    observedAt: generated.now + FIVE_MINUTES,
    futuresPrice: generated.result.at(-1)!.close,
    candles5m: generated.result,
    multiTimeframeTrend: 0.12,
    changePercentage: 0.8,
    spotCvdRatio: 0.08,
    openInterestChangePct: 1,
  }));
  const breakout = evaluation.opportunities.find((item) => item.playbookId === "compression_breakout");
  assert.ok(breakout);
  assert.ok(["TRADE", "WATCH", "REJECT"].includes(breakout.state));
  assert.ok(breakout.environmentFit >= 0 && breakout.environmentFit <= 100);
});

test("V2 ignores an unfinished final 5m candle", () => {
  const input = baseInput();
  const complete = evaluateSentinelV2(input);
  const poisoned = [...input.candles5m, {
    time: input.observedAt,
    open: input.futuresPrice,
    high: input.futuresPrice * 1.5,
    low: input.futuresPrice * 0.5,
    close: input.futuresPrice * 0.55,
    volume: 1_000_000,
  }];
  const withIncomplete = evaluateSentinelV2({ ...input, candles5m: poisoned });
  assert.equal(withIncomplete.context.regime, complete.context.regime);
  assert.equal(withIncomplete.context.transitionRisk, complete.context.transitionRisk);
});
