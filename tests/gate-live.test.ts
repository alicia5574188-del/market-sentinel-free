import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveEntryIntent, buildLiveStopIntent, GateLiveClient, liveEntryDisposition, liveOrderId } from "../lib/gate-live.ts";
import type { PaperPlan } from "../lib/liquidity-core.ts";

function plan(marketState: PaperPlan["marketState"], side: PaperPlan["side"]): PaperPlan {
  return {
    id: `BTC_USDT:${marketState}:${side}`, symbol: "BTC_USDT", observedAt: Date.now(), marketState, side,
    entryTrigger: 100, invalidation: side === "LONG" ? 99 : 101, target: side === "LONG" ? 103 : 97,
    targetIdentity: "BOOK:target", score: 2, oppositeScore: 1, reason: ["test"], state: "PREPARED",
    createdAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, plannedRisk: 20, notional: 2_000,
  };
}

test("breakout becomes exchange price-trigger market order within 5% risk", () => {
  const intent = buildLiveEntryIntent({ plan: plan("BREAKOUT", "LONG"), equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
  assert.equal(intent.kind, "PRICE_TRIGGER");
  assert.ok(intent.plannedRisk > 0 && intent.plannedRisk <= 50);
  assert.ok(intent.notional <= 4_000);
  assert.ok(intent.notional * 0.0018 <= 7.2);
  assert.ok(intent.margin <= 200.01);
  assert.deepEqual((intent.body.trigger as { strategy_type: number; price_type: number; rule: number }).strategy_type, 0);
  assert.equal((intent.body.trigger as { price_type: number }).price_type, 0);
  assert.equal((intent.body.trigger as { rule: number }).rule, 1);
  assert.equal((intent.body.trigger as { expiration: number }).expiration, 86_400);
  assert.equal((intent.body.initial as { price: string; tif: string; reduce_only: boolean }).price, "0");
  assert.equal((intent.body.initial as { tif: string }).tif, "ioc");
  assert.equal((intent.body.initial as { reduce_only: boolean }).reduce_only, false);
});

test("reversal and range become passive limit entries, not early-filling short limits", () => {
  for (const state of ["REVERSAL", "RANGE"] as const) {
    const intent = buildLiveEntryIntent({ plan: plan(state, "SHORT"), equity: 1_000, available: 1_000, openRisk: 0, quantoMultiplier: 0.001, leverageMax: 50 });
    assert.equal(intent.kind, "LIMIT");
    assert.equal(intent.body.price, "100");
    assert.equal(intent.body.tif, "gtc");
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
