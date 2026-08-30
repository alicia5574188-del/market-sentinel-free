import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("HTE 3.1 is the sole new-entry authority and Gate live follows the same lifecycle", async () => {
  const [liveRepository, liveEngine, growthRepository, scanner, strategy] = await Promise.all([
    readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/live-trading-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sentinel-v2-strategy.ts", import.meta.url), "utf8"),
  ]);
  assert.match(liveRepository, /import \{ hte31Trades \} from "\.\.\/db\/hte31-schema"/);
  assert.match(liveRepository, /db\.select\(\)\.from\(hte31Trades\)[\s\S]*eq\(hte31Trades\.status, "holding"\)/);
  assert.match(liveRepository, /netMovePct:\s*hte31Trades\.netMovePct[\s\S]*eq\(hte31Trades\.status, "closed"\)/);
  assert.match(liveRepository, /await requireHte31Candidate\(values\.tradeCaseId\)/);
  assert.match(liveRepository, /export async function getLiveLinkedTrade/);
  assert.match(liveRepository, /if \(hte\) return \{ source: "hte31", \.\.\.hte \}/);
  assert.doesNotMatch(liveRepository, /HTE31_LIVE_BRIDGE_MODEL|ensureHte31LiveBridge|syncActiveHte31LiveBridges|insert\(tradeCases\)/);
  assert.doesNotMatch(liveRepository, /eq\(tradeCases\.simulationModel, "contract_v2"\)/);
  assert.doesNotMatch(liveRepository, /entryRiskMultiplier\(/);
  assert.match(liveEngine, /await getLiveLinkedTrade\(order\.tradeCaseId\)/);
  assert.doesNotMatch(liveEngine, /await getTrade\(order\.tradeCaseId\)/);
  assert.match(growthRepository, /processDecision\(growthPacket\(packet,\s*selected,\s*governor\),\s*settings\)/);
  assert.doesNotMatch(growthRepository, /simulationModel:\s*strategyModel/);
  assert.match(scanner, /function legacyObservationOnly/);
  assert.match(scanner, /Strategy 2\.0 唯一开仓权/);
  assert.match(scanner, /const basePacket\s*=\s*openSymbols\.includes\(packet\.symbol\)\s*\?\s*packet\s*:\s*legacyObservationOnly\(packet\)/);
  assert.match(scanner, /evaluateSentinelV2Strategies\(/);
  assert.match(scanner, /processShadowStrategies\(packet,\s*growthCandles,\s*v2\.signals,\s*settings\)/);
  assert.match(strategy, /evaluateHumanTraderPool\(input\)/);
  assert.match(strategy, /human-trader-authority/);
  assert.match(strategy, /At most one human trader owns a symbol/);
  assert.doesNotMatch(strategy, /Strategy 2\.0 综合许可/);
});

test("legacy strategy trades are archived instead of contaminating the Human Trader account", async () => {
  const growthRepository = await readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8");
  assert.match(growthRepository, /LEGACY_SHADOW_PREFIX\s*=\s*"shadow_v3:"/);
  assert.match(growthRepository, /HUMAN_REGIME_PREFIX\s*=\s*"S2\|HT"/);
  assert.match(growthRepository, /notLike\(tradeCases\.regime, `\$\{HUMAN_REGIME_PREFIX\}%`\)/);
  assert.match(growthRepository, /status:\s*"archived"/);
  assert.match(growthRepository, /activeKey:\s*null/);
  assert.match(growthRepository, /learningApplied:\s*true/);
  assert.match(growthRepository, /listOpenShadowTradeSymbols\(\)[\s\S]*return \[\] as string\[\]/);
});

test("new HTE live lineage bypasses tradeCases while historical live lineage remains readable", async () => {
  const liveRepository = await readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8");
  assert.match(liveRepository, /await requireHte31Candidate\(values\.tradeCaseId\)/);
  assert.doesNotMatch(liveRepository, /insert\(tradeCases\)|hte31_live_bridge|HTE31_LIVE_BRIDGE_MODEL/);
  const resolver = liveRepository.match(/export async function getLiveLinkedTrade[\s\S]*?\n}\n\nexport async function getLiveControl/)?.[0] ?? "";
  assert.match(resolver, /from\(hte31Trades\)/);
  assert.match(resolver, /if \(hte\) return \{ source: "hte31", \.\.\.hte \}/);
  assert.match(resolver, /from\(tradeCases\)/);
  assert.match(resolver, /source: "legacy"/);
});

test("archiving simulation history never mutates the separate Gate live order tables", async () => {
  const growthRepository = await readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8");
  const retire = growthRepository.match(/export async function retireLegacyShadowTrades\(\)[\s\S]*?return shadow\.length \+ oldContract\.length;\n}/)?.[0] ?? "";
  assert.match(retire, /tradeCases/);
  assert.doesNotMatch(retire, /liveOrders|liveTradingControl|deleteLiveCredential/);
});
