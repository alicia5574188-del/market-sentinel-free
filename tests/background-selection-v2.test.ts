import assert from "node:assert/strict";
import test from "node:test";
import { chooseBackgroundDeepUniverse, snapshotBackgroundUniverse } from "../lib/background-selection.ts";
import type { UniverseTicker } from "../lib/gate-client.ts";

function ticker(symbol: string, coarseScore: number, changePercentage: number, state: UniverseTicker["state"] = "observing"): UniverseTicker {
  return {
    symbol,
    price: 100,
    changePercentage,
    volumeUsd: 100_000_000,
    fundingRate: 0.0001,
    basisPct: 0,
    coarseScore,
    confidence: 60,
    state,
    stateLabel: state === "blocked" ? "风险拦截" : state === "pre_alert" ? "初筛预警" : "持续观察",
    side: state === "pre_alert" ? (coarseScore >= 0 ? "LONG" : "SHORT") : "WAIT",
  };
}

test("free background deep scan assigns anchor, strongest anomaly and fastest mover", () => {
  const previous = snapshotBackgroundUniverse([
    ticker("BTC_USDT", 0.10, 0.8),
    ticker("ETH_USDT", 0.05, 0.5),
    ticker("A_USDT", 0.86, 6.0, "pre_alert"),
    ticker("B_USDT", -0.42, -2.0, "pre_alert"),
    ticker("C_USDT", 0.22, 1.2),
  ]);
  const universe = [
    ticker("BTC_USDT", 0.12, 0.9),
    ticker("ETH_USDT", 0.04, 0.4),
    ticker("A_USDT", 0.90, 6.2, "pre_alert"),
    ticker("B_USDT", 0.38, 1.1, "pre_alert"),
    ticker("C_USDT", 0.25, 1.3),
  ];

  const selected = chooseBackgroundDeepUniverse(universe, ["BTC_USDT", "ETH_USDT"], [], 3, 0, previous);
  assert.deepEqual(selected.map((item) => item.symbol), ["BTC_USDT", "A_USDT", "B_USDT"]);
});

test("cold start keeps three distinct slots by rotating the remaining universe", () => {
  const universe = [
    ticker("BTC_USDT", 0.08, 0.5),
    ticker("ETH_USDT", 0.06, 0.4),
    ticker("A_USDT", -0.75, -5.2, "pre_alert"),
    ticker("B_USDT", 0.24, 1.7),
    ticker("C_USDT", -0.18, -1.2),
  ];

  const selected = chooseBackgroundDeepUniverse(universe, ["BTC_USDT", "ETH_USDT"], [], 3, 1, {});
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map((item) => item.symbol)).size, 3);
  assert.equal(selected[0].symbol, "BTC_USDT");
  assert.equal(selected[1].symbol, "A_USDT");
});

test("blocked extreme funding symbols do not consume a discovery slot", () => {
  const previous = snapshotBackgroundUniverse([
    ticker("BTC_USDT", 0.1, 0.5),
    ticker("BLOCKED_USDT", -0.8, -6.5, "blocked"),
    ticker("MOVE_USDT", -0.1, -0.5),
    ticker("A_USDT", 0.5, 3.5, "pre_alert"),
  ]);
  const universe = [
    ticker("BTC_USDT", 0.12, 0.6),
    ticker("BLOCKED_USDT", 0.95, 8.5, "blocked"),
    ticker("MOVE_USDT", 0.35, 2.1, "pre_alert"),
    ticker("A_USDT", 0.55, 3.7, "pre_alert"),
  ];

  const selected = chooseBackgroundDeepUniverse(universe, ["BTC_USDT"], [], 3, 0, previous);
  assert.ok(!selected.some((item) => item.symbol === "BLOCKED_USDT"));
  assert.ok(selected.some((item) => item.symbol === "MOVE_USDT"));
});
