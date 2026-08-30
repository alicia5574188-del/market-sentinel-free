import test from "node:test";
import assert from "node:assert/strict";

function accountForEpoch(rows: Array<{ entryAt: number; status: "holding" | "closed"; netPnlUsdt: number | null; unrealizedNetUsdt: number; marginUsdt: number }>, epochStartedAt: number, startingCapitalUsdt: number) {
  const closed = rows.filter((row) => row.status === "closed");
  const open = rows.filter((row) => row.status === "holding");
  const epochClosed = closed.filter((row) => row.entryAt >= epochStartedAt);
  const realizedPnlUsdt = epochClosed.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0);
  const unrealizedPnlUsdt = open.reduce((sum, row) => sum + row.unrealizedNetUsdt, 0);
  const realizedBalanceUsdt = startingCapitalUsdt + realizedPnlUsdt;
  const equityUsdt = realizedBalanceUsdt + unrealizedPnlUsdt;
  const usedMarginUsdt = open.reduce((sum, row) => sum + row.marginUsdt, 0);
  return { realizedPnlUsdt, equityUsdt, usedMarginUsdt, allClosedCount: closed.length };
}

test("a new paper epoch restores capital without erasing historical samples", () => {
  const rows = [
    { entryAt: 100, status: "closed" as const, netPnlUsdt: -48, unrealizedNetUsdt: 0, marginUsdt: 0 },
    { entryAt: 200, status: "closed" as const, netPnlUsdt: -45, unrealizedNetUsdt: 0, marginUsdt: 0 },
    { entryAt: 1_100, status: "closed" as const, netPnlUsdt: 40, unrealizedNetUsdt: 0, marginUsdt: 0 },
  ];
  const beforeReset = accountForEpoch(rows, 0, 1000);
  assert.equal(beforeReset.equityUsdt, 947);
  assert.equal(beforeReset.allClosedCount, 3);

  const afterReset = accountForEpoch(rows, 1000, 1000);
  assert.equal(afterReset.realizedPnlUsdt, 40);
  assert.equal(afterReset.equityUsdt, 1040);
  assert.equal(afterReset.allClosedCount, 3);
});
