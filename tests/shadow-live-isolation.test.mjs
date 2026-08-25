import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Gate live candidates remain baseline contract_v2 only", async () => {
  const [liveRepository, shadowRepository, scanner] = await Promise.all([
    readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8"),
  ]);
  assert.match(liveRepository, /eq\(tradeCases\.simulationModel, "contract_v2"\)/);
  assert.match(shadowRepository, /const SHADOW_PREFIX = "shadow_v3:"/);
  assert.match(shadowRepository, /simulationModel: strategyModel/);
  assert.match(shadowRepository, /shadowOnly: true/);
  assert.match(scanner, /processDecision\(packet, settings\)/);
  assert.match(scanner, /processShadowStrategies\(packet, shadowCandles, shadowSignals, settings\)/);
});

test("strategy lab cannot auto-promote into live execution", async () => {
  const promotion = await readFile(new URL("../lib/strategy-promotion.ts", import.meta.url), "utf8");
  const shadowRepository = await readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8");
  assert.match(promotion, /达到实盘候选线（仍需人工批准）/);
  assert.doesNotMatch(shadowRepository, /createLiveOrderIntent|armLiveControl|submitCandidate/);
});
