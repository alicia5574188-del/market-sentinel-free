import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { ancillaryIsFresh, ancillarySchedule, emptySymbolMemory, optionalEvidenceIsFresh } from "../lib/liquidity-runtime.ts";
import { remainingStressRisk, STALE_AFTER_MS, type PaperPlan, type PaperPosition } from "../lib/liquidity-core.ts";
import type { ArenaTrade } from "../lib/strategy-arena.ts";

const cloudflareStub = `
  export class DurableObject {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  }
`;
const vinextStub = `export default { fetch() { return new Response("test shell"); } };`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(cloudflareStub)}` };
    }
    if (specifier === "vinext/server/app-router-entry") {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(vinextStub)}` };
    }
    return nextResolve(specifier, context);
  },
});

const runtimeWorkerSpecifier = "../worker/index-clean.ts?runtime-fault-suite";
const { MarketStream, failedRadarRuntime, radarAttemptDue, radarCandidateExecutionAllowed,
  successfulRadarRuntime } = await import(runtimeWorkerSpecifier);

class FakeStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  failPuts = 0;
  getCalls = 0;
  putCalls = 0;
  setAlarmCalls = 0;
  deleteAlarmCalls = 0;

  constructor(checkpoint?: unknown) {
    if (checkpoint !== undefined) this.values.set("checkpoint", structuredClone(checkpoint));
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.getCalls += 1;
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put(key: string, value: unknown) {
    this.putCalls += 1;
    if (this.failPuts > 0) {
      this.failPuts -= 1;
      throw new Error("injected Durable Object storage failure");
    }
    this.values.set(key, structuredClone(value));
  }

  async getAlarm() { return this.alarm; }

  async setAlarm(value: number) {
    this.setAlarmCalls += 1;
    this.alarm = value;
  }

  async deleteAlarm() {
    this.deleteAlarmCalls += 1;
    this.alarm = null;
  }
}

class FakeContext {
  storage: FakeStorage;
  ready: Promise<void> = Promise.resolve();

  constructor(storage: FakeStorage) { this.storage = storage; }

  blockConcurrencyWhile(callback: () => Promise<void>) {
    this.ready = Promise.resolve().then(callback);
    return this.ready;
  }
}

class FakeD1 {
  fail = false;
  batchCalls = 0;
  statements: Array<Array<{ sql: string; args: unknown[] }>> = [];

  prepare(sql: string) {
    return { bind: (...args: unknown[]) => ({ sql, args, all: async () => ({ results: [] }) }) };
  }

  async batch(statements: Array<{ sql: string; args: unknown[] }>) {
    this.batchCalls += 1;
    this.statements.push(statements);
    if (this.fail) throw new Error("injected D1 outage");
    return [];
  }
}

async function makeStreamFromStorage(storage: FakeStorage) {
  const ctx = new FakeContext(storage);
  const db = new FakeD1();
  const env = {
    ASSETS: { fetch: async () => new Response("asset") },
    DB: db,
    MARKET_STREAM: {},
    OWNER_ACCESS_TOKEN: "owner-access-token-long-enough",
  };
  // Test-only reflective access is required to inject failures into private transaction boundaries.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = new MarketStream(ctx as never, env as never) as any;
  await ctx.ready;
  return { stream, storage, ctx, db };
}

async function makeStream(checkpoint?: unknown) {
  return makeStreamFromStorage(new FakeStorage(checkpoint));
}

test("radar timeout preserves the last good scan and retries once per normal scan without contaminating execution health", () => {
  const candidate = { id: "BTC:1", symbol: "BTC_USDT", side: "LONG", strength: 2, moveRate: 0.01,
    movementMultiple: 2, volume24hUsd: 1_000_000, confirmations: 2, firstSeenAt: 1, observedAt: 1,
    kind: "NEW_MONEY" };
  const healthy = { scanned: 30, lastScanAt: 1_000, lastAttemptAt: 1_000, consecutiveFailures: 0,
    retryAt: null, lastError: null, candidates: [candidate] };
  const first = failedRadarRuntime(healthy, 11_000, new Error("The operation was aborted due to timeout"));

  assert.equal(first.scanned, 30);
  assert.equal(first.lastScanAt, 1_000);
  assert.deepEqual(first.candidates, [candidate]);
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.retryAt, 21_000);
  assert.equal(radarAttemptDue(first, 20_999), false);
  assert.equal(radarAttemptDue(first, 21_000), true);

  const second = failedRadarRuntime(first, 21_000, new Error("timeout again"));
  const third = failedRadarRuntime(second, 31_000, new Error("timeout again"));
  const fourth = failedRadarRuntime(third, 41_000, new Error("timeout again"));
  assert.equal(second.retryAt, 31_000);
  assert.equal(third.retryAt, 41_000);
  assert.equal(fourth.retryAt, 51_000, "failures must not starve the eighteen-sample regime warmup");

  const recovered = successfulRadarRuntime(fourth, 51_000, 30, [candidate]);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.retryAt, null);
  assert.equal(recovered.lastError, null);
});

test("stale radar can never authorize a new strategy observation", () => {
  assert.equal(radarCandidateExecutionAllowed(null, 100_000), false);
  assert.equal(radarCandidateExecutionAllowed(70_000, 100_000), true);
  assert.equal(radarCandidateExecutionAllowed(69_999, 100_000), false);
});

test("stale bulk radar does not interrupt completed-five-minute shadow evaluation in the stable core", async () => {
  const { stream } = await makeStream();
  const now = 3_600_000;
  const memory = emptySymbolMemory();
  memory.recentCompletedMinuteCandles = Array.from({ length: 60 }, (_, index) => ({
    time: index * 60, open: 100 + index * 0.08, high: 100.12 + index * 0.08,
    low: 99.96 + index * 0.08, close: 100.08 + index * 0.08,
  }));
  memory.timeframeUpdatedAt.m1 = now;
  memory.minuteNoiseRate = 0.001;
  stream.memory.BTC_USDT = memory;
  stream.contractCatalog = new Map([["BTC_USDT", { symbol: "BTC_USDT", tickSize: 0.01, quantoMultiplier: 0.001,
    maintenanceRate: 0.005, leverageMax: 50, fundingRate: 0.0001, last: 104.8, volume24hUsd: 1_000_000_000 }]]);
  stream.runtime.symbols = ["BTC_USDT"];
  stream.runtime.contractMeta.BTC_USDT = { quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50, fundingRate: 0.0001 };
  stream.runtime.radar.lastScanAt = null;
  stream.observeArena("BTC_USDT", 104.8, { midpoint: 104.8, zones: [], bands: [], absorption: 0.7, decision: null,
    routes: [], range15m: null, confirmationBySide: { LONG: 0.8, SHORT: 0.1 },
    fakeoutBySide: { LONG: 0.2, SHORT: 0.8 } }, now, 0.0002, 104.79, 104.81, 1_000_000, 1_000_000);
  const opened = Object.values(stream.runtime.strategyArena.open) as ArenaTrade[];
  assert.equal(opened.length, 4, "all executable, genuinely distinct stable-candle variants keep learning when bulk radar is stale");
  assert.ok(opened.every((trade) => trade.context.structureSource === "CANDLE_5M"));
  assert.equal(new Set(opened.map((trade) => `${trade.strategyId}:${trade.orientation ?? "NORMAL"}`)).size, opened.length);
});

