/**
 * htf-donch20 (C1b, rulebook rule 1): daily trend breakout long. Pure rule (signal / regime / stop / trail / sizing / slots),
 * engine wiring (once-a-day check, pending picks, own exits, switch 9, restart), forward core (adaptive leverage, sizing, no time
 * exit, trail persistence) and replay parity with the research per-coin logic on Binance public daily data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {HTF,atrOf,priorHigh,trailLow,smaClose,bullRegime,htfSignal,htfOrder,htfExitLevel,dailyCheck,closedDaily,freshThrough,volumeRanks,dayKey,type DailyBar} from "../lib/living/htf-trend.ts";
import {htfPaperLeverage,isolatedLiquidationPrice} from "../lib/paper-leverage.ts";
import {LivingEngine,LIVING_KEYS,type PlanContext,type ForwardView,type HtfInput} from "../lib/living/engine.ts";
import {defaultLivingConfig,LIVING_ITEMS,LIVING_ITEM_LABELS} from "../lib/living/config.ts";
import {LEADER} from "../lib/living/burst-leader.ts";
import {fastProtection,thesisExits,type PositionView} from "../lib/living/exits.ts";
import {LivingTape} from "../lib/living/tape.ts";
import {livingFields} from "../lib/living/run-log-fields.ts";
import {livingDetail,livingWhy} from "../lib/living-trade-view.ts";
import {advanceForward,type ForwardState} from "../lib/forward-relations.ts";
import type {LivingDirective,LivingNote,LivingOrder} from "../lib/living/directive.ts";
import {allItems} from "../lib/living/config.ts";
import {runForward,simInputs,GOLDEN_SYMBOLS} from "./living/forward-sim.ts";
import {bj} from "./living/fixture.ts";

const D=86_400;
function bars(closes:number[],spread=.02,t0=1_700_006_400):DailyBar[]{
  const base=Math.floor(t0/D)*D;
  return closes.map((c,i)=>({time:base+i*D,open:i?closes[i-1]!:c,high:c*(1+spread/2),low:c*(1-spread/2),close:c}));
}
/** now (ms) a few minutes after the close of the last bar */
const after=(rows:DailyBar[],min=5)=>(rows.at(-1)!.time+D)*1000+min*60_000;

