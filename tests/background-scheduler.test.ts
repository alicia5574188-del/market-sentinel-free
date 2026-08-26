import test from "node:test";
import assert from "node:assert/strict";
import { chooseBackgroundDeepUniverse } from "../lib/background-selection.ts";
import type { UniverseTicker } from "../lib/gate-client.ts";

function ticker(symbol: string, coarseScore: number): UniverseTicker {
  return {
    symbol,
    price: 1,
    changePercentage: coarseScore * 10,
    volumeUsd: 1_000_000,
    fundingRate: 0,
    basisPct: 0,
    coarseScore,
    confidence: 60,
    state: "observing",
    stateLabel: "持续观察",
    side: "WAIT",
  };
}

const universe = [
  ticker("BTC_USDT", 0.12),
  ticker("ETH_USDT", -0.18),
  ticker("SOL_USDT", 0.22),
  ticker("HYPE_USDT", 0.31),
  ticker("PUMP_USDT", 0.81),
  ticker("BEAT_USDT", -0.73),
  ticker("TAO_USDT", 0.42),
];

test("free background batch caps deep fan-out at three while preserving anchor and strongest anomaly", () => {
  const selected = chooseBackgroundDeepUniverse(
    universe,
    ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
    ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
    8,
    0,
  );
  assert.deepEqual(selected.map((item) => item.symbol), ["ETH_USDT", "PUMP_USDT", "BTC_USDT"]);
});

test("cold-start third sensor slot still rotates through coverage candidates", () => {
  const selected = chooseBackgroundDeepUniverse(
    universe,
    ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
    ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
    3,
    2,
  );
  assert.deepEqual(selected.map((item) => item.symbol), ["ETH_USDT", "PUMP_USDT", "SOL_USDT"]);
});

test("without a prior velocity snapshot the anchor and anomaly stay fixed while coverage rotates", () => {
  const first = chooseBackgroundDeepUniverse(
    universe,
    ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
    [],
    3,
    0,
  );
  const second = chooseBackgroundDeepUniverse(
    universe,
    ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
    [],
    3,
    1,
  );
  assert.deepEqual(first.map((item) => item.symbol), ["ETH_USDT", "PUMP_USDT", "BTC_USDT"]);
  assert.deepEqual(second.map((item) => item.symbol), ["ETH_USDT", "PUMP_USDT", "SOL_USDT"]);
});
