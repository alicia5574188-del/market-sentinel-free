/**
 * dynamic-v1 D1 store (never Durable Object storage, so the 4MB DO value cap is untouched). Own tables:
 *  - dyn_bars: history in chunks (one row per symbol × interval × time span, ≤ ~600 bars of [t,o,h,l,c,v] JSON)
 *  - dyn_trade_chunks: shadow trades in groups (one row per replay unit / live day / long series), rewritten as a whole
 *  - dyn_meta: small JSON values (backfill plan, trade watermarks, analysis snapshot, state timeline)
 * A self-imposed daily row budget caps writes; over budget a write is deferred (data stays in memory and is retried).
 */
import type {D1Like} from "../run-log-archive.ts";
import {Series,IV_SEC,type Bar,type Iv} from "./series.ts";
export const DYN_SCHEMA=[
  `CREATE TABLE IF NOT EXISTS dyn_bars (sym TEXT NOT NULL, iv TEXT NOT NULL, t0 INTEGER NOT NULL, t1 INTEGER NOT NULL, n INTEGER NOT NULL,
    json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (sym, iv, t0)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS dyn_trades (id TEXT PRIMARY KEY NOT NULL, pb TEXT NOT NULL, side TEXT NOT NULL, sym TEXT NOT NULL, iv TEXT NOT NULL,
    et INTEGER NOT NULL, xt INTEGER NOT NULL, net REAL NOT NULL, json TEXT NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS dyn_trade_chunks (k TEXT PRIMARY KEY NOT NULL, sym TEXT NOT NULL, iv TEXT NOT NULL, t0 INTEGER NOT NULL, n INTEGER NOT NULL,
    json TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS dyn_meta (k TEXT PRIMARY KEY NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID`,
] as const;
export const DYN_TABLES=["dyn_bars","dyn_trades","dyn_trade_chunks","dyn_meta"] as const;
/** chunk span per interval (s): 600 bars each */
export const CHUNK_SEC:Record<Iv,number>={"1d":600*86_400,"4h":600*14_400,"1h":600*3_600,"15m":600*900,"5m":600*300,"1m":600*60};
export const chunkStart=(iv:Iv,t:number)=>Math.floor(t/CHUNK_SEC[iv])*CHUNK_SEC[iv];
export const DYN_DAILY_ROWS=20_000;
export type DynStoreStatus={schemaReady:boolean;day:string;rowsToday:number;deferred:number;lastOkAt:number|null;error:string|null;failures:number};
export const emptyDynStore=():DynStoreStatus=>({schemaReady:false,day:"",rowsToday:0,deferred:0,lastOkAt:null,error:null,failures:0});
function budget(st:DynStoreStatus,now:number,rows:number){const d=new Date(now).toISOString().slice(0,10);if(st.day!==d){st.day=d;st.rowsToday=0;}
  if(st.rowsToday+rows>DYN_DAILY_ROWS){st.deferred++;return false;}st.rowsToday+=rows;return true;}