function position(id: string, symbol: string, patch: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id,
    symbol,
    side: "LONG",
    scenario: "BREAKOUT",
    entryAt: 1,
    entryPrice: 100,
    initialStop: 95,
    currentStop: 95,
    currentTarget: 110,
    plannedRisk: 10,
    notional: 1_000,
    targetScore: 1,
    targetIdentity: `BOOK:LONG:${symbol}:110`,
    status: "OPEN",
    ...patch,
  };
}

function portfolioTrade(symbol: string, openedAt: number, patch: Partial<ArenaTrade> = {}): ArenaTrade {
  return {
    id: `PORTFOLIO:${symbol}:${openedAt}`, strategyId: "steady_trend:confirm:fast", strategyName: "平稳趋势延续",
    family: "TREND", lane: "PORTFOLIO", eventId: `${symbol}:${openedAt}`, symbol, side: "LONG", status: "OPEN",
    openedAt, closedAt: null, entryPrice: 100, stopPrice: 95, targetPrice: 110, exitPrice: null, outcome: null,
    grossReturnRate: null, netReturnRate: null, netPnl: null, notional: 300, maxFavorableRate: 0,
    maxAdverseRate: 0, lastPrice: 100, selectedForPortfolio: true, reason: "趋势确认",
    admissionTier: "NORMAL", plannedRisk: 15.36, contracts: 300, quantoMultiplier: 0.01,
    leverage: 3, margin: 100, accountEquityAtOpen: 1_000,
    context: { channel: "TREND", regime: "TREND", anomalyKind: null, entryStyle: "CONFIRM", exitProfile: "FAST",
      candidateScore: 70, trendRate: 0.01, trendEfficiency: 0.8, volatilityRatio: 1.2, rangePosition: 0.9,
      openInterestChangeRate: 0.01, volume24hUsd: 100_000_000, fundingRate: 0, alignedFlow: 0.2,
      confirmation: 0.8, fakeoutRisk: 0.1, rangeId: null, modeledCostRate: 0.0012, spreadRate: 0.0001,
      bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000,
      structureSource: "ROUTE", grossRewardRate: 0.1, structuralStopRate: 0.05, netRewardRisk: 1.93,
      costShare: 0.012, empiricalExpectedReturnRate: 0.001, empiricalProfitFactor: 1.3, empiricalEvents: 8 },
    ...patch,
  };
}

function plan(symbol: string): PaperPlan {
  return {
    id: `plan:${symbol}`,
    symbol,
    observedAt: 1,
    marketState: "BREAKOUT",
    side: "LONG",
    entryTrigger: 101,
    invalidation: 98,
    target: 110,
    targetIdentity: `BOOK:LONG:${symbol}:110`,
    score: 2,
    oppositeScore: 1,
    reason: [],
    state: "PREPARED",
    createdAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    plannedRisk: 10,
    notional: 1_000,
  };
}

function bookResponse(symbol: string, midpoint: number, now: number, sequence: number) {
  const bids = Array.from({ length: 50 }, (_, index) => ({ p: String(midpoint - 0.1 - index * 0.1), s: "10" }));
  const asks = Array.from({ length: 50 }, (_, index) => ({ p: String(midpoint + 0.1 + index * 0.1), s: "10" }));
  return Response.json({ id: sequence, update: now, bids, asks, contract: symbol });
}

async function withGateBooks<T>(rows: Record<string, { midpoint: number; now: number; sequence: number }>, callback: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!url.pathname.endsWith("/futures/usdt/order_book")) throw new Error(`unexpected test fetch ${url}`);
    const symbol = url.searchParams.get("contract") ?? "";
    const row = rows[symbol];
    if (!row) return Response.json({ label: "CONTRACT_NOT_FOUND" }, { status: 404 });
    return bookResponse(symbol, row.midpoint, row.now, row.sequence);
  }) as typeof fetch;
  try { return await callback(); }
  finally { globalThis.fetch = original; }
}

test("failed authoritative checkpoint rolls back CLOSE, equity and outbox before any D1 mirror", async () => {
  const { stream, storage, db } = await makeStream();
  const now = 1_800_000_000_000;
  const open = position("rollback", "BTC_USDT");
  stream.runtime.symbols = ["BTC_USDT"];
  stream.runtime.tickSize = { BTC_USDT: 0.1 };
  stream.runtime.contractMeta = { BTC_USDT: { quantoMultiplier: 1, maintenanceRate: 0.005, fundingRate: 0 } };
  stream.runtime.positions = { BTC_USDT: open };
  stream.runtime.plans = { BTC_USDT: plan("BTC_USDT") };
  stream.runtime.evidence = { BTC_USDT: { midpoint: 100, observedAt: now - 1_000, warmup: 0, fresh: true, ancillaryFresh: false, topLong: null, topShort: null, absorption: 0 } };
  stream.memory.BTC_USDT = emptySymbolMemory();
  stream.memory.BTC_USDT.lastSequence = 100;
  stream.memory.BTC_USDT.lastBookObservedAt = now - 1_000;
  stream.memory.BTC_USDT.lastMid = 100;
  stream.sessionWarmup.BTC_USDT = 0;
  stream.publishAuthority();
  const authorityBefore = structuredClone(stream.authorityView);
  const runtimeBefore = structuredClone({
    positions: stream.runtime.positions,
    plans: stream.runtime.plans,
    evidence: stream.runtime.evidence,
    equity: stream.runtime.equity,
    equityVersion: stream.runtime.equityVersion,
    outbox: stream.runtime.outbox,
  });
  storage.failPuts = 1;

  await withGateBooks({ BTC_USDT: { midpoint: 94, now, sequence: 101 } }, async () => {
    await assert.rejects(stream.processBooks(now, ["BTC_USDT"]), /injected Durable Object storage failure/);
  });

  assert.deepEqual({
    positions: stream.runtime.positions,
    plans: stream.runtime.plans,
    evidence: stream.runtime.evidence,
    equity: stream.runtime.equity,
    equityVersion: stream.runtime.equityVersion,
    outbox: stream.runtime.outbox,
  }, runtimeBefore);
  assert.deepEqual(stream.authorityView, authorityBefore);
  assert.equal(stream.runtime.positions.BTC_USDT.status, "OPEN");
  assert.equal(storage.putCalls, 1);
  assert.equal(db.batchCalls, 0);
});

