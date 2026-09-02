import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { liveDirectionalExposureBlockReason } from "../lib/live-portfolio-risk.ts";

test("three same-direction live positions block a fourth correlated entry", () => {
  assert.match(liveDirectionalExposureBlockReason(["LONG", "LONG", "LONG"], "LONG") ?? "", /同方向实盘仓位已达 3 个/);
  assert.match(liveDirectionalExposureBlockReason(["SHORT", "SHORT", "SHORT"], "SHORT") ?? "", /同方向实盘仓位已达 3 个/);
});

test("one same-direction position or opposite exposure still leaves room", () => {
  assert.equal(liveDirectionalExposureBlockReason([], "LONG"), null);
  assert.equal(liveDirectionalExposureBlockReason(["LONG"], "LONG"), null);
  assert.equal(liveDirectionalExposureBlockReason(["LONG", "SHORT"], "LONG"), null);
  assert.equal(liveDirectionalExposureBlockReason(["LONG", "LONG"], "LONG"), null);
  assert.equal(liveDirectionalExposureBlockReason(["SHORT", "SHORT"], "LONG"), null);
});

test("live engine checks directional exposure before building a new Gate order", () => {
  const source = readFileSync(fileURLToPath(new URL("../lib/live-trading-engine.ts", import.meta.url)), "utf8");
  const guard = source.indexOf("liveDirectionalExposureBlockReason(");
  const plan = source.indexOf("buildLiveEntryPlan({", guard);
  assert.ok(guard >= 0, "missing directional exposure guard");
  assert.ok(plan > guard, "directional exposure must be checked before live sizing/submission");
});
