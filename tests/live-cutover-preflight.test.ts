import assert from "node:assert/strict";
import test from "node:test";
import { cutoverPreflightTokenMatches } from "../lib/cutover-preflight-auth.ts";
import {
  readGateCutoverPreflight,
  type GateCutoverReadClient,
} from "../lib/live-cutover-summary.ts";

test("cutover CI bearer requires an exact token of at least 32 bytes", async () => {
  const now = 1_788_595_200_000;
  const token = `${Math.floor(now / 1_000)}.${"a".repeat(64)}`;
  assert.equal(await cutoverPreflightTokenMatches(new Request("https://example.test/api/live/preflight", {
    headers: { Authorization: `Bearer ${token}` },
  }), token, now), true);
  assert.equal(await cutoverPreflightTokenMatches(new Request("https://example.test/api/live/preflight", {
    headers: { Authorization: `Bearer ${token.slice(0, -1)}b` },
  }), token, now), false);
  assert.equal(await cutoverPreflightTokenMatches(new Request("https://example.test/api/live/preflight", {
    headers: { Authorization: `Bearer ${"a".repeat(31)}` },
  }), "a".repeat(31), now), false);
});

test("cutover CI bearer rejects future and older-than-20-minute tokens", async () => {
  const now = 1_788_595_200_000;
  const requestFor = (token: string) => new Request("https://example.test/api/live/preflight", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const future = `${Math.floor(now / 1_000) + 1}.${"b".repeat(64)}`;
  const expired = `${Math.floor((now - 20 * 60 * 1_000 - 1_000) / 1_000)}.${"c".repeat(64)}`;
  assert.equal(await cutoverPreflightTokenMatches(requestFor(future), future, now), false);
  assert.equal(await cutoverPreflightTokenMatches(requestFor(expired), expired, now), false);
});

test("cutover preflight reads all three Gate inventories concurrently and exposes only safe summary data", async () => {
  const calls: string[] = [];
  const reader = {
    async positions(holding: boolean) {
      calls.push(`positions:${holding}`);
      return [{ contract: "BTC_USDT", size: "12", liq_price: "1" }];
    },
    async openOrders() {
      calls.push("openOrders");
      return [{ id: "secret-order-id", contract: "ETH_USDT", size: "99" }];
    },
    async priceOrders(status: "open" | "finished") {
      calls.push(`priceOrders:${status}`);
      return [{ id_string: "secret-price-order-id", initial: { contract: "BTC_USDT", size: "100" } }];
    },
  } as unknown as GateCutoverReadClient;

  const result = await readGateCutoverPreflight(reader, 1_788_595_200_000);

  assert.deepEqual(calls.sort(), ["openOrders", "positions:true", "priceOrders:open"]);
  assert.deepEqual(result, {
    counts: { positions: 1, openOrders: 1, priceOrders: 1 },
    activeContracts: ["BTC_USDT", "ETH_USDT"],
    checkedAt: 1_788_595_200_000,
    safeToCutover: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-order-id|secret-price-order-id|liq_price|size/i);
});

test("cutover preflight is safe only when positions and both order inventories are empty", async () => {
  const reader = {
    async positions() { return []; },
    async openOrders() { return []; },
    async priceOrders() { return []; },
  } as unknown as GateCutoverReadClient;

  const result = await readGateCutoverPreflight(reader, 123);

  assert.equal(result.safeToCutover, true);
  assert.deepEqual(result.counts, { positions: 0, openOrders: 0, priceOrders: 0 });
  assert.deepEqual(result.activeContracts, []);
});
