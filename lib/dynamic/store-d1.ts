/**
 * dynamic-v1 D1 store (never Durable Object storage, so the 4MB DO value cap is untouched). Own tables:
 *  - dyn_bars: history in chunks (one row per symbol × interval × time span, ≤ ~600 bars of [t,o,h,l,c,v] JSON)
 *  - dyn_trades: one row per closed shadow trade (deterministic id, written once)
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
  `CREATE TABLE IF NOT EXISTS dyn_meta (k TEXT PRIMARY KEY NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID`,
] as const;
export const DYN_TABLES=["dyn_bars","dyn_trades","dyn_meta"] as const;
/** chunk span per interval (s): 600 bars each */
export const CHUNK_SEC:Record<Iv,number>={"1d":600*86_400,"4h":600*14_400,"1h":600*3_600};
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
  const stmts=starts.map(t0=>{const rows:number[][]=[];for(let i=0;i<s.n;i++){const t=s.t[i]!;if(t>=t0&&t<t0+CHUNK_SEC[s.iv])rows.push([t,s.o[i]!,s.h[i]!,s.l[i]!,s.c[i]!,s.v[i]!]);}
    return rows.length?db.prepare(BAR_UPSERT).bind(s.sym,s.iv,t0,rows.at(-1)![0],rows.length,JSON.stringify(rows),now):null;}).filter((x):x is NonNullable<typeof x>=>!!x);
  if(stmts.length)await db.batch(stmts);st.lastOkAt=now;return true;
}
/** full stored history of one series */
export async function readSeries(db:D1Like,st:DynStoreStatus,sym:string,iv:Iv):Promise<Series>{
  await ensureDynSchema(db,st);
  const res=await db.prepare(`SELECT json FROM dyn_bars WHERE sym=? AND iv=? ORDER BY t0`).bind(sym,iv).all<{json:string}>();
  const s=new Series(sym,iv),bars:Bar[]=[];
  for(const r of res.results){try{for(const x of JSON.parse(r.json) as number[][])bars.push({t:x[0]!,o:x[1]!,h:x[2]!,l:x[3]!,c:x[4]!,v:x[5]!});}catch{/* 坏块跳过 */}}
  s.merge(bars);return s;
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