test("one stale book freezes entry intent but never destroys the plan or closes an open position", async () => {
  const { stream } = await makeStream();
  const now = 1_800_000_050_000;
  const observedAt = now - STALE_AFTER_MS - 1;
  const open = position("stale-open", "ETH_USDT");
  stream.runtime.symbols = ["BTC_USDT", "ETH_USDT"];
  stream.runtime.tickSize = { BTC_USDT: 0.1, ETH_USDT: 0.1 };
  stream.runtime.contractMeta = {
    BTC_USDT: { quantoMultiplier: 1, maintenanceRate: 0.005, fundingRate: 0 },
    ETH_USDT: { quantoMultiplier: 1, maintenanceRate: 0.005, fundingRate: 0 },
  };
  stream.runtime.plans = { BTC_USDT: plan("BTC_USDT"), ETH_USDT: null };
  stream.runtime.positions = { BTC_USDT: null, ETH_USDT: open };
  stream.runtime.decisions = { BTC_USDT: { ...plan("BTC_USDT") }, ETH_USDT: null };
  stream.runtime.evidence = Object.fromEntries(stream.runtime.symbols.map((symbol: string) => [symbol, {
    midpoint: 100, observedAt, warmup: 30, fresh: true, ancillaryFresh: true,
    topLong: null, topShort: null, absorption: 0,
  }]));
  for (const symbol of stream.runtime.symbols) {
    stream.memory[symbol] = emptySymbolMemory();
    stream.memory[symbol].lastSequence = 10;
    stream.memory[symbol].lastBookObservedAt = observedAt;
    stream.memory[symbol].lastMid = 100;
    stream.sessionWarmup[symbol] = 30;
  }

  await withGateBooks({
    BTC_USDT: { midpoint: 100, now: observedAt, sequence: 10 },
    ETH_USDT: { midpoint: 100, now: observedAt, sequence: 10 },
  }, async () => { await stream.processBooks(now, ["BTC_USDT", "ETH_USDT"]); });

  assert.equal(stream.runtime.plans.BTC_USDT.state, "PREPARED");
  assert.equal(stream.runtime.decisions.BTC_USDT, null);
  assert.equal(stream.runtime.positions.BTC_USDT, null);
  assert.deepEqual(stream.runtime.positions.ETH_USDT, open, "stale transport data is never an exit price");
  assert.equal(stream.runtime.evidence.BTC_USDT.fresh, false);
  assert.equal(stream.runtime.evidence.ETH_USDT.fresh, false);
  assert.equal(stream.runtime.feedFailures.BTC_USDT.count, 1);
  assert.match(stream.runtime.evidence.BTC_USDT.suspensionReason, /计划冻结/);
});

test("a frozen plan needs two advancing fresh books to re-arm and persistent failure eventually cancels", async () => {
  const { stream } = await makeStream();
  const now = 1_800_000_060_000;
  stream.runtime.symbols = ["BTC_USDT"];
  stream.runtime.tickSize = { BTC_USDT: 0.1 };
  stream.runtime.contractMeta = { BTC_USDT: { quantoMultiplier: 1, maintenanceRate: 0.005, leverageMax: 50, fundingRate: 0 } };
  stream.runtime.plans = { BTC_USDT: plan("BTC_USDT") };
  stream.runtime.positions = { BTC_USDT: null };
  stream.runtime.evidence = { BTC_USDT: { midpoint: 100, observedAt: now - 1_000, warmup: 30, fresh: false, ancillaryFresh: true,
    entryReady: false, topLong: null, topShort: null, absorption: 0, range15m: null } };
  stream.runtime.feedFailures.BTC_USDT = { count: 1, retryAt: 0, suspendedSince: now - 2_000, lastFreshAt: now - 2_000, recoveryFreshCount: 0 };
  stream.memory.BTC_USDT = emptySymbolMemory();
  stream.memory.BTC_USDT.lastSequence = 10;
  stream.memory.BTC_USDT.lastBookObservedAt = now - 1_000;
  stream.memory.BTC_USDT.lastMid = 100;
  stream.memory.BTC_USDT.timeframeUpdatedAt = { m1: now, m15: now, h1: now, h4: now };
  stream.sessionWarmup.BTC_USDT = 30;

  await withGateBooks({ BTC_USDT: { midpoint: 100.2, now, sequence: 11 } }, async () => { await stream.processBooks(now, ["BTC_USDT"]); });
  assert.equal(stream.runtime.plans.BTC_USDT.state, "PREPARED");
  assert.equal(stream.runtime.evidence.BTC_USDT.entryReady, false);
  assert.equal(stream.runtime.evidence.BTC_USDT.recoveryFreshCount, 1);

  await withGateBooks({ BTC_USDT: { midpoint: 100.3, now: now + 2_000, sequence: 12 } }, async () => { await stream.processBooks(now + 2_000, ["BTC_USDT"]); });
  assert.equal(stream.runtime.evidence.BTC_USDT.entryReady, true);
  assert.equal(stream.runtime.feedFailures.BTC_USDT.recoveries, 1);

  stream.runtime.plans.BTC_USDT = plan("BTC_USDT");
  stream.runtime.evidence.BTC_USDT.observedAt = now + 2_000;
  for (const failureAt of [now + 4_000, now + 6_000, now + 10_000, now + 18_000]) {
    await withGateBooks({}, async () => { await stream.processBooks(failureAt, ["BTC_USDT"]); });
  }
  assert.equal(stream.runtime.plans.BTC_USDT.state, "CANCELLED");
  assert.equal(stream.runtime.feedFailures.BTC_USDT.count, 4);
});

test("a bankrupt PAPER cycle is archived before a fresh 1000 U cycle starts", async () => {
  const { stream, db } = await makeStream();
  const now = 1_800_000_075_000;
  stream.runtime.symbols = ["BTC_USDT"];
  stream.runtime.tickSize = { BTC_USDT: 0.1 };
  stream.runtime.contractMeta = { BTC_USDT: { quantoMultiplier: 1, maintenanceRate: 0.005, leverageMax: 50, fundingRate: 0 } };
  stream.runtime.equity = 290;
  stream.runtime.paperCycle = { number: 4, startedAt: now - 86_400_000, startingEquity: 1_000, peakEquity: 1_050, trades: [] };
  stream.memory.BTC_USDT = emptySymbolMemory();
  stream.sessionWarmup.BTC_USDT = 0;

  await withGateBooks({ BTC_USDT: { midpoint: 100, now, sequence: 1 } }, async () => {
    await stream.processBooks(now, ["BTC_USDT"]);
  });

  assert.equal(stream.runtime.equity, 1_000);
  assert.equal(stream.runtime.paperCycle.number, 5);
  assert.equal(stream.runtime.paperCycle.startingEquity, 1_000);
  assert.equal(stream.runtime.bankruptcyOutbox.length, 0, "successful D1 archive drains only after the authority checkpoint");
  const archive = db.statements.flat().find((statement) => statement.args.includes("PAPER_BANKRUPTCY"));
  assert.ok(archive);
  const payload = JSON.parse(String(archive.args.at(-1)));
  assert.equal(payload.cycleNumber, 4);
  assert.equal(payload.endingEquity, 290);
});

