/** Run log v3: timeline buckets + funnel, research cases with 6h minute paths, D1 store, export shape. */
import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {LivingEngine,LIVING_KEYS} from "../lib/living/engine.ts";
import {defaultLivingConfig,LIVING_MAX_VALUE_BYTES} from "../lib/living/config.ts";
import {RunLog,buildPath,outcome,decodePath,mergeBuckets,blockerOf,CASE_ACTIVE_CAP,CASES_KEY,type CaseInput} from "../lib/living/runlog.ts";
import {writeLivingLog,readLivingLog,emptyLivingLogStatus} from "../lib/living/runlog-d1.ts";
import {buildLivingRunLog,slimPosition} from "../lib/living/runlog-export.ts";
import {LivingTape} from "../lib/living/tape.ts";
import {bytesOf} from "../lib/living/util.ts";
import type {D1Like,D1Stmt} from "../lib/run-log-archive.ts";

const NOW=1_790_000_000_000,MIN=60_000,H=60*MIN;
const t0=Math.floor(NOW/MIN)*MIN,syms=Array.from({length:60},(_,i)=>`W${i}_USDT`);
const px=(i:number,at:number)=>{const m=(at-t0)/MIN;return (100+i)*(i<20?1+.0006*Math.min(m,240)-(m>240?.0004*(m-240):0):1+Math.sin(at/7e5+i)*.004);};
const forward={positions:[],history:[],opportunities:[]};
function run(hours:number,mode:"compute-only"|"paper-enabled"|"off"="compute-only"){
  const e=new LivingEngine(t0);e.restore(new Map([[LIVING_KEYS.config,{...defaultLivingConfig(t0),mode}]]),t0);
  const store=new Map<string,unknown>();let caseWrites=0;
  for(let at=t0;at<t0+hours*H;at+=10_000){
    if(mode!=="off"){
      const pts=syms.map((s,i)=>({symbol:s,mid:px(i,at),at,volume24hUsd:5e8-i*1e6,sources:3,spread:.0002}));
      e.onHub([...pts,{symbol:"BTC_USDT",mid:60000,at,volume24hUsd:5e9,sources:3},{symbol:"ETH_USDT",mid:3000,at,volume24hUsd:3e9,sources:3}],at,()=>true,
        syms.map((s,i)=>({symbol:s,at,oi:1e6*(i<20?1+.0004*((at-t0)/MIN):1)+i,funding:.0001,basis:.0002,taker:i<20?.3:0,turnover:null})));
    }
    e.tickLog(at,forward as never);
    if(at%MIN===0&&mode!=="off")e.plan({now:at,forward:forward as never,quotes:{},contracts:{},funding:{},candles:{}});
    if(mode!=="off"){const w=e.writes(at),keys=Object.keys(w);for(const k of keys){store.set(k,w[k]);if(k===CASES_KEY)caseWrites++;}if(keys.length)e.committed(keys,at);}
  }
  return {e,store,caseWrites};
}

test("timeline: one sample a minute into 10-minute buckets; funnel and blocker say what stopped entries",()=>{
  const {e,store,caseWrites}=run(7);
  const rl=e.runlog;
  assert.ok(rl.closed.length>=40,`buckets ${rl.closed.length}`);
  for(const b of rl.closed.slice(1)){assert.equal(b.minutes,10);assert.equal(Object.values(b.gate).reduce((n,x)=>n+x,0),10);
    assert.equal(Object.values(b.market).reduce((n,x)=>n+x,0),10);}
  const withIdeas=rl.closed.find(b=>(b.funnel.ideas??0)>0)!;
  assert.ok(withIdeas,"some bucket had ideas");
  assert.ok((withIdeas.funnel.L1_MARKET??0)+(withIdeas.funnel.ENV_MISMATCH??0)>0,"the market / env layer blocked them");
  assert.match(withIdeas.blocker!,/只计算.*(第一层：市场意图不允许|环境：这个打法和币自己的环境对不上)/);
  const quiet=rl.closed.at(-1)!;assert.match(quiet.blocker!,/没有一个有打法想法/);
  // cases key: one own key, ≤ 96KB, written at most every 10 minutes
  assert.ok(store.has(CASES_KEY));assert.ok(bytesOf(store.get(CASES_KEY))<=LIVING_MAX_VALUE_BYTES);
  assert.ok(caseWrites<=7*6+1,`case key writes ${caseWrites} in 7h (≤ 144/day)`);
});

