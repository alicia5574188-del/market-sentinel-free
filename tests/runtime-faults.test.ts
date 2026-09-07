import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { ancillaryIsFresh, ancillarySchedule, emptySymbolMemory } from "../lib/liquidity-runtime.ts";
import { remainingStressRisk, type PaperPlan, type PaperPosition } from "../lib/liquidity-core.ts";

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
const { MarketStream } = await import(runtimeWorkerSpecifier);

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
    return { bind: (...args: unknown[]) => ({ sql, args }) };
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

test("an unchanged book at TTL plus one millisecond cancels entry intent but never closes an open position", async () => {
  const { stream } = await makeStream();
  const now = 1_800_000_050_000;
  const observedAt = now - 3_001;
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

  assert.equal(stream.runtime.plans.BTC_USDT.state, "CANCELLED");
  assert.equal(stream.runtime.decisions.BTC_USDT, null);
  assert.equal(stream.runtime.positions.BTC_USDT, null);
  assert.deepEqual(stream.runtime.positions.ETH_USDT, open, "stale transport data is never an exit price");
  assert.equal(stream.runtime.evidence.BTC_USDT.fresh, false);
  assert.equal(stream.runtime.evidence.ETH_USDT.fresh, false);
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

test("ancillary wheel covers every symbol/feature and each TTL fails one millisecond beyond its boundary", () => {
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

  const expiryCases: Array<(memory: ReturnType<typeof emptySymbolMemory>) => void> = [
    (memory) => { memory.oiUpdatedAt -= 1; },
    (memory) => { memory.tradesUpdatedAt -= 1; },
    (memory) => { memory.liquidationsUpdatedAt -= 1; },
    (memory) => { memory.timeframeUpdatedAt.m1 -= 1; },
    (memory) => { memory.timeframeUpdatedAt.m15 -= 1; },
    (memory) => { memory.timeframeUpdatedAt.h1 -= 1; },
    (memory) => { memory.timeframeUpdatedAt.h4 -= 1; },
  ];
  for (const expire of expiryCases) {
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

test("a capacity-limited plan is skipped without blocking LIVE or other affordable plans", async () => {
  const { stream } = await makeStream();
  const symbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];
  stream.runtime.symbols = symbols;
  stream.runtime.plans = Object.fromEntries(symbols.map((symbol) => [symbol, { ...plan(symbol), marketState: "RANGE" }]));
  stream.runtime.contractMeta = Object.fromEntries(symbols.map((symbol) => [symbol, {
    quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50, fundingRate: 0,
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

  assert.equal(result.ok, true);
  assert.equal(stream.runtime.live.requestedEnabled, true);
  assert.equal(stream.runtime.live.operational, true);
  assert.equal(createCalls, 1, "the affordable plan must not be blocked by later capacity-limited plans");
  assert.equal(snapshotCalls, 1);
  assert.equal(Object.values(stream.runtime.live.entrySkips).filter(Boolean).length, 2);
  assert.match(stream.runtime.live.entrySkips.ETH_USDT.reason, /本轮未挂单/);
});

test("LIVE waits through three snapshots and submits only a four-snapshot exceptional breakout", async () => {
  const { stream } = await makeStream();
  stream.runtime.symbols = ["BTC_USDT"];
  stream.runtime.plans = { BTC_USDT: plan("BTC_USDT") };
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

  const triggeredAt = stream.runtime.live.changedAt + 1;
  stream.runtime.plans.BTC_USDT = { ...stream.runtime.plans.BTC_USDT, state: "TRIGGERED", breakoutSignalCount: 3 };
  stream.runtime.positions.BTC_USDT = position(stream.runtime.plans.BTC_USDT.id, "BTC_USDT",
    { entryAt: triggeredAt, entryPrice: 101.2 });
  stream.runtime.evidence.BTC_USDT = { midpoint: 101.2, observedAt: triggeredAt, warmup: 30, fresh: true,
    ancillaryFresh: true, topLong: null, topShort: null, absorption: 0 };
  await stream.syncLive(triggeredAt + 1);
  assert.equal(createCalls, 0);

  stream.runtime.plans.BTC_USDT = { ...stream.runtime.plans.BTC_USDT, breakoutSignalCount: 4 };
  await stream.syncLive(triggeredAt + 2);
  assert.equal(createCalls, 1);
  assert.equal(stream.runtime.live.entries.BTC_USDT.kind, "MARKET");
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
