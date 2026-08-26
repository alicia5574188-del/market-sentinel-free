import assert from "node:assert/strict";
import test from "node:test";
import { buildSentinelV2MarketContext } from "../lib/sentinel-v2-core.ts";
import { evaluateSentinelV2Strategies } from "../lib/sentinel-v2-strategy.ts";
import type { UniverseTicker } from "../lib/gate-client.ts";
import type { Candle } from "../lib/signal-engine.ts";

const observedAt = Date.UTC(2026, 7, 26, 6, 0, 0);

function healthyUniverse(): UniverseTicker[] {
  const changes = [4.1, 3.8, 3.4, 2.9, 2.7, 2.5, 2.2, 1.9, 1.7, 1.4, 1.2, 0.9];
  return changes.map((changePercentage, index) => ({
    symbol: `C${index + 10}_USDT`,
    price: 100 + index,
    changePercentage,
    volumeUsd: 100_000_000 - index * 100_000,
    fundingRate: 0.0001,
    basisPct: 0,
    coarseScore: Math.max(-1, Math.min(1, changePercentage / 7)),
    confidence: 60,
    state: "observing",
    stateLabel: "持续观察",
    side: "WAIT",
  }));
}

function pullbackCandles(): Candle[] {
  const count = 90;
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.01 + Math.sin(index / 2) * 0.15;
    const open = close - 0.006;
    return {
      time: Math.floor((observedAt - (count - index) * 5 * 60_000) / 1000),
      open,
      high: Math.max(open, close) + 0.12,
      low: Math.min(open, close) - 0.12,
      close,
      volume: 1_000 + (index % 5) * 40,
    };
  });
}

test("completed 5m candles can flow through P1 into a V2 TRADE", () => {
  const candles5m = pullbackCandles();
  const futuresPrice = candles5m.at(-1)!.close;
  const market = buildSentinelV2MarketContext({
    observedAt,
    universe: healthyUniverse(),
    benchmarkMomentum: 3.2,
    optionsIvPercentile: 0.48,
    macroEventRisk: 0.1,
  });

  const result = evaluateSentinelV2Strategies({
    symbol: "BTC_USDT",
    observedAt,
    futuresPrice,
    volumeUsd: 2_000_000_000,
    changePercentage: 3.2,
    fundingRate: 0.0001,
    openInterestChangePct: 1.2,
    spotCvdRatio: 0.05,
    orderBookImbalance: 0.08,
    liquidationImbalance: 0.05,
    multiTimeframeTrend: 0.58,
    benchmarkMomentum: 3.2,
    macroEventRisk: 0.1,
    dataQuality: 0.94,
    candles5m,
  }, {
    market,
    openTrades: [],
  });

  const p1Signal = result.signals.find((item) => item.strategyId === "trend_pullback");
  const p1Opportunity = result.opportunities.find((item) => item.playbook === "P1_TREND_PULLBACK");
  assert.ok(p1Signal);
  assert.ok(p1Opportunity);
  assert.equal(market.permission, "GREEN");
  assert.equal(p1Signal.state, "ready");
  assert.equal(p1Signal.entryPlan?.ready, true);
  assert.equal(p1Opportunity.state, "TRADE");
  assert.ok(p1Opportunity.opportunityScore >= 74);
  assert.ok(p1Opportunity.riskMultiplier > 0);
});
