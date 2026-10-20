/**
 * One-shot run-log wipe (runlog-wipe:v1) and paged research cases.
 *  - every run-log store is emptied (DO keys + D1 rows), open positions / balance / live switch untouched;
 *  - runs once: a second pass and a restart change nothing;
 *  - recording continues at once (bucket starts at the wipe, cases, equity minutes) and the export starts at the wipe
 *    with a zero identity error;
 *  - research cases are no longer evicted by the single-key byte cap before their 6 h finish.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import {DatabaseSync} from "node:sqlite";
import {runForward} from "./living/forward-sim.ts";
import {bj} from "./living/fixture.ts";
import {allItems,defaultLivingConfig} from "../lib/living/config.ts";
import type {LivingDirective,LivingTradeAction} from "../lib/living/directive.ts";
import type {ForwardState} from "../lib/forward-relations.ts";
import {applyFundsReset} from "../lib/forward-relations.ts";
import {wipeForwardLog,wipeBaseline,RUNLOG_WIPE_KEY,RUNLOG_WIPE_D1_TABLES} from "../lib/runlog-wipe.ts";
import {accountLogBook,buildRunLogExport} from "../lib/run-log.ts";
import {RunLog,CASE_PAGE_KEYS,CASES_KEY,type CaseInput} from "../lib/living/runlog.ts";
import {LivingEngine,LIVING_KEYS,LOG_PAGE_PREFIX} from "../lib/living/engine.ts";
import {buildLivingRunLog} from "../lib/living/runlog-export.ts";
import {ensureArchiveSchema,type D1Like,type D1Stmt} from "../lib/run-log-archive.ts";
import {LIVING_LOG_SCHEMA} from "../lib/living/runlog-d1.ts";
import {emptyOrderJournal,observeOrderJournal,ORDER_JOURNAL_KEY} from "../lib/order-journal.ts";
import {TRADE_PATH_INDEX_KEY,TRADE_PATH_PAGE_PREFIX} from "../lib/trade-path.ts";

const MIN=60_000,H=60*MIN;
let cached:ForwardState|null=null;
function account(){
  if(cached)return structuredClone(cached);
  const exited=new Set<string>();
  const r=runForward({from:bj("10-19 05:20"),to:bj("10-19 07:28"),stepMs:6000,
    extra:(state,inp)=>{
      const actions:LivingTradeAction[]=[];
      for(const t of state.positions)if(!t.inverseCopy&&t.status==="OPEN"&&!exited.has(t.id)&&inp.now-t.openedAt>=120_000){
        exited.add(t.id);actions.push({tradeId:t.id,action:"EXIT",code:"LIVING_FAST_EXHAUST",reason:"test exit"});}
      const living:LivingDirective={version:"living-v1",items:allItems(true),actions,orders:[],legacyGate:"open"};
      return {living};
    }});
  cached=r.state;return structuredClone(cached);
}
const identity=(s:ForwardState,now:number,since:{at:number;adjust:number}|null)=>{
  const book=accountLogBook(s,{},now,undefined,since);
  const file=buildRunLogExport({events:[],funnel:book.funnel,health:{},gate:{},exportedAt:now,liveEnabled:false,positions:book.positions,fills:book.fills,
    curve:book.curve,equity:book.equity,initial:book.initial,closedNet:book.closedNet,priorAdjustment:book.priorAdjustment,unreconstructed:0,unreconstructedN:0,
    places:[],notOpened:[],stageTimeline:[],liveFills:[],equityMinutes:[],tallySince:null,accountResets:book.accountResets,pendingResetAt:null} as never);
  return {book,error:(file as {invariants:{identity_error:number|null}}).invariants.identity_error};
};

test("wipeForwardLog: closed rows go, open positions / balance / totals / inverse rows stay; idempotent",()=>{
  const s=account(),at=s.lastCycleAt??Date.now();
  assert.ok(s.history.length>0,"fixture has closed trades");
  const {state:w,counts}=wipeForwardLog(s,at);
  assert.equal(w.balance,s.balance);assert.equal(w.resolved,s.resolved);assert.equal(w.fees,s.fees);
  assert.deepEqual(w.positions.map(t=>t.id),s.positions.map(t=>t.id));
  assert.equal(w.history.filter(t=>!t.inverseCopy).length,0);
  assert.equal(w.history.filter(t=>t.inverseCopy).length,s.history.filter(t=>t.inverseCopy).length,"inverse-trial rows are kept");
  assert.equal(counts.history,s.history.filter(t=>!t.inverseCopy).length);
  const again=wipeForwardLog(w,at);assert.equal(again.counts.history,0);assert.equal(again.counts.unopened,0);
  assert.deepEqual(again.state.history,w.history);
});

test("export identity after the wipe: zero at the wipe and after a later funds reset",()=>{
  const s=account(),at=(s.lastCycleAt??Date.now())+1;
  const before=identity(s,at,null);assert.ok(before.book.positions.some(r=>r.net_pnl!=null));
  const w=wipeForwardLog(s,at).state;
  const adjust=wipeBaseline({equity:identity(w,at,{at,adjust:0}).book.equity,initial:w.initialEquity,positions:identity(w,at,{at,adjust:0}).book.positions});
  const after=identity(w,at,{at,adjust});
  assert.equal(after.book.positions.filter(r=>r.net_pnl!=null).length,0,"no closed row from before the wipe");
  assert.ok(Math.abs(after.error??1)<1e-3,`identity ${after.error}`);
  assert.equal(w.positions.length,0,"fixture ends flat (reset applies at once)");
  {
    const r=structuredClone(w);applyFundsReset(r,at+MIN);
    const reset=identity(r,at+MIN,{at,adjust});
    assert.equal(r.balance,r.initialEquity);assert.equal(reset.book.accountResets.length,1);
    assert.ok(Math.abs(reset.error??1)<1e-3,`identity after reset ${reset.error}`);
  }
});

const caseInput=(i:number,at:number):CaseInput=>({at,sym:`C${i}_USDT`,side:i%2?"LONG":"SHORT",pb:"follow",pbLabel:"顺着真资金",kind:"normal",intent:"SUPPLY/CONVICTION",
  strength:.5,why:"真卖盘：价格 -1.10%，持仓量同步 +1.20%，空头没挤在一边，等反弹跟空，不追低".repeat(3),
  ev:{p15:-1.1,p60:-2.3,oi15:1.2,oi60:2.5,funding:.01,taker15:.41,vol15:2.2,basis:-.03},market:{state:"RISK_OFF",side:"SHORT",conf:.7,allowed:["follow","fade","break"]},px:100+i});
test("cases: 100 active cases (more than one key) are all kept and restored, unchanged pages are not rewritten",()=>{
  const now=1_790_000_000_000,rl=new RunLog(now);
  const layers=["WATCH","NO_LOCATION","L2_WEAK","CONFIRM_FAIL"] as const;
  for(let i=0;i<100;i++){const c=rl.noteCase(caseInput(i,now+i*1000),layers[i%4]!,"一个足够长的原因，用来把案例撑大一点点 ".repeat(2));
    for(let k=0;k<5;k++)rl.noteCase({...caseInput(i,now+i*1000+k*60_000+1)},layers[(i+k+1)%4]!,`阶段 ${k} 的原因说明 `.repeat(3));assert.ok(c);}
  assert.equal(rl.activeCount(),100);
  const out=rl.values(),keys=Object.keys(out);
  assert.ok(keys.length>=2,`spread over ${keys.length} pages`);assert.ok(keys.every(k=>CASE_PAGE_KEYS.includes(k)));
  assert.equal(rl.activeCount(),100,"no case dropped to fit one key");
  for(const v of Object.values(out))assert.ok(JSON.stringify(v).length<=96*1024);
  rl.committed(keys);assert.equal(rl.dirty,false);
  assert.deepEqual(rl.values(),{},"nothing changed → nothing written");
  rl.closeTrade("none",{closedAt:null,exit:null,exitReason:null,netPnl:null});
  rl.noteCase(caseInput(500,now+200_000),"WATCH","新的");
  const changed=Object.keys(rl.values());assert.ok(changed.length>=1&&changed.length<keys.length+1);
  const back=new RunLog(now+H);
  const stored=JSON.parse(JSON.stringify(out));
  assert.equal(back.restore(stored[CASES_KEY],now+H,CASE_PAGE_KEYS.slice(1).map(k=>stored[k])),100);
});

// ---------------------------------------------------------------- worker: one-shot wipe end to end
const cloudflareStub=`export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }`;
registerHooks({resolve(specifier,context,next){
  if(specifier==="cloudflare:workers")return {shortCircuit:true,url:`data:text/javascript,${encodeURIComponent(cloudflareStub)}`};
  if(specifier==="vinext/server/app-router-entry")return {shortCircuit:true,url:`data:text/javascript,${encodeURIComponent("export default { fetch() { return new Response('x'); } };")}`};
  return next(specifier,context);
}});
class Storage{
  values=new Map<string,unknown>();alarm:number|null=null;deletes=0;
  async get(key:string|string[]){if(Array.isArray(key))return new Map(key.filter(k=>this.values.has(k)).map(k=>[k,structuredClone(this.values.get(k))]));
    const v=this.values.get(key);return v===undefined?undefined:structuredClone(v);}
  async put(key:string|Record<string,unknown>,value?:unknown){for(const [k,v] of typeof key==="string"?[[key,value]]:Object.entries(key))this.values.set(k as string,structuredClone(v));}
  async delete(key:string|string[]){const ks=Array.isArray(key)?key:[key];let n=0;for(const k of ks){if(this.values.delete(k))n++;this.deletes++;}return Array.isArray(key)?n:n>0;}
  async transaction<T>(fn:(s:Storage)=>Promise<T>){const saved=new Map(this.values);try{return await fn(this);}catch(e){this.values=saved;throw e;}}
  async list(o:{prefix?:string;limit?:number;reverse?:boolean;start?:string;startAfter?:string;end?:string}){
    let rows=[...this.values].filter(([k])=>k.startsWith(o.prefix??"")&&(!o.startAfter||k>o.startAfter)&&(!o.start||k>=o.start)&&(!o.end||k<o.end)).sort(([a],[b])=>a.localeCompare(b));
    if(o.reverse)rows.reverse();rows=rows.slice(0,o.limit??Infinity);return new Map(rows.map(([k,v])=>[k,structuredClone(v)]));}
  async getAlarm(){return this.alarm;}async setAlarm(v:number){this.alarm=v;}async deleteAlarm(){this.alarm=null;}
}
class Ctx{ready:Promise<void>=Promise.resolve();storage:Storage;constructor(storage:Storage){this.storage=storage;}
  blockConcurrencyWhile(cb:()=>Promise<void>){this.ready=Promise.resolve().then(cb);return this.ready;}waitUntil(t:Promise<unknown>){void t;}}
function sqliteD1(){
  const sql=new DatabaseSync(":memory:");
  const make=(text:string,values:unknown[]=[]):D1Stmt=>({bind:(...v:unknown[])=>make(text,v),
    run:async()=>sql.prepare(text).run(...(values as never[])),all:async<R>()=>({results:sql.prepare(text).all(...(values as never[])) as R[]}),
    first:async<R>()=>(sql.prepare(text).get(...(values as never[])) as R|undefined)??null});
  const db:D1Like={prepare:text=>make(text),batch:async list=>{const out=[];for(const s of list)out.push(await s.run());return out;}};
  return {db,sql};
}
const count=(sql:DatabaseSync,table:string)=>(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n;

test("worker: the wipe clears every run-log store once, keeps the account, and recording resumes",async()=>{
  const {MarketStream}=await import("../worker/index-clean.ts?runlog-wipe-suite");
  const storage=new Storage(),{db,sql}=sqliteD1();
  await ensureArchiveSchema(db);for(const q of LIVING_LOG_SCHEMA)sql.exec(q);
  sql.exec("CREATE TABLE paper_positions (id TEXT PRIMARY KEY, status TEXT)");sql.exec("CREATE TABLE paper_events (id TEXT PRIMARY KEY)");
  sql.exec("INSERT INTO paper_positions VALUES ('p1','CLOSED'),('p2','CLOSED')");sql.exec("INSERT INTO paper_events VALUES ('e1')");
  sql.exec("INSERT INTO living_run_log VALUES ('b:1','bucket',1,1,'{}'),('c:1','case',1,1,'{}')");
  sql.exec("INSERT INTO run_log_archive (id,kind,account_started_at,opened_at,archived_at,partial,bytes,row_json) VALUES ('t1','trade',1,1,3,0,2,'{}')");
  sql.exec("INSERT INTO run_log_equity_days VALUES ('2026-01-01',1,2,3,'[]')");
  sql.exec("INSERT INTO run_log_stages VALUES (1,1,'{}')");
  sql.exec("INSERT INTO run_log_archive_meta VALUES ('export_cursor','{\"at\":1,\"id\":\"x\"}',1)");

  const s=account(),now=(s.lastCycleAt??Date.now())+5*MIN;
  s.storage={persistedAt:now-1000,error:null};
  const journal=emptyOrderJournal(s.startedAt);observeOrderJournal(journal,s.history,s.startedAt);
  assert.ok(journal.rows.length>0);
  storage.values.set(ORDER_JOURNAL_KEY,journal);
  storage.values.set(TRADE_PATH_INDEX_KEY,{version:"trade-path-v2",accountStartedAt:s.startedAt,pages:[0]});
  storage.values.set(`${TRADE_PATH_PAGE_PREFIX}0`,{version:"trade-path-v2",accountStartedAt:s.startedAt,page:0,trades:[]});
  storage.values.set("market-intelligence:trade-paths:v1",{version:"trade-path-v1",accountStartedAt:s.startedAt,trades:[]});
  storage.values.set("log:review:v1:stage",{version:"x",changes:[]});storage.values.set(`log:review:v1:unopened:${s.startedAt}:t:u1`,{id:"u1"});
  const day=new Date(now+8*H).toISOString().slice(0,10);
  storage.values.set(`log:eqmin:${day}`,[{ts:now-10*MIN,equity:1},{ts:now-9*MIN,equity:1}]);
  storage.values.set("log:eqmin:2026-01-01",[{ts:1,equity:1}]);
  storage.values.set(`${LOG_PAGE_PREFIX}0`,{v:1,seq:0,rows:[{at:1,k:"OLD"}]});
  storage.values.set("unrelated:key",{keep:true});

  const env={ASSETS:{fetch:async()=>new Response("a")},DB:db,MARKET_STREAM:{},OWNER_ACCESS_TOKEN:"owner-access-token-long-enough"};
  const ctx=new Ctx(storage);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w=new MarketStream(ctx as never,env as never) as any;await ctx.ready;
  w.launchOptionalWork=()=>undefined;
  w.forwardState=structuredClone(s);w.forwardError=null;w.authorityReady=true;
  const engine=new LivingEngine(now-H);engine.restore(new Map([[LIVING_KEYS.config,{...defaultLivingConfig(now-H),mode:"compute-only"}]]),now-H);
  engine.runlog.sample(now-30*MIN,{gate:"COMPUTE_ONLY",market:null,fast:"CALM",open:0,watches:0,mode:"compute-only"});
  engine.runlog.sample(now-15*MIN,{gate:"COMPUTE_ONLY",market:null,fast:"CALM",open:0,watches:0,mode:"compute-only"});
  engine.runlog.noteCase(caseInput(1,now-20*MIN),"WATCH","old");engine.note(now-20*MIN,"OLD_ROW");
  w.living=engine;
  w.eqMinBuf=[{ts:now-2*MIN,equity:1},{ts:now+MIN,equity:1}];
  const balance=s.balance,open=s.positions.map(t=>t.id);

  await w.runLogWipeOnce(now);
  const rec=storage.values.get(RUNLOG_WIPE_KEY) as {phase:string;at:number;passes:number;cleared:Record<string,number>;d1:Record<string,number>;adjust:number};
  assert.equal(w.runlogWipeError,null,String(w.runlogWipeError));
  assert.equal(rec.phase,"done");assert.equal(rec.at,now);assert.equal(rec.passes,1);
  assert.ok(rec.cleared.history>0&&rec.cleared.journal>0&&rec.cleared.living_cases===1,JSON.stringify(rec.cleared));
  for(const t of RUNLOG_WIPE_D1_TABLES)assert.equal(count(sql,t),0,`${t} emptied`);
  assert.equal(rec.d1.paper_positions,2);assert.equal(rec.d1.living_run_log,2);
  const keys=[...storage.values.keys()];
  assert.ok(!keys.some(k=>k.startsWith("log:review:v1:unopened:")),"cold not-opened rows gone");
  assert.ok(!keys.includes(`log:eqmin:2026-01-01`)&&!keys.includes(`${LOG_PAGE_PREFIX}0`)&&!keys.includes("market-intelligence:trade-paths:v1"));
  assert.equal((storage.values.get(`log:eqmin:${day}`) as unknown[]|undefined)?.length??0,0,"pre-wipe minutes gone");
  assert.equal((storage.values.get(ORDER_JOURNAL_KEY) as {rows:unknown[]}).rows.length,0);
  assert.ok(storage.values.has("unrelated:key"),"other keys untouched");
  // the account: same balance and open positions, no closed log rows, live switch still off
  assert.equal(w.forwardState.balance,balance);assert.deepEqual(w.forwardState.positions.map((t:{id:string})=>t.id),open);
  assert.equal(w.forwardState.history.filter((t:{inverseCopy?:unknown})=>!t.inverseCopy).length,0);
  assert.equal(w.runtime.live.requestedEnabled,false);
  assert.deepEqual(w.eqMinBuf.map((r:{ts:number})=>r.ts),[now+MIN]);

  // runs once: a second pass and a restart change nothing
  const snapshot=JSON.stringify([...storage.values.entries()].filter(([k])=>k===RUNLOG_WIPE_KEY));
  w.runlogWipeRetryAt=0;await w.runLogWipeOnce(now+2*MIN);
  assert.equal(JSON.stringify([...storage.values.entries()].filter(([k])=>k===RUNLOG_WIPE_KEY)),snapshot);
  sql.exec("INSERT INTO living_run_log VALUES ('b:new','bucket',2,2,'{}')");
  const ctx2=new Ctx(storage);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w2=new MarketStream(ctx2 as never,env as never) as any;await ctx2.ready;w2.launchOptionalWork=()=>undefined;
  w2.forwardState=structuredClone(w.forwardState);w2.forwardError=null;w2.authorityReady=true;w2.living=engine;
  await w2.runLogWipeOnce(now+3*MIN);
  assert.equal(w2.runlogWipe.phase,"done");assert.equal(w2.runlogWipe.passes,1,"not run again after a restart");
  assert.equal(count(sql,"living_run_log"),1,"post-wipe rows are not deleted again");

  // recording resumes at once: the first bucket starts at the wipe, cases and minutes are recorded
  engine.runlog.sample(now+MIN,{gate:"COMPUTE_ONLY",market:null,fast:"CALM",open:0,watches:0,mode:"compute-only"});
  const b=engine.runlog.bucket!;assert.equal(b.at,now,"bucket starts at the wipe time");assert.equal(b.minutes,1);
  assert.ok(b.events.some(e=>e.k==="RUNLOG_WIPE"),"the wipe is the first event of the new timeline");
  assert.ok(engine.runlog.noteCase(caseInput(9,now+2*MIN),"WATCH","new"));
  assert.equal(engine.runlog.activeCount(),1);
  const out=buildLivingRunLog({exportedAt:now+3*MIN,liveEnabled:false,buildSha:"x",hours:72,since:now,status:null,
    buckets:[{...engine.runlog.bucketsDue(now+3*MIN)[0]!,at:now-30*MIN,end:now-20*MIN,id:"old"},...engine.runlog.bucketsDue(now+3*MIN)],
    cases:[...engine.runlog.activeView(now+3*MIN,engine.tape)],
    account:{equity:null,initial:null,invariants:null,book_audit:null,equity_curve:null,equity_minutes:[],drawdown:{},curve_since:null,drawdown_since:null,
      account_resets:[],account_epoch:0,account_reset_pending:null,liveFills:[],equity_gaps:[],equity_filled_min:0},positions:[],fills:[],paths:[],archive:{}});
  assert.equal(out.window_from,now);assert.equal(out.log_since,now);
  assert.deepEqual(out.timeline_gaps,[],"no gap reported for the time before the wipe");
  assert.ok(out.timeline.every(r=>r.at>=now),"no pre-wipe bucket");assert.equal(out.cases.length,1);
  w.lastEqMinAt=0;w.eqMinBuf=[];
  for(let i=1;i<=6;i++)await w.noteEquityMinute(now+i*MIN+1);
  const mins=(storage.values.get(`log:eqmin:${day}`) as {ts:number}[]|undefined)??[];
  assert.ok(mins.length>=5&&mins.every(r=>r.ts>=now),"equity minutes record again from the wipe");
});
