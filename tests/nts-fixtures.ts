import type { Bar } from "../lib/nts/types.ts";
import type { Packs, Snap, BiasResult, Zone } from "../lib/nts/decision.ts";

export const T0 = 1_760_000_000; // seconds, arbitrary fixed anchor (deterministic fixtures)
export function bars(n: number, stepSec: number, f: (i: number) => number, vol: (i: number) => number = () => 100, wick = 0.0006): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = f(i), o = i ? out[i - 1]!.close : c;
    out.push({ time: T0 + i * stepSec, open: o, close: c, high: Math.max(o, c) * (1 + wick), low: Math.min(o, c) * (1 - wick), volume: vol(i) });
  }
  return out;
}
export const up = (n: number, step: number, base = 100, slope = 0.0012) => bars(n, step, i => base * (1 + slope * i + 0.002 * Math.sin(i / 3)));
export const down = (n: number, step: number, base = 100, slope = 0.0012) => bars(n, step, i => base * (1 - slope * i + 0.002 * Math.sin(i / 3)));
export const flat = (n: number, step: number, base = 100) => bars(n, step, i => base * (1 + 0.0008 * Math.sin(i / 2)));
export const snap = (over: Partial<Snap> = {}): Snap => ({ symbol: "BTC_USDT", now: (T0 + 400 * 900) * 1000, bid: 99.99, ask: 100.01, funding: 0, fundingChg: 0, basis: 0, oiChg: { h1: 0, h4: 0 }, ...over });
export const zone = (lo: number, hi: number, score = 70, over: Partial<Zone> = {}): Zone => ({ lo, hi, mid: (lo + hi) / 2, score, touches: 3, tfs: ["1h", "4h"], reaction: 2, lastTouch: T0, parts: { touch: 0, react: 0, recent: 0, vol: 0, tf: 0, conf: 0 }, ...over });
export const biasOf = (side: "LONG" | "SHORT" | null, core = side === "LONG" ? 0.6 : side === "SHORT" ? -0.6 : 0): BiasResult => ({
  core, score: core, side, confidence: 0.7, comps: { trend: core, oi: 0, funding: 0, basis: 0, tf: {} },
  aux: { rsi1h: 55, rsi4h: 55, macdH1h: 0, macdH4h: 0, macdDir1h: "flat", macdDir4h: "flat", div1h: null, div4h: null, raw: 0, biasAdj: 0, confAdj: 0, note: "" }, unconnected: [], note: "" });

/** 15m bars hovering near 100 whose last two bars sweep below `level` and reclaim above it. LONG variant; SHORT is mirrored by the caller (price * -). */
export function sweepBars(level: number, opts: { depth?: number; reclaimVol?: number; sweepVol?: number; reclaim?: boolean; strength?: number } = {}): Bar[] {
  const depth = opts.depth ?? 0.002, base = bars(30, 900, i => level * (1.004 + 0.0004 * Math.sin(i)), () => 100);
  const sweepLow = level * (1 - depth), n = base.length;
  const sw: Bar = { time: base[n - 1]!.time + 900, open: level * 1.001, high: level * 1.0012, low: sweepLow, close: level * 0.9985, volume: opts.sweepVol ?? 150 };
  const range = level * 0.006, rcLow = sweepLow * 1.0002, rcHigh = rcLow + range, strength = opts.strength ?? 0.85;
  const rcClose = opts.reclaim === false ? level * 0.9986 : rcLow + range * strength;
  const rc: Bar = { time: sw.time + 900, open: rcLow + range * 0.1, high: opts.reclaim === false ? level * 0.9988 : rcHigh, low: rcLow, close: rcClose, volume: opts.reclaimVol ?? 160 };
  return [...base, sw, rc];
}
export const fakePack = (over: Record<string, unknown> = {}) => ({ tf: "1h", close: 100, ema: { e20: 101, e50: 100, e200: 98, s20: 0.001, s50: 0.001, s200: 0.0005, a20: 0.01, a50: 0.02, a200: 0.03 }, atr: 0.4, atrPct: 0.004, atrRank: 0.5,
  rsi: 55, rsiDiv: null, macd: { m: 0, s: 0, h: 0.1, hDir: "up", cross: null, div: null }, boll: {}, adx: {}, stoch: {}, vwapDev: 0, volX: 1, obv: "flat", cci: 0, mfi: 50, hhDist: 0, llDist: 0, patterns: [], ...over });
export const packsOf = (over: Partial<Record<"1d" | "4h" | "1h" | "15m", unknown>> = {}) => ({ "1d": fakePack({ tf: "1d" }), "4h": fakePack({ tf: "4h" }), "1h": fakePack(), "15m": null, ...over }) as unknown as Packs;

