import test from "node:test";
import assert from "node:assert/strict";
import { detectExtremeSequencePath } from "../lib/extreme-sequence-mirror.ts";

function baseRows() {
  return Array.from({ length: 23 }, (_, index) => {
    const open = 100 + index * 0.025;
    const close = open + 0.02;
    return { time: 1_700_000_000 + index * 300, open, high: close + 0.12, low: open - 0.12, close, volume: 1_000 };
  });
}

test("detects a retained boundary fission and freezes continuation geometry", () => {
  const rows = baseRows();
  rows.push({ time: 1_700_000_000 + 23 * 300, open: 100.55, high: 101.1, low: 100.5, close: 100.95, volume: 1_500 });
  const path = detectExtremeSequencePath(rows);
  assert.ok(path);
  assert.equal(path.branch, "FISSION");
  assert.equal(path.baseSide, "LONG");
  assert.ok(path.invalidationPrice < path.triggerPrice);
  assert.ok(path.profitArmPrice > path.triggerPrice);
});

test("detects a retained downside fission without a long-side bias", () => {
  const rows = baseRows();
  rows.push({ time: 1_700_000_000 + 23 * 300, open: 100.45, high: 100.5, low: 99.7, close: 99.86, volume: 1_500 });
  const path = detectExtremeSequencePath(rows);
  assert.ok(path);
  assert.equal(path.branch, "FISSION");
  assert.equal(path.baseSide, "SHORT");
  assert.ok(path.invalidationPrice > path.triggerPrice);
  assert.ok(path.profitArmPrice < path.triggerPrice);
});

test("detects a failed upper exploration and freezes snapback geometry", () => {
  const rows = baseRows();
  rows.push({ time: 1_700_000_000 + 23 * 300, open: 100.45, high: 102.2, low: 99.95, close: 100.2, volume: 1_450 });
  const path = detectExtremeSequencePath(rows);
  assert.ok(path);
  assert.equal(path.branch, "SNAPBACK");
  assert.equal(path.baseSide, "SHORT");
  assert.ok(path.invalidationPrice > path.triggerPrice);
  assert.ok(path.profitArmPrice < path.triggerPrice);
});

test("detects a failed lower exploration without a short-side bias", () => {
  const rows = baseRows();
  rows.push({ time: 1_700_000_000 + 23 * 300, open: 100.5, high: 100.7, low: 98.5, close: 100.2, volume: 1_450 });
  const path = detectExtremeSequencePath(rows);
  assert.ok(path);
  assert.equal(path.branch, "SNAPBACK");
  assert.equal(path.baseSide, "LONG");
  assert.ok(path.invalidationPrice < path.triggerPrice);
  assert.ok(path.profitArmPrice > path.triggerPrice);
});

test("ordinary movement produces no 极序 event", () => {
  assert.equal(detectExtremeSequencePath(baseRows()), null);
});
