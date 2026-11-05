import { test } from "node:test";
import assert from "node:assert/strict";
import { beExitPlain, beExitShort, beStopFact } from "../lib/nts/be-display.ts";
const base = { side: "SHORT" as const, entryPrice: 0.1986, stopPrice: 0.1985, status: "CLOSED" as const, exitReason: "STRUCTURE_STOP", rule: { id: "nts-v1" } };
test("closed BE with origStop", () => {
  const t = { ...base, breakeven: { origStop: 0.2006, stop: 0.1985, at: 1 } };
  assert.equal(beExitShort(t), "保本止损");
  assert.match(beExitPlain(t)!, /^保本止损：.*原止损 0\.2006.*保本价 0\.1985/);
  assert.deepEqual(beStopFact(t), { label: "保本止损", value: "0.1985（原止损 0.2006）" });
});
test("legacy closed BE without field", () => {
  assert.equal(beExitShort(base), "保本止损");
  assert.equal(beStopFact(base)!.value, "0.1985（原止损 没记下）");
});
test("normal hard stop untouched", () => {
  const t = { ...base, stopPrice: 0.2006 };
  assert.equal(beExitShort(t), null); assert.equal(beExitPlain(t), null); assert.equal(beStopFact(t), null);
  assert.equal(beStopFact({ ...base, rule: { id: "x" } }), null);
});
test("open BE labelled", () => {
  const t = { ...base, side: "LONG" as const, entryPrice: 10, stopPrice: 10.01, status: "OPEN" as const, exitReason: null, breakeven: { origStop: 9.8, stop: 10.01, at: 1 } };
  assert.equal(beStopFact(t)!.label, "保本止损"); assert.equal(beExitPlain(t), null);
});
