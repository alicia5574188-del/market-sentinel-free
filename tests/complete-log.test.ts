import test from "node:test";
import assert from "node:assert/strict";
import type { ForwardState, Trade } from "../lib/forward-relations.ts";
import { isCompleteLogRow, logRowGaps, exportLogRow, LOG_DROPPED_FIELDS } from "../lib/log-complete.ts";
import { buildRunLogExport, closedLogRow, isCompleteTradeRecord, type LsrPositionRow } from "../lib/run-log.ts";
import { emptyReviewLogCursor, prepareIncompletePrune, prepareReviewLogWrite, readArchivedUnopened, readReviewLog, restoreReviewLog,
  unopenedIndexKey, unopenedRowKey, UNOPENED_COLD_CAP, UNOPENED_MEMORY_CAP, UNOPENED_HOT_WINDOW_MS, INCOMPLETE_PRUNE_LIMIT, type ReviewLogCursor } from "../lib/review-log-store.ts";
import { emptyTradePathBook, exportTradePaths, observeTradePaths, pathComplete, pruneOrphanPaths, PATH_CAP, type TradePath } from "../lib/trade-path.ts";

const T = 1_792_300_000_000;
class MemoryStorage {
  map = new Map<string, unknown>();
  async get<V>(key: string) { return structuredClone(this.map.get(key)) as V | undefined; }
  async put(entries: Record<string, unknown>) { for (const [k, v] of Object.entries(entries)) this.map.set(k, structuredClone(v)); }
  async delete(keys: string[]) { let n = 0; for (const k of keys) if (this.map.delete(k)) n++; return n; }
}

/** A not-opened trade as the current capture writes it. `legacy` = captured before the snapshot fields existed. */
function trade(i: number, openedAt: number, opt: { status?: "OPEN" | "CLOSED"; legacy?: boolean; unopened?: boolean } = {}): Trade {
  const status = opt.status ?? "CLOSED", side = i % 2 ? "SHORT" : "LONG";
  const ctx: Record<string, unknown> = {
    environment: "TRANSITION", marketEvolutionPhase: "EARLY", marketExpectancy: 1.2,
    entryStructure: { kind: "RANGE", note: "x" },
    stageNote: { liveStage: "TRANSITION", priorStage: i % 3 ? "TREND" : null, stageAgeMin: 12, minutesSinceShock: null, shockPush: 0.2, syncDrop: null },
    entryRead: { trendSide: i % 4 ? side : null, withTrend: i % 4 ? true : null, book: 0.1, residual: -0.3, relativeStrength: 0.6, move30: 0.4, sync: 0.5, breadth: 0.4 },
    coinPath: { version: "coin-path-v1", cycle: "5m", background: "DOWN", recent: "UP", bars: 96, backgroundBars: 90, windowMin: 450, backgroundPct: -2.1, recentPct: 0.5, typicalBarPct: 0.4, runBars: 2, runMaxBarPct: 0.3, label: "已经压成下跌。" },
  };
  if (!opt.legacy) ctx.entrySnap = { mode: "RELATIVE", trade_plan: "REVERSAL", intent: "FADE", long_score: 0.3, short_score: 0.7, residual_z: -1.4, score: 71,
    stop_price: 98, planned_hold_min: 240, volume24h_usd: 5e7, funding_rate: 0.0001, trend_score: 0.2, factor_30m_pct: -0.3 };
  return {
    id: `t-${i}`, symbol: `S${i % 40}_USDT`, side, openedAt, closedAt: status === "CLOSED" ? openedAt + 30 * 60_000 : null, status,
    entryPrice: 100, leverage: 8, exitPrice: status === "CLOSED" ? 100.5 : null, quantity: 1, notional: 100, stopPrice: 98, lastPrice: 100.5, lastQuoteAt: openedAt,
    entryFee: 0.07, exitFee: status === "CLOSED" ? 0.07 : 0, fundingAllowance: 0, grossPnl: status === "CLOSED" ? 0.5 : null, netPnl: status === "CLOSED" ? 0.36 : null,
    exitReason: status === "CLOSED" ? "PLAN_INVALIDATED" : null, exitRegime: status === "CLOSED" ? { stage: "TRANSITION", phase: "LATE" } : undefined,
    unopened: opt.unopened ?? true, entryContext: ctx,
    signalRepeat: opt.legacy ? undefined : { n: 1, gapMin: null, nSymbol: 1, prevSide: null, prevGapMin: null, prevNetPct: null, prevMfePct: null },
    entrySpreadBps: opt.legacy ? undefined : 4.2,
  } as unknown as Trade;
}
const account = (rows: Trade[]) => ({ startedAt: T - 72 * 3600_000, unopenedTrades: rows, positions: [], history: [] } as unknown as ForwardState);

