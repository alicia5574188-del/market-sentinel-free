import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Sentinel V2 is the sole new-entry authority while existing positions keep the normal lifecycle", async () => {
  const [liveRepository, growthRepository, scanner, v2Strategy] = await Promise.all([
    readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sentinel-v2-strategy.ts", import.meta.url), "utf8"),
  ]);
  assert.match(liveRepository, /eq\(tradeCases\.simulationModel, "contract_v2"\)/);
  assert.match(liveRepository, /v2RiskMultiplier\(row\.entryMetricsJson\)/);
  assert.match(growthRepository, /processDecision\(growthPacket\(packet, selected\), settings\)/);
  assert.doesNotMatch(growthRepository, /simulationModel: strategyModel/);
  assert.match(scanner, /function legacyObservationOnly/);
  assert.match(scanner, /Sentinel V2 唯一开仓权/);
  assert.match(scanner, /const basePacket = openSymbols\.includes\(packet\.symbol\) \? packet : legacyObservationOnly\(packet\)/);
  assert.match(scanner, /evaluateSentinelV2Strategies\(/);
  assert.match(scanner, /processShadowStrategies\(packet, growthCandles, v2\.signals, settings\)/);
  assert.match(v2Strategy, /opportunity\.state === "TRADE"/);
  assert.match(v2Strategy, /Sentinel V2 环境许可/);
});

test("legacy V3 shadow positions are retired instead of creating parallel accounts", async () => {
  const growthRepository = await readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8");
  assert.match(growthRepository, /LEGACY_SHADOW_PREFIX = "shadow_v3:"/);
  assert.match(growthRepository, /status: "archived"/);
  assert.match(growthRepository, /activeKey: null/);
  assert.match(growthRepository, /listOpenShadowTradeSymbols\(\)[\s\S]*return \[\] as string\[\]/);
});