import { DEFAULT_NTS_CONFIG } from "../lib/nts/config.ts";
import { evaluateEntry } from "../lib/nts/decision.ts";
import { NtsLog } from "../lib/nts/log.ts";
import { NtsEngine } from "../lib/nts/engine.ts";
import { initialForward, type Contract, type Quote } from "../lib/forward-relations.ts";
export const CONTRACT: Contract = { quantoMultiplier: 1, leverageMax: 100, maintenanceRate: 0.003 };
export const quote = (bid: number, ask: number, now: number): Quote => ({ bestBid: bid, bestAsk: ask, observedAt: now, fresh: true, entryReady: true });
/** A ready-to-open long on BTC_USDT built from the sweep fixture. */
export function openScenario(now = Date.now()) {
  const lvl = 100, b15 = sweepBars(lvl), close = b15.at(-1)!.close, z = zone(lvl * 0.999, lvl * 1.001, 75), opp = zone(close * 1.02, close * 1.022, 70);
  const s = snap({ symbol: "BTC_USDT", now, bid: close * 0.99995, ask: close * 1.00005 });
  const dec = evaluateEntry(s, { "15m": b15 }, biasOf("LONG"), { zones: [z, opp], atr1hPct: 0.004, sizeMult: 1, inEvent: null, dataOk: true, dataNote: "" }, DEFAULT_NTS_CONFIG);
  if (dec.action !== "ENTER") throw new Error("fixture does not enter: " + JSON.stringify(dec));
  const q = quote(s.bid, s.ask, now), barTime = b15.at(-1)!.time;
  const eng = new NtsEngine(DEFAULT_NTS_CONFIG, new NtsLog(DEFAULT_NTS_CONFIG), null, now), fwd = initialForward(now);
  return { eng, fwd, dec, q, barTime, now, close, action: { type: "OPEN" as const, sym: "BTC_USDT", decision: dec, barTime, snapshot: { fixture: true } }, c: { now, quotes: { BTC_USDT: q }, contracts: { BTC_USDT: CONTRACT } } };
}

/** In-memory stand-in for DurableObjectStorage (sorted keys, list with prefix/startAfter/limit/reverse). Counts rows written. */
export function memStorage(seed: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  const st = { rowsWritten: 0, puts: 0, failPut: false, failList: false, deleted: 0 };
  const api = {
    m, st,
    async get<T>(k: string) { return m.get(k) as T | undefined; },
    async put(a: string | Record<string, unknown>, v?: unknown) {
      if (st.failPut) throw new Error("storage put failed");
      const e = typeof a === "string" ? { [a]: v } : a; st.puts++;
      for (const [k, x] of Object.entries(e)) { m.set(k, structuredClone(x)); st.rowsWritten++; }
    },
    async delete(keys: string[]) { let n = 0; for (const k of keys) if (m.delete(k)) { n++; st.deleted++; } return n; },
    async list<T>(o: { prefix?: string; start?: string; startAfter?: string; limit?: number; reverse?: boolean }) {
      if (st.failList) throw new Error("storage list failed");
      let ks = [...m.keys()].filter(k => !o.prefix || k.startsWith(o.prefix)).sort();
      if (o.start) ks = ks.filter(k => k >= o.start!); if (o.startAfter) ks = ks.filter(k => k > o.startAfter!);
      if (o.reverse) ks.reverse(); if (o.limit) ks = ks.slice(0, o.limit);
      return new Map(ks.map(k => [k, structuredClone(m.get(k)) as T]));
    },
  };
  return api;
}
export async function readAll(stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder(), reader = stream.getReader(); let text = "";
  for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
  return text.split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
}

import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1Stmt } from "../lib/run-log-archive.ts";
/** D1 on node:sqlite (same surface as D1; batch is one transaction). `fail` lets a test make matching statements throw. */
export function sqliteD1() {
  const sql = new DatabaseSync(":memory:"); const ctl = { fail: null as null | ((text: string) => boolean), statements: 0 };
  const make = (text: string, values: unknown[] = []): D1Stmt => ({
    bind: (...v: unknown[]) => make(text, v),
    run: async () => { ctl.statements++; if (ctl.fail?.(text)) throw new Error("D1 injected failure"); return sql.prepare(text).run(...(values as never[])); },
    all: async <R>() => { ctl.statements++; if (ctl.fail?.(text)) throw new Error("D1 injected failure"); return { results: sql.prepare(text).all(...(values as never[])) as R[] }; },
    first: async <R>() => { ctl.statements++; if (ctl.fail?.(text)) throw new Error("D1 injected failure"); return (sql.prepare(text).get(...(values as never[])) as R | undefined) ?? null; },
  });
  const db: D1Like & { raw: DatabaseSync; ctl: typeof ctl } = { raw: sql, ctl, prepare: text => make(text),
    batch: async list => { sql.exec("BEGIN"); try { const out = []; for (const s of list) out.push(await s.run()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
  return db;
}