test("complete-record predicate: current capture is complete, legacy rows are not, by-design nulls never count as gaps", () => {
  const fresh = closedLogRow(trade(1, T));
  assert.deepEqual(logRowGaps(fresh as unknown as Record<string, unknown>), []);
  // by-design nulls present in this row: prev_*, signal_gap_min (first signal), minutes_since_shock (no shock), sync_drop
  for (const key of ["prev_side", "prev_gap_min", "prev_net_pct", "prev_mfe_pct", "signal_gap_min", "minutes_since_shock", "sync_drop"])
    assert.equal((fresh as unknown as Record<string, unknown>)[key], null, key);
  // no market direction: trend_side and with_trend both null is fine
  assert.equal(isCompleteTradeRecord(trade(4, T)), true);
  // still observing: no exit yet is fine
  assert.equal(isCompleteTradeRecord(trade(5, T, { status: "OPEN" })), true);
  const legacy = logRowGaps(closedLogRow(trade(6, T, { legacy: true })) as unknown as Record<string, unknown>);
  assert.ok(legacy.includes("score") && legacy.includes("signal_n") && legacy.includes("entry_spread_bps"), legacy.join(","));
  assert.equal(isCompleteTradeRecord(trade(6, T, { legacy: true })), false);
});

test("complete-record predicate: conditional fields", () => {
  const base = closedLogRow(trade(1, T)) as unknown as Record<string, unknown>;
  assert.equal(isCompleteLogRow({ ...base, with_trend: null }), false, "trend side without with_trend");
  assert.equal(isCompleteLogRow({ ...base, exit: null }), false, "closed row without exit price");
  assert.equal(isCompleteLogRow({ ...base, exit: null, closed_at: null, net_pnl: null, gross_pnl: null, exit_stage: null, exit_phase: null, exit_trigger: null }, false), true);
  assert.equal(isCompleteLogRow({ ...base, gap_applicable: true, gap_bps: null }), false);
  assert.equal(isCompleteLogRow({ ...base, coin_recent: "NONE", coin_recent_pct: null }), true);
  assert.equal(isCompleteLogRow({ ...base, coin_recent: "UP", coin_recent_pct: null }), false);
  assert.equal(isCompleteLogRow({ ...base, signal_n: 3, signal_gap_min: null }), false);
  assert.equal(isCompleteLogRow({ ...base, score: Number.NaN }), false);
  const shown = exportLogRow(base);
  for (const key of LOG_DROPPED_FIELDS) assert.equal(key in shown, false, key);
});

async function seeded(rows: Trade[]) {
  const storage = new MemoryStorage(), s = account(rows);
  let cursor: ReviewLogCursor = emptyReviewLogCursor();
  for (let i = 0; i < 200; i++) {
    const plan = prepareReviewLogWrite(s, T, cursor); if (!plan.writes) break;
    await storage.put(plan.entries); await storage.delete(plan.deletes); cursor = plan.cursor;
  }
  return { storage, s, cursor };
}
async function applyPrune(storage: MemoryStorage, s: ForwardState, cursor: ReviewLogCursor) {
  const plan = prepareIncompletePrune(s, cursor, isCompleteTradeRecord)!;
  if (Object.keys(plan.entries).length) await storage.put(plan.entries);
  if (plan.deletes.length) await storage.delete(plan.deletes);
  s.unopenedTrades = (s.unopenedTrades ?? []).filter(t => !plan.ids.has(t.id));
  return { plan, cursor: plan.cursor };
}

