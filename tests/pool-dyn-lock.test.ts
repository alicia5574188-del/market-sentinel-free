/**
 * Pool profit lock (lib/dynamic/pool-lock.ts + LivingEngine.poolLockStep): pure rule (arming, curve, stall, cost floor, unknowns)
 * and the engine wiring (long / short, only dp trades, restart with the clock persisted or lost, never loosens a stop, same-tick exits win).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {POOL_LOCK,POOL_LOCK_CODE,lockLine,poolLock,tickClock,stallWindowMin,lockUnit,atr5Frac,type PeakClock} from "../lib/dynamic/pool-lock.ts";
import {LivingEngine,LIVING_KEYS,type PlanContext,type ForwardView} from "../lib/living/engine.ts";
import {defaultLivingConfig} from "../lib/living/config.ts";
import type {DynPlanInput} from "../lib/dynamic/runtime.ts";
import type {LivingNote} from "../lib/living/directive.ts";

const A=.004;// a coin whose volatility unit is 0.4%
const W=30;
test("small profit does not arm: below max(3a, 0.6%) nothing triggers, even after a long stall and a full giveback",()=>{
  for(const peak of [0,.002,.005,3*A-1e-4]){
    assert.equal(lockLine(peak,A,500,W),null,`peak ${peak}`);
    const v=poolLock({peak,cur:-.02,stallMin:500,a:A,windowMin:W});assert.equal(v?.act,"HOLD");assert.equal(v?.armed,false);
  }
  assert.equal(lockLine(.0059,.0015,500,W),null,"quiet coin: the 0.6% floor still applies");
  assert.ok(lockLine(.006,.0015,0,W));
});
test("curve: the kept share of the peak rises monotonically with the peak; the room never drops to a touch",()=>{
  let last=-1;
  for(let p=.012;p<=.2;p+=.004){const r=lockLine(p,A,0,W)!,share=r.line/p;assert.ok(share>=last-1e-12,`share ${share} at ${p}`);last=share;assert.ok(r.giveback>=POOL_LOCK.curveC*A*.999-1e-12||r.line===POOL_LOCK.costFloor||r.giveback>=POOL_LOCK.tightA*A,"room kept");}
  // quiet coin vs wild coin at the same peak: the wild coin gets more room
  assert.ok(lockLine(.03,.002,0,W)!.line>lockLine(.03,.008,0,W)!.line);
  // line is monotone in the peak
  let l=-1;for(let p=.012;p<=.2;p+=.002){const r=lockLine(p,A,0,W)!;assert.ok(r.line>=l);l=r.line;}
});
test("curve trigger (no stall): peak 3% on a=0.4% → exit at or under it, hold above it",()=>{
  const line=lockLine(.03,A,0,W)!.line;assert.ok(Math.abs(line-.03*.03/(.03+3*A))<1e-12);
  assert.equal(poolLock({peak:.03,cur:line+.0005,stallMin:0,a:A,windowMin:W})!.act,"HOLD");
  const v=poolLock({peak:.03,cur:line-.0001,stallMin:0,a:A,windowMin:W})!;assert.equal(v.act,"EXIT");assert.match(v.why,/池内动态锁利/);
});
test("stall trigger: after W minutes without a new high the giveback narrows from 3a to 1.5a, and a new high resets it",()=>{
  const peak=.06,wide=lockLine(peak,A,0,W)!,tight=lockLine(peak,A,2*W,W)!;
  assert.ok(tight.line>wide.line,"narrower giveback → line closer to the peak");assert.ok(Math.abs(tight.giveback-1.5*A)<1e-12||tight.line===POOL_LOCK.costFloor,"narrowed to 1.5a");
  assert.equal(lockLine(peak,A,W,W)!.line,wide.line,"exactly W: not yet narrowing");
  const mid=lockLine(peak,A,1.5*W,W)!.line;assert.ok(mid>wide.line&&mid<tight.line);
  const cur=(wide.line+tight.line)/2;
  assert.equal(poolLock({peak,cur,stallMin:0,a:A,windowMin:W})!.act,"HOLD","fresh high: trend gets its room");
  assert.equal(poolLock({peak,cur,stallMin:2*W,a:A,windowMin:W})!.act,"EXIT","stalled: tight line");
  assert.match(poolLock({peak,cur,stallMin:2*W,a:A,windowMin:W})!.why,/60 分钟没创新高/);
});
test("the line is never below cost (fees + buffer) once armed, and never above the peak",()=>{
  for(const a of [.0015,.003,.01,.05])for(const peak of [.006,.01,.02,.1])for(const st of [0,W,2*W,10*W]){
    const r=lockLine(peak,a,st,W);if(!r)continue;assert.ok(r.line>=POOL_LOCK.costFloor-1e-12,`a ${a} peak ${peak}`);assert.ok(r.line<=peak);}
  assert.ok(Math.abs(POOL_LOCK.costFloor-.0024)<1e-12);
  // with the arming rule the curve alone already stays above cost (peak ≥ 0.6% → line ≥ peak/2 ≥ 0.3%): the floor is a guarantee, not a tuning knob
  for(const a of [.0015,.002])assert.ok(lockLine(.006,a,0,W)!.line>=POOL_LOCK.costFloor);
  // a winner that was armed leaves at about its curve line, which is above cost: it does not turn into a loss
  assert.equal(poolLock({peak:.0061,cur:.0023,stallMin:0,a:.0015,windowMin:W})!.act,"EXIT");
});
test("unknowns never trigger: lost peak, lost clock, no fresh quote, no unit",()=>{
  const ok={peak:.03,cur:-.05,stallMin:100,a:A,windowMin:W};assert.equal(poolLock(ok)!.act,"EXIT");
  for(const k of ["peak","cur","stallMin","a"] as const)assert.equal(poolLock({...ok,[k]:null}),null,k);
  assert.equal(poolLock({...ok,a:0}),null);assert.equal(poolLock({...ok,peak:NaN}),null);
});
test("peak clock: first sight / lost clock starts at now and reports unknown; new high resets; stall grows",()=>{
  const ck:PeakClock={},t0=1e12;
  assert.equal(tickClock(ck,"x",.01,t0),null);assert.deepEqual(ck.x,[.01,t0]);
  assert.equal(tickClock(ck,"x",.01,t0+10*60_000),10);
  assert.equal(tickClock(ck,"x",.012,t0+11*60_000),0);assert.deepEqual(ck.x,[.012,t0+11*60_000]);
  assert.equal(tickClock(ck,"x",.012,t0+41*60_000),30);
  assert.equal(tickClock(ck,"y",null,t0),null);assert.equal(ck.y,undefined);
  const bad={z:["a",1]} as unknown as PeakClock;assert.equal(tickClock(bad,"z",.02,t0),null);
});
test("window follows the planned hold: planned/24 clamped to 15–45 min; unit helpers",()=>{
  assert.equal(stallWindowMin("1h",48),45);assert.equal(stallWindowMin("15m",24),15);assert.equal(stallWindowMin("5m",12),15);
  assert.equal(stallWindowMin("1h",null),45);assert.equal(stallWindowMin("15m",null),15);assert.equal(stallWindowMin("1h",24),45);
  assert.equal(stallWindowMin("15m",48),30);
  assert.equal(lockUnit(null,null),.0015);assert.equal(lockUnit(.002,.004),.004);
  assert.equal(atr5Frac([]),null);
  const bars=Array.from({length:15},(_,i)=>({high:101,low:99,close:100+(i%2)*0}));assert.ok(Math.abs(atr5Frac(bars)!-.02)<1e-9);
});

// ---------------------------------------------------------------- engine wiring
const NOW=Date.UTC(2026,9,23,8,5);
const emptyFwd=():ForwardView=>({positions:[],history:[],opportunities:[]});
function engine(){const e=new LivingEngine(NOW),cfg=defaultLivingConfig(NOW);e.restore(new Map([[LIVING_KEYS.config,{...cfg,mode:"paper-enabled" as const}]]),NOW);return e;}
const q=(now:number,sym:string,p:number)=>({[sym]:{bestBid:p,bestAsk:p,observedAt:now-500,entryReady:true}});
const dynIn=(exits:DynPlanInput["exits"]=[]):DynPlanInput=>({ready:true,gates:{},signals:[],exits,state:"UP/MID"});
const pos=(id:string,side:"LONG"|"SHORT",favorable:number,living:Partial<LivingNote>|undefined={})=>({id,symbol:"AAA_USDT",side,entryPrice:100,stopPrice:side==="LONG"?95:105,
  openedAt:NOW-3*3_600_000,favorable,adverse:0,leverage:3,entryContext:{living:{v:"living-v2",k:"N",pb:"box1h-long",inv:side==="LONG"?95:105,hx:1,dp:1,mb:48,...living} as LivingNote}});
const plan=(e:LivingEngine,now:number,price:number,positions:ReturnType<typeof pos>[],exits:DynPlanInput["exits"]=[])=>
  e.plan({now,forward:{...emptyFwd(),positions:positions as never},quotes:q(now,"AAA_USDT",price),contracts:{},funding:{},candles:{},dyn:dynIn(exits)} as PlanContext)!;
const lockActs=(d:{actions:{code:string;tradeId:string;action:string}[]})=>d.actions.filter(a=>a.code===POOL_LOCK_CODE);
// no tape: a = 0.15% floor → armed at peak ≥ 0.6%; window for box1h-long mb48 = 45 min
const A0=.0015;

test("engine, long: no fresh clock → no trigger on the first tick; after the stall window a fall to the line exits with the new code and the audit detail",()=>{
  const e=engine(),p=pos("t1","LONG",.03);
  assert.equal(lockActs(plan(e,NOW,100,[p])).length,0,"first sight starts the clock only");
  const line=lockLine(.03,A0,0,45)!.line;
  assert.equal(lockActs(plan(e,NOW+10_000,100*(1+line+.002),[p])).length,0,"above the line");
  const d=plan(e,NOW+20_000,100*(1+line-.0005),[p]);const a=lockActs(d);assert.equal(a.length,1);
  assert.equal(a[0]!.action,"EXIT");assert.equal(a[0]!.tradeId,"t1");
  const det=(a[0] as unknown as {detail:Record<string,number>}).detail;
  assert.equal(det.peak,.03);assert.ok(det.cur<det.line);assert.equal(det.stall_min,0);assert.equal(det.window_min,45);
  assert.match((a[0] as unknown as {reason:string}).reason,/池内动态锁利/);
});
test("engine, short: mirrored (price rising against the short)",()=>{
  const e=engine(),p=pos("t2","SHORT",.03);plan(e,NOW,100,[p]);
  const line=lockLine(.03,A0,0,45)!.line;// short move = -(price/entry-1)
  assert.equal(lockActs(plan(e,NOW+10_000,100*(1-line-.002),[p])).length,0);
  assert.equal(lockActs(plan(e,NOW+20_000,100*(1-line+.0005),[p])).length,1);
});
test("engine: stall trigger — same price holds right after a new high, exits once 2W have passed without one",()=>{
  const e=engine(),p=pos("t3","LONG",.02);plan(e,NOW,100,[p]);
  const wide=lockLine(.02,A0,0,45)!.line,tight=lockLine(.02,A0,90,45)!.line,px=100*(1+(wide+tight)/2);assert.ok(tight>wide);
  assert.equal(lockActs(plan(e,NOW+60_000,px,[p])).length,0);
  assert.equal(lockActs(plan(e,NOW+91*60_000,px,[p])).length,1,"91 min without a new high");
  // a new high resets the clock → no trigger at the same price
  const e2=engine(),p2=pos("t3b","LONG",.02);plan(e2,NOW,100,[p2]);
  const px2=100*(1+lockLine(.021,A0,0,45)!.line+.0003);
  plan(e2,NOW+60*60_000,px2,[{...p2,favorable:.021}]);
  assert.equal(lockActs(plan(e2,NOW+61*60_000,px2,[{...p2,favorable:.021}])).length,0,"new high at minute 60 → clock restarted");
});
test("engine: small profit and losing trades are untouched; non-pool trades are untouched",()=>{
  const e=engine();const small=pos("s1","LONG",.004),loser=pos("s2","LONG",0),old=pos("s3","LONG",.05,{dp:undefined,hx:undefined,pb:"fast"}),burst=pos("s4","LONG",.05,{dp:undefined,bh:1,pb:"burst-leader"});
  const ps=[small,loser,old,burst];plan(e,NOW,100,ps);
  assert.equal(lockActs(plan(e,NOW+3*3_600_000,90,ps)).length,0);
});
test("engine: restart — clock persisted and restored triggers; clock lost → no trigger on the first tick (peak missing = conservative)",()=>{
  const e=engine(),p=pos("r1","LONG",.03);plan(e,NOW,100,[p]);
  const line=lockLine(.03,A0,0,45)!.line,fall=100*(1+line-.002);
  const w=e.writes(NOW+5_000,true),saved=JSON.parse(JSON.stringify(w[LIVING_KEYS.trades])) as {dx?:{pk?:Record<string,unknown>}};
  assert.ok(saved.dx?.pk?.r1,"peak clock is inside the normal trades key (no new key, no new write)");
  const mk=(trades:unknown)=>{const r=new LivingEngine(NOW),cfg=defaultLivingConfig(NOW);r.restore(new Map<string,unknown>([[LIVING_KEYS.config,{...cfg,mode:"paper-enabled"}],...(trades?[[LIVING_KEYS.trades,trades] as [string,unknown]]:[])]),NOW+6_000);return r;};
  assert.equal(lockActs(plan(mk(saved),NOW+7_000,fall,[p])).length,1,"restored clock → rule works at once");
  const lost=structuredClone(saved);delete lost.dx!.pk;
  const r2=mk(lost);assert.equal(lockActs(plan(r2,NOW+7_000,fall,[p])).length,0,"clock lost → no trigger now");
  assert.equal(lockActs(plan(r2,NOW+8_000,fall,[p])).length,1,"…and it works from the next tick on (clock started)");
  const r3=mk(null);assert.equal(lockActs(plan(r3,NOW+7_000,fall,[p])).length,0);
  // peak itself missing/NaN on the position → never triggers
  const r4=mk(saved);assert.equal(lockActs(plan(r4,NOW+7_000,fall,[{...p,favorable:Number.NaN}])).length,0);
});
test("engine: no fresh quote → no trigger; closes of the playbook's own rules (EXIT in the same tick) win; GUARD (stop) is never touched or loosened",()=>{
  const e=engine(),p=pos("g1","LONG",.03);plan(e,NOW,100,[p]);
  const line=lockLine(.03,A0,0,45)!.line,fall=100*(1+line-.002);
  const stale=e.plan({now:NOW+20_000,forward:{...emptyFwd(),positions:[p] as never},quotes:{AAA_USDT:{bestBid:fall,bestAsk:fall,observedAt:NOW,entryReady:true}},contracts:{},funding:{},candles:{},dyn:dynIn()} as PlanContext)!;
  assert.equal(lockActs(stale).length,0,"quote older than 10 s");
  const own=plan(e,NOW+21_000,fall,[p],[{tradeId:"g1",act:"EXIT",why:"到时",code:"LIVING_DYN_EXIT"}]);
  assert.deepEqual(own.actions.filter(a=>a.tradeId==="g1").map(a=>a.code),["LIVING_DYN_EXIT"],"only the playbook's exit, no second one");
  const guard=plan(e,NOW+22_000,fall,[p],[{tradeId:"g1",act:"GUARD",stop:98,why:"trail",code:"LIVING_DYN_TRAIL"}]);
  const acts=guard.actions.filter(a=>a.tradeId==="g1");
  assert.equal(acts[0]!.action,"GUARD");assert.equal((acts[0] as {stop?:number}).stop,98,"the trail guard passes through unchanged");
  assert.ok(acts.every(a=>a.action==="EXIT"||(a as {stop?:number}).stop===98),"the lock never emits a stop change at all");
});
test("engine: ordinary trades with a deep drawdown are never closed by the lock; only EXIT actions with the lock code are ever added",()=>{
  const e=engine(),p=pos("o1","LONG",.0007);plan(e,NOW,100,[p]);
  const d=plan(e,NOW+4*3_600_000,90,[p]);assert.ok(!d.actions.some(a=>a.code===POOL_LOCK_CODE));
  assert.equal(POOL_LOCK_CODE,"LIVING_DYN_POOL_LOCK");
});
