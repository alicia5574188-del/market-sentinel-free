import assert from "node:assert/strict";
import test from "node:test";
import { healthy, summarizeUsage } from "../scripts/check-production.mjs";

test("D1 acceptance distinguishes unknown data from real counters", () => {
  assert.deepEqual(summarizeUsage([{ sum: { rowsRead: 123, rowsWritten: 5 } }, { sum: { rowsRead: 4, rowsWritten: 6 } }]), { rowsRead: 127, rowsWritten: 11 });
  for (const groups of [undefined, [], [{ sum: { rowsRead: 1 } }], [{ sum: { rowsRead: -1, rowsWritten: 0 } }]]) assert.throws(() => summarizeUsage(groups));
});

test("health requires both managers fresh without an active failure", () => {
  const status = { state: "live", lastSuccessAt: 900, nextRunAt: 2_000, lastError: null };
  const data = { ok: true, schedulerError: null, schedulers: { scanner: { ...status }, position: { ...status } } };
  assert.equal(healthy(data, 1_000), true);
  assert.equal(healthy(data, 181_000), false);
  data.schedulers.position.lastSuccessAt = -240_000;
  assert.equal(healthy(data, 1_000), true);
  data.schedulers.position.lastSuccessAt = null;
  assert.equal(healthy(data, 1_000), false);
});
