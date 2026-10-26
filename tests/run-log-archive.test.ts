import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import type {ForwardState, Trade} from "../lib/forward-relations.ts";
import {buildRunLogExport,closedLogRow,type LsrPositionRow} from "../lib/run-log.ts";
import {emptyTradePathBook,PATH_CAP,type TradePath} from "../lib/trade-path.ts";
import {emptyOrderJournal,orderRecord,ORDER_JOURNAL_CAP} from "../lib/order-journal.ts";
import {ARCHIVE_BATCH,ARCHIVE_SEGMENT_SIZE,TAIL_DONE_MS,archiveFileName,buildArchiveEntries,buildArchiveFile,countArchive,dueRecords,ensureArchiveSchema,
  mergeContinuousOrders,planArchiveBatch,readMeta,readSegment,segmentCount,sourceRows,writeArchiveEntries,writeMeta,type ArchiveEntry,type D1Like,type D1Stmt} from "../lib/run-log-archive.ts";
import {RunLogArchiver} from "../lib/run-log-archiver.ts";

const MIN=60_000,H=60*MIN,T=1_792_300_000_000;

/** D1 on node:sqlite: same prepare/bind/run/all/first/batch surface; batch is one transaction like D1's. */
function sqliteD1(){
  const sql=new DatabaseSync(":memory:");let statements=0;
  const make=(text:string,values:unknown[]=[]):D1Stmt=>({
    bind:(...v:unknown[])=>make(text,v),
    run:async()=>{statements++;return sql.prepare(text).run(...(values as never[]));},
    all:async<R>()=>{statements++;return {results:sql.prepare(text).all(...(values as never[])) as R[]};},
    first:async<R>()=>{statements++;return (sql.prepare(text).get(...(values as never[])) as R|undefined)??null;},
  });
  const db:D1Like&{raw:DatabaseSync;statements:()=>number}={raw:sql,statements:()=>statements,prepare:text=>make(text),
    batch:async list=>{sql.exec("BEGIN");try{const out=[];for(const s of list)out.push(await s.run());sql.exec("COMMIT");return out;}catch(e){sql.exec("ROLLBACK");throw e;}}};
  return db;
}

function trade(i:number,openedAt:number,opt:{legacy?:boolean}={}):Trade{
  const side=i%2?"SHORT":"LONG";
  const ctx:Record<string,unknown>={
    environment:"TRANSITION",marketEvolutionPhase:"EARLY",marketExpectancy:1.2,entryStructure:{kind:"RANGE",note:"x"},
    stageNote:{liveStage:"TRANSITION",priorStage:null,stageAgeMin:12,minutesSinceShock:null,shockPush:0.2,syncDrop:null},
    entryRead:{trendSide:null,withTrend:null,book:0.1,residual:-0.3,relativeStrength:0.6,move30:0.4,sync:0.5,breadth:0.4},
    coinPath:{version:"coin-path-v1",cycle:"5m",background:"DOWN",recent:"UP",bars:96,backgroundBars:90,windowMin:450,backgroundPct:-2.1,recentPct:0.5,typicalBarPct:0.4,runBars:2,runMaxBarPct:0.3,label:"x"},
  };
  if(!opt.legacy)ctx.entrySnap={mode:"RELATIVE",trade_plan:"REVERSAL",intent:"FADE",long_score:0.3,short_score:0.7,residual_z:-1.4,score:71,
    stop_price:98,planned_hold_min:240,volume24h_usd:5e7,funding_rate:0.0001,trend_score:0.2,factor_30m_pct:-0.3};
  return {id:`t-${i}`,symbol:`S${i%40}_USDT`,side,openedAt,closedAt:openedAt+30*MIN,status:"CLOSED",
    entryPrice:100,leverage:8,exitPrice:100.5,quantity:1,notional:100,stopPrice:98,lastPrice:100.5,lastQuoteAt:openedAt,
    entryFee:0.07,exitFee:0.07,fundingAllowance:0,grossPnl:0.5,netPnl:0.36,exitReason:"PLAN_INVALIDATED",exitRegime:{stage:"TRANSITION",phase:"LATE"},
    unopened:true,entryContext:ctx,
    signalRepeat:opt.legacy?undefined:{n:1,gapMin:null,nSymbol:1,prevSide:null,prevGapMin:null,prevNetPct:null,prevMfePct:null},
    entrySpreadBps:opt.legacy?undefined:4.2} as unknown as Trade;
}
const FEATURES={leverage:8,stop_dist_pct:2,hour_utc:3,weekday:1,chg_1h_pct:0.4,atr_5m_pct:0.3,dist_high_10h_pct:1,dist_low_10h_pct:2,range_pos_10h:0.6,mkt_with_share:0.7};
const END={m:30,pct:0.5,stage:null,stop:null,pi:null,pi_phase:null,wm_phase:null,wm_stop:null,wm_action:null,pl_phase:null,pl_action:null,
  pl_floor:null,pl_giveback:null,pl_trajectory:null,pp_mode:null,pp_floor:null,pp_locked_r:null,hv:null,trigger:"PLAN_INVALIDATED",detail:null,
  evidence:null,exit_stage:"TRANSITION",peak_pct:0.6,exit_pct:0.5,giveback_pct:0.1};
