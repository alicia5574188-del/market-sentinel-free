/**
 * D1 store for run log v3 (timeline buckets + finished research cases). Review only; never touches Durable
 * Object storage or the account. Keeps the newest 1200 rows and deletes the rest. Not a long-term archive.
 */
import type {D1Like} from "../run-log-archive.ts";
import {RUN_LOG_KEEP_ROWS} from "../run-log-archive.ts";
import type {Bucket,FinalCase} from "./runlog.ts";

export const LIVING_LOG_SCHEMA=[
  `CREATE TABLE IF NOT EXISTS living_run_log (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
    archived_at INTEGER NOT NULL, json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS living_run_log_kind_at ON living_run_log (kind, at)`,
] as const;
const UPSERT=`INSERT INTO living_run_log (id,kind,at,archived_at,json) VALUES (?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET json=excluded.json,archived_at=excluded.archived_at WHERE living_run_log.json IS NOT excluded.json`;
/** Self-imposed D1 row budget per UTC day for this table (rows + index entries, estimated x2). */
export const LIVING_LOG_DAILY_ROWS=8_000;
export const LIVING_LOG_EVERY_MS=2*60_000;

export type LivingLogStatus={schemaReady:boolean;lastRunAt:number|null;lastOkAt:number|null;error:string|null;failures:number;
  day:string;rowsToday:number;bucketsThisBoot:number;casesThisBoot:number;deferred:boolean};
export const emptyLivingLogStatus=():LivingLogStatus=>({schemaReady:false,lastRunAt:null,lastOkAt:null,error:null,failures:0,
  day:"",rowsToday:0,bucketsThisBoot:0,casesThisBoot:0,deferred:false});

export async function writeLivingLog(db:D1Like,status:LivingLogStatus,now:number,buckets:Bucket[],cases:FinalCase[]){
  const d=new Date(now).toISOString().slice(0,10);if(status.day!==d){status.day=d;status.rowsToday=0;}
  if(!status.schemaReady){await db.batch(LIVING_LOG_SCHEMA.map(sql=>db.prepare(sql)));status.schemaReady=true;}
  try{await db.prepare(`DELETE FROM living_run_log WHERE rowid IN (SELECT rowid FROM living_run_log ORDER BY at ASC LIMIT ?) AND (SELECT COUNT(*) FROM living_run_log)>?`).bind(800,RUN_LOG_KEEP_ROWS).run();}catch{/* 超限的旧行下轮再删 */}
  const rows=[...buckets.map(b=>({id:b.id,kind:"bucket",at:b.at,json:JSON.stringify(b)})),...cases.map(c=>({id:c.id,kind:"case",at:c.at,json:JSON.stringify(c)}))];
  if(!rows.length)return {buckets:[] as string[],cases:[] as string[]};
  // cases first when over budget: the timeline row for the current bucket is rewritten anyway
  if(status.rowsToday+rows.length*2>LIVING_LOG_DAILY_ROWS){status.deferred=true;return {buckets:[],cases:[]};}
  status.deferred=false;
  for(let i=0;i<rows.length;i+=20){
    const part=rows.slice(i,i+20);
    await db.batch(part.map(r=>db.prepare(UPSERT).bind(r.id,r.kind,r.at,now,r.json)));
  }
  status.rowsToday+=rows.length*2;status.bucketsThisBoot+=buckets.length;status.casesThisBoot+=cases.length;
  return {buckets:buckets.map(b=>b.id),cases:cases.map(c=>c.id)};
}
export async function readLivingLog(db:D1Like,kind:"bucket"|"case",from:number,to:number,limit:number){
  const res=await db.prepare(`SELECT json FROM living_run_log WHERE kind=? AND at>=? AND at<=? ORDER BY at DESC LIMIT ?`).bind(kind,from,to,limit).all<{json:string}>();
  const out:unknown[]=[];for(const r of res.results){try{out.push(JSON.parse(r.json));}catch{/* 坏行跳过 */}}
  return out.reverse();
}
export async function countLivingLog(db:D1Like){
  const res=await db.prepare(`SELECT kind, COUNT(*) AS n, MIN(at) AS first FROM living_run_log GROUP BY kind`).all<{kind:string;n:number;first:number}>();
  return Object.fromEntries(res.results.map(r=>[r.kind,{n:r.n,first:r.first}]));
}