test("manual PAPER reset closes only PAPER positions at a fresh price and starts a 1000 U cycle", async () => {
  const { stream } = await makeStream();
  const now = Date.now();
  const open = position("manual-reset", "BTC_USDT");
  stream.runtime.equity = 740;
  stream.runtime.paperCycle = { number: 3, startedAt: now - 10_000, startingEquity: 1_000, peakEquity: 1_000, trades: [] };
  stream.runtime.positions = { BTC_USDT: open };
  stream.runtime.plans = { BTC_USDT: plan("BTC_USDT") };
  stream.runtime.decisions = { BTC_USDT: { ...plan("BTC_USDT") } };
  stream.runtime.routes = { BTC_USDT: [] };
  stream.runtime.evidence = { BTC_USDT: { midpoint: 102, observedAt: now, warmup: 30, fresh: true, ancillaryFresh: true,
    topLong: null, topShort: null, absorption: 0, range15m: null } };
  const liveBefore = structuredClone(stream.runtime.live);

  const result = await stream.resetPaperAccount();

  assert.equal(result.ok, true);
  assert.equal(stream.runtime.equity, 1_000);
  assert.equal(stream.runtime.paperCycle.number, 4);
  assert.deepEqual(stream.runtime.positions, {});
  assert.deepEqual(stream.runtime.plans, {});
  assert.deepEqual(stream.runtime.live, liveBefore, "manual PAPER reset cannot mutate Gate state");
});

test("manual PAPER reset refuses to price an open position from stale evidence", async () => {
  const { stream, storage } = await makeStream();
  const now = Date.now();
  stream.runtime.positions = { BTC_USDT: position("stale-reset", "BTC_USDT") };
  stream.runtime.evidence = { BTC_USDT: { midpoint: 102, observedAt: now - STALE_AFTER_MS - 1, warmup: 30, fresh: true,
    ancillaryFresh: true, topLong: null, topShort: null, absorption: 0, range15m: null } };
  const before = structuredClone(stream.runtime);

  await assert.rejects(stream.resetPaperAccount(), /行情不新鲜/);

  assert.deepEqual(stream.runtime, before);
  assert.equal(storage.putCalls, 0);
});

test("manual reset archives the V3 futures account while preserving shadow research", async () => {
  const { stream } = await makeStream();
  const now = Date.now();
  const strategyId = "steady_trend:confirm:fast";
  stream.runtime.strategyArena.portfolioEquity = 980;
  stream.runtime.strategyArena.portfolioResolved = 3;
  stream.runtime.strategyArena.strategies[strategyId].shadowResolved = 7;
  stream.runtime.strategyArena.portfolioOpen = { BTC_USDT: portfolioTrade("BTC_USDT", now - 10_000) };
  stream.runtime.evidence = { BTC_USDT: { midpoint: 102, bestBid: 101.9, bestAsk: 102.1, observedAt: now,
    warmup: 30, fresh: true, ancillaryFresh: true, topLong: null, topShort: null, absorption: 0, range15m: null } };

  const result = await stream.resetPaperAccount();

  assert.equal(result.ok, true);
  assert.equal(stream.runtime.strategyArena.portfolioEquity, 1_000);
  assert.equal(stream.runtime.strategyArena.portfolioCycle, 2);
  assert.deepEqual(stream.runtime.strategyArena.portfolioOpen, {});
  assert.equal(stream.runtime.strategyArena.strategies[strategyId].shadowResolved, 7);
  assert.equal(stream.runtime.strategyArena.archivedPortfolioCycles.length, 1);
  assert.equal(stream.runtime.strategyArena.archivedPortfolioCycles[0].resolved, 4);
  assert.equal(stream.runtime.live.requestedEnabled, false);
  assert.equal(stream.runtime.live.operational, false);
});

test("manual reset is blocked whenever LIVE is requested", async () => {
  const { stream, storage } = await makeStream();
  stream.runtime.live.requestedEnabled = true;
  const before = structuredClone(stream.runtime.strategyArena);

  await assert.rejects(stream.resetPaperAccount(), /请先关闭实盘/);

  assert.deepEqual(stream.runtime.strategyArena, before);
  assert.equal(storage.putCalls, 0);
});

test("clearing PAPER history preserves current equity, open PAPER exposure and Gate state", async () => {
  const { stream, db } = await makeStream();
  const now = Date.now();
  const open = position("keep-open", "BTC_USDT");
  const closed = { ...position("drop-closed", "ETH_USDT"), status: "CLOSED" as const, exitAt: now, exitPrice: 99, realizedPnl: -11 };
  stream.runtime.equity = 812;
  stream.runtime.positions = { BTC_USDT: open, ETH_USDT: closed };
  stream.runtime.outbox = [
    { key: "keep-open:1", position: open, equity: 812, equityVersion: 1 },
    { key: "drop-closed:2", position: closed, equity: 812, equityVersion: 2 },
  ];
  stream.runtime.bankruptcyOutbox = [{ report: { id: "old-log" }, equity: 1_000, equityVersion: 3 }];
  const liveBefore = structuredClone(stream.runtime.live);

  const result = await stream.clearPaperHistory();

  assert.equal(result.ok, true);
  assert.equal(stream.runtime.equity, 812);
  assert.equal(stream.runtime.positions.BTC_USDT.status, "OPEN");
  assert.equal(stream.runtime.positions.ETH_USDT, null);
  assert.deepEqual(stream.runtime.outbox.map((item: { position: PaperPosition }) => item.position.id), ["keep-open"]);
  assert.equal(stream.runtime.bankruptcyOutbox.length, 0);
  assert.deepEqual(stream.runtime.live, liveBefore);
  assert.ok(db.statements.flat().some((statement) => statement.sql.startsWith("DELETE FROM paper_events")));
  assert.ok(db.statements.flat().some((statement) => statement.sql.includes("DELETE FROM paper_positions")));
});

test("restart preserves committed OPEN authority, cancels PREPARED work and warms from zero", async () => {
  const seed = await makeStream();
  const saved = structuredClone(seed.stream.runtime);
  const open = position("restart", "BTC_USDT");
  saved.positions = { BTC_USDT: open };
  saved.plans = { BTC_USDT: plan("BTC_USDT") };
  saved.equity = 876.5;
  saved.equityVersion = 9;
  saved.outbox = [{ key: "restart:9", position: open, equity: 876.5, equityVersion: 9 }];
  saved.contractMeta = { BTC_USDT: { quantoMultiplier: 0.0001, maintenanceRate: 0.005, fundingRate: 0 } };
  saved.symbols = ["BTC_USDT"];

  const { stream } = await makeStream(saved);
  assert.equal(stream.authorityReady, true);
  assert.equal(stream.runtime.state, "WARMING");
  assert.equal(stream.runtime.positions.BTC_USDT.status, "OPEN");
  assert.equal(stream.runtime.plans.BTC_USDT.state, "CANCELLED");
  assert.equal(stream.runtime.equity, 876.5);
  assert.equal(stream.runtime.equityVersion, 9);
  assert.equal(stream.runtime.outbox.length, 1);
  assert.equal(stream.sessionWarmup.BTC_USDT, 0);
  assert.equal(stream.authorityView.positions.BTC_USDT.status, "OPEN");
});