const path=(t:Trade,done=true):TradePath=>({id:t.id,symbol:t.symbol,side:t.side,entry:100,qty:1,notional:100,entryFee:0.07,openedAt:t.openedAt,
  exit:100.5,exitAt:t.openedAt+30*MIN,net:0.36,hold:[[0,100,100]],after:[[1,100.2,100.1]],page:0,x:FEATURES,end:done?END:null} as unknown as TradePath);
const STARTED=T-30*24*H;
const account=(rows:Trade[])=>({startedAt:STARTED,unopenedTrades:rows,positions:[],history:[]} as unknown as ForwardState);
function bookOf(rows:Trade[]){const b=emptyTradePathBook(STARTED);b.trades=rows.map(t=>path(t)).reverse();return b;} // newest first
const entry=(i:number,openedAt:number,extra:Record<string,unknown>={}):ArchiveEntry=>({id:`e-${String(i).padStart(5,"0")}`,kind:i%3?"not_opened":"position",openedAt,partial:false,
  row:{id:`e-${String(i).padStart(5,"0")}`,opened_at:openedAt,...extra},path:{id:`e-${String(i).padStart(5,"0")}`,hold:[[0,1,1]]} as never});
const STATS={records:0,bytes:0,firstOpenedAt:null,lastOpenedAt:null};

test("upsert is idempotent by id; stats count each id once; archived_at only moves when content changed", async()=>{
  const db=sqliteD1();await ensureArchiveSchema(db);await ensureArchiveSchema(db); // lazy schema is safe to repeat
  const a=entry(1,T),b=entry(2,T+MIN);
  let r=await writeArchiveEntries(db,[a,b],STARTED,T+10,STATS);
  assert.equal(r.inserted,2);assert.equal(r.stats.records,2);
  r=await writeArchiveEntries(db,[a,b],STARTED,T+20,r.stats);
  assert.equal(r.inserted,0);assert.equal(r.stats.records,2,"re-writing the same ids never double counts");
  const rows=()=>db.raw.prepare("SELECT id,archived_at,row_json FROM run_log_archive ORDER BY id").all() as {id:string;archived_at:number;row_json:string}[];
  assert.deepEqual(rows().map(x=>x.archived_at),[T+10,T+10],"unchanged content keeps archived_at");
  r=await writeArchiveEntries(db,[entry(1,T,{net_pnl:1})],STARTED,T+30,r.stats);
  assert.equal(rows().length,2);assert.equal(rows()[0]!.archived_at,T+30);assert.equal(JSON.parse(rows()[0]!.row_json).net_pnl,1);
  assert.deepEqual(await readMeta(db,"stats"),r.stats);
  assert.equal(r.stats.firstOpenedAt,T);assert.equal(r.stats.lastOpenedAt,T+MIN);
});

