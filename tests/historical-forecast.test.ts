import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { buildHistoricalForecast, cleanAnalogCandles, analogCalendar, ANALOG_BAR_MS } from "../lib/historical-forecast.ts";
import { loadHistoricalForecastCandles } from "../lib/historical-forecast-cache.ts";
import { buildDirectMarketCandidate } from "../lib/direct-market-brain.ts";
import { directMarketRiskAdmission } from "../lib/direct-market-risk.ts";
import { deriveDirectMarketLearningProfile, evaluateDirectMarketLearningAdmission } from "../lib/direct-market-learning.ts";
import { validateDirectMarketEntry } from "../lib/direct-market-entry.ts";
import { buildHte31PaperPosition } from "../lib/hte31-position-sizing.ts";
import type { Hte31Candle } from "../lib/hte31-types.ts";
const now = Date.UTC(2026, 8, 5, 12);
function history(sign = 1, count = 4032): Hte31Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 * Math.exp(sign * i * 0.0003), close = open * Math.exp(sign * 0.0003);
    return { time: (now - (count - i) * ANALOG_BAR_MS) / 1000, open, close,
      high: Math.max(open, close) * 1.0001, low: Math.min(open, close) * 0.9999, volume: 100 + i % 7 };
  });
}
function forecast(rows = history(), overrides = {}) {
  return buildHistoricalForecast({ candles: rows, now, costBps: 12, stopPct: 0.2, ...overrides });
}
function candidate(sign = 1) {
  const candles = history(sign);
  const packet = { symbol: "BTC_USDT", observedAt: now,
    market: { futuresPrice: candles.at(-1)!.close, volumeUsd: 1e9, fundingRate: 0, macroEventRisk: 0 },
    decision: { dataQuality: 0.9 } } as Parameters<typeof buildDirectMarketCandidate>[0]["packet"];
  return buildDirectMarketCandidate({ packet, candles, btcCandles: candles, volumeRank: 1, batchId: "test", roundTripCostBps: 12 });
}

test("analog evidence uses complete disjoint historical episodes with outcomes purged before current input", () => {
  const f = forecast();
  assert.equal(f.state, "READY"); assert.equal(f.side, "LONG"); assert.equal(f.sampleCount, 5);
  assert.ok(f.effectiveSamples >= 4.5); assert.ok(f.netEdgeR > 0);
  assert.equal(Math.round(f.upPct + f.downPct + f.neutralPct), 100);
  assert.ok(f.matches.every((m) => m.futureTo <= now - 120 * 60_000));
  for (const m of f.matches) for (const n of f.matches) if (m !== n) assert.ok(m.futureTo <= n.from || n.futureTo <= m.from);
  assert.equal(f.matches.length, 5);
  assert.ok(f.matches.every((m) => m.candles?.length === 36));
  assert.ok(f.matches.every((m) => m.candles?.every((c) => c.open > 0 && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))));
  assert.equal(f.path.length, 13);
  const reverse = forecast(history(-1)); assert.equal(reverse.side, "SHORT");
});

test("future and unfinished rows cannot leak into analog choices or target distribution", () => {
  const rows = history(), base = forecast(rows);
  const future = { ...rows.at(-1)!, time: now / 1000, open: 1000, close: 10000, high: 20000, low: 1 };
  assert.deepEqual(forecast([...rows, future, { ...future, time: (now + ANALOG_BAR_MS) / 1000 }]), base);
  assert.deepEqual(forecast([...rows, rows[100]]), base);
});

test("gaps, stale bars and sparse history fail closed without a legacy fallback", () => {
  assert.equal(forecast(history(1, 70)).side, "WAIT");
  const gap = history(); gap.splice(-6, 1);
  assert.match(forecast(gap).reason, /缺口/);
  assert.equal(forecast(history(), { now: now + 6 * 60_000 }).state, "STALE");
  assert.equal(cleanAnalogCandles([{ ...history(1, 1)[0], low: -1 }], now).length, 0);
});