test("V4.4 to V5 cutover preserves the evolved account and completed-candle state", async () => {
  const seed = await makeStream();
  const saved = structuredClone(seed.stream.runtime);
  saved.version = "adaptive-target-countertrend-v4.4";
  saved.strategyArena.portfolioEquity = 963.25;
  saved.strategyArena.portfolioResolved = 11;
  saved.marketRegimes.lastUpdatedAt = 123_456;
  saved.equity = 812;
  saved.equityVersion = 7;

  const { stream } = await makeStream(saved);
  assert.equal(stream.runtime.version, "state-conditioned-expectancy-v5");
  assert.equal(stream.runtime.strategyArena.portfolioEquity, 963.25);
  assert.equal(stream.runtime.strategyArena.portfolioResolved, 11);
  assert.equal(stream.runtime.marketRegimes.lastUpdatedAt, 123_456);
  assert.equal(stream.runtime.equity, 812);
  assert.equal(stream.runtime.equityVersion, 7);
  assert.equal(stream.runtime.live.requestedEnabled, false);
  assert.equal(stream.runtime.live.operational, false);
});

test("unknown authority schema stays fail-closed and alarm never overwrites its checkpoint", async (t) => {
  const seed = await makeStream();
  const incompatible = { ...structuredClone(seed.stream.runtime), authoritySchemaVersion: 999 };
  const { stream, storage } = await makeStream(incompatible);
  assert.equal(stream.authorityReady, false);
  assert.equal(stream.runtime.state, "RECOVERY_REQUIRED");
  const now = 1_800_000_100_000;
  t.mock.method(Date, "now", () => now);
  await stream.alarm();
  assert.equal(storage.setAlarmCalls, 1, "recovery mode must keep its watchdog chain alive");
  assert.equal(storage.putCalls, 0, "unknown checkpoint must never be replaced");
  assert.deepEqual(storage.values.get("checkpoint"), incompatible);
});

test("a full D1 outage for 24h has bounded retries and a bounded latest-state outbox", async () => {
  const { stream, db } = await makeStream();
  const base = 1_800_057_600_000;
  stream.runtime.positions = { BTC_USDT: position("authority", "BTC_USDT") };
  stream.runtime.outbox = Array.from({ length: 512 }, (_, index) => {
    const value = position(`queued-${index}`, `S${index}_USDT`, { status: "CLOSED", exitAt: base, exitPrice: 100, realizedPnl: -1.8 });
    return { key: `${value.id}:${index + 1}`, position: value, equity: 900, equityVersion: index + 1 };
  });
  db.fail = true;
  for (let slot = 0; slot < 43_200; slot += 1) await stream.drainOutbox(base + slot * 2_000);

  assert.equal(db.batchCalls, 292, "2s/10s/30s/120s/300s backoff must cap a 24h outage at 292 attempts");
  assert.equal(stream.runtime.outbox.length, 512);
  assert.equal(stream.runtime.d1FailureCount, 5);
  assert.equal(stream.runtime.d1Writes, 0);
  assert.equal(stream.runtime.positions.BTC_USDT.status, "OPEN", "D1 is only a mirror");

  db.fail = false;
  await stream.drainOutbox(stream.runtime.d1RetryAt);
  assert.equal(stream.runtime.outbox.length, 0);
  assert.equal(stream.runtime.d1FailureCount, 0);
  assert.equal(stream.runtime.d1Writes, 1_536, "closed rows also retain one detailed diagnostic record each");
});

test("24h Free-plan budget stays below every published daily cap", () => {
  const alarms = 86_400_000 / 2_000;
  const cronWatchdogs = 24 * 60;
  const foreground = 86_400 / 15;
  const nonAlarmWriteCap = 8_000;
  const watchdogWorstWrites = cronWatchdogs * 2;
  const doRequests = alarms + cronWatchdogs + foreground;
  const doWrites = alarms + nonAlarmWriteCap + watchdogWorstWrites;
  const gateBookRequests = alarms * 4;
  const universeCycles = 24 * 60 / 5;
  const ancillaryCycles = alarms - universeCycles;
  const gateRequests = gateBookRequests + universeCycles * 2 + ancillaryCycles * 2;

  assert.equal(alarms, 43_200);
  assert.equal(doRequests, 50_400);
  assert.equal(doWrites, 54_080);
  assert.equal(gateRequests, 259_200);
  assert.ok(doRequests < 100_000);
  assert.ok(doWrites < 100_000);
  assert.ok(4 + 2 <= 6, "normal alarm uses at most six simultaneous outbound connections");
  assert.ok(6 < 50, "external subrequests per invocation stay below the Free limit");
  assert.ok(4 * (10_000 / 2_000) < 200, "Gate order-book calls remain below 200 requests/10s per endpoint");
  assert.ok(4_800 < 100_000, "D1 write redline retains more than 95% daily headroom");
});

test("at-least-once duplicate alarm does not reprocess a slot or add another alarm write", async (t) => {
  const { stream, storage } = await makeStream();
  const now = 1_800_000_200_000;
  t.mock.method(Date, "now", () => now);
  stream.runtime.lastUniverseAt = now;
  stream.runtime.symbols = ["A", "B", "C", "D"];
  stream.processBooks = async () => ({ successes: 4, requests: 0, criticalChanged: false });
  stream.updateAncillary = async () => 0;

  await stream.alarm();
  const processed = stream.runtime.alarmCount;
  await stream.alarm();

  assert.equal(stream.runtime.alarmCount, processed, "same UTC 2s slot must be idempotent");
  assert.equal(storage.setAlarmCalls, 1, "43,200 alarm writes/day is a hard bound only if duplicates do not re-arm");
});

test("candidate rotation stays operational while new slots warm and no protected exposure is stale", async (t) => {
  const { stream } = await makeStream();
  const now = 1_800_000_210_000;
  t.mock.method(Date, "now", () => now);
  stream.runtime.lastUniverseAt = now;
  stream.runtime.lastRadarAt = now;
  stream.runtime.symbols = ["READY_USDT", "WARMING_USDT"];
  stream.runtime.contractMeta = {
    READY_USDT: { quantoMultiplier: 1, maintenanceRate: 0.005, leverageMax: 20, fundingRate: 0 },
    WARMING_USDT: { quantoMultiplier: 1, maintenanceRate: 0.005, leverageMax: 20, fundingRate: 0 },
  };
  stream.sessionWarmup.READY_USDT = 4;
  stream.sessionWarmup.WARMING_USDT = 1;
  stream.runtime.evidence = {
    READY_USDT: { midpoint: 100, bestBid: 99.99, bestAsk: 100.01, observedAt: now, warmup: 4,
      fresh: true, ancillaryFresh: true, entryReady: true, topLong: null, topShort: null, absorption: 0, range15m: null },
    WARMING_USDT: { midpoint: 50, bestBid: 49.99, bestAsk: 50.01, observedAt: now, warmup: 1,
      fresh: true, ancillaryFresh: false, entryReady: false, topLong: null, topShort: null, absorption: 0, range15m: null },
  };
  stream.processBooks = async () => ({ successes: 2, requests: 2, criticalChanged: false });
  stream.updateAncillary = async () => 0;

  await stream.alarm();

  assert.equal(stream.runtime.state, "LIVE");
  assert.equal(stream.runtime.lastError, null);
  assert.equal(stream.runtime.evidence.WARMING_USDT.entryReady, false, "warming slot must remain unable to trade");
});

