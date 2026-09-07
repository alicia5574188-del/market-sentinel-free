import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveEntryIntent, buildLiveStopIntent, GateLiveClient, LiveEntrySizingError, liveEntryDisposition, liveOrderId } from "../lib/gate-live.ts";
import type { PaperPlan } from "../lib/liquidity-core.ts";

function plan(marketState: PaperPlan["marketState"], side: PaperPlan["side"]): PaperPlan {
  return {
    id: `BTC_USDT:${marketState}:${side}`, symbol: "BTC_USDT", observedAt: Date.now(), marketState, side,
    entryTrigger: 100, invalidation: side === "LONG" ? 99 : 101, target: side === "LONG" ? 103 : 97,
    targetIdentity: "BOOK:target", score: 2, oppositeScore: 1, reason: ["test"], state: "PREPARED",
    createdAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, plannedRisk: 20, notional: 2_000,
  };
}

test("a confirmed breakout becomes an IOC market order sized from its current entry", () => {
  const intent = buildLiveEntryIntent({ plan: plan("BREAKOUT", "LONG"), entryPrice: 100.25,
    equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
  assert.equal(intent.kind, "MARKET");
  assert.ok(intent.plannedRisk > 0 && intent.plannedRisk <= 50);
  assert.ok(intent.notional <= 4_000);
  assert.ok(intent.notional * 0.0018 <= 7.2);
  assert.ok(intent.margin <= 200.01);
  assert.equal(intent.body.price, "0");
  assert.equal(intent.body.tif, "ioc");
  assert.equal(intent.body.reduce_only, false);
  assert.equal(intent.body.trigger, undefined);
});

test("confirmed retest and failed-break entries both use realtime IOC", () => {
  const retest = buildLiveEntryIntent({ plan: { ...plan("BREAKOUT", "LONG"), routeKind: "BREAKOUT_RETEST" },
    entryPrice: 100.2, equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
  assert.equal(retest.kind, "MARKET");
  const failed = buildLiveEntryIntent({ plan: { ...plan("REVERSAL", "SHORT"), routeKind: "FAILED_BREAKOUT_REVERSAL" },
    entryPrice: 99.8, equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
  assert.equal(failed.kind, "MARKET");
  assert.equal(failed.body.tif, "ioc");
});

test("LIVE ignores a legacy farther target and rejects an uneconomic short-term target", () => {
  const staged = { ...plan("BREAKOUT", "LONG"), invalidation: 99.8, target: 100.6, nextTarget: 101,
    routeKind: "LOCAL_BREAKOUT" as const, confirmationScore: 0.9, fakeoutRisk: 0.1, economicTarget: 101 };
  assert.throws(() => buildLiveEntryIntent({ plan: staged, entryPrice: 100, equity: 1_000, available: 1_000,
    openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 }),
  (error) => error instanceof LiveEntrySizingError && error.code === "ECONOMICS");
  assert.equal(staged.target, 100.6);
});

test("a 10 U LIVE account uses Gate's one-contract lot when its actual stop risk fits total and correlated caps", () => {
  const scaled = { ...plan("BREAKOUT", "LONG"), invalidation: 99.8 };
  const intent = buildLiveEntryIntent({ plan: scaled, equity: 10, available: 5.88, openRisk: 0, quantoMultiplier: 1, leverageMax: 50 });
  assert.equal(intent.contracts, 1);
  assert.equal(intent.notional, 100);
  assert.equal(intent.leverage, 50);
  assert.ok(intent.margin <= 5.88);
  assert.ok(intent.plannedRisk <= 0.65);
});

test("an indivisible Gate lot is rejected when its real correlated risk or margin cannot fit", () => {
  assert.throws(
    () => buildLiveEntryIntent({ plan: plan("BREAKOUT", "LONG"), equity: 10, available: 5.88, openRisk: 0, quantoMultiplier: 1, leverageMax: 50 }),
    (error) => error instanceof LiveEntrySizingError && error.code === "RISK_CAP",
  );
  const scaled = { ...plan("BREAKOUT", "LONG"), invalidation: 99.8 };
  assert.throws(
    () => buildLiveEntryIntent({ plan: scaled, equity: 10, available: 0.01, openRisk: 0, quantoMultiplier: 1, leverageMax: 50 }),
    (error) => error instanceof LiveEntrySizingError && error.code === "MARGIN",
  );
});

test("reversal and range submit only realtime IOC after internal confirmation", () => {
  for (const state of ["REVERSAL", "RANGE"] as const) {
    const intent = buildLiveEntryIntent({ plan: plan(state, "SHORT"), equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
    assert.equal(intent.kind, "MARKET");
    assert.equal(intent.body.price, "0");
    assert.equal(intent.body.tif, "ioc");
    assert.ok(Number(intent.body.size) < 0);
  }
});

test("protective stop is close-only and cannot reverse the account", () => {
  const stop = buildLiveStopIntent({ id: "position-1", symbol: "SOL_USDT", side: "LONG", currentStop: 99 });
  const initial = stop.body.initial as { size: number; price: string; close: boolean; reduce_only: boolean };
  const trigger = stop.body.trigger as { rule: number; price: string };
  assert.deepEqual(initial, { contract: "SOL_USDT", size: 0, price: "0", tif: "ioc", close: true, reduce_only: true, text: stop.tag });
  assert.equal(trigger.rule, 2);
  assert.equal(trigger.price, "99");
  assert.equal((stop.body.trigger as { expiration: number }).expiration, 86_400 * 30);
});

test("terminal Gate orders are classified without ever replaying a successful entry", () => {
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "filled" }, "LIMIT"), "FILLED");
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "filled" }, "MARKET"), "FILLED");
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "ioc" }, "MARKET"), "CANCELLED");
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "cancelled" }, "LIMIT"), "CANCELLED");
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "succeeded" }, "PRICE_TRIGGER"), "FILLED");
  assert.equal(liveEntryDisposition({ status: "finished", finish_as: "failed" }, "PRICE_TRIGGER"), "ERROR");
  assert.equal(liveEntryDisposition({ status: "inactive" }, "PRICE_TRIGGER"), "ERROR");
});

