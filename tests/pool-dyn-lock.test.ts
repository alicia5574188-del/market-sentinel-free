/**
 * Pool profit lock (lib/dynamic/pool-lock.ts + LivingEngine.poolLockStep): pure rule (arming, curve, stall, cost floor, unknowns)
 * and the engine wiring (long / short, only dp trades, restart with the clock persisted or lost, never loosens a stop, same-tick exits win).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {POOL_LOCK,POOL_LOCK_CODE,lockLine,poolLock,tickClock,stallWindowMin,plannedMin,riskR,type PeakClock} from "../lib/dynamic/pool-lock.ts";
import {LivingEngine,LIVING_KEYS,type PlanContext,type ForwardView} from "../lib/living/engine.ts";
import {defaultLivingConfig} from "../lib/living/config.ts";
import type {DynPlanInput} from "../lib/dynamic/runtime.ts";
import type {LivingNote} from "../lib/living/directive.ts";

const R=.02;// a trade that planned a 2% stop distance
const W=30;
test("small profit does not arm: below max(0.5R, 0.6%) nothing triggers, even after a long stall and a full giveback",()=>{
  for(const peak of [0,.002,.005,.5*R-1e-4]){
    assert.equal(lockLine(peak,R,500,W),null,`peak ${peak}`);
    const v=poolLock({peak,cur:-.02,stallMin:500,r:R,windowMin:W});assert.equal(v?.act,"HOLD");assert.equal(v?.armed,false);
  }
  assert.equal(lockLine(.0059,.008,500,W),null,"small R: the 0.6% floor (2.5 × cost) still applies");
  assert.ok(lockLine(.006,.008,0,W));
  assert.ok(lockLine(.5*R,R,0,W),"armed exactly at 0.5R");
});
test("scale is the trade's own R: the same peak in R-multiples gets the same kept share, whatever R is",()=>{
  for(const r of [.01,.02,.05,.08]){const l=lockLine(1*r,r,0,W)!;assert.ok(Math.abs(l.line/(1*r)-1/(1+POOL_LOCK.curveK))<1e-12,`1R share at R ${r}`);}
  // a wide-stop trade (R 6%) is not armed by a 1% peak; a tight-stop trade (R 1%) is
  assert.equal(lockLine(.01,.06,0,W),null);assert.ok(lockLine(.01,.01,0,W));
  // the 5-minute noise level is not an input at all: line depends on (peak, R, stall, window) only
  assert.equal(lockLine.length,4);
});
test("curve: the kept share of the peak rises monotonically with the peak; the room never drops to a touch",()=>{
  let last=-1;
  for(let p=.01;p<=.3;p+=.004){const r=lockLine(p,R,0,W)!,share=r.line/p;assert.ok(share>=last-1e-12,`share ${share} at ${p}`);last=share;assert.ok(r.giveback>=POOL_LOCK.curveK*R*p/(p+POOL_LOCK.curveK*R)-1e-12||r.line===POOL_LOCK.costFloor,"room kept");}
  // wide-stop trade at the same peak gets more room than a tight-stop one
  assert.ok(lockLine(.05,.01,0,W)!.line>lockLine(.05,.04,0,W)!.line);
  let l=-1;for(let p=.01;p<=.3;p+=.002){const r=lockLine(p,R,0,W)!;assert.ok(r.line>=l);l=r.line;}
});
test("curve trigger (no stall): peak 3% on R=2% → exit at or under it, hold above it",()=>{
  const line=lockLine(.03,R,0,W)!.line;assert.ok(Math.abs(line-.03*.03/(.03+POOL_LOCK.curveK*R))<1e-12);
  assert.equal(poolLock({peak:.03,cur:line+.0005,stallMin:0,r:R,windowMin:W})!.act,"HOLD");
  const v=poolLock({peak:.03,cur:line-.0001,stallMin:0,r:R,windowMin:W})!;assert.equal(v.act,"EXIT");assert.match(v.why,/池内动态锁利/);assert.match(v.why,/1\.50R/);
});
test("stall trigger: after W minutes without a new high the giveback narrows to 0.25R, and a new high resets it",()=>{
  const peak=.15,wide=lockLine(peak,R,0,W)!,tight=lockLine(peak,R,2*W,W)!;// peak 7.5R: curve keeps 15R/(...) → a wide line, stall tightens it
  assert.ok(tight.line>wide.line,"narrower giveback → line closer to the peak");assert.ok(Math.abs(tight.giveback-POOL_LOCK.tightK*R)<1e-12||tight.line===POOL_LOCK.costFloor,"narrowed to 0.25R");
  assert.equal(lockLine(peak,R,W,W)!.line,wide.line,"exactly W: not yet narrowing");
  const mid=lockLine(peak,R,1.5*W,W)!.line;assert.ok(mid>=wide.line&&mid<=tight.line);
  const cur=(wide.line+tight.line)/2;
  assert.equal(poolLock({peak,cur,stallMin:0,r:R,windowMin:W})!.act,"HOLD","fresh high: trend gets its room");
  assert.equal(poolLock({peak,cur,stallMin:2*W,r:R,windowMin:W})!.act,"EXIT","stalled: tight line");
  assert.match(poolLock({peak,cur,stallMin:2*W,r:R,windowMin:W})!.why,/60 分钟没创新高/);
});
test("the line is never below cost (fees + buffer) once armed, and never above the peak",()=>{
  for(const r of [.008,.01,.02,.06,.1])for(const peak of [.006,.01,.02,.1,.3])for(const st of [0,W,2*W,10*W]){
    const x=lockLine(peak,r,st,W);if(!x)continue;assert.ok(x.line>=POOL_LOCK.costFloor-1e-12,`R ${r} peak ${peak}`);assert.ok(x.line<=peak);}
  assert.ok(Math.abs(POOL_LOCK.costFloor-.0024)<1e-12);assert.ok(Math.abs(POOL_LOCK.armFloor-2.5*POOL_LOCK.costFloor)<1e-12);
  // an armed winner leaves at about its curve line, which is above cost: it does not turn into a loss
  assert.equal(poolLock({peak:.0061,cur:.0023,stallMin:0,r:.008,windowMin:W})!.act,"EXIT");
});
test("unknowns never trigger: lost peak, lost clock, no fresh quote, no R",()=>{
  const ok={peak:.03,cur:-.05,stallMin:100,r:R,windowMin:W};assert.equal(poolLock(ok)!.act,"EXIT");
  for(const k of ["peak","cur","stallMin","r"] as const)assert.equal(poolLock({...ok,[k]:null}),null,k);
  assert.equal(poolLock({...ok,r:0}),null);assert.equal(poolLock({...ok,peak:NaN}),null);
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
test("window follows the planned hold: planned/8 clamped to 15–45 min; R comes from the initial stop",()=>{
  assert.equal(plannedMin("5m",24),120);assert.equal(plannedMin("1h",12),720);assert.equal(plannedMin("15m",null),360);
  assert.equal(stallWindowMin("5m",24),15,"cascade 2h → 15");assert.equal(stallWindowMin("15m",16),30,"box-fade 4h → 30");
  assert.equal(stallWindowMin("1h",6),45,"burst 6h → 45");assert.equal(stallWindowMin("1h",12),45,"nr7 12h → clamp 45");assert.equal(stallWindowMin("5m",6),15);
  assert.equal(riskR(100,95),.05);assert.equal(riskR(100,105),.05);assert.equal(riskR(100,99.9),.008,"degenerate tiny stop floored at the pool minimum");
  for(const bad of [[100,null],[100,undefined],[0,95],[100,0],[100,100],[NaN,95],[100,Number.NaN],[100,300]] as const)assert.equal(riskR(bad[0],bad[1]),null,String(bad));
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
// entry 100, initial stop 95 → R = 5%; armed at peak ≥ 2.5%; window for box1h-long mb48 = 45 min
const A0=.05;

test("engine, long: no fresh clock → no trigger on the first tick; after the stall window a fall to the line exits with the new code and the audit detail",()=>{
  const e=engine(),p=pos("t1","LONG",.03);
  assert.equal(lockActs(plan(e,NOW,100,[p])).length,0,"first sight starts the clock only");
  const line=lockLine(.03,A0,0,45)!.line;
  assert.equal(lockActs(plan(e,NOW+10_000,100*(1+line+.002),[p])).length,0,"above the line");
  const d=plan(e,NOW+20_000,100*(1+line-.0005),[p]);const a=lockActs(d);assert.equal(a.length,1);
  assert.equal(a[0]!.action,"EXIT");assert.equal(a[0]!.tradeId,"t1");
  const det=(a[0] as unknown as {detail:Record<string,number>}).detail;
  assert.equal(det.peak,.03);assert.ok(det.cur<det.line);assert.equal(det.stall_min,0);assert.equal(det.window_min,45);assert.equal(det.r,.05);assert.equal(det.peak_r,.6);
  assert.match((a[0] as unknown as {reason:string}).reason,/池内动态锁利/);
});
test("engine, short: mirrored (price rising against the short)",()=>{
  const e=engine(),p=pos("t2","SHORT",.03);plan(e,NOW,100,[p]);
  const line=lockLine(.03,A0,0,45)!.line;// short move = -(price/entry-1)
  assert.equal(lockActs(plan(e,NOW+10_000,100*(1-line-.002),[p])).length,0);
  assert.equal(lockActs(plan(e,NOW+20_000,100*(1-line+.0005),[p])).length,1);
});
test("engine: stall trigger — same price holds right after a new high, exits once 2W have passed without one",()=>{
  const e=engine(),p=pos("t3","LONG",.06);plan(e,NOW,100,[p]);
  const wide=lockLine(.06,A0,0,45)!.line,tight=lockLine(.06,A0,90,45)!.line,px=100*(1+(wide+tight)/2);assert.ok(tight>wide);
  assert.equal(lockActs(plan(e,NOW+60_000,px,[p])).length,0);
  assert.equal(lockActs(plan(e,NOW+91*60_000,px,[p])).length,1,"91 min without a new high");
  // a new high resets the clock → no trigger at the same price
  const e2=engine(),p2=pos("t3b","LONG",.06);plan(e2,NOW,100,[p2]);
  const px2=100*(1+lockLine(.061,A0,0,45)!.line+.0003);
  plan(e2,NOW+60*60_000,px2,[{...p2,favorable:.061}]);
  assert.equal(lockActs(plan(e2,NOW+61*60_000,px2,[{...p2,favorable:.061}])).length,0,"new high at minute 60 → clock restarted");
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
test("engine: the line scales with the trade's own R — a volatile cascade trade (R 2.75%, peak 1.92%) is armed and protected; R comes from living.inv, not the trailed stop",()=>{
  const e=engine(),p={...pos("v1","LONG",.0192,{pb:"cascade5m-long",mb:24,inv:100*(1-.0275)}),stopPrice:99};// stop trailed to 99: must not shrink R
  plan(e,NOW,100,[p]);
  const line=lockLine(.0192,.0275,0,15)!.line;assert.ok(line>.0105&&line<.0115,"keeps ~58% of a 0.70R peak");
  assert.equal(lockActs(plan(e,NOW+10_000,100*(1+line+.001),[p])).length,0);
  const a=lockActs(plan(e,NOW+20_000,100*(1+line-.001),[p]));assert.equal(a.length,1);
  const det=(a[0] as unknown as {detail:Record<string,number>}).detail;assert.equal(det.r,.0275);assert.equal(det.window_min,15);assert.ok(Math.abs(det.peak_r-.698)<.001);
});
test("engine: unknown R (no initial stop in the order note) → the lock stays out",()=>{
  const e=engine(),p=pos("n1","LONG",.05,{inv:undefined});plan(e,NOW,100,[p]);
  assert.equal(lockActs(plan(e,NOW+20_000,90,[p])).length,0);
});
test("engine: a wide-stop trade with a small peak (0.17R) is not armed — the lock never sells a small profit",()=>{
  const e=engine(),p=pos("w1","LONG",.0102,{pb:"burst1h-long",mb:6,inv:100*(1-.0613)});plan(e,NOW,100,[p]);
  assert.equal(lockActs(plan(e,NOW+3_600_000,100.1,[p])).length,0);
});