// ---------------------------------------------------------------- pure rule
test("constants are C1b: BTC>SMA100, top 30, Donchian 20 / trail 10 / 2×ATR20, 0.75% risk, ≤1× equity, max 8; switch 9 default on",()=>{
  assert.deepEqual([HTF.pb,HTF.regimeN,HTF.topLiquid,HTF.entryN,HTF.exitN,HTF.atrN,HTF.stopAtr,HTF.riskRate,HTF.notionalCap,HTF.maxOpen],
    ["htf-donch20",100,30,20,10,20,2,.0075,1,8]);
  assert.equal(HTF.label,"日线突破做多");
  assert.equal(LIVING_ITEMS.length,10);assert.equal(LIVING_ITEMS[8],"htfTrend");assert.match(LIVING_ITEM_LABELS.htfTrend,/^9 日线突破做多/);
  assert.equal(defaultLivingConfig(0).items.htfTrend,true);
  assert.equal(LEADER.maxOpen,3,"burst max 3 unchanged");
});
test("ATR, prior high, trail low and SMA use only closed bars; unclosed / bad rows are dropped",()=>{
  const r=bars([100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121]);
  assert.ok(Math.abs(atrOf(r,20)!-r.slice(-20).reduce((s,x,i)=>s+Math.max(x.high-x.low,Math.abs(x.high-r[r.length-21+i]!.close),Math.abs(x.low-r[r.length-21+i]!.close)),0)/20)<1e-9);
  assert.equal(priorHigh(r,20),Math.max(...r.slice(-21,-1).map(x=>x.high)));
  assert.equal(trailLow(r,10),Math.min(...r.slice(-10).map(x=>x.low)));
  assert.equal(smaClose(r,5),(117+118+119+120+121)/5);
  assert.equal(atrOf(r.slice(0,10),20),null);
  const now=after(r);const forming={...r.at(-1)!,time:r.at(-1)!.time+D};
  assert.equal(closedDaily([...r,forming,{...r[0]!,close:NaN}],now).length,r.length,"today's forming bar and NaN rows are not used");
  assert.equal(freshThrough(closedDaily(r,now),now),true);assert.equal(freshThrough(closedDaily(r,now+D*1000),now+D*1000),false);
});
test("BTC regime: last closed close vs 100-day SMA; fewer than 100 rows → unknown",()=>{
  assert.equal(bullRegime(bars(Array(80).fill(100))).on,null);
  const up=bullRegime(bars([...Array(99).fill(100),120]));assert.equal(up.on,true);assert.ok(Math.abs(up.sma!-100.2)<1e-9);assert.match(up.why,/100 日均线/);
  assert.equal(bullRegime(bars([...Array(99).fill(100),90])).on,false);
});
test("signal: yesterday's close above the prior 20-day high, top-30 by 24h volume, ≥90 rows, fresh",()=>{
  const ok=bars([...Array(100).fill(100),110]),now=after(ok);
  const s=htfSignal("A_USDT",ok,3,now,5e8);assert.equal(s.ok,true);assert.equal(s.code,"BREAK");assert.equal(s.breakout,101);
  assert.equal(htfSignal("A_USDT",ok,31,now).code,"RANK");
  assert.equal(htfSignal("A_USDT",bars([...Array(100).fill(100),100.5]),3,after(bars([...Array(100).fill(100),100.5]))).code,"NO_BREAK");
  const short=bars([...Array(50).fill(100),110]);assert.equal(htfSignal("A_USDT",short,3,after(short)).code,"SHORT");
  assert.equal(htfSignal("A_USDT",ok,3,now+D*1000).code,"STALE");
  assert.equal(htfSignal("A_USDT",[],3,now).code,"NO_DATA");
  assert.deepEqual([...volumeRanks({A:5,B:9,C:null,D:7})],[["B",1],["D",2],["A",3]]);
});
test("order: stop = entry − 2×ATR20; notional = equity × 0.75% / stop distance, capped at 1× equity",()=>{
  const o=htfOrder(100,5,1000)!;assert.equal(o.stop,90);assert.ok(Math.abs(o.notional-75)<1e-9);assert.ok(Math.abs(o.riskUsd-7.5)<1e-9);
  assert.equal(htfOrder(100,.2,1000)!.notional,1000,"0.4% stop → 187.5% → capped at 1×");
  assert.equal(htfOrder(100,60,1000),null,"stop below zero");
});
test("adaptive paper leverage: highest whole ≤10× keeping the stop within 40% of the liquidation distance; 1× above ~20%; none ≥40%",()=>{
  const liqDist=(lev:number)=>1-isolatedLiquidationPrice({entry:1,leverage:lev,side:"LONG",maintenanceRate:.005})!;
  for(const [stop,lev] of [[.03,10],[.05,7],[.115,3],[.18,2],[.25,1],[.39,1]] as const)assert.equal(htfPaperLeverage(stop,20,.005),lev,`stop ${stop}`);
  assert.equal(htfPaperLeverage(.40,20,.005),null);assert.equal(htfPaperLeverage(.05,5,.005),5,"contract max caps it");
  for(const stop of [.01,.05,.1,.15,.2,.3]){const l=htfPaperLeverage(stop,20,.005)!;if(l>1)assert.ok(stop<=.4*liqDist(l));if(l<10&&l>0)assert.ok(stop>.4*liqDist(l+1));}
});
test("exit level: initial stop until the entry day closes, then max(stop, 10-day low), never lower than before",()=>{
  const r=bars([...Array(15).fill(100),110,115,120]),entryT=r[15]!.time+300;
  assert.equal(htfExitLevel(80,r.slice(0,15),entryT),80,"no closed day on/after entry");
  const l=htfExitLevel(80,r.slice(0,16),entryT);assert.equal(l,Math.min(...r.slice(6,16).map(x=>x.low)),"entry day closed → 10-day low (days before entry count, as in the research)");
  assert.equal(htfExitLevel(80,r,entryT,l+5),l+5,"never lower");
  assert.equal(htfExitLevel(150,r,entryT),150,"initial stop above the low stays");
});
test("daily check: regime off → nothing picked (breakouts listed); slots / one per coin / volume order",()=>{
  const brk=bars([...Array(100).fill(100),110]),flat=bars(Array(101).fill(100)),now=after(brk);
  const coins=["A","B","C","D","E"].map((s,i)=>({sym:`${s}_USDT`,rows:i<4?brk:flat,vol:[3e8,9e8,5e8,1e8,7e8][i]!}));
  const off=dailyCheck({nowMs:now,btc:bars([...Array(99).fill(100),90]),coins,held:new Set(),open:0});
  assert.equal(off.regime.on,false);assert.equal(off.picks.length,0);assert.equal(off.skipped.length,4);assert.match(off.skipped[0]!.why,/100 日均线下/);
  const btc=bars([...Array(99).fill(100),120]);
  const on=dailyCheck({nowMs:now,btc,coins,held:new Set(["C_USDT"]),open:0});
  assert.deepEqual(on.picks.map(p=>p.sym),["B_USDT","A_USDT","D_USDT"],"by 24h volume, held C skipped");
  assert.match(on.skipped.find(x=>x.sym==="C_USDT")!.why,/已有持仓/);
  const full=dailyCheck({nowMs:now,btc,coins,held:new Set(),open:HTF.maxOpen-1});
  assert.deepEqual(full.picks.map(p=>p.sym),["B_USDT"]);assert.equal(full.skipped.filter(x=>/最多 8/.test(x.why)).length,3);
  assert.equal(dailyCheck({nowMs:now,btc,coins,held:new Set(),open:HTF.maxOpen}).picks.length,0);
  assert.equal(on.day,dayKey(now));
});

