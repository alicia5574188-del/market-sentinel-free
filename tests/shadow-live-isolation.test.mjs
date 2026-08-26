import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Sentinel V2 is the only new-entry strategy and still joins the normal contract_v2 live path", async () => {
  const [liveRepository, growthRepository, scanner] = await Promise.all([
    readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8"),
  ]);
  assert.match(liveRepository, /eq\(tradeCases\.simulationModel, "contract_v2"\)/);
  assert.match(growthRepository, /processDecision\(growthPacket\(packet, selected, evaluation\), settings\)/);
  assert.match(growthRepository, /Sentinel Growth V2/);
  assert.match(growthRepository, /only V2 TRADE|只有 V2 TRADE/);
  assert.doesNotMatch(growthRepository, /simulationModel: strategyModel/);
  assert.doesNotMatch(scanner, /const baseResult = await processDecision\(packet, settings\)/);
  assert.match(scanner, /evaluateSentinelV2\(/);
  assert.match(scanner, /processShadowStrategies\(packet, evaluation, settings\)/);
  assert.match(scanner, /only Sentinel V2 can create a new trade case/);
});

test("legacy V3 shadow positions are retired instead of creating parallel accounts", async () => {
  const growthRepository = await readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8");
  assert.match(growthRepository, /LEGACY_SHADOW_PREFIX = "shadow_v3:"/);
  assert.match(growthRepository, /status: "archived"/);
  assert.match(growthRepository, /activeKey: null/);
  assert.match(growthRepository, /listOpenShadowTradeSymbols\(\)[\s\S]*return \[\] as string\[\]/);
});