test("completeness gate: only records the export itself would show are archived, with the export's exact row and path", ()=>{
  const now=T+30*H,good=trade(1,T),legacy=trade(2,T,{legacy:true}),unfinished=trade(3,T);
  const state=account([good,legacy,unfinished]);
  const due=[{path:path(good),partial:false},{path:path(legacy),partial:false},{path:path(unfinished,false),partial:false}];
  const rows=sourceRows(new Set(due.map(d=>d.path.id)),state,null,[]);
  const entries=buildArchiveEntries({due,rows,tallySince:null,now});
  assert.deepEqual(entries.map(e=>e.id),["t-1"]);
  const live=buildRunLogExport({events:[],funnel:null,health:{},gate:{},exportedAt:now,liveEnabled:false,notOpened:[closedLogRow(good)] as LsrPositionRow[],completeOnly:true});
  for(const key of Object.keys(live.not_opened[0] as object))assert.ok(key in entries[0]!.row,key);
  assert.equal(entries[0]!.kind,"not_opened");assert.equal(entries[0]!.path?.id,"t-1");
});

test("due records: closed + 24h tail finished; rows about to be evicted go early as partial; oldest first in batches", ()=>{
  const now=T+3*24*H;
  const old=Array.from({length:100},(_,i)=>trade(i,now-TAIL_DONE_MS-(100-i)*MIN));
  const fresh=trade(500,now-2*H);
  const book=[path(fresh),...old.map(t=>path(t)).reverse()];
  const r=dueRecords(book,now,new Map(),new Map());
  assert.equal(r.pending,100);assert.equal(r.due.length,ARCHIVE_BATCH);
  assert.equal(r.due[0]!.path.id,"t-0","oldest first");assert.ok(!r.due.some(d=>d.path.id==="t-500"),"tail not finished");
  const archived=new Map(old.map(t=>[t.id,false]));
  assert.equal(dueRecords(book,now,archived,new Map()).pending,0,"final rows are not rewritten");
  assert.equal(dueRecords(book,now,new Map(),new Map([["t-0",now+H]])).due[0]!.path.id,"t-1","retry later");
  // a nearly full book: its oldest young rows are archived early as partial, then again once final
  const young=Array.from({length:PATH_CAP},(_,i)=>trade(1000+i,now-2*H+i*1000));
  const full=young.map(t=>path(t)).reverse();
  const early=dueRecords(full,now,new Map(),new Map(),1000);
  assert.ok(early.due.length>0&&early.due.every(d=>d.partial));
  assert.equal(early.due[0]!.path.id,"t-1000");
  assert.equal(dueRecords(full,now,new Map(early.due.map(d=>[d.path.id,true])),new Map(),1000).pending,0,"partial rows wait for the tail");
});

test("a pass deletes the long-term copy and does not write new rows", async()=>{
  const now=T+3*24*H,db=sqliteD1();
  await ensureArchiveSchema(db);
  await writeArchiveEntries(db,Array.from({length:5},(_,i)=>entry(i,now-i*MIN)),STARTED,now,STATS);
  assert.equal(await countArchive(db,{mode:"all"}),5);
  const rows=Array.from({length:100},(_,i)=>trade(i,now-TAIL_DONE_MS-(100-i)*MIN));
  const archiver=new RunLogArchiver({db:()=>db,readCold:async()=>[],readEquityDay:async()=>null},now);
  await archiver.step({now,state:account(rows),book:bookOf(rows),journal:{version:"x",accountStartedAt:STARTED,rows:[]} as never});
  assert.equal(archiver.status.error,null);
  assert.equal(await countArchive(db,{mode:"all"}),0,"the long-term archive is deleted, not copied into");
  assert.equal(archiver.status.recordsThisBoot,0);
  assert.equal(archiver.status.backfillDone,true);
  assert.equal(archiver.healthy(now),true);
});

