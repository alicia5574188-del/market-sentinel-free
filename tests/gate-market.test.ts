import assert from "node:assert/strict";
import test from "node:test";
import { fetchActiveContracts, fetchContractStats, fetchFuturesBook, fetchLiquidations, fetchMarketTickers, fetchStructureCandles } from "../lib/gate-market.ts";

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

test("completed candles retry once on the official futures host and support bounded incremental reads", async () => {
  const prior = globalThis.fetch;
  const urls: string[] = [];
  const completed = Math.floor(Date.now() / 300_000) * 300 - 300;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    if (urls.length === 1) throw new DOMException("timed out", "TimeoutError");
    return Response.json([{ t: completed, v: "1", o: "100", h: "102", l: "99", c: "101" }]);
  };
  try {
    const rows = await fetchStructureCandles("BTC_USDT", "5m", 4);
    assert.equal(rows.length, 1);
    assert.match(urls[0], /^https:\/\/api\.gateio\.ws\/api\/v4\//);
    assert.match(urls[1], /^https:\/\/fx-api\.gateio\.ws\/api\/v4\//);
    assert.ok(urls.every((url) => url.includes("limit=4")));
  } finally { globalThis.fetch = prior; }
});

test("active universe exposes every liquid trading USDT future to the radar", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/futures/usdt/tickers")) return Response.json([
      { contract: "ZEC_USDT", last: "10", volume_24h_settle: "999999999" },
      { contract: "SOL_USDT", last: "100", volume_24h_settle: "500000000", funding_rate: "0.0001" },
      { contract: "BTC_USDT", last: "80000", volume_24h_settle: "800000000", funding_rate: "0.0002" },
      { contract: "ETH_USDT", last: "2500", volume_24h_settle: "600000000", funding_rate: "0.0003" },
      { contract: "BNB_USDT", last: "900", volume_24h_settle: "888888888" },
    ]);
    return Response.json(["ZEC_USDT", "SOL_USDT", "BTC_USDT", "ETH_USDT", "BNB_USDT"].map((name) => ({ name, status: "trading", order_price_round: "0.1", quanto_multiplier: "0.01", maintenance_rate: "0.005" })));
  };
  try {
    assert.deepEqual((await fetchActiveContracts()).map((item) => item.symbol), ["ZEC_USDT", "BNB_USDT", "BTC_USDT", "ETH_USDT", "SOL_USDT"]);
  } finally { globalThis.fetch = prior; }
});

test("one bulk ticker request returns the complete low-cost radar surface", async () => {
  await withFetch([{ contract: "X_USDT", last: "2", volume_24h_usd: "3000000", total_size: "55", funding_rate: "0.001" }], async () => {
    assert.deepEqual(await fetchMarketTickers(), [{ symbol: "X_USDT", last: 2, volume24hUsd: 3_000_000, fundingRate: 0.001, openInterest: 55 }]);
  });
});

test("Gate stats use contract_stats and liquidations retain signed order_size", async () => {
  await withFetch([{ time: 1, open_interest: "123.5" }], async () => assert.equal(Number((await fetchContractStats("X_USDT"))?.open_interest), 123.5));
  await withFetch([{ time: 1, order_size: "-7", size: "999", fill_price: "100" }], async () => assert.equal(Number((await fetchLiquidations("X_USDT"))[0].order_size), -7));
});