test("prune removes incomplete closed rows from memory and the cold archive in small batches, never OPEN rows, idempotently", async () => {
  const old = Array.from({ length: 120 }, (_, i) => trade(100 + i, T - UNOPENED_HOT_WINDOW_MS - (60 + i) * 60_000, { legacy: true }));
  const good = Array.from({ length: 30 }, (_, i) => trade(i, T - UNOPENED_HOT_WINDOW_MS - (i + 1) * 60_000));
  const openLegacy = trade(999, T - 5 * 60_000, { status: "OPEN", legacy: true });
  const hotLegacy = trade(998, T - 60 * 60_000, { legacy: true });
  const seed = await seeded([openLegacy, hotLegacy, ...good, ...old]);
  const { storage, s } = seed;
  let cursor = seed.cursor;
  assert.equal(cursor.coldIds.length, 150);
  let rounds = 0;
  for (;;) {
    const r = await applyPrune(storage, s, cursor); cursor = r.cursor; rounds++;
    assert.ok(r.plan.ids.size <= INCOMPLETE_PRUNE_LIMIT);
    if (!r.plan.ids.size) break;
  }
  assert.equal(rounds, 4); // 121 incomplete closed rows / 48 per tick + the empty check
  assert.deepEqual(new Set(s.unopenedTrades!.map(t => t.id)), new Set([openLegacy.id, ...good.map(t => t.id)]));
  assert.equal(cursor.coldIds.length, 30);
  for (const t of old) assert.equal(storage.map.has(unopenedRowKey(s.startedAt, t.id)), false);
  const reread = await readReviewLog(storage, s.startedAt);
  assert.equal(reread.unopenedComplete, true);
  assert.deepEqual(reread.unopened.map(t => t.id).sort(), good.map(t => t.id).sort());
  // nothing left: plan is empty, no writes
  const again = prepareIncompletePrune(s, cursor, isCompleteTradeRecord)!;
  assert.equal(again.writes, 0); assert.equal(again.ids.size, 0);
  // other account: no plan at all
  assert.equal(prepareIncompletePrune({ ...s, startedAt: s.startedAt + 1 } as ForwardState, cursor, isCompleteTradeRecord), null);
});

test("cold archive keeps 1200 rows (= PATH_CAP); boot loads only the newest 800 into memory; export reads the rest from storage", async () => {
  assert.equal(UNOPENED_COLD_CAP, 1200); assert.equal(UNOPENED_MEMORY_CAP, 800); assert.equal(PATH_CAP, UNOPENED_COLD_CAP);
  const rows = Array.from({ length: 1300 }, (_, i) => trade(i, T - UNOPENED_HOT_WINDOW_MS - (i + 1) * 60_000));
  const { storage, s, cursor } = await seeded(rows);
  assert.equal(cursor.coldIds.length, UNOPENED_COLD_CAP);
  assert.equal(cursor.coldIds[0], "t-0");
  assert.equal(storage.map.has(unopenedRowKey(s.startedAt, "t-1299")), false, "oldest beyond the cap is evicted");
  const log = await readReviewLog(storage, s.startedAt);
  assert.equal(log.unopened.length, UNOPENED_MEMORY_CAP);
  assert.equal(log.cursor.coldIds.length, UNOPENED_COLD_CAP);
  assert.equal(log.unopenedComplete, true);
  const fresh = account([]);
  restoreReviewLog(fresh, log);
  assert.equal(fresh.unopenedTrades!.length, UNOPENED_MEMORY_CAP);
  const archived = await readArchivedUnopened(storage, s.startedAt, log.cursor.coldIds, new Set(fresh.unopenedTrades!.map(t => t.id)), t => closedLogRow(t));
  assert.equal(archived.rows.length, UNOPENED_COLD_CAP - UNOPENED_MEMORY_CAP);
  assert.equal(archived.missing, 0);
  // A newly cold row after a restart goes in front; archived rows not in memory are NOT evicted first.
  const next = account([trade(5000, T - UNOPENED_HOT_WINDOW_MS - 10_000), ...fresh.unopenedTrades!]);
  const plan = prepareReviewLogWrite(next, T, log.cursor);
  assert.equal(plan.cursor.coldIds[0], "t-5000");
  assert.equal(plan.cursor.coldIds.length, UNOPENED_COLD_CAP);
  assert.equal(plan.cursor.coldIds.includes("t-1198"), true);
  assert.deepEqual(plan.deletes, [unopenedRowKey(s.startedAt, "t-1199")]);
  assert.ok(JSON.stringify((plan.entries[unopenedIndexKey(s.startedAt)] as { ids: string[] }).ids).length < 112 * 1024, "index fits one value");
});