test("failure isolation: a broken or missing D1 never throws, records the error and backs off", async()=>{
  const now=T,rows=[trade(1,now-TAIL_DONE_MS-MIN)];
  const broken:D1Like={prepare:()=>{throw new Error("D1_ERROR: overloaded");},batch:async()=>{throw new Error("D1_ERROR");}};
  const a=new RunLogArchiver({db:()=>broken,readCold:async()=>{throw new Error("x");},readEquityDay:async()=>{throw new Error("x");}},now);
  await assert.doesNotReject(a.step({now,state:account(rows),book:bookOf(rows),journal:{rows:[]} as never}));
  assert.match(a.status.error??"",/overloaded/);assert.equal(a.status.failures,1);assert.equal(a.healthy(now),false);
  assert.equal(a.due(now+MIN),false,"backs off");assert.equal(a.due(now+30*MIN),true);
  const none=new RunLogArchiver({db:()=>null,readCold:async()=>[],readEquityDay:async()=>null},now);
  await none.step({now,state:account(rows),book:null,journal:null});
  assert.match(none.status.error??"",/binding/);
  // a write that fails half way leaves no rows and no stats behind (one transaction per chunk)
  const db=sqliteD1();await ensureArchiveSchema(db);
  const bad=entry(9,T);(bad.row as Record<string,unknown>).self=bad.row; // JSON.stringify throws
  await assert.rejects(writeArchiveEntries(db,[entry(8,T),bad],STARTED,T,STATS));
  assert.equal(await countArchive(db,{mode:"all"}),0);assert.equal(await readMeta(db,"stats"),null);
});

test("segments and the 'since' cursor: ≤500 per file, no overlap, cursor only moves when told", async()=>{
  const db=sqliteD1();await ensureArchiveSchema(db);
  let stats={...STATS};
  for(let i=0;i<1203;i+=200){const r=await writeArchiveEntries(db,Array.from({length:Math.min(200,1203-i)},(_,k)=>entry(i+k,T+(i+k)*MIN)),STARTED,T+i,stats);stats=r.stats;}
  assert.equal(segmentCount(1203),3);assert.equal(segmentCount(0),0);assert.equal(segmentCount(500),1);
  assert.equal(await countArchive(db,{mode:"all"}),1203);
  const seen=new Set<string>();
  for(let k=1;k<=3;k++){const seg=await readSegment(db,{mode:"all"},k);assert.ok(seg.length<=ARCHIVE_SEGMENT_SIZE);for(const r of seg){assert.ok(!seen.has(r.id));seen.add(r.id);}}
  assert.equal(seen.size,1203);
  let cursor=await readMeta<{at:number;id:string}>(db,"export_cursor");assert.equal(cursor,null);
  const first=await readSegment(db,{mode:"since",cursor},1);assert.equal(first.length,500);
  // not advanced (e.g. download failed) → same segment again
  assert.deepEqual((await readSegment(db,{mode:"since",cursor},1)).map(r=>r.id),first.map(r=>r.id));
  await writeMeta(db,"export_cursor",{at:first.at(-1)!.archived_at,id:first.at(-1)!.id},T);
  cursor=await readMeta(db,"export_cursor");
  assert.equal(await countArchive(db,{mode:"since",cursor}),703);
  const second=await readSegment(db,{mode:"since",cursor},1);
  assert.equal(new Set([...first,...second].map(r=>r.id)).size,1000);
  // a record re-archived later (partial → final) comes back through 'since'
  await writeArchiveEntries(db,[entry(0,T,{net_pnl:2})],STARTED,T+99*H,stats);
  assert.equal(await countArchive(db,{mode:"since",cursor}),704);
});

test("time range filters on opened time [from,to)", async()=>{
  const db=sqliteD1();await ensureArchiveSchema(db);
  await writeArchiveEntries(db,Array.from({length:48},(_,i)=>entry(i,T+i*H)),STARTED,T,STATS);
  const q={mode:"range" as const,from:T+10*H,to:T+20*H};
  assert.equal(await countArchive(db,q),10);
  const seg=await readSegment(db,q,1);
  assert.deepEqual(seg.map(r=>r.opened_at),Array.from({length:10},(_,i)=>T+(10+i)*H));
});