test("absolute price scale does not fake or destroy similarity, while costs can invalidate a prediction", () => {
  const rows = history();
  const scaled = rows.map((r) => ({ ...r, open: r.open * 40, high: r.high * 40, low: r.low * 40, close: r.close * 40 }));
  assert.equal(forecast(scaled).side, forecast(rows).side);
  assert.ok(Math.abs(forecast(scaled).medianPct - forecast(rows).medianPct) < 1e-9);
  assert.equal(forecast(rows, { costBps: 100 }).side, "WAIT");
  assert.equal(analogCalendar(Date.UTC(2026, 8, 4, 17)).weekend, true);
  assert.equal(analogCalendar(Date.UTC(2026, 8, 4, 12)).weekend, false);
  assert.match(forecast().eventContext, /部分覆盖/);
});

test("new analog signal passes entry/risk/learning together without inherited synthetic edge gates", () => {
  for (const sign of [1, -1]) {
    const c = candidate(sign);
    assert.equal(c.setup, "HISTORICAL_ANALOG"); assert.equal(c.decision, sign > 0 ? "LONG" : "SHORT");
    assert.equal(c.setupEvaluations?.length, 1); assert.equal(c.maxHoldingMinutes, 60);
    assert.ok(c.invalidationPrice! > 0);
    const entry = (c.entryZone![0] + c.entryZone![1]) / 2;
    assert.equal(validateDirectMarketEntry(c, { symbol: c.symbol, price: entry, observedAt: now }, now).allowed, true);
    const modest = { ...c, confidence: 61, netEdgeR: 0.10 };
    assert.equal(directMarketRiskAdmission({ ...modest, historical: true, state: "CALIBRATING" }).allowed, true);
    assert.equal(evaluateDirectMarketLearningAdmission(deriveDirectMarketLearningProfile([]), modest, now).allowed, true);
    assert.equal(directMarketRiskAdmission({ ...modest, historical: true, state: "PAUSED" }).allowed, false);
  }
});

test("liquidity, late price and too-wide structural stops still block new entries", () => {
  const rows = history();
  const packet = { symbol: "BTC_USDT", observedAt: now, market: { futuresPrice: rows.at(-1)!.close, volumeUsd: 1e6, fundingRate: 0, macroEventRisk: 0 }, decision: { dataQuality: 0.9 } } as Parameters<typeof buildDirectMarketCandidate>[0]["packet"];
  const c = buildDirectMarketCandidate({ packet, candles: rows, btcCandles: [], volumeRank: 1, batchId: "test" });
  assert.equal(c.decision, "WAIT"); assert.equal(c.checks.find((r) => r.key === "liquidity")?.passed, false);
  const valid = candidate(); valid.invalidationPrice = valid.entryZone![0] * 0.9;
  assert.equal(validateDirectMarketEntry(valid, { symbol: valid.symbol, price: valid.entryZone![0], observedAt: now }, now).allowed, false);
});

test("history bootstrap is bounded, cached per symbol and updated incrementally without D1", async () => {
  const data = new Map<string, unknown>(), rows = history(); let calls = 0, active = 0, peak = 0;
  const store = { async get<T>(key: string) { return data.get(key) as T | undefined; }, async put<T>(key: string, value: T) { data.set(key, value); } };
  const fetch = async (_symbol: string, from: number, to: number) => {
    calls++; active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
    assert.ok(to - from <= 72 * 3_600_000);
    return rows.filter((r) => r.time * 1000 >= from && r.time * 1000 <= to);
  };
  const loaded = await loadHistoricalForecastCandles(store, fetch, "BTC_USDT", now);
  assert.ok(loaded.length >= 4000); assert.equal(calls, 5); assert.ok(peak <= 2);
  await loadHistoricalForecastCandles(store, fetch, "BTC_USDT", now + 1000);
  assert.equal(calls, 5); assert.equal(data.size, 1);
  assert.ok(JSON.stringify([...data.values()][0]).length < 1_000_000);
  await loadHistoricalForecastCandles(store, fetch, "BTC_USDT", now + ANALOG_BAR_MS);
  assert.equal(calls, 6);
});