// ---------------------------------------------------------------- engine wiring
const SYMS=["BTC_USDT","AAA_USDT","BBB_USDT","CCC_USDT"];
function htfWorld(dayOffset=0,breakers=["AAA_USDT","BBB_USDT"]){
  const n=110+dayOffset,daily:Record<string,DailyBar[]>={};
  daily.BTC_USDT=bars([...Array(n-1).fill(100),120]);
  for(const s of SYMS.slice(1))daily[s]=bars(breakers.includes(s)?[...Array(n-1).fill(10),11]:Array(n).fill(10));
  const htf:HtfInput={daily,volume:{BTC_USDT:9e9,AAA_USDT:5e8,BBB_USDT:8e8,CCC_USDT:1e8},universe:SYMS.slice(1),notExternal:["ZZZ_USDT"]};
  return {htf,dayStartMs:(daily.BTC_USDT.at(-1)!.time+D)*1000};
}
const quotesAt=(now:number,px:Record<string,number>)=>Object.fromEntries(Object.entries(px).map(([s,p])=>[s,{bestBid:p*.9999,bestAsk:p*1.0001,observedAt:now-500,entryReady:true}]));
const emptyForward=():ForwardView=>({positions:[],history:[],opportunities:[]});
function engine(items:Partial<Record<string,boolean>>={},mode:"paper-enabled"|"compute-only"="paper-enabled",at=0){
  const e=new LivingEngine(at),cfg=defaultLivingConfig(at);
  e.restore(new Map([[LIVING_KEYS.config,{...cfg,mode,items:{...cfg.items,dynAllocator:false,...items}}]]),at);return e;
}
const ctxOf=(now:number,htf:HtfInput,forward:ForwardView=emptyForward(),px:Record<string,number>={AAA_USDT:11,BBB_USDT:11,CCC_USDT:10,BTC_USDT:120}):PlanContext=>
  ({now,forward,quotes:quotesAt(now,px),contracts:{},funding:{},candles:{},htf});

