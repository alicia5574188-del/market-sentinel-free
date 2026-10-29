/** Test driver: replays a price path through the real NtsHost + the real paper-account engine (advanceForward), the same way the DO cycle does. */
import { advanceForward, initialForward, type Contract, type ForwardState, type Quote } from "../lib/forward-relations.ts";
import { ARCHIVE_SCHEMA } from "../lib/run-log-archive.ts";
import { LIVING_LOG_SCHEMA } from "../lib/living/runlog-d1.ts";
import { NTS_RESET_KEY, newResetRecord } from "../lib/nts/reset.ts";
import { NtsHost, type HostDeps } from "../lib/nts/host.ts";
import { NTS_CONFIG_KEY } from "../lib/nts/engine.ts";
import type { Bar, Tf } from "../lib/nts/types.ts";
import { CONTRACT, memStorage, sqliteD1 } from "./nts-fixtures.ts";

export const TF_SEC: Record<Tf, number> = { "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };
export type Series = Record<string, Record<Tf, Bar[]>>;
/** price inside a 15m bar at fraction f∈[0,1]: open → (low|high first, alternating by bar) → (high|low) → close. Deterministic. */
export function pricePath(b: Bar, f: number) {
  const lowFirst = Math.floor(b.time / 900) % 2 === 0, a = lowFirst ? b.low : b.high, c = lowFirst ? b.high : b.low;
  if (f < 0.25) return b.open + (a - b.open) * (f / 0.25);
  if (f < 0.6) return a + (c - a) * ((f - 0.25) / 0.35);
  return c + (b.close - c) * ((f - 0.6) / 0.4);
}
export type SimOpts = { series: Series; startMs: number; endMs: number; stepMs?: number; spreadPct?: number; syntheticTicker?: boolean; persistEveryMs?: number; resetDone?: boolean; budget?: boolean; fresh?: boolean; onStep?: (host: NtsHost, now: number) => void; trimHistory?: number; config?: Record<string, unknown> };
/** number of leading elements satisfying a monotone predicate (true…true false…false). */
function upper<T>(arr: readonly T[], ok: (x: T) => boolean) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ok(arr[m]!)) lo = m + 1; else hi = m; } return lo; }
export async function runSim(o: SimOpts) {
  const step = o.stepMs ?? 60_000, st = memStorage({}), db = sqliteD1();
  for (const s of [...ARCHIVE_SCHEMA, ...LIVING_LOG_SCHEMA]) db.raw.exec(s);
  if (o.config) st.m.set(NTS_CONFIG_KEY, o.config);
  if (o.resetDone !== false) { const r = newResetRecord(o.startMs - 1e7); r.phase = "done"; r.resetLogged = true; r.hotCleared = true; r.verified = true; st.m.set(NTS_RESET_KEY, r); }
  const t = { now: o.startMs }, stats = { requests: 0, spendDenied: 0, perHour: new Map<number, number>(), maxPerSec: 0, secWindow: [] as number[], times: [] as number[], ntsRows: 0, entriesCalls: 0, steps: 0, openMax: 0, errors: [] as string[], maxMem: 0 };
  const seriesAt = (sym: string, tf: Tf, limit: number) => {
    const arr = o.series[sym]![tf], nowSec = t.now / 1000;
    const n = upper(arr, b => b.time + TF_SEC[tf] <= nowSec); // 已收盘的K线数（序列按时间升序，二分）
    return arr.slice(Math.max(0, n - limit), n);
  };
  const deps: HostDeps = {
    storage: st as never, db: () => db,
    candles: async (sym, tf, limit) => { stats.requests++; return seriesAt(sym, tf, limit); },
    ticker: async () => { stats.requests++; return { funding: 0.0001, oi: 1_000_000, mark: null, index: null }; },
    spend: now => { const ok = true; stats.times.push(now); stats.secWindow.push(now); while (stats.secWindow.length && now - stats.secWindow[0]! > 1000) stats.secWindow.shift(); stats.maxPerSec = Math.max(stats.maxPerSec, stats.secWindow.length); return ok; },
    reserve: () => (o.budget === false ? null : { finish() {} }), resetMemory() {}, now: () => t.now,
  };
  const host = new NtsHost(deps); await host.boot(t.now);
  const contracts: Record<string, Contract> = { BTC_USDT: { ...CONTRACT, quantoMultiplier: 0.0001 }, ETH_USDT: { ...CONTRACT, quantoMultiplier: 0.01 } }; // Gate 实际乘数
  let fwd: ForwardState = initialForward(t.now), lastPersist = t.now, peakOpen = 0; const trades: ForwardState["history"] = [];
  const bookAt = (sym: string): Quote | null => {
    const bars = o.series[sym]!["15m"], sec = t.now / 1000, i = bars.findIndex(b => b.time <= sec && sec < b.time + 900); if (i < 0) return null;
    const p = pricePath(bars[i]!, (sec - bars[i]!.time) / 900), half = p * (o.spreadPct ?? 0.0001) / 2;
    return { bestBid: p - half, bestAsk: p + half, observedAt: t.now, fresh: true, entryReady: true };
  };
  for (; t.now < o.endMs; t.now += step) {
    stats.steps++;
    try {
      o.onStep?.(host, t.now);
      const work = host.background(t.now); if (work) await work;
      const quotes: Record<string, Quote> = {}; for (const sym of Object.keys(o.series)) { const q = bookAt(sym); if (q) quotes[sym] = q; }
      const draft = host.before(t.now, fwd, quotes, contracts);
      const res = advanceForward({ state: draft ?? fwd, now: t.now, quotes, contracts });
      const changedByNts = host.after(t.now, res.state, quotes) || host.mustPersist || draft != null;
      fwd = res.state;
      // 长回放：账户引擎每步都会复制整个成交历史，历史越长越慢（O(n²)）。只保留最近 N 笔在 fwd 里，其余移到 trades（统计用日志里的 EXIT，不受影响）。
      if (o.trimHistory && fwd.history.length > o.trimHistory * 2) { trades.push(...fwd.history.slice(o.trimHistory)); fwd = { ...fwd, history: fwd.history.slice(0, o.trimHistory) } } // history 新的在前
      peakOpen = Math.max(peakOpen, fwd.positions.filter(p => p.status === "OPEN").length);
      if (changedByNts || res.changed || t.now - lastPersist >= (o.persistEveryMs ?? 300_000)) {
        const out = host.entries(t.now); stats.ntsRows += out.rows; stats.entriesCalls++;
        if (out.rows) await st.put(out.entries); host.committed(t.now); lastPersist = t.now;
      }
    } catch (e) { stats.errors.push(String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 300)); host.failed(e); }
  }
  stats.openMax = peakOpen;
  return { host, st, fwd, stats, db, now: () => t.now, trimmed: trades };
}
