import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("public Human Trader module is now a thin HTE31 compatibility export", () => {
  const compatibility = source("../lib/human-trader-engine.ts");
  assert.match(compatibility, /hte31-human-trader-engine/);
  assert.doesNotMatch(compatibility, /strategy-2-engine|shadow-strategy-engine|signal-engine|trade-lifecycle/);
});

test("HTE31 Human Trader implementation owns its domain dependencies", () => {
  const engine = source("../lib/hte31-human-trader-engine.ts");
  assert.match(engine, /hte31-regime\.ts/);
  assert.match(engine, /hte31-types\.ts/);
  assert.doesNotMatch(engine, /strategy-2-engine|shadow-strategy-engine|signal-engine|trade-lifecycle/);
  assert.match(engine, /rr: 2\.4/);
  assert.match(engine, /rr: 2\.2/);
  assert.match(engine, /rr: 2\.1/);
  assert.match(engine, /minutes: 240/);
  assert.match(engine, /minutes: 180/);
  assert.match(engine, /minutes: 100/);
});

test("HTE31 scanner imports the HTE31 engine and owns candle/signal types directly", () => {
  const scanner = source("../lib/hte31-scanner.ts");
  assert.match(scanner, /hte31-human-trader-engine\.ts/);
  assert.match(scanner, /hte31-advanced-traders\.ts/);
  assert.match(scanner, /evaluateAdvancedHumanTraders/);
  assert.doesNotMatch(scanner, /from "\.\/human-trader-engine\.ts"/);
  assert.match(scanner, /Hte31Candle/);
  assert.match(scanner, /Hte31Signal/);
  assert.match(scanner, /hte31-types\.ts/);
  assert.doesNotMatch(scanner, /strategy-2-engine|signal-engine|from "\.\/repository\.ts"/);
});

test("HTE31 repository and diagnostics no longer import retired strategy types", () => {
  const repository = source("../lib/hte31-repository.ts");
  const diagnostics = source("../lib/hte31-diagnostics.ts");
  for (const file of [repository, diagnostics]) {
    assert.match(file, /settings-repository\.ts/);
    assert.match(file, /hte31-types\.ts/);
    assert.doesNotMatch(file, /strategy-2-engine|signal-engine|from "\.\/human-trader-engine\.ts"|from "\.\/repository\.ts"/);
  }
  assert.match(repository, /Hte31Signal/);
  assert.match(repository, /Hte31Candle/);
  assert.match(diagnostics, /Hte31Signal/);
});

test("HTE31 worker runtime reads settings only from the clean settings repository", () => {
  const workers = source("../worker/hte31-workers.ts");
  const recovery = source("../worker/hte31-recovery-manager.ts");
  for (const file of [workers, recovery]) {
    assert.match(file, /settings-repository/);
    assert.doesNotMatch(file, /lib\/repository/);
  }
  assert.match(recovery, /Hte31Candle/);
  assert.doesNotMatch(recovery, /signal-engine/);
});

test("HTE31 primitives do not import retired strategy domains", () => {
  const types = source("../lib/hte31-types.ts");
  const regime = source("../lib/hte31-regime.ts");
  assert.doesNotMatch(types, /strategy-2|shadow-strategy|signal-engine|trade-lifecycle/);
  assert.doesNotMatch(regime, /strategy-2|shadow-strategy|signal-engine|trade-lifecycle/);
});

test("new HTE31 live orders use direct HTE31 lineage without writing compatibility tradeCases", () => {
  const repository = source("../lib/live-trading-repository.ts");
  const engine = source("../lib/live-trading-engine.ts");
  const schema = source("../db/schema.ts");

  assert.match(repository, /export async function getLiveLinkedTrade/);
  assert.match(repository, /source: "hte31"/);
  assert.match(repository, /source: "legacy"/);
  assert.match(repository, /await requireHte31Candidate\(values\.tradeCaseId\)/);
  assert.doesNotMatch(repository, /hte31BridgeInsert|ensureHte31LiveBridge|syncActiveHte31LiveBridges|HTE31_LIVE_BRIDGE_MODEL/);
  assert.doesNotMatch(repository, /insert\(tradeCases\)/);

  assert.match(engine, /getLiveLinkedTrade/);
  assert.match(engine, /await getLiveLinkedTrade\(order\.tradeCaseId\)/);
  assert.match(engine, /from "\.\/settings-repository"/);
  assert.doesNotMatch(engine, /getSettings, getTrade|await getTrade\(order\.tradeCaseId\)|from "\.\/repository"/);

  // Historical D1 lineage remains readable: no destructive rename/drop is used.
  assert.match(schema, /tradeCaseId: text\("trade_case_id"\)\.notNull\(\)\.unique\(\)/);
});

test("HT4 and HT5 can learn in paper but cannot silently acquire Gate live authority", () => {
  const repository = source("../lib/live-trading-repository.ts");
  assert.match(repository, /HTE31_LIVE_VALIDATED_TRADERS/);
  assert.match(repository, /"dennis_trend", "raschke_pullback", "turtle_soup"/);
  assert.doesNotMatch(repository, /HTE31_LIVE_VALIDATED_TRADERS[^\n]*exhaustion_reversal/);
  assert.doesNotMatch(repository, /HTE31_LIVE_VALIDATED_TRADERS[^\n]*higher_timeframe_swing/);
  assert.match(repository, /HT4\/HT5 仍在模拟验证阶段，禁止直接进入 Gate 实盘/);
});

test("retired UI overlays and patch styles are physically absent", () => {
  for (const path of [
    "../app/human-trader.css",
    "../app/live-orders-inline.tsx",
    "../app/bottom-nav-viewport-fix.css",
    "../app/polish.css",
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} should stay deleted`);
  }
});
