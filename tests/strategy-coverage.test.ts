import assert from "node:assert/strict";
import test from "node:test";
import { buildStrategyCoverageReport, classifyMarketState, deriveMarketStateFeatures, type CoverageTrade, type MarketStateFeatures } from "../lib/strategy-coverage.ts";

const compression: MarketStateFeatures = { trendRate: 0.001, trendEfficiency: 0.35, volatilityRatio: 0.7,
  rangePosition: 0.5, marketBreadth: 0.5, marketMedianMove: 0 };
const expansion: MarketStateFeatures = { ...compression, volatilityRatio: 1.6 };
const at = Date.UTC(2026, 0, 1);
const splitAt = at + 14 * 86_400_000;

function rows(strategyId: string, state: MarketStateFeatures, returns: number[], start: number): CoverageTrade[] {
  return returns.map((netReturnRate, index) => ({ strategyId, strategyName: strategyId, symbol: index % 2 ? "BTC_USDT" : "ETH_USDT",
    side: index % 2 ? "LONG" : "SHORT", openedAt: start + index * 86_400_000, netReturnRate, state }));
}

test("market state classification is causal and independent of trade outcome", () => {
  assert.deepEqual(classifyMarketState(compression), { key: "COMPRESSION:MIXED:CENTER", phase: "COMPRESSION", crowding: "MIXED", location: "CENTER" });
  assert.equal(classifyMarketState({ ...expansion, rangePosition: 0.9 }).key, "EXPANSION:MIXED:HIGH_EDGE");
});

test("research and runtime can derive the same state features from one completed-candle path", () => {
  const candles = Array.from({ length: 48 }, (_, index) => ({ open: 100 + index, high: 101.2 + index,
    low: 99.8 + index, close: 100.8 + index }));
  const features = deriveMarketStateFeatures(candles, 0.7, 0.002);
  assert.ok(features);
  assert.equal(features.marketBreadth, 0.7);
  assert.equal(features.marketMedianMove, 0.002);
  assert.ok(features.trendEfficiency > 0.9);
});

test("coverage accepts a strategy only in its held-out-positive state and leaves a negative state as a gap", () => {
  const win = [0.02, -0.005, 0.018, -0.004, 0.017, -0.003, 0.016, -0.004];
  const lose = [-0.02, 0.004, -0.018, 0.003, -0.017, 0.002, -0.016, 0.003];
  const trades = [
    ...rows("compression_edge", compression, win, at),
    ...rows("compression_edge", compression, win, splitAt),
    ...rows("expansion_trial", expansion, win, at),
    ...rows("expansion_trial", expansion, lose, splitAt),
  ];
  const report = buildStrategyCoverageReport(trades, splitAt, { discoveryTrades: 6, validationTrades: 6,
    knownDiscoveryOpportunities: 6, knownValidationOpportunities: 6, validationPositivePeriods: 1 });
  assert.deepEqual(report.acceptedCells.map((cell) => `${cell.strategyId}:${cell.state.phase}`), ["compression_edge:COMPRESSION"]);
  assert.deepEqual(report.gaps.map((gap) => gap.state.phase), ["EXPANSION"]);
  const rejected = report.cells.find((cell) => cell.strategyId === "expansion_trial" && cell.state.phase === "EXPANSION");
  assert.ok(rejected?.blockers.includes("VALIDATION_EDGE"));
});

test("coverage rejects a one-symbol or one-period result even when its profit factor is positive", () => {
  const trades = [...rows("concentrated", compression, [0.02, -0.002, 0.02, -0.002], at),
    ...rows("concentrated", compression, [0.02, -0.002, 0.02, -0.002], splitAt).map((row) => ({ ...row, symbol: "BTC_USDT", openedAt: splitAt }))];
  const report = buildStrategyCoverageReport(trades, splitAt, { discoveryTrades: 4, validationTrades: 4,
    knownDiscoveryOpportunities: 4, knownValidationOpportunities: 1, validationPositivePeriods: 2 });
  const result = report.cells.find((cell) => cell.strategyId === "concentrated");
  assert.equal(result?.accepted, false);
  assert.ok(result?.blockers.includes("SYMBOL_CONCENTRATION"));
  assert.ok(result?.blockers.includes("TIME_CONCENTRATION"));
});