test("an empty entry-ready set is diagnostic and never becomes a global recovery error", async (t) => {
  const { stream } = await makeStream();
  const now = 1_800_000_215_000;
  t.mock.method(Date, "now", () => now);
  stream.runtime.lastUniverseAt = now;
  stream.runtime.symbols = ["WARMING_USDT"];
  stream.runtime.contractMeta = {
    WARMING_USDT: { quantoMultiplier: 1, maintenanceRate: 0.005, leverageMax: 20, fundingRate: 0 },
  };
  stream.sessionWarmup.WARMING_USDT = 4;
  stream.runtime.evidence = {
    WARMING_USDT: { midpoint: 50, bestBid: 49.99, bestAsk: 50.01, observedAt: now, warmup: 4,
      fresh: true, ancillaryFresh: false, entryReady: false, topLong: null, topShort: null, absorption: 0, range15m: null },
  };
  stream.processBooks = async () => ({ successes: 1, requests: 1, criticalChanged: false });
  stream.updateAncillary = async () => 0;

  await stream.alarm();

  assert.equal(stream.runtime.state, "WARMING");
  assert.equal(stream.runtime.lastError, null, "normal data preparation must not claim the authority is recovering");
});

test("delayed at-least-once retry crossing a 2s slot repairs the chain without reprocessing", async (t) => {
  const { stream, storage } = await makeStream();
  let now = 1_800_000_220_000;
  t.mock.method(Date, "now", () => now);
  stream.runtime.lastUniverseAt = now;
  stream.runtime.symbols = ["A", "B", "C", "D"];
  let processCalls = 0;
  stream.processBooks = async () => {
    processCalls += 1;
    return { successes: 4, requests: 0, criticalChanged: false };
  };
  stream.updateAncillary = async () => 0;

  await stream.alarm({ isRetry: false, retryCount: 0 });
  const processed = stream.runtime.alarmCount;
  now += 2_500;
  await stream.alarm({ isRetry: true, retryCount: 1 });

  assert.equal(processCalls, 1, "Cloudflare retry identity, not wall-clock slot, must suppress delayed replay");
  assert.equal(stream.runtime.alarmCount, processed);
  assert.equal(stream.runtime.nextAlarmAt, now + 2_000, "a due pre-arm is replaced by exactly one recovery alarm");
  assert.equal(storage.setAlarmCalls, 2, "the recovery write replaces the elapsed normal slot; it does not replay work");
});

test("re-instantiated retries handle future, missing and past alarms without replaying work", async (t) => {
  const checkpointSeed = await makeStream();
  const checkpoint = structuredClone(checkpointSeed.stream.runtime);
  const now = 1_800_000_240_000;
  t.mock.method(Date, "now", () => now);

  const scenarios = [
    { name: "future", alarm: now + 5_000, expectedSets: 0, expectedNext: now + 5_000 },
    { name: "missing", alarm: null, expectedSets: 1, expectedNext: now + 2_000 },
    { name: "past", alarm: now - 1, expectedSets: 1, expectedNext: now + 2_000 },
  ] as const;

  for (const scenario of scenarios) {
    const storage = new FakeStorage(checkpoint);
    storage.alarm = scenario.alarm;
    const { stream } = await makeStreamFromStorage(storage);
    let processCalls = 0;
    stream.processBooks = async () => {
      processCalls += 1;
      return { successes: 4, requests: 0, criticalChanged: false };
    };

    await stream.alarm({ isRetry: true, retryCount: 1 });

    assert.equal(processCalls, 0, `${scenario.name} retry must not repeat market decisions`);
    assert.equal(stream.runtime.alarmCount, checkpoint.alarmCount, `${scenario.name} retry must not increment alarm work`);
    assert.equal(storage.setAlarmCalls, scenario.expectedSets, `${scenario.name} retry must use the minimum alarm writes`);
    assert.equal(stream.runtime.nextAlarmAt, scenario.expectedNext);
  }
});

test("critical structure blocks entries while OI, trades and liquidation remain optional", () => {
  const symbols = ["A", "B", "C", "D"];
  assert.deepEqual(ancillarySchedule(7, symbols, ["C"]), { symbol: "C", feature: "1m" });
  const schedule = Array.from({ length: 20 }, (_, cursor) => ancillarySchedule(cursor, symbols)!);
  assert.equal(new Set(schedule.map((row) => `${row.symbol}:${row.feature}`)).size, 20);
  assert.deepEqual(schedule, Array.from({ length: 20 }, (_, cursor) => ancillarySchedule(cursor + 20, symbols)!));

  const now = 1_800_000_300_000;
  const fresh = emptySymbolMemory();
  fresh.oiUpdatedAt = now - 6 * 60_000;
  fresh.tradesUpdatedAt = now - 120_000;
  fresh.liquidationsUpdatedAt = now - 120_000;
  fresh.timeframeUpdatedAt = { m1: now - 3 * 60_000, m15: now - 45 * 60_000,
    h1: now - 3 * 60 * 60_000, h4: now - 12 * 60 * 60_000 };
  assert.equal(ancillaryIsFresh(fresh, now), true);
  assert.equal(optionalEvidenceIsFresh(fresh, now), true);

  const optionalExpiryCases: Array<(memory: ReturnType<typeof emptySymbolMemory>) => void> = [
    (memory) => { memory.oiUpdatedAt -= 1; }, (memory) => { memory.tradesUpdatedAt -= 1; }, (memory) => { memory.liquidationsUpdatedAt -= 1; },
  ];
  for (const expire of optionalExpiryCases) {
    const stale = structuredClone(fresh); expire(stale);
    assert.equal(ancillaryIsFresh(stale, now), true);
    assert.equal(optionalEvidenceIsFresh(stale, now), false);
  }
  const criticalExpiryCases: Array<(memory: ReturnType<typeof emptySymbolMemory>) => void> = [
    (memory) => { memory.timeframeUpdatedAt.m1 -= 1; },
    (memory) => { memory.timeframeUpdatedAt.m15 -= 1; },
    (memory) => { memory.timeframeUpdatedAt.h1 -= 1; },
    (memory) => { memory.timeframeUpdatedAt.h4 -= 1; },
  ];
  for (const expire of criticalExpiryCases) {
    const stale = structuredClone(fresh);
    expire(stale);
    assert.equal(ancillaryIsFresh(stale, now), false);
  }
});

