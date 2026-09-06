import assert from "node:assert/strict";
import test from "node:test";
import { fetchContractStats, fetchFuturesBook, fetchLiquidations, fetchStructureCandles } from "../lib/gate-market.ts";

const withFetch = async (body: unknown, run: () => Promise<void>) => {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => Response.json(body);
  try { await run(); } finally { globalThis.fetch = prior; }
};

test("Gate book requires both exchange id and update, parses object levels, and converts contracts to USDT", async () => {
  await withFetch({ update: Date.now(), bids: [{ p: "99", s: "2" }], asks: [{ p: "101", s: "3" }] }, async () => {
    await assert.rejects(fetchFuturesBook("X_USDT"), /sequence id/);
  });
  await withFetch({ id: 7, update: Date.now(), bids: [{ p: "99", s: "2" }], asks: [{ p: "102", s: "1" }, { p: "101", s: "3" }] }, async () => {
    const book = await fetchFuturesBook("X_USDT", 0.1, 0.01);
    assert.equal(book.sequence, 7);
    assert.deepEqual(book.asks.map((row) => row.price), [101, 102]);
    assert.equal(book.bids[0].size, 1.98);
  });
});

test("Gate candle objects exclude unfinished rows, deduplicate, and retain only a continuous completed suffix", async () => {
  const now = Math.floor(Date.now() / 60_000) * 60;
  const row = (t: number) => ({ t, v: "1", o: "100", h: "102", l: "99", c: "101" });
  await withFetch([row(now - 300), row(now - 180), row(now - 120), row(now - 120), row(now - 60), row(now)], async () => {
    const rows = await fetchStructureCandles("X_USDT", "1m");
    assert.deepEqual(rows.map((item) => item.time), [now - 180, now - 120, now - 60]);
  });
});

test("Gate stats use contract_stats and liquidations retain signed order_size", async () => {
  await withFetch([{ time: 1, open_interest: "123.5" }], async () => assert.equal(Number((await fetchContractStats("X_USDT"))?.open_interest), 123.5));
  await withFetch([{ time: 1, order_size: "-7", size: "999", fill_price: "100" }], async () => assert.equal(Number((await fetchLiquidations("X_USDT"))[0].order_size), -7));
});
