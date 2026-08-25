import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("all growth modules join the normal contract_v2 lifecycle and live path", async () => {
  const [liveRepository, growthRepository, scanner] = await Promise.all([
    readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8"),
  ]);
  assert.match(liveRepository, /eq\(tradeCases\.simulationModel, "contract_v2"\)/);
  assert.match(growthRepository, /processDecision\(growthPacket\(packet, selected\), settings\)/);
  assert.match(growthRepository, /成长策略 · \$\{signal\.label\}/);
  assert.match(growthRepository, /一套订单、一套学习、一套实盘风控/);
  assert.doesNotMatch(growthRepository, /simulationModel: strategyModel/);
  assert.match(scanner, /processDecision\(packet, settings\)/);
  assert.match(scanner, /processShadowStrategies\(packet, shadowCandles, shadowSignals, settings\)/);
});

test("legacy V3 shadow positions are retired instead of creating parallel accounts", async () => {
  const growthRepository = await readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8");
  assert.match(growthRepository, /LEGACY_SHADOW_PREFIX = "shadow_v3:"/);
  assert.match(growthRepository, /status: "archived"/);
  assert.match(growthRepository, /activeKey: null/);
  assert.match(growthRepository, /listOpenShadowTradeSymbols\(\)[\s\S]*return \[\] as string\[\]/);
});