test("mark-to-market drawdown rebalances the weakest PAPER risk back under ten percent", async () => {
  const { stream } = await makeStream();
  const now = 1_800_000_400_000;
  const stop = 86.112;
  const weak = position("weak", "BTC_USDT", { currentStop: stop, initialStop: stop, targetScore: 1 });
  const strong = position("strong", "ETH_USDT", { currentStop: stop, initialStop: stop, targetScore: 2 });
  stream.runtime.symbols = ["BTC_USDT", "ETH_USDT"];
  stream.runtime.tickSize = { BTC_USDT: 0.1, ETH_USDT: 0.1 };
  stream.runtime.contractMeta = {
    BTC_USDT: { quantoMultiplier: 1, maintenanceRate: 0.005, fundingRate: 0 },
    ETH_USDT: { quantoMultiplier: 1, maintenanceRate: 0.005, fundingRate: 0 },
  };
  stream.runtime.positions = { BTC_USDT: weak, ETH_USDT: strong };
  stream.runtime.evidence = {
    BTC_USDT: { midpoint: 90, observedAt: now, warmup: 0, fresh: true, ancillaryFresh: false, topLong: null, topShort: null, absorption: 0 },
    ETH_USDT: { midpoint: 90, observedAt: now, warmup: 0, fresh: true, ancillaryFresh: false, topLong: null, topShort: null, absorption: 0 },
  };
  for (const symbol of stream.runtime.symbols) {
    stream.memory[symbol] = emptySymbolMemory();
    stream.sessionWarmup[symbol] = 0;
  }
  stream.publishAuthority();

  await withGateBooks({
    BTC_USDT: { midpoint: 90, now, sequence: 1 },
    ETH_USDT: { midpoint: 90, now, sequence: 1 },
  }, async () => { await stream.processBooks(now, ["BTC_USDT", "ETH_USDT"]); });

  assert.equal(stream.runtime.positions.BTC_USDT.status, "CLOSED", "lowest target utility exits first");
  assert.equal(stream.runtime.positions.ETH_USDT.status, "OPEN");
  const markedEquity = stream.runtime.equity
    + stream.runtime.positions.ETH_USDT.notional * (90 - stream.runtime.positions.ETH_USDT.entryPrice) / stream.runtime.positions.ETH_USDT.entryPrice;
  const remaining = remainingStressRisk(stream.runtime.positions.ETH_USDT, 90);
  assert.ok(remaining <= markedEquity * 0.10 + 1e-9, `${remaining} must be <= 10% of MTM equity ${markedEquity}`);
});

test("market refresh can never add a fourth symbol", async () => {
  const { stream } = await makeStream();
  for (let cycle = 0; cycle < 288; cycle += 1) {
    const ranked = Array.from({ length: 4 }, (_, index) => ({
      symbol: `S${cycle * 4 + index}_USDT`,
      tickSize: 0.01,
      quantoMultiplier: 1,
      maintenanceRate: 0.005,
      fundingRate: 0,
    }));
    for (const symbol of stream.runtime.symbols) {
      stream.runtime.plans[symbol] = plan(symbol);
      stream.runtime.positions[symbol] = position(`closed:${symbol}`, symbol, { status: "CLOSED", exitAt: 2, exitPrice: 100 });
      stream.runtime.evidence[symbol] = { midpoint: 100, observedAt: 1, warmup: 30, fresh: true, ancillaryFresh: true, topLong: null, topShort: null, absorption: 0 };
      stream.runtime.feedFailures[symbol] = { count: 1, retryAt: 1 };
    }
    stream.refreshUniverse(cycle * 300_000, ranked);
  }

  for (const map of [stream.memory, stream.sessionWarmup, stream.runtime.decisions, stream.runtime.plans,
    stream.runtime.positions, stream.runtime.evidence, stream.runtime.feedFailures, stream.runtime.tickSize,
    stream.runtime.contractMeta]) assert.ok(Object.keys(map).every((symbol) => ["BTC_USDT", "ETH_USDT", "SOL_USDT"].includes(symbol)));
});

test("funding-only metadata changes update resident memory without resetting warmup", async () => {
  const { stream } = await makeStream();
  const symbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];
  stream.runtime.symbols = [...symbols];
  stream.runtime.contractMeta = Object.fromEntries(symbols.map((symbol) => [symbol, {
    quantoMultiplier: 1,
    maintenanceRate: 0.005,
    fundingRate: 0.0001,
  }]));
  for (const symbol of symbols) {
    stream.memory[symbol] = emptySymbolMemory();
    stream.memory[symbol].flow.funding = 0.0001;
    stream.sessionWarmup[symbol] = 30;
  }
  const residentMemory = stream.memory.BTC_USDT;

  stream.refreshUniverse(1_800_000_500_000, symbols.map((symbol) => ({
    symbol,
    tickSize: 0.01,
    quantoMultiplier: 1,
    maintenanceRate: 0.005,
    fundingRate: symbol === "BTC_USDT" ? -0.0007 : 0.0001,
  })));

  assert.equal(stream.runtime.contractMeta.BTC_USDT.fundingRate, -0.0007);
  assert.equal(stream.memory.BTC_USDT.flow.funding, -0.0007);
  assert.strictEqual(stream.memory.BTC_USDT, residentMemory, "funding refresh must not discard accumulated evidence");
  assert.equal(stream.sessionWarmup.BTC_USDT, 30);
});

test("status exposes bounded mirror telemetry, never the complete outage outbox", async () => {
  const { stream } = await makeStream();
  stream.runtime.outbox = Array.from({ length: 512 }, (_, index) => ({
    key: `status:${index}`,
    position: position(`status:${index}`, "BTC_USDT"),
    equity: 1_000,
    equityVersion: index + 1,
  }));
  const response = await stream.fetch(new Request("https://market-stream/status"));
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.equal(body.outbox, undefined);
  assert.equal(body.live, undefined);
  assert.deepEqual(body.liveMode, { requestedEnabled: false, operational: false });
  assert.equal(body.outboxLength, 512);
  assert.equal(body.authorityReady, true);
  assert.ok(text.length < 200_000);

  const owner = await (await stream.fetch(new Request("https://market-stream/owner-runtime"))).json() as Record<string, unknown>;
  assert.deepEqual(owner.live, {
    requestedEnabled: false, operational: false, changedAt: null, lastSyncAt: null, lastError: null,
    equity: null, available: null, credentialConfigured: false, entries: {}, positions: {}, entrySkips: {},
  });
});