test("engine: no check before 00:02 UTC; waits (HTF_WAIT once) while BTC's candle is missing; then one HTF_CHECK per day",()=>{
  const {htf,dayStartMs}=htfWorld(),e=engine({},"paper-enabled",dayStartMs);
  assert.deepEqual(e.plan(ctxOf(dayStartMs+60_000,htf))!.orders,[]);assert.equal(e.log.filter(r=>r.k==="HTF_CHECK").length,0);
  const late={...htf,daily:{...htf.daily,BTC_USDT:htf.daily.BTC_USDT!.slice(0,-1)}};
  for(let m=3;m<8;m++)e.plan(ctxOf(dayStartMs+m*60_000,late));
  assert.equal(e.log.filter(r=>r.k==="HTF_WAIT").length,1);assert.equal(e.log.filter(r=>r.k==="HTF_CHECK").length,0);
  const d=e.plan(ctxOf(dayStartMs+9*60_000,htf))!;
  const rows=e.log.filter(r=>r.k==="HTF_CHECK");assert.equal(rows.length,1);
  const c=rows[0]!;assert.equal(c.regime,"ON");assert.equal(c.btc,120);assert.ok(Math.abs(Number(c.sma100)-100.2)<1e-9);
  assert.equal(c.picks,"BBB_USDT,AAA_USDT");assert.match(String(c.breakouts),/BBB #1 距突破\+8\.9%/);assert.match(String(c.skipped),/ZZZ:外部交易所没有日线/);
  assert.deepEqual(d.orders.map(o=>o.id),[`lh-${dayKey(dayStartMs)}-BBB_USDT`,`lh-${dayKey(dayStartMs)}-AAA_USDT`]);
  for(const o of d.orders){assert.equal(o.note.hx,1);assert.equal(o.note.pb,"htf-donch20");assert.equal(o.riskRate,.0075);assert.equal(o.multiple,1);assert.equal(o.side,"LONG");
    const atr=o.note.atr!;assert.ok(Math.abs(o.stop-(11*1.0001-2*atr))<1e-6,"stop = live ask − 2×ATR20");assert.ok(Math.abs(o.note.ref!-10.1)<1e-9);}
  for(let m=10;m<20;m++)e.plan(ctxOf(dayStartMs+m*60_000,htf));
  assert.equal(e.log.filter(r=>r.k==="HTF_CHECK").length,1,"once per UTC day");
  // timeline + brain view + decisions
  const b=e.runlog.bucket!;assert.match(b.htf??"",/regime ON/);assert.match(b.htf??"",/WAIT/);assert.ok(b.events.some(x=>x.k==="HTF_CHECK"));
  assert.ok(e.decisions.some(x=>x.k==="HTF_CHECK"));
  const st=e.status(dayStartMs+20*60_000,emptyForward());assert.equal(st.htf.last!.regime,"ON");assert.equal(st.htf.pending.length,2);
  assert.ok(st.items.some(i=>i.key==="htfTrend"&&i.on));
});
test("engine: regime off → no orders, every breakout skipped with the reason",()=>{
  const {htf,dayStartMs}=htfWorld();htf.daily.BTC_USDT=bars([...Array(109).fill(100),90]);
  const e=engine({},"paper-enabled",dayStartMs);const d=e.plan(ctxOf(dayStartMs+5*60_000,htf))!;
  assert.equal(d.orders.length,0);const c=e.log.find(r=>r.k==="HTF_CHECK")!;assert.equal(c.regime,"OFF");assert.match(String(c.skipped),/100 日均线下/);
});
test("engine: htf orders pass the burst-leader record-only filter; switch 9 off → recorded only; compute-only → kept pending, no directive",()=>{
  const {htf,dayStartMs}=htfWorld(),now=dayStartMs+5*60_000;
  const on=engine({burstLeader:true},"paper-enabled",now);assert.equal(on.plan(ctxOf(now,htf))!.orders.length,2,"burstLeader on does not drop htf");
  assert.ok(!on.log.some(r=>r.k==="RECORD_ONLY"&&r.pb==="htf-donch20"&&/突然爆发/.test(String(r.reason))));
  const off=engine({htfTrend:false},"paper-enabled",now);const d=off.plan(ctxOf(now,htf))!;assert.equal(d.orders.length,0);
  assert.equal(off.log.filter(r=>r.k==="RECORD_ONLY"&&/开关 9 关着/.test(String(r.reason))).length,2);
  off.plan(ctxOf(now+60_000,htf));assert.equal(off.log.filter(r=>r.k==="RECORD_ONLY"&&/开关 9 关着/.test(String(r.reason))).length,2,"no per-tick repeat");
  assert.equal(off.log.filter(r=>r.k==="HTF_CHECK").length,1,"the check still runs and is logged");
  const co=engine({},"compute-only",now);assert.equal(co.plan(ctxOf(now,htf)),undefined);assert.equal(co.trades.hx!.pending.length,2);
});
test("engine: pending picks expire after the entry window (logged); opened / rejected orders leave the pending list",()=>{
  const {htf,dayStartMs}=htfWorld(),now=dayStartMs+5*60_000,e=engine({},"paper-enabled",now);
  const d=e.plan(ctxOf(now,htf))!;const [a,b]=d.orders as [LivingOrder,LivingOrder];
  const pos={id:"lv-1",symbol:a.symbol,side:"LONG" as const,entryPrice:11,stopPrice:a.stop,openedAt:now,favorable:0,entryContext:{living:a.note}};
  e.afterForward({opened:[{orderId:a.id,tradeId:"lv-1",symbol:a.symbol,side:"LONG",risk:7.5,notional:75}],rejected:[{orderId:b.id,symbol:b.symbol,reason:"剩余风险预算不足以形成有效仓位"}],applied:[]},
    {...emptyForward(),positions:[pos]},now);
  assert.equal(e.trades.hx!.pending.length,0);assert.ok(e.log.some(r=>r.k==="HTF_OPEN"&&r.sym===a.symbol));assert.ok(e.log.some(r=>r.k==="HTF_REJECT"&&r.sym===b.symbol));
  const e2=engine({},"paper-enabled",now);e2.plan({...ctxOf(now,htf),quotes:{}});
  e2.afterForward({opened:[],rejected:[{orderId:`lh-${dayKey(now)}-AAA_USDT`,symbol:"AAA_USDT",reason:"没有可成交的 Gate 实时盘口（不新增请求）"}],applied:[]},emptyForward(),now);
  assert.equal(e2.trades.hx!.pending.length,2,"a missing Gate quote keeps the pick inside its window");
  e2.plan({...ctxOf(now+HTF.entryWindowMin*60_000+60_000,htf),quotes:{}});
  assert.equal(e2.trades.hx!.pending.length,0);assert.equal(e2.log.filter(r=>r.k==="HTF_EXPIRE").length,2);
});
test("engine: restart keeps the day's check and pending picks (no second check, same orders); held coins are skipped",()=>{
  const {htf,dayStartMs}=htfWorld(),now=dayStartMs+5*60_000,e=engine({},"paper-enabled",now);
  e.plan(ctxOf(now,htf));const w=e.writes(now+120_000,true);assert.ok(w[LIVING_KEYS.trades]);
  const back=new LivingEngine(now+180_000);back.restore(new Map(Object.entries(w)),now+180_000);
  assert.equal(back.trades.hx!.day,dayKey(now));
  const pos={id:"lv-9",symbol:"AAA_USDT",side:"LONG" as const,entryPrice:11,stopPrice:9,openedAt:now,favorable:0,entryContext:{living:{v:"living-v2",k:"N",pb:"x"} as LivingNote}};
  const d=back.plan(ctxOf(now+181_000,htf,{...emptyForward(),positions:[pos]}))!;
  assert.equal(back.log.filter(r=>r.k==="HTF_CHECK").length,0,"no second check after the restart");
  assert.deepEqual(d.orders.map(o=>o.symbol),["BBB_USDT"],"AAA is held: one per coin");
});
test("engine: a coin whose daily-breakout trade closed on the signal day is not re-entered that day (research: next signal after the exit bar)",()=>{
  const {htf,dayStartMs}=htfWorld(),now=dayStartMs+5*60_000,e=engine({},"paper-enabled",now);
  const h={id:"lv-old",symbol:"BBB_USDT",side:"LONG" as const,netPnl:-1,plannedRisk:1,notional:10,closedAt:dayStartMs-3*3_600_000,exitReason:"LIVING_GUARD_STOP",openedAt:dayStartMs-9*86_400_000,
    entryContext:{living:{v:"living-v2",k:"N",pb:HTF.pb,hx:1} as LivingNote}};
  const d=e.plan(ctxOf(now,htf,{...emptyForward(),history:[h]}))!;
  assert.deepEqual(d.orders.map(o=>o.symbol),["AAA_USDT"]);assert.match(String(e.log.find(r=>r.k==="HTF_CHECK")!.skipped),/BBB:.*信号那天平掉/);
});
test("engine: at most 8 open daily-breakout trades (burst trades not counted)",()=>{
  const {htf,dayStartMs}=htfWorld(),now=dayStartMs+5*60_000;
  const mk=(i:number,hx:boolean)=>({id:`p${i}`,symbol:`X${i}_USDT`,side:"LONG" as const,entryPrice:1,stopPrice:.9,openedAt:now-D*1000,favorable:0,
    entryContext:{living:{v:"living-v2",k:hx?"N":"F",pb:hx?HTF.pb:LEADER.pb,inv:.9,...(hx?{hx:1}:{bh:1})} as LivingNote}});
  const e=engine({},"paper-enabled",now);const d=e.plan(ctxOf(now,htf,{...emptyForward(),positions:[...Array.from({length:7},(_,i)=>mk(i,true)),mk(7,false),mk(8,false),mk(9,false)]}))!;
  assert.equal(d.orders.length,1,"7 htf open → one slot left (3 burst trades do not use htf slots)");
  const e2=engine({},"paper-enabled",now);assert.equal(e2.plan(ctxOf(now,htf,{...emptyForward(),positions:Array.from({length:8},(_,i)=>mk(i,true))}))!.orders.length,0);
});
test("engine: daily trail → GUARD LIVING_HTF_TRAIL once per level (passes with switch 9 off), EXIT when the price is already below",()=>{
  const {htf,dayStartMs}=htfWorld(),now=dayStartMs+5*60_000;
  const rows=bars([...Array(100).fill(10),11,12,13,14,15,16,17,18,19,20]);htf.daily.AAA_USDT=rows;
  const entryAt=(rows.at(-5)!.time)*1000+300_000;
  const note={v:"living-v2",k:"N",pb:HTF.pb,th:null,ep:null,ev:"normal",mult:1,sc:null,t:null,n:null,per:null,rk:1,inv:10,ref:12,hold:HTF.holdMin,why:"t",hx:1} as LivingNote;
  const pos=(guard:number|null)=>({id:"lv-h",symbol:"AAA_USDT",side:"LONG" as const,entryPrice:16,stopPrice:guard??10,openedAt:entryAt,favorable:0,
    livingGuard:guard==null?undefined:{stop:guard},entryContext:{living:note}});
  const want=Math.min(...rows.slice(-10).map(r=>r.low));
  const e=engine({htfTrend:false},"paper-enabled",now);
  const d=e.plan(ctxOf(now,htf,{...emptyForward(),positions:[pos(null)]},{AAA_USDT:20,BBB_USDT:11}))!;
  const a=d.actions.find(x=>x.code==="LIVING_HTF_TRAIL");assert.ok(a,"trail action passes with switch 9 off");assert.equal(a!.action,"GUARD");assert.ok(Math.abs(a!.stop!-want)<1e-9);
  e.plan(ctxOf(now+60_000,htf,{...emptyForward(),positions:[pos(null)]},{AAA_USDT:20}));
  assert.equal(e.log.filter(r=>r.k==="HTF_TRAIL").length,1,"one row per level");
  const d2=e.plan(ctxOf(now+120_000,htf,{...emptyForward(),positions:[pos(want)]},{AAA_USDT:20}))!;assert.equal(d2.actions.filter(x=>x.code.startsWith("LIVING_HTF")).length,0,"applied level is not re-sent");
  const d3=engine().plan(ctxOf(now,htf,{...emptyForward(),positions:[pos(null)]},{AAA_USDT:want*.99}))!;
  assert.equal(d3.actions.find(x=>x.code==="LIVING_HTF_TRAIL_EXIT")?.action,"EXIT");
  // no other layer exit for an htf trade
  assert.equal(d.actions.filter(x=>!x.code.startsWith("LIVING_HTF")).length,0);
});
test("exit ownership: thesis / fast-lane exits skip htf trades; only the liquidation guard remains",()=>{
  const tape=new LivingTape();
  for(let t=0;t<=70_000;t+=2_000)tape.feed([{symbol:"C0_USDT",mid:100-t/70_000*1.5,at:t},{symbol:"C1_USDT",mid:50-t/70_000*.75,at:t}],t);
  const hx={v:"living-v2",k:"N",pb:HTF.pb,inv:90,hold:HTF.holdMin,hx:1} as LivingNote;
  const pv=(o:Partial<PositionView>={}):PositionView=>({id:"t1",symbol:"C0_USDT",side:"LONG",entryPrice:100,stopPrice:90,liquidationPrice:70,openedAt:0,favorable:0,guard:null,living:hx,price:98.6,...o});
  const ep={id:"fe-2",side:"SHORT",phase:"CONFIRMED",anchor:{C0_USDT:100,C1_USDT:50}} as never;
  assert.deepEqual(fastProtection({positions:[pv()],ep,events:[{type:"ALERT",episodeId:"fe-2"},{type:"CONFIRM",episodeId:"fe-2"}] as never,tape,now:70_000,scale:1,peaks:new Map()}),[]);
  assert.equal(fastProtection({positions:[pv({liquidationPrice:98})],ep,events:[{type:"ALERT",episodeId:"fe-2"}] as never,tape,now:70_000,scale:1,peaks:new Map()})[0]?.code,"LIVING_FAST_LIQ_GUARD");
  assert.deepEqual(thesisExits({positions:[pv({openedAt:-10*86_400_000})],thesis:null,scores:{} as never,tape,now:70_000,episode:null,handedOff:new Set(),lastEnd:null}),[]);
});
test("run-log fields and trade card for an htf trade",()=>{
  const n={v:"living-v2",k:"N",pb:HTF.pb,th:null,ep:null,ev:"normal",mult:1,sc:null,t:null,n:null,per:null,rk:2,inv:9,ref:10.05,hold:HTF.holdMin,why:"日线收盘 11 突破",
    hx:1,atr:.5,cl:11,dy:"2026-10-21",evd:"收盘 11"} as LivingNote;
  const f=livingFields(n,{stop:9.5,code:"LIVING_HTF_TRAIL",reason:"上移",at:1});
  assert.equal(f.living_playbook,"htf-donch20");assert.equal(f.living_htf_day,"2026-10-21");assert.equal(f.living_htf_initial_stop,9);assert.equal(f.living_protect_code,"LIVING_HTF_TRAIL");
  assert.equal(livingFields({...n,hx:undefined},null).living_htf_day,undefined,"other living rows unchanged");
  const t={side:"LONG" as const,entryPrice:11,stopPrice:9.5,liquidationPrice:null,plannedRisk:7.6,leverage:3,notional:41,entryContext:{living:n}};
  assert.match(livingWhy(t,"日线突破做多"),/突破前 20 日最高 10\.05/);
  const lines=livingDetail(t,"日线突破做多").join("\n");
  assert.match(lines,/0\.75%/);assert.match(lines,/10 天最低/);assert.match(lines,/3× 逐仓/);assert.match(lines,/没有时间限制/);assert.doesNotMatch(lines,/ROE/);
});

// ---------------------------------------------------------------- forward core
let base:ForwardState|null=null;
function forwardStart(){
  if(!base)runForward({from:bj("10-19 05:20"),to:bj("10-19 05:50"),stepMs:6000,onTick:(state)=>{base=structuredClone(state);}});
  const s=structuredClone(base!) as ForwardState,cache={};
  const step=(state:ForwardState,now:number,living?:LivingDirective)=>{const inp=simInputs(state,now,GOLDEN_SYMBOLS,cache);
    return advanceForward({state,now,paths:inp.paths,minutePaths:inp.minutePaths,quotes:inp.quotes,analysisQuotes:inp.quotes,contracts:inp.contracts,
      entrySymbols:GOLDEN_SYMBOLS,allowDataCycle:inp.allowDataCycle,btc1hPct:inp.btc1hPct,referenceMids:{BTC_USDT:inp.mids.BTC_USDT??null,ETH_USDT:inp.mids.ETH_USDT??null},...(living?{living}:{})});};
  return {s,step,at:(s.lastCycleAt??Date.now())};
}
const dir=(orders:LivingOrder[]=[],actions:LivingDirective["actions"]=[]):LivingDirective=>({version:"living-v2",items:{...allItems(true)},actions,orders,legacyGate:"note"});
function htfOrderFor(sym:string,ask:number,stopRate:number,hold=HTF.holdMin):LivingOrder{
  const stop=ask*(1-stopRate);
  return {id:`lh-test-${sym}`,symbol:sym,side:"LONG",stop,riskRate:HTF.riskRate,multiple:1,kind:"N",episodeId:null,episodeCap:null,winner:false,reason:"htf test",
    note:{v:"living-v2",k:"N",pb:HTF.pb,th:null,ep:null,ev:"normal",mult:1,sc:null,t:null,n:null,per:null,rk:1,inv:stop,ref:ask*.98,hold,why:"htf test",hx:1,atr:ask*stopRate/2,cl:ask,dy:"2026-10-19"}};
}
test("forward: htf order opens with adaptive leverage (stop inside 40% of liquidation), 0.75% risk sizing, ≤1× equity; no time exit; trail persists",()=>{
  const {s,step,at}=forwardStart();const now=at+6000;
  const inp=simInputs(s,now,GOLDEN_SYMBOLS,{});const sym=GOLDEN_SYMBOLS.find(x=>!s.positions.some(p=>p.symbol===x)&&inp.quotes[x]?.bestAsk&&(inp.contracts[x]?.maintenanceRate??1)<=.02)!;
  const ask=inp.quotes[sym]!.bestAsk;
  const n=step(s,now,dir([htfOrderFor(sym,ask,.115,4)]));
  const t=n.state.positions.find(p=>p.entryContext?.living?.hx===1);assert.ok(t,`htf trade opened (${JSON.stringify(n.living?.rejected)})`);
  assert.equal(t!.leverage,htfPaperLeverage(Math.abs(t!.entryPrice-t!.stopPrice)/t!.entryPrice,inp.contracts[sym]!.leverageMax,inp.contracts[sym]!.maintenanceRate));
  assert.ok(t!.leverage<=3);
  const liqDist=t!.liquidationPrice?1-t!.liquidationPrice/t!.entryPrice:Infinity,stopRate=1-t!.stopPrice/t!.entryPrice;
  assert.ok(stopRate<=.4*liqDist,"stop within 40% of the liquidation distance");
  const eq=t!.forecast!.sizingEquity;assert.ok(t!.notional<=eq*HTF.riskRate/stopRate*1.0001&&t!.notional>=eq*HTF.riskRate/stopRate*.97,`notional ${t!.notional} eq ${eq}`);
  assert.ok(t!.notional<=eq);
  // a too-wide stop is rejected; a tiny stop is capped at 1× equity
  const wide=step(structuredClone(s),now,dir([htfOrderFor(sym,ask,.38)]));assert.match(wide.living!.rejected[0]!.reason,/35%/);
  // no fallback timeout (planned hold 4 minutes, layer not driving for 20 minutes)
  let st=n.state;for(let k=1;k<=200;k++){const r=step(st,now+k*6000);st=r.state;}
  assert.ok(st.positions.some(p=>p.id===t!.id),"still open: only stop / trail / liquidation close it");
  // trail GUARD → persisted on the position (survives a JSON round trip = restart / redeploy)
  const cur=st.positions.find(p=>p.id===t!.id)!,lvl=cur.stopPrice*1.02;
  const g=step(st,now+201*6000,dir([],[{tradeId:t!.id,action:"GUARD",stop:lvl,code:"LIVING_HTF_TRAIL",reason:"上移"}]));
  const back=JSON.parse(JSON.stringify(g.state)) as ForwardState,p=back.positions.find(x=>x.id===t!.id)!;
  assert.equal(p.stopPrice,lvl);assert.equal(p.livingGuard?.code,"LIVING_HTF_TRAIL");assert.equal(p.entryContext?.living?.hx,1);assert.equal(p.entryContext?.living?.inv,t!.entryContext!.living!.inv);
  // stop touch closes it
  p.stopPrice=p.lastPrice*1.05;const c=step(back,now+202*6000);
  assert.ok(["LIVING_STOP","LIVING_GUARD_STOP"].includes(c.state.history.find(h=>h.id===t!.id)?.exitReason??""));
});

// ---------------------------------------------------------------- replay parity with the research
test("replay parity: the live rule functions reproduce the research per-coin C1b trades on Binance daily data",()=>{
  const fx=JSON.parse(readFileSync(new URL("./fixtures/htf-c1b-parity.json",import.meta.url),"utf8")) as {warm:number;coins:string[];
    rows:Record<string,[number,number,number,number,number][]>;trades:{coin:string;signal:string;entry:string;exit:string|null;pe:number;st:number;px:number|null;why:string}[]};
  const rows:Record<string,DailyBar[]>=Object.fromEntries(Object.entries(fx.rows).map(([s,r])=>[s,r.map(([time,open,high,low,close])=>({time,open,high,low,close}))]));
  const days=rows.BTC!.map(r=>r.time),iso=(t:number)=>new Date(t*1000).toISOString().slice(0,10);
  type Open={coin:string;signal:number;e:number;pe:number;st:number;lvl:number};
  const open=new Map<string,Open>(),got:{coin:string;signal:string;entry:string;exit:string|null;pe:number;st:number;px:number|null}[]=[];
  const upto=(s:string,t:number)=>{const r=rows[s]!;let i=r.length;while(i>0&&r[i-1]!.time>t)i--;return r.slice(Math.max(0,i-120),i);};
  for(let i=fx.warm;i<days.length;i++){
    const day=days[i]!,nowMs=(day+D)*1000+5*60_000;
    // during day i: exits at the level known at the start of the day
    const exitedToday=new Set<string>();
    for(const [s,o] of [...open]){
      const bar=rows[s]!.find(r=>r.time===day);if(!bar)continue;
      if(bar.low<=o.lvl){got.push({coin:s,signal:iso(o.signal),entry:iso(o.e),exit:iso(day),pe:o.pe,st:o.st,px:Math.min(bar.open,o.lvl)});open.delete(s);exitedToday.add(s);}
    }
    // after day i closes: trail update for open trades, then the daily check (signal bar = day i)
    for(const [s,o] of open)o.lvl=htfExitLevel(o.st,closedDaily(upto(s,day),nowMs),o.e,o.lvl);
    const coins=fx.coins.map(s=>({sym:s,rows:closedDaily(upto(s,day),nowMs),vol:1e9}));
    const c=dailyCheck({nowMs,btc:closedDaily(upto("BTC",day),nowMs),coins,held:new Set([...open.keys(),...exitedToday]),open:0});
    const next=days[i+1];if(next==null)continue;
    for(const p of c.picks){const nb=rows[p.sym]!.find(r=>r.time===next);if(!nb)continue;
      const z=htfOrder(nb.open,p.atr!,1)!;open.set(p.sym,{coin:p.sym,signal:day,e:next,pe:nb.open,st:z.stop,lvl:z.stop});}
  }
  for(const o of open.values())got.push({coin:o.coin,signal:iso(o.signal),entry:iso(o.e),exit:null,pe:o.pe,st:o.st,px:null});
  const key=(x:{coin:string;signal:string})=>`${x.coin}|${x.signal}`,want=new Map(fx.trades.map(t=>[key(t),t]));
  assert.equal(got.length,fx.trades.length,`trade count ${got.length} vs research ${fx.trades.length}`);
  for(const g of got){const w=want.get(key(g));assert.ok(w,`extra trade ${key(g)}`);
    assert.equal(g.entry,w!.entry);assert.equal(g.exit,w!.exit,`${key(g)} exit`);assert.ok(Math.abs(g.pe/w!.pe-1)<1e-12);assert.ok(Math.abs(g.st/w!.st-1)<1e-9,`${key(g)} stop`);
    if(w!.px!=null)assert.ok(Math.abs(g.px!/w!.px-1)<1e-9,`${key(g)} exit px`);}
  assert.ok(fx.trades.length>=100,"enough trades to mean something");
});
