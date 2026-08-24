import test from "node:test";
import assert from "node:assert/strict";
import { computeLiquidationImbalance, computeMultiTimeframeTrend, fetchGateChartCandles, fetchGatePositionQuotes, rankUniverseFromPayload } from "../lib/gate-client.ts";

test("全市场初筛按成交额取前 N，并把核心币补回", () => {
  const payload = [
    { contract: "AAA_USDT", last: "10", change_percentage: "4", volume_24h_usd: "5000000", funding_rate: "0.0001", mark_price: "10", index_price: "10" },
    { contract: "BBB_USDT", last: "5", change_percentage: "-5", volume_24h_usd: "4000000", funding_rate: "-0.0001", mark_price: "5", index_price: "5" },
    { contract: "CORE_USDT", last: "1", change_percentage: "0.5", volume_24h_usd: "100", funding_rate: "0", mark_price: "1", index_price: "1" },
    { contract: "INVALID-PAIR", last: "9", change_percentage: "90", volume_24h_usd: "999999999" },
  ];
  const ranked = rankUniverseFromPayload(payload, 2, ["CORE_USDT"]);
  assert.deepEqual(ranked.map((item) => item.symbol), ["AAA_USDT", "BBB_USDT", "CORE_USDT"]);
  assert.ok(ranked.every((item) => String(item.state) !== "confirmed"));
});

test("极端资金费率在初筛层直接标记风险拦截", () => {
  const [row] = rankUniverseFromPayload([{ contract: "SOL_USDT", last: "100", change_percentage: "8", volume_24h_usd: "1000000", funding_rate: "0.002", mark_price: "100", index_price: "100" }], 1);
  assert.equal(row.state, "blocked");
  assert.equal(row.side, "WAIT");
});

test("15m/1h/4h 同向趋势会形成稳定的多周期分数", () => {
  const payload = (slope: number) => Array.from({ length: 60 }, (_, index) => {
    const close = 100 + index * slope;
    return [1_700_000_000 + index * 300, "100", String(close), String(close + .2), String(close - .2), String(close - slope / 2)];
  });
  const up = computeMultiTimeframeTrend([payload(.2), payload(.15), payload(.1)]);
  const down = computeMultiTimeframeTrend([payload(-.2), payload(-.15), payload(-.1)]);
  assert.ok(up != null && up > .2);
  assert.ok(down != null && down < -.2);
});

test("多周期趋势排除各周期尚未结束的 K 线", () => {
  const observedAt = 1_700_100_000_000;
  const intervals = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
  const completedPayloads = intervals.map((interval) => Array.from({ length: 40 }, (_, index) => {
    const time = observedAt - (40 - index + 1) * interval;
    const close = 100 + index * 0.2;
    return [time / 1000, "100", String(close), String(close + .2), String(close - .2), String(close - .1)];
  }));
  const withLiveReversal = completedPayloads.map((payload, index) => [
    ...payload,
    [(observedAt - intervals[index] / 2) / 1000, "99999", "70", "108", "69", "108"],
  ]);
  const baseline = computeMultiTimeframeTrend(completedPayloads, observedAt);
  const filtered = computeMultiTimeframeTrend(withLiveReversal, observedAt);
  assert.equal(filtered, baseline);
  assert.ok((filtered ?? 0) > 0.2);
});

test("清算流按名义金额计算净方向", () => {
  const result = computeLiquidationImbalance([
    { order_size: "2", fill_price: "100" },
    { order_size: "1", fill_price: "100" },
    { order_size: "-1", fill_price: "100" },
  ]);
  assert.equal(result, 0.5);
});

test("订单图从 Gate 读取真实5m窗口并按时间排序", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify([
      ["1700000300", "20", "101", "102", "99", "100"],
      ["1700000000", "10", "100", "101", "98", "99"],
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const now = Date.now();
    const candles = await fetchGateChartCandles("BTC_USDT", now - 3_600_000, now);
    assert.match(requestedUrl, /\/futures\/usdt\/candlesticks\?/);
    assert.match(requestedUrl, /contract=BTC_USDT/);
    assert.match(requestedUrl, /interval=5m/);
    assert.deepEqual(candles.map((item) => item.time), [1_700_000_000, 1_700_000_300]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("持仓刷新一次读取实时 ticker 并附带最新5m高低价", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/futures/usdt/tickers")) {
      return new Response(JSON.stringify([
        { contract: "BTC_USDT", last: "61234.5", volume_24h_usd: "500000000" },
        { contract: "ETH_USDT", last: "3210.5", volume_24h_usd: "200000000" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const price = url.includes("BTC_USDT") ? 61234.5 : 3210.5;
    return new Response(JSON.stringify([
      ["1700000000", "10", String(price - 1), String(price + 8), String(price - 9), String(price - 2)],
      ["1700000300", "11", String(price), String(price + 5), String(price - 4), String(price - 1)],
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const quotes = await fetchGatePositionQuotes(["BTC_USDT", "ETH_USDT", "BTC_USDT"]);
    assert.equal(quotes.length, 2);
    assert.deepEqual(quotes.map((quote) => quote.symbol), ["BTC_USDT", "ETH_USDT"]);
    assert.equal(quotes[0].price, 61234.5);
    assert.equal(quotes[0].highPrice, 61239.5);
    assert.equal(quotes[0].lowPrice, 61230.5);
    assert.equal(quotes[0].candleTime, 1_700_000_300);
    assert.equal(requested.filter((url) => url.endsWith("/futures/usdt/tickers")).length, 1);
    assert.equal(requested.filter((url) => url.includes("candlesticks")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
