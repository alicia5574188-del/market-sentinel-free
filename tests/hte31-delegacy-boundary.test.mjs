import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("HTE31 scanner owns candle and signal types instead of importing Strategy2 domains", () => {
  const scanner = source("../lib/hte31-scanner.ts");
  assert.match(scanner, /Hte31Candle/);
  assert.match(scanner, /Hte31Signal/);
  assert.match(scanner, /hte31-types\.ts/);
  assert.doesNotMatch(scanner, /strategy-2-engine|signal-engine/);
});

test("HTE31 primitives do not import retired strategy domains", () => {
  const types = source("../lib/hte31-types.ts");
  const regime = source("../lib/hte31-regime.ts");
  assert.doesNotMatch(types, /strategy-2|shadow-strategy|signal-engine|trade-lifecycle/);
  assert.doesNotMatch(regime, /strategy-2|shadow-strategy|signal-engine|trade-lifecycle/);
});