test("private Gate requests are signed and order IDs remain strings", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); seen.push(request);
    return Response.json({ id_string: "9223372036854775807" });
  };
  try {
    const client = new GateLiveClient({ apiKey: "abcdefgh12345678", apiSecret: "secret-value-12345678", environment: "live" });
    const intent = buildLiveEntryIntent({ plan: plan("BREAKOUT", "LONG"), equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
    assert.equal(await client.createEntry(intent), "9223372036854775807");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.get("KEY"), "abcdefgh12345678");
    assert.match(seen[0].headers.get("SIGN") ?? "", /^[0-9a-f]{128}$/);
    assert.equal(seen[0].url.includes("secret-value"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an IOC market entry is inspected through Gate's regular futures-order endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); seen.push(request);
    return Response.json({ id_string: "123", status: "finished", finish_as: "filled" });
  };
  try {
    const client = new GateLiveClient({ apiKey: "abcdefgh12345678", apiSecret: "secret-value-12345678", environment: "live" });
    const order = await client.inspectEntry("MARKET", "BTC_USDT", "t-ms-e-market", "123");
    assert.equal(order?.finish_as, "filled");
    assert.equal(new URL(seen[0].url).pathname, "/api/v4/futures/usdt/orders/123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("int64 order IDs from Gate snapshots survive JSON parsing and cancellation unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); seen.push(request);
    const path = new URL(request.url).pathname;
    if (request.method === "DELETE") return new Response("{}", { headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/accounts")) return new Response('{"user":1,"total":"10","available":"5"}');
    if (path.endsWith("/positions")) return new Response("[]");
    if (path.endsWith("/price_orders")) return new Response("[]");
    return new Response('[{"id":9223372036854775807,"text":"t-ms-e-stale","contract":"BTC_USDT"}]');
  };
  try {
    const client = new GateLiveClient({ apiKey: "abcdefgh12345678", apiSecret: "secret-value-12345678", environment: "live" });
    const snapshot = await client.snapshot();
    assert.equal(liveOrderId(snapshot.orders[0]), "9223372036854775807");
    await client.cancelOrder("LIMIT", liveOrderId(snapshot.orders[0])!);
    assert.equal(new URL(seen.at(-1)!.url).pathname.endsWith("/orders/9223372036854775807"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