test("research cases: deduped per symbol+side+playbook, 6h one-minute path and outcome in price %",()=>{
  const {e}=run(8);
  const rl=e.runlog,all=[...rl.cases.values()];
  assert.ok(all.length>=20);
  const w0=all.filter(c=>c.sym==="W0_USDT");
  assert.ok(w0.length>=1&&w0.every((c,i)=>i===0||c.at-w0[i-1]!.at>90*MIN),"one case per 90 minutes");
  const c=w0[0]!;assert.equal(c.pb,"follow");assert.equal(c.side,"LONG");assert.ok(c.layer==="L1_MARKET"||c.layer==="ENV_MISMATCH",c.layer);assert.ok(c.seen>1);assert.ok(typeof c.env==="string"&&c.env.includes("|M:"),"env kept on the case");
  assert.ok(c.ev&&c.ev.oi15!=null&&c.ev.p15!=null,"evidence numbers kept");
  const due=rl.casesDue(t0+8*H,e.tape);assert.ok(due.length>=1);
  const f=due.find(x=>x.id===c.id)!;assert.ok(f.final);
  assert.equal(f.path!.minutes,360);assert.equal(f.path!.missing,0);assert.equal(decodePath(f.path!).length,360);
  assert.ok(f.out!.mfe!>0&&f.out!.r60!>0,"the rising coin's long idea went up (price %)");
  assert.equal(f.out!.hit_1pct_first,"UP");
  rl.casesSaved(due.map(x=>x.id));assert.ok(!rl.cases.has(c.id),"saved cases leave the active key");
});

test("off mode is still recorded (no hole in the timeline)",()=>{
  const {e}=run(1,"off");
  const b=e.runlog.closed.at(-1)!;assert.equal(b.gate.PAUSED_OFF,10);assert.match(blockerOf(b)!,/研究层关着/);
});

const input=(sym:string,at:number,pb="follow"):CaseInput=>({at,sym,side:"SHORT",pb,pbLabel:"顺着真资金",kind:"normal",intent:"SUPPLY/CONVICTION",strength:.5,
  why:"真卖盘：价格 -1.10%，持仓量同步 +1.20%，空头没挤在一边，等反弹跟空，不追低".repeat(3),ev:null,market:null,px:100});
test("case caps: early-layer ideas are capped, watches/trades always get a case, the key stays ≤ 96KB",()=>{
  const rl=new RunLog(NOW);
  for(let i=0;i<300;i++)rl.noteCase(input(`E${i}_USDT`,NOW+i*1000),"L1_MARKET","第一层：市场不支持");
  assert.ok(rl.activeCount()<=CASE_ACTIVE_CAP);
  const w=rl.noteCase(input("WATCHED_USDT",NOW+400_000),"WATCH","等位置");assert.ok(w,"a watch always gets a case");
  rl.linkTrade("WATCHED_USDT","SHORT","follow",{id:"t1",openedAt:NOW+500_000,entry:100,stop:101});
  assert.equal(rl.cases.get(w!.id)!.furthest,"OPENED");
  const v=rl.value();assert.ok(bytesOf(v)<=LIVING_MAX_VALUE_BYTES,`${bytesOf(v)}`);
  const back=new RunLog(NOW+H);assert.ok(back.restore(JSON.parse(JSON.stringify(v)),NOW+H)>0);
  assert.equal([...back.cases.values()].find(x=>x.sym==="WATCHED_USDT")!.trade!.id,"t1","restart keeps the case and its trade");
});

test("path: 1m bars, 5m bars where 1m is gone (coarse), blanks while the program was down; short outcome",()=>{
  const T5=Math.floor(t0/300_000)*300_000,tape=new LivingTape(),s="P_USDT",start=T5/1000;
  const bar=(t:number,c:number)=>({time:t,open:c,high:c*1.001,low:c*.999,close:c});
  tape.m1.set(s,[...Array.from({length:30},(_,i)=>bar(start+i*60,100-i*.1)),...Array.from({length:30},(_,i)=>bar(start+(60+i)*60,95))]);
  tape.m5.set(s,Array.from({length:6},(_,i)=>bar(start+(30+i*5)*60,97)).slice(0,4));// 30..49 covered at 5m
  const p=buildPath(tape,s,T5,100,90);
  assert.equal(p.minutes,90);assert.deepEqual(p.coarse,[[30,49]]);assert.equal(p.missing,10);
  const o=outcome(p,"SHORT");assert.ok(o.mfe!>=5,"short gained ~5% as the price fell");assert.ok(o.r30!>0);assert.equal(o.r60,null,"no data at minute 60 (down) → null, not a guess");
});

