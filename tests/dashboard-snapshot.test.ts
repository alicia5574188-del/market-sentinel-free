import assert from "node:assert/strict";
import test from "node:test";
import { retainDashboardSnapshot } from "../lib/dashboard-snapshot.ts";

function snapshot() {
  return { version: "v6", requestedAt: 1_000, observedAt: 900,
    dashboard: { account: { epochStartedAt: 500 }, openTrades: ["one"] } as { account: { epochStartedAt: number }; openTrades: string[] } | null,
    scanner: { status: { state: "live" }, readModel: { target: "BTC" } as { target: string } | null, ageMs: 100 },
    position: { status: { state: "live" } }, market: { label: "震荡" },
    twelveHourReview: { count: 3 } as { count: number } | null,
    degraded: false, errors: {} as Record<string, string> };
}

test("partial success preserves missing sections, but accepts fresh closed-position truth", () => {
  const old = snapshot();
  const incoming = { ...snapshot(), requestedAt: 2_000, observedAt: 1_900,
    dashboard: { account: { epochStartedAt: 500 }, openTrades: [] },
    scanner: { ...old.scanner, readModel: null }, twelveHourReview: null };
  const recovered = retainDashboardSnapshot(old, incoming);
  assert.deepEqual(recovered.dashboard?.openTrades, []);
  assert.equal(recovered.scanner.readModel?.target, "BTC");
  assert.equal(recovered.twelveHourReview?.count, 3);
  assert.equal(recovered.degraded, true);
  assert.equal(recovered.observedAt, 900);
  assert.equal(recovered.scanner.ageMs, 1_100);
});

test("cold API empty dashboard never wipes the browser's last good orders", () => {
  const recovered = retainDashboardSnapshot(snapshot(), { ...snapshot(), dashboard: null });
  assert.deepEqual(recovered.dashboard?.openTrades, ["one"]);
  assert.equal(recovered.degraded, true);
});

test("version and epoch changes never borrow an old decision or review", () => {
  for (const next of [{ ...snapshot(), version: "v7" }, { ...snapshot(), dashboard: { account: { epochStartedAt: 700 }, openTrades: [] } }]) {
    next.scanner.readModel = null;
    next.twelveHourReview = null;
    const recovered = retainDashboardSnapshot(snapshot(), next);
    assert.equal(recovered.scanner.readModel, null);
    assert.equal(recovered.twelveHourReview, null);
    assert.equal(recovered.degraded, true);
  }
});

test("stale responses and malformed payloads cannot replace newer state", () => {
  const current = snapshot();
  assert.equal(retainDashboardSnapshot(current, { ...snapshot(), requestedAt: 999 }), current);
  assert.throws(() => retainDashboardSnapshot(current, { ...snapshot(), version: "" }), /格式不完整/);
  const good = retainDashboardSnapshot(current, { ...snapshot(), requestedAt: 2_000 });
  assert.equal(good.degraded, false);
});