export async function ensureDynSchema(db:D1Like,st:DynStoreStatus){if(st.schemaReady)return;await db.batch(DYN_SCHEMA.map(s=>db.prepare(s)));st.schemaReady=true;}
const BAR_UPSERT=`INSERT INTO dyn_bars (sym,iv,t0,t1,n,json,updated_at) VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(sym,iv,t0) DO UPDATE SET t1=excluded.t1,n=excluded.n,json=excluded.json,updated_at=excluded.updated_at WHERE dyn_bars.json IS NOT excluded.json`;
/** rewrite the chunks of `s` that contain any of the given bar times (from the in-memory series). false = deferred by budget. */
export async function writeChunks(db:D1Like,st:DynStoreStatus,s:Series,times:readonly number[],now:number){
  const starts=[...new Set(times.map(t=>chunkStart(s.iv,t)))];if(!starts.length)return true;
  if(!budget(st,now,starts.length))return false;
  await ensureDynSchema(db,st);
  const stmts=starts.map(t0=>{const rows:number[][]=[];for(let i=0;i<s.n;i++){const t=s.t[i]!;if(t>=t0&&t<t0+CHUNK_SEC[s.iv])rows.push([t,p7(s.o[i]!),p7(s.h[i]!),p7(s.l[i]!),p7(s.c[i]!),p5(s.v[i]!)]);}
    return rows.length?db.prepare(BAR_UPSERT).bind(s.sym,s.iv,t0,rows.at(-1)![0],rows.length,JSON.stringify(rows),now):null;}).filter((x):x is NonNullable<typeof x>=>!!x);
  if(stmts.length)await db.batch(stmts);st.lastOkAt=now;return true;
}
const p7=(x:number)=>Number(x.toPrecision(7)),p5=(x:number)=>Number(x.toPrecision(5));
/** stored history of one series (all chunks, or only the last `lastChunks`; or the chunks overlapping [from, to)) */
export async function readSeries(db:D1Like,st:DynStoreStatus,sym:string,iv:Iv,opts:{lastChunks?:number;from?:number;to?:number}={}):Promise<Series>{
  await ensureDynSchema(db,st);
  const res=opts.lastChunks!=null
    ?await db.prepare(`SELECT json FROM dyn_bars WHERE sym=? AND iv=? ORDER BY t0 DESC LIMIT ?`).bind(sym,iv,opts.lastChunks).all<{json:string}>()
    :opts.from!=null&&opts.to!=null
    ?await db.prepare(`SELECT json FROM dyn_bars WHERE sym=? AND iv=? AND t0<? AND t1>=? ORDER BY t0`).bind(sym,iv,opts.to,opts.from).all<{json:string}>()
    :await db.prepare(`SELECT json FROM dyn_bars WHERE sym=? AND iv=? ORDER BY t0`).bind(sym,iv).all<{json:string}>();
  const s=new Series(sym,iv),bars:Bar[]=[];
  for(const r of res.results){try{for(const x of JSON.parse(r.json) as number[][])bars.push({t:x[0]!,o:x[1]!,h:x[2]!,l:x[3]!,c:x[4]!,v:x[5]!});}catch{/* 坏块跳过 */}}
  s.merge(bars);
  if(opts.from!=null&&opts.to!=null){const keep=bars.filter(b=>b.t>=opts.from!&&b.t<opts.to!);const z=new Series(sym,iv);z.merge(keep);return z;}
  return s;
}
/** chunk starts stored for a series (cheap: keys only) */
export async function chunkStarts(db:D1Like,st:DynStoreStatus,sym:string,iv:Iv):Promise<number[]>{
  await ensureDynSchema(db,st);
  return (await db.prepare(`SELECT t0 FROM dyn_bars WHERE sym=? AND iv=? ORDER BY t0`).bind(sym,iv).all<{t0:number}>()).results.map(r=>r.t0);
}
/** history older than the depth (+20%) is dropped for the short intervals, so the database stays bounded */
export async function pruneBars(db:D1Like,st:DynStoreStatus,iv:Iv,olderThanSec:number,now:number){
  if(!budget(st,now,1))return false;await ensureDynSchema(db,st);
  await db.prepare(`DELETE FROM dyn_bars WHERE iv=? AND t1<?`).bind(iv,olderThanSec).run();return true;
}
/** trades of one source (replay unit / live day / long series): [pbIndex, et, xt, net×1e6, ep, xp] */
export type TradeRow=[number,number,number,number,number,number];
const TCHUNK_UPSERT=`INSERT INTO dyn_trade_chunks (k,sym,iv,t0,n,json,updated_at) VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(k) DO UPDATE SET n=excluded.n,json=excluded.json,updated_at=excluded.updated_at WHERE dyn_trade_chunks.json IS NOT excluded.json`;
export async function writeTradeChunks(db:D1Like,st:DynStoreStatus,rows:readonly {k:string;sym:string;iv:Iv;t0:number;pbs:string[];trades:TradeRow[]}[],now:number){
  if(!rows.length)return true;if(!budget(st,now,rows.length))return false;await ensureDynSchema(db,st);
  for(let i=0;i<rows.length;i+=20)await db.batch(rows.slice(i,i+20).map(r=>db.prepare(TCHUNK_UPSERT).bind(r.k,r.sym,r.iv,r.t0,r.trades.length,JSON.stringify({p:r.pbs,t:r.trades}),now)));
  st.lastOkAt=now;return true;
}
export async function readTradeChunks(db:D1Like,st:DynStoreStatus,afterKey:string,limit:number){
  await ensureDynSchema(db,st);
  const res=await db.prepare(`SELECT k,sym,iv,t0,json FROM dyn_trade_chunks WHERE k>? ORDER BY k LIMIT ?`).bind(afterKey,limit).all<{k:string;sym:string;iv:string;t0:number;json:string}>();
  return res.results.map(r=>{let j:{p:string[];t:TradeRow[]}={p:[],t:[]};try{j=JSON.parse(r.json);}catch{/* 坏块跳过 */}return {k:r.k,sym:r.sym,iv:r.iv as Iv,t0:r.t0,pbs:j.p??[],trades:j.t??[]};});
}
export type StoredTrade={id:string;pb:string;side:"LONG"|"SHORT";sym:string;iv:Iv;et:number;xt:number;net:number;[k:string]:unknown};
const TRADE_INSERT=`INSERT OR IGNORE INTO dyn_trades (id,pb,side,sym,iv,et,xt,net,json) VALUES (?,?,?,?,?,?,?,?,?)`;
export async function writeTrades(db:D1Like,st:DynStoreStatus,trades:readonly StoredTrade[],now:number){
  if(!trades.length)return true;if(!budget(st,now,trades.length))return false;await ensureDynSchema(db,st);
  for(let i=0;i<trades.length;i+=40)await db.batch(trades.slice(i,i+40).map(t=>db.prepare(TRADE_INSERT).bind(t.id,t.pb,t.side,t.sym,t.iv,t.et,t.xt,t.net,JSON.stringify(t))));
  st.lastOkAt=now;return true;
}
export async function readMeta<T>(db:D1Like,st:DynStoreStatus,k:string):Promise<T|null>{
  await ensureDynSchema(db,st);const r=await db.prepare(`SELECT json FROM dyn_meta WHERE k=?`).bind(k).first<{json:string}>();
  if(!r)return null;try{return JSON.parse(r.json) as T;}catch{return null;}
}
export async function writeMeta(db:D1Like,st:DynStoreStatus,entries:Record<string,unknown>,now:number){
  const ks=Object.keys(entries);if(!ks.length)return true;if(!budget(st,now,ks.length))return false;await ensureDynSchema(db,st);
  await db.batch(ks.map(k=>db.prepare(`INSERT INTO dyn_meta (k,at,json) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET at=excluded.at,json=excluded.json`).bind(k,now,JSON.stringify(entries[k]))));
  st.lastOkAt=now;return true;
}
export async function dynCounts(db:D1Like){
  const out:Record<string,number>={};
  for(const t of DYN_TABLES){try{const r=await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{n:number}>();out[t]=r?.n??0;}catch{out[t]=-1;}}
  return out;
}
export const barsPerChunk=(iv:Iv)=>CHUNK_SEC[iv]/IV_SEC[iv];
