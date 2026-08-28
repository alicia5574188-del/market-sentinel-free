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

test("free background batch stays capped at three while keeping priority and rotation", () => {
  const selected = chooseBackgroundDeepUniverse(
    universe,
    ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
    ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
    8,
    0,
  );
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map((item) => item.symbol)).size, 3);
  assert.ok(selected.some((item) => item.symbol === "PUMP_USDT"));
  assert.ok(selected.some((item) => /^(BTC|ETH)_USDT$/.test(item.symbol)));
});

test("non-anchor phases reserve at least two rotating discovery slots", () => {
  const phaseOne = chooseBackgroundDeepUniverse(
    universe,
    ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
    [],
    3,
    1,
  );
  const phaseTwo = chooseBackgroundDeepUniverse(
    universe,
    ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
    [],
    3,
    2,
  );
  assert.equal(phaseOne.length, 3);
  assert.equal(phaseTwo.length, 3);
  assert.ok(phaseOne.some((item) => item.symbol === "PUMP_USDT"));
  assert.ok(phaseTwo.some((item) => item.symbol === "PUMP_USDT"));
  assert.notDeepEqual(phaseOne.map((item) => item.symbol), phaseTwo.map((item) => item.symbol));
});

test("six scheduler rotations expand deep coverage beyond the same three leaders", () => {
  const seen = new Set<string>();
  for (let offset = 0; offset < 6; offset += 1) {
    const selected = chooseBackgroundDeepUniverse(
      universe,
      ["BTC_USDT", "ETH_USDT", "SOL_USDT", "HYPE_USDT"],
      [],
      3,
      offset,
    );
    assert.equal(selected.length, 3);
    selected.forEach((item) => seen.add(item.symbol));
  }
  assert.ok(seen.size >= 6, `expected broad coverage, got ${[...seen].join(",")}`);
  assert.ok(seen.has("PUMP_USDT"));
});