test("fresh latest bars do not prevent repairing truncated history and interior gaps", async () => {
  const rows = history();
  for (const previous of [rows.slice(-80), rows.filter((_, i) => i < 2100 || i >= 2400)]) {
    let cached: unknown = { observedAt: now, candles: previous }, calls = 0;
    const store = { async get<T>() { return cached as T; }, async put<T>(_key: string, value: T) { cached = value; } };
    const loaded = await loadHistoricalForecastCandles(store, async (_s, from, to) => {
      calls++; return rows.filter((r) => r.time * 1000 >= from && r.time * 1000 <= to);
    }, "BTC_USDT", now);
    assert.equal(calls, 1, "a warm repair uses one bounded historical request");
    assert.ok(loaded.length > previous.length);
    assert.deepEqual(loaded.at(-1), rows.at(-1));
    if (previous.length > 1000) assert.equal(loaded.length, rows.length);
  }
});

test("partial bootstrap survives page failure; an unavailable repair backs off without stopping fresh data", async () => {
  const rows = history(), data = new Map<string, unknown>(); let calls = 0;
  const store = { async get<T>(key: string) { return data.get(key) as T | undefined; }, async put<T>(key: string, value: T) { data.set(key, value); } };
  const partial = await loadHistoricalForecastCandles(store, async (_s, from, to) => {
    calls++; if (calls === 2) throw new Error("one unavailable page");
    return rows.filter((r) => r.time * 1000 >= from && r.time * 1000 <= to);
  }, "BTC_USDT", now);
  assert.equal(calls, 5); assert.ok(partial.length > 2500 && partial.length < rows.length);
  assert.ok(data.size === 1, "successful pages survive a failed sibling");
  const failed = async () => { calls++; throw new Error("history temporarily unavailable"); };
  await loadHistoricalForecastCandles(store, failed, "BTC_USDT", now + 60_000);
  assert.equal(calls, 6);
  await loadHistoricalForecastCandles(store, failed, "BTC_USDT", now + 120_000);
  assert.equal(calls, 6, "fresh data plus failed old repair respects the cooldown");
  await loadHistoricalForecastCandles(store, failed, "BTC_USDT", now + ANALOG_BAR_MS);
  assert.equal(calls, 7, "old repair cooldown does not suspend the latest-bar request");
});

test("complete history with too few matches is not described as data collection", () => {
  const rows = history().map((row, i) => i < 4008 ? row : {
    ...row, open: row.open * Math.exp((i - 4008) * 0.01), close: row.close * Math.exp((i - 4008) * 0.01),
    high: row.high * Math.exp((i - 4008) * 0.01), low: row.low * Math.exp((i - 4008) * 0.01),
  });
  const f = forecast(rows);
  assert.equal(f.state, "INSUFFICIENT"); assert.equal(f.missingHistoryBars, 0);
  assert.match(f.reason, /本轮检索4032根已存K线/); assert.doesNotMatch(f.reason, /正在准备|正在补取/);
  assert.equal(f.side, "WAIT");
  if (!f.sampleCount) assert.deepEqual(f.path, [], "zero matches must not manufacture a flat forecast");
  assert.match(forecast([]).reason, /尚未取得有效历史行情/);
});

test("full two-week inference has a bounded CPU workload", () => {
  const start = performance.now(); forecast();
  assert.ok(performance.now() - start < 3000, "bounded 4032-row inference must not become an unbounded history scan");
});

test("analog sizing can use smaller collateral-safe exposure without raising leverage or stretching targets", () => {
  const c = candidate(), entry = (c.entryZone![0] + c.entryZone![1]) / 2;
  const sizing = buildHte31PaperPosition({ side: "LONG", entryPrice: entry, stopLossPrice: c.invalidationPrice!,
    originalTakeProfit2Price: c.targets[1], accountEquityUsdt: 1000, availableMarginUsdt: 1000,
    riskRate: 0.035, minimumRiskRate: 0.005, riskMultiplier: 1, roundTripCostBps: 12,
    minimumTp2NetProfitUsdt: 0, confidence: 61, dataQuality: 0.85, liquidityVolumeUsd: 1e9, atrPct: 0.2 });
  assert.equal(sizing.accepted, true);
  assert.ok(sizing.plannedRiskUsdt >= 5 && sizing.plannedRiskUsdt <= 35);
  assert.ok(sizing.leverage <= 12); assert.ok(sizing.marginUsdt <= 350);
  assert.ok(Math.abs(sizing.takeProfit2Price - c.targets[1]) < 1e-8);
});