test("archive file: same top-level keys as the live export, standalone, named by mode/range/segment", async()=>{
  const db=sqliteD1();await ensureArchiveSchema(db);
  await writeArchiveEntries(db,[entry(1,T),entry(3,T+H)],STARTED,T,STATS);
  const rows=await readSegment(db,{mode:"all"},1);
  const file=buildArchiveFile({rows,stages:[],equity:{minutes:[],days:[],truncated:false},exportedAt:T+2*H,mode:"all",segment:1,segments:1,total:2,from:null,to:null});
  const live=buildRunLogExport({events:[],funnel:null,health:{},gate:{},exportedAt:T,liveEnabled:false,completeOnly:true});
  const extra=["equity_minutes_since","equity_gaps","equity_filled_min","researchNotes","archive_read","path_check","paths","holding"];
  for(const key of [...Object.keys(live),...extra])assert.ok(key in file,key);
  assert.deepEqual(Object.keys(file).filter(k=>!(k in live)&&!extra.includes(k)),["archive"]);
  assert.deepEqual(file.not_opened.map(r=>r.id),["e-00001"]);assert.deepEqual(file.positions.map(r=>r.id),["e-00003"]);
  assert.equal(file.paths.length,2);
  assert.equal(archiveFileName({mode:"range",segment:2,segments:3,from:Date.UTC(2026,9,1)-8*H,to:Date.UTC(2026,9,8)-8*H}),
    "lsr-run-log-archive-range-202610010000-202610080000-seg2of3.json");
  assert.match(archiveFileName({mode:"since",segment:1,segments:1,openedFirst:T,openedLast:T}),/^lsr-run-log-archive-since-\d{12}-\d{12}-seg1of1\.json$/);
});

test("worker wiring: archive runs after the tick off the critical path; cursor moves only for the owner after a full segment", ()=>{
  const src=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  assert.match(src,/this\.launchTurnoverWork\(Date\.now\(\)\);\s*this\.launchArchiveWork\(Date\.now\(\)\);/);
  const fn=src.slice(src.indexOf("private launchArchiveWork("),src.indexOf("private archiveView("));
  assert.match(fn,/\.catch\(\(\)=>undefined\)/);assert.match(fn,/ctx\.waitUntil/);assert.doesNotMatch(fn,/await|storage\.put|ensureTradePaths/);
  const exp=src.slice(src.indexOf("private async archiveExport("),src.indexOf("private launchOptionalWork("));
  assert.match(exp,/mode==="since"&&rows\.length&&owner/);
  assert.ok(exp.indexOf("buildArchiveFile(")<exp.indexOf("'export_cursor',{at:"),"cursor written after the file is built");
  assert.match(src,/runLogArchive:this\.archiveView\(Date\.now\(\)\)/);
  assert.match(src,/"x-archive-owner":owner\?"1":"0"/);
});

test("a pass does not store equity days; rows already there are deleted", async()=>{
  const db=sqliteD1(),now=STARTED+3*24*H+H,asked:string[]=[];
  await ensureArchiveSchema(db);
  db.raw.prepare("INSERT INTO run_log_equity_days (day,first_ts,last_ts,archived_at,rows_json) VALUES ('2026-10-01',1,2,3,'[]')").run();
  const archiver=new RunLogArchiver({db:()=>db,readCold:async()=>[],readEquityDay:async day=>{asked.push(day);return [{ts:1,equity:1000}] as never;}},now);
  await archiver.step({now,state:account([]),book:emptyTradePathBook(STARTED),journal:{rows:[]} as never});
  assert.equal(asked.length,0,"equity days are not read into the long-term archive");
  const rows=db.raw.prepare("SELECT day FROM run_log_equity_days").all() as {day:string}[];
  assert.equal(rows.length,0);
});