const FEATURES = { leverage: 8, stop_dist_pct: 2, hour_utc: 3, weekday: 1, chg_1h_pct: 0.4, atr_5m_pct: 0.3, dist_high_10h_pct: 1, dist_low_10h_pct: 2, range_pos_10h: 0.6, mkt_with_share: 0.7 };
const path = (id: string, page = 0): TradePath => ({ id, symbol: "A_USDT", side: "LONG", entry: 1, qty: 1, notional: 1, entryFee: 0, openedAt: T, exit: null, exitAt: null, net: null, hold: [[0, 1, 1]], after: [], page, x: FEATURES });

test("orphan paths (owner record removed) leave the log; owned paths stay; nothing happens unless owners are complete", () => {
  const book = emptyTradePathBook(T);
  book.trades = [path("keep-1", 1), path("gone-1", 1), path("keep-2", 0), path("gone-2", 0)];
  const owners = new Set(["keep-1", "keep-2"]);
  assert.deepEqual(pruneOrphanPaths(book, { startedAt: T, complete: false, ids: owners }), { removed: 0, remaining: 0 });
  assert.deepEqual(pruneOrphanPaths(book, { startedAt: T + 1, complete: true, ids: owners }), { removed: 0, remaining: 0 });
  assert.deepEqual(pruneOrphanPaths(book, { startedAt: T, complete: true, ids: new Set() }), { removed: 0, remaining: 0 });
  assert.deepEqual(pruneOrphanPaths(book, { startedAt: T, complete: true, ids: owners }, 1), { removed: 1, remaining: 1 });
  assert.deepEqual(pruneOrphanPaths(book, { startedAt: T, complete: true, ids: owners }), { removed: 1, remaining: 0 });
  assert.deepEqual(book.trades.map(r => r.id), ["keep-1", "keep-2"]);
  assert.equal(book.indexDirty, true);
  assert.deepEqual(exportTradePaths(book, id => id === "keep-2").map(r => r.id), ["keep-2"]);
});

test("export with completeOnly shows only complete records; account sums still include every trade", () => {
  const legacyTrade = trade(7, T - 3600_000, { legacy: true, unopened: false });
  const goodTrade = trade(8, T - 3600_000, { unopened: false });
  const rows = [closedLogRow(legacyTrade), closedLogRow(goodTrade)] as LsrPositionRow[];
  const notOpened = [closedLogRow(trade(1, T)), closedLogRow(trade(2, T, { legacy: true }))] as LsrPositionRow[];
  const fills = rows.map(row => ({ ts: row.opened_at, symbol: row.symbol, side: row.side, price: row.entry, qty: row.qty, notional: row.notional, fee: row.fee, tag: "open" as const, trace: row.trace, waitMs: null, limit: row.entry }));
  const args = { events: [], funnel: null, health: {}, gate: {}, exportedAt: T, liveEnabled: false, positions: rows, fills, equity: 10_000.72, initial: 10_000, closedNet: 0.72, notOpened };
  const all = buildRunLogExport(args), file = buildRunLogExport({ ...args, completeOnly: true });
  assert.deepEqual(file.positions.map(r => r.id), [goodTrade.id]);
  assert.deepEqual(file.not_opened.map(r => r.id), ["t-1"]);
  assert.deepEqual(file.fills.map(r => r.trace), [goodTrade.id]);
  assert.deepEqual(file.invariants, all.invariants);
  assert.equal(file.invariants.checks.fees_match, true);
  assert.equal(file.log_completeness?.positions_left_out, 1);
  assert.equal(file.log_completeness?.not_opened_left_out, 1);
  for (const key of LOG_DROPPED_FIELDS) assert.equal(key in (file.not_opened[0] as object), false, key);
  assert.equal("entry_signal" in (file.fieldNotes as object), false);
  // legacy callers (no completeOnly) are unchanged
  assert.equal(all.positions.length, 2); assert.equal(all.not_opened.length, 2);
});