test("export: same window from two boots merged, whole missing windows listed, legacy columns dropped",()=>{
  const T=Math.floor(t0/600_000)*600_000,a=new RunLog(NOW),b=new RunLog(NOW+5*MIN);
  for(let m=0;m<4;m++)a.sample(T+m*MIN,{gate:"OPEN",market:null,fast:"CALM",open:0,watches:0,mode:"paper-enabled"});
  for(let m=6;m<10;m++)b.sample(T+m*MIN,{gate:"OPEN",market:null,fast:"CALM",open:0,watches:0,mode:"paper-enabled"});
  b.sample(T+40*MIN,{gate:"WARMING",market:null,fast:"CALM",open:0,watches:0,mode:"paper-enabled"});
  const rows=[...a.bucketsDue(T+5*MIN),...b.bucketsDue(T+41*MIN)];
  const m=mergeBuckets(rows.filter(r=>r.at===T));assert.equal(m.minutes,8);
  const file=buildLivingRunLog({exportedAt:T+45*MIN,liveEnabled:false,buildSha:"x",hours:2,status:null,buckets:rows,cases:[],
    account:{equity:1000,initial:1000,invariants:{},book_audit:[],equity_curve:[],equity_minutes:[],drawdown:{},curve_since:null,drawdown_since:null,
      account_resets:[],account_epoch:0,account_reset_pending:null,liveFills:[],equity_gaps:[],equity_filled_min:0},
    positions:[{id:"p",symbol:"X",entry_gate:"TREND",s1_branch:"follow",market_stage:"SHOCK",living_playbook:"follow",net_pnl:1,mfe_pct:.5}],fills:[],paths:[],archive:{}});
  assert.equal(file.version,"living-run-log-v3");
  assert.equal(file.timeline.filter(r=>r.minutes===8).length,1,"one row per window");
  assert.ok(file.timeline_gaps.length>=1,"a window with no row at all is listed");
  assert.deepEqual(Object.keys(file.positions[0]!).sort(),["id","living_playbook","mfe_pct","net_pnl","symbol"]);
  assert.deepEqual(slimPosition({stageTimeline:1,id:"a"}),{id:"a"});
  assert.ok(!("not_opened" in file)&&!("stageTimeline" in file)&&!("researchNotes" in file));
  assert.ok(file.howToRead.join("").includes("不是 ROE"));
});

function sqliteD1(){
  const sql=new DatabaseSync(":memory:");
  const make=(text:string,values:unknown[]=[]):D1Stmt=>({bind:(...v:unknown[])=>make(text,v),
    run:async()=>sql.prepare(text).run(...(values as never[])),all:async<R>()=>({results:sql.prepare(text).all(...(values as never[])) as R[]}),
    first:async<R>()=>(sql.prepare(text).get(...(values as never[])) as R|undefined)??null});
  const db:D1Like={prepare:text=>make(text),batch:async list=>{sql.exec("BEGIN");try{const out=[];for(const s of list)out.push(await s.run());sql.exec("COMMIT");return out;}catch(e){sql.exec("ROLLBACK");throw e;}}};
  return db;
}
test("D1: buckets upserted (current one rewritten), finished cases archived with their path, read back for the export",async()=>{
  const {e}=run(8);const db=sqliteD1(),st=emptyLivingLogStatus();
  const now=t0+8*H,cases=e.runlog.casesDue(now,e.tape);
  const done=await writeLivingLog(db,st,now,e.runlog.bucketsDue(now),cases);
  e.runlog.bucketsSaved(done.buckets);e.runlog.casesSaved(done.cases);
  assert.ok(done.cases.length>=1);
  const again=await writeLivingLog(db,st,now+MIN,e.runlog.bucketsDue(now+MIN),[]);assert.equal(again.buckets.length,1,"only the current bucket again");
  const back=await readLivingLog(db,"case",0,now,100) as {path:{bps:string}}[];assert.equal(back.length,done.cases.length);assert.ok(back[0]!.path.bps.length>100);
  const bs=await readLivingLog(db,"bucket",0,now+MIN,1000);assert.ok(bs.length>=40);
});

test("D1 keeps the newest 1200 run-log rows and deletes the older ones",async()=>{
  const db=sqliteD1(),st=emptyLivingLogStatus(),now=t0+9*H;
  await writeLivingLog(db,st,now,[],[]);
  for(let i=0;i<1205;i++)await db.prepare(`INSERT INTO living_run_log (id,kind,at,archived_at,json) VALUES (?,?,?,?,?)`).bind(`b${i}`,"bucket",i,now,"{}").run();
  const n=async()=>Number((await db.prepare(`SELECT COUNT(*) AS n FROM living_run_log`).first<{n:number}>())?.n??0);
  assert.equal(await n(),1205);
  await writeLivingLog(db,st,now+1,[],[]);
  assert.equal(await n(),1205-800,"one pass deletes the oldest 800 once the book is over 1200");
});
