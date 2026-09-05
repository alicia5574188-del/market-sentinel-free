import assert from "node:assert/strict";
import test from "node:test";
import {
  readGateCutoverPreflight,
  type GateCutoverReadClient,
} from "../lib/live-cutover-summary.ts";

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