test("a record is complete only with its price path: missing or unfinished path = left out of the export", () => {
  const end = { m: 30, pct: 0.5, stage: null, stop: null, pi: null, pi_phase: null, wm_phase: null, wm_stop: null, wm_action: null, pl_phase: null, pl_action: null,
    pl_floor: null, pl_giveback: null, pl_trajectory: null, pp_mode: null, pp_floor: null, pp_locked_r: null, hv: null, trigger: "PLAN_INVALIDATED", detail: null,
    evidence: null, exit_stage: "TRANSITION", peak_pct: 0.6, exit_pct: 0.5, giveback_pct: 0.1 };
  const closedPath = { ...path("t-1"), exit: 100.5, exitAt: T + 1, end };
  assert.equal(pathComplete({ ...closedPath, end: null }, true), false, "closed record: path must carry the exit state");
  assert.equal(pathComplete({ ...path("x"), x: { ...FEATURES, atr_5m_pct: null } }, false), false, "entry features are part of the record");
  assert.equal(pathComplete({ ...path("x"), x: undefined }, false), false);
  assert.equal(pathComplete(undefined, false), false);
  assert.equal(pathComplete({ ...path("x"), hold: [] }, false), false);
  assert.equal(pathComplete(path("x"), false), true, "open record: entry point is enough so far");
  assert.equal(pathComplete(path("x"), true), false, "closed record: path must carry the exit");
  assert.equal(pathComplete(closedPath, true), true);
  const notOpened = [closedLogRow(trade(1, T)), closedLogRow(trade(3, T))] as LsrPositionRow[];
  const paths = new Map([["t-1", closedPath]]);
  const file = buildRunLogExport({ events: [], funnel: null, health: {}, gate: {}, exportedAt: T, liveEnabled: false, notOpened,
    completeOnly: true, pathReady: (id, closed) => pathComplete(paths.get(id), closed) });
  assert.deepEqual(file.not_opened.map(r => r.id), ["t-1"]);
  assert.equal(file.log_completeness?.not_opened_left_out, 1);
});

test("prune also drops archived (cold, not in memory) rows whose path is gone; memory rows need record + path", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => trade(i, T - UNOPENED_HOT_WINDOW_MS - (i + 1) * 60_000));
  const { storage, s, cursor } = await seeded(rows);
  s.unopenedTrades = s.unopenedTrades!.slice(0, 6); // t-6..t-9 are archive-only now
  const withPath = new Set(["t-0", "t-1", "t-2", "t-3", "t-4", "t-6", "t-7"]);
  const plan = prepareIncompletePrune(s, cursor, t => isCompleteTradeRecord(t) && withPath.has(t.id), undefined, id => withPath.has(id))!;
  assert.deepEqual([...plan.ids].sort(), ["t-5", "t-8", "t-9"]);
  await storage.put(plan.entries); await storage.delete(plan.deletes);
  assert.deepEqual(plan.cursor.coldIds, ["t-0", "t-1", "t-2", "t-3", "t-4", "t-6", "t-7"]);
  assert.equal((await readReviewLog(storage, s.startedAt)).unopenedComplete, true);
});

test("path cap evicts the oldest records' paths but never the path of a record that is still open", () => {
  const book = emptyTradePathBook(T - 72 * 3600_000);
  const oldOpen = trade(0, T - 40 * 24 * 3600_000, { status: "OPEN", unopened: false });
  const closed = Array.from({ length: PATH_CAP + 5 }, (_, i) => trade(i + 1, T - (PATH_CAP + 10 - i) * 60_000));
  const s = { startedAt: T - 72 * 3600_000, positions: [oldOpen], history: [], unopenedTrades: closed } as unknown as ForwardState;
  observeTradePaths(book, s, {}, {}, T);
  assert.equal(book.trades.length, PATH_CAP);
  const ids = new Set(book.trades.map(r => r.id));
  assert.equal(ids.has(oldOpen.id), true);
  // the 6 dropped are the oldest closed records (t-1..t-6), not the open position
  for (let i = 1; i <= 6; i++) assert.equal(ids.has(`t-${i}`), false, `t-${i}`);
  assert.equal(ids.has("t-7"), true);
});