test("health status is compact while retaining every release gate", async () => {
  const { stream } = await makeStream();
  const now = Date.now();
  stream.runtime.lastSuccessAt = now;
  stream.runtime.lastHeartbeatAt = now;
  stream.runtime.state = "LIVE";
  stream.runtime.radar.scanned = 30;

  const response = await stream.fetch(new Request("https://market-stream/health-status"));
  const status = await response.json();

  assert.equal(status.version, "state-conditioned-expectancy-v5");
  assert.equal(status.strategyArena.version, 6);
  assert.equal(status.strategyArena.playbookCount, 12);
  assert.equal(status.strategyArena.catalogSize, 48);
  assert.equal(status.strategyArena.portfolioEquity, 1_000);
  assert.equal(status.strategyArena.rules.minimumPortfolioRiskUsdt, 10);
  assert.equal(status.strategyArena.rules.empiricalCostFloorRate, 0.0014);
  assert.equal(status.strategyArena.rules.authorityWindowPriority, "STATE_CONDITIONED_EXPECTANCY");
  assert.equal(status.strategyArena.rules.adaptivePolicyVersion, 1);
  assert.equal(status.strategyArena.rules.adaptiveMinimumAnalogSamples, 8);
  assert.equal(status.strategyArena.rules.dailyObjectiveIsQuota, false);
  assert.equal(status.limits.scanUniverse, 30);
  assert.equal(status.limits.realtimeCapacity, 10);
  assert.equal(status.liveMode.requestedEnabled, false);
  assert.equal(status.liveMode.operational, false);
  assert.equal(status.evidence, undefined);
  assert.equal(status.strategyArena.strategies, undefined);
  assert.ok(JSON.stringify(status).length < 5_000);
});

test("a capacity-limited portfolio order is skipped without blocking an affordable mirror", async () => {
  const { stream } = await makeStream();
  const symbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];
  stream.runtime.symbols = symbols;
  stream.runtime.contractMeta = Object.fromEntries(symbols.map((symbol, index) => [symbol, {
    quantoMultiplier: index === 0 ? 0.001 : 10, maintenanceRate: 0.005, leverageMax: 50, fundingRate: 0,
  }]));
  stream.runtime.evidence = Object.fromEntries(symbols.map((symbol) => [symbol, {
    midpoint: 100, observedAt: Date.now(), warmup: 30, fresh: true, ancillaryFresh: true, entryReady: true,
    topLong: null, topShort: null, absorption: 0, range15m: null,
  }]));
  let createCalls = 0;
  let snapshotCalls = 0;
  stream.liveClient = {
    requestCount: 0,
    snapshot: async () => {
      snapshotCalls += 1;
      return { account: { total: "1000", available: "100", in_dual_mode: false }, positions: [], orders: [], priceOrders: [], checkedAt: Date.now() };
    },
    createEntry: async () => { createCalls += 1; return "should-not-exist"; },
    setLeverage: async () => undefined,
  };

  const result = await stream.setLiveMode(true);
  const openedAt = stream.runtime.live.changedAt! + 1;
  stream.runtime.strategyArena.portfolioOpen = Object.fromEntries(symbols.map((symbol) =>
    [symbol, portfolioTrade(symbol, openedAt)]));
  for (const symbol of symbols) stream.runtime.evidence[symbol].observedAt = openedAt;
  await stream.syncLive(openedAt + 1);

  assert.equal(result.ok, true);
  assert.equal(stream.runtime.live.requestedEnabled, true);
  assert.equal(stream.runtime.live.operational, true);
  assert.equal(createCalls, 1, "the affordable plan must not be blocked by later capacity-limited plans");
  assert.equal(snapshotCalls, 2);
  assert.equal(Object.values(stream.runtime.live.entrySkips).filter(Boolean).length, 2);
  assert.match(stream.runtime.live.entrySkips.ETH_USDT.reason, /本轮未挂单/);
});

test("LIVE ignores existing portfolio positions and mirrors only a new post-enable account order", async () => {
  const { stream } = await makeStream();
  stream.runtime.symbols = ["BTC_USDT"];
  const oldOpenedAt = Date.now() - 60_000;
  stream.runtime.strategyArena.portfolioOpen = { BTC_USDT: portfolioTrade("BTC_USDT", oldOpenedAt) };
  stream.runtime.contractMeta = { BTC_USDT: {
    quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50, fundingRate: 0,
  } };
  let createCalls = 0;
  stream.liveClient = {
    requestCount: 0,
    snapshot: async () => ({ account: { total: "1000", available: "1000", in_dual_mode: false },
      positions: [], orders: [], priceOrders: [], checkedAt: Date.now() }),
    createEntry: async () => { createCalls += 1; return "confirmed-breakout"; },
    setLeverage: async () => undefined,
  };

  const enabled = await stream.setLiveMode(true);
  assert.equal(enabled.ok, true);
  assert.equal(createCalls, 0);

  const triggeredAt = stream.runtime.live.changedAt! + 1;
  stream.runtime.strategyArena.portfolioOpen.BTC_USDT = portfolioTrade("BTC_USDT", triggeredAt,
    { id: `PORTFOLIO:BTC_USDT:${triggeredAt}`, entryPrice: 101.2, stopPrice: 98, targetPrice: 110, lastPrice: 101.2 });
  stream.runtime.evidence.BTC_USDT = { midpoint: 101.2, observedAt: triggeredAt, warmup: 30, fresh: true,
    ancillaryFresh: true, topLong: null, topShort: null, absorption: 0 };
  await stream.syncLive(triggeredAt + 1);
  assert.equal(createCalls, 1);
  assert.equal(stream.runtime.live.entries.BTC_USDT.kind, "MARKET");
  assert.equal(stream.runtime.live.entries.BTC_USDT.planId, `PORTFOLIO:BTC_USDT:${triggeredAt}`);
});

test("forced OFF reconciliation cancels only orphaned Market Sentinel entry tags", async () => {
  const { stream } = await makeStream();
  const cancelled: Array<[string, string]> = [];
  let snapshotCalls = 0;
  stream.liveClient = {
    requestCount: 0,
    snapshot: async () => {
      snapshotCalls += 1;
      return { account: { total: "1000", available: "1000", in_dual_mode: false }, positions: [],
        orders: snapshotCalls === 1 ? [
          { id_string: "101", text: "t-ms-e-stale" },
          { id_string: "102", text: "manual-order" },
        ] : [{ id_string: "102", text: "manual-order" }], priceOrders: [], checkedAt: Date.now() };
    },
    cancelOrder: async (kind: string, id: string) => { cancelled.push([kind, id]); },
  };

  await stream.syncLive(Date.now(), false, true);

  assert.deepEqual(cancelled, [["LIMIT", "101"]]);
  assert.equal(stream.runtime.live.requestedEnabled, false);
});

test("forced OFF reconciliation fails unless Gate confirms system orders are gone", async () => {
  const { stream } = await makeStream();
  let snapshotCalls = 0;
  stream.liveClient = {
    requestCount: 0,
    snapshot: async () => {
      snapshotCalls += 1;
      return { account: { total: "1000", available: "1000", in_dual_mode: false }, positions: [],
        orders: [{ id_string: "9223372036854775807", text: "t-ms-e-stuck" }], priceOrders: [], checkedAt: Date.now() };
    },
    cancelOrder: async () => undefined,
  };

  await assert.rejects(() => stream.syncLive(Date.now(), false, true), /仍有 1 张系统挂单未撤销/);
  assert.equal(snapshotCalls, 3, "cleanup must re-read Gate after both cancellation attempts");
});