test("a pass does not copy a path that has no order row", async()=>{
  const now=T+3*24*H,db=sqliteD1();
  const good=Array.from({length:40},(_,i)=>trade(i,now-TAIL_DONE_MS-(40-i)*MIN));
  const book=bookOf(good);
  const missing=Array.from({length:40},(_,i)=>path(trade(1000+i,now-TAIL_DONE_MS-(100-i)*MIN)));
  book.trades=[...book.trades,...missing.reverse()];
  const archiver=new RunLogArchiver({db:()=>db,readCold:async()=>[],readEquityDay:async()=>null},now);
  const journal={version:"order-journal-v1" as const,accountStartedAt:STARTED,rows:[]};
  await archiver.step({now,state:account(good),book,journal});
  assert.equal(archiver.status.error,null);
  assert.equal(await countArchive(db,{mode:"all"}),0);
});

test("an order about to fall out of the journal is copied before a path that can wait", ()=>{
  const now=T+3*24*H;
  const keep=path(trade(1,now-TAIL_DONE_MS-MIN));
  const journalRows=Array.from({length:ORDER_JOURNAL_CAP},(_,i)=>({id:`j-${i}`}));
  const plan=planArchiveBatch({trades:[keep],journalRows,archived:new Map(),retryAt:new Map(),now,limit:1});
  assert.equal(plan.jobs[0]!.id,`j-${ORDER_JOURNAL_CAP-1}`,"oldest journal row, the one the cap drops");
  assert.ok(plan.pending>1);
});

test("a later pass does not keep a path that was stored before the archive was turned off", async()=>{
  const now=T+3*24*H,db=sqliteD1();
  const t=trade(7,now-TAIL_DONE_MS-H);
  await ensureArchiveSchema(db);
  await writeArchiveEntries(db,[entry(7,t.openedAt)],STARTED,now,STATS);
  const archiver=new RunLogArchiver({db:()=>db,readCold:async()=>[],readEquityDay:async()=>null},now);
  await archiver.step({now,state:account([t]),book:bookOf([t]),journal:emptyOrderJournal(STARTED)});
  assert.equal(await countArchive(db,{mode:"all"}),0);
});

test("a pass does not copy journal rows that are older than the path book", async()=>{
  const now=T+3*24*H,db=sqliteD1();
  const t=trade(7,now-TAIL_DONE_MS-H);
  const journal=emptyOrderJournal(STARTED);journal.rows=[orderRecord(t)];
  const first=new RunLogArchiver({db:()=>db,readCold:async()=>[],readEquityDay:async()=>null},now);
  await first.step({now,state:account([]),book:emptyTradePathBook(STARTED),journal});
  assert.equal(await countArchive(db,{mode:"all"}),0);
  const again=new RunLogArchiver({db:()=>db,readCold:async()=>[],readEquityDay:async()=>null},now);
  await again.step({now:now+2*MIN,state:account([]),book:emptyTradePathBook(STARTED),journal});
  assert.equal(again.status.recordsThisBoot,0);
  assert.equal(await countArchive(db,{mode:"all"}),0);
});

test("a closed order whose path has left the book is not copied into the long-term archive", async()=>{
  const now=T+3*24*H,db=sqliteD1();
  const {orderRecord}=await import("../lib/order-journal.ts");
  const row=orderRecord(trade(7,now-TAIL_DONE_MS-H));
  const journal={version:"order-journal-v1" as const,accountStartedAt:STARTED,rows:[row]};
  const archiver=new RunLogArchiver({db:()=>db,readCold:async()=>[],readEquityDay:async()=>null},now);
  const book=emptyTradePathBook(STARTED);
  await archiver.step({now,state:account([]),book,journal});
  assert.equal(archiver.status.error,null);
  assert.equal(await countArchive(db,{mode:"all"}),0);
});

test("export merge is one row per id, hot wins, open time order",()=>{
  const rows=mergeContinuousOrders(
    [{id:"b",opened_at:2,src:"hot"},{id:"c",opened_at:3,src:"hot"}],
    [{id:"a",opened_at:1,src:"old"},{id:"b",opened_at:2,src:"old"}]);
  assert.deepEqual(rows.map(r=>`${r.id}:${r.src}`),["a:old","b:hot","c:hot"]);
});
