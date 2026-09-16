import test from "node:test";
import assert from "node:assert/strict";
import { advanceForward, initialForward, normalizeForward, synthesizeRules, forwardEquity,
  forwardWatchSymbols, BAR_MS, type Rule, type Measurement, type ForwardState, type Candle } from "../lib/forward-relations.ts";
import { EVIDENCE_POLICY, inspectCondition, blankDiagnostics, collectFeedback, executionCalibration,
  familyKey, ruleApplies, entryEconomics, type Feedback } from "../lib/forward-evidence.ts";
import { readForwardStore, prepareForwardWrite } from "../lib/forward-store.ts";
const T=1_790_000_100_000,START=Math.floor(T/BAR_MS)*BAR_MS,HOUR=3_600_000;
const conditions=[{feature:0,op:"GE" as const,threshold:0}];
function rows(response:(k:number,j:number)=>number=()=>.006,symbols=8,count=12,h=15):Measurement[]{
  return Array.from({length:count},(_,k)=>Array.from({length:symbols},(_,j)=>{
    const at=START+(k+1)*h*60000,r=response(k,j);return {symbol:`S${j}`,at,seenAt:at+90000,price:100,
      x:[1,k%2*.2,0,0,0,0,0,0],horizon:h,endAt:at+h*60000,availableAt:at+h*60000+90000,
      response:r,up:Math.max(0,r)+.003,down:Math.max(0,-r)+.003};})).flat();
}
function inspect(data:Measurement[],scopeSymbol?:string,feedback:Feedback[]=[]) {
  const diagnostics=blankDiagnostics(),now=Math.max(...data.map(r=>r.availableAt))+1;
  return {candidate:inspectCondition({rows:data,conditions,horizon:15,now,feedback,scopeSymbol},diagnostics),diagnostics,now};
}
function fixtureRule(now:number,symbols=["S0","S1","S2","S3"]):Rule {
  const c=inspect(rows(()=>.02)).candidate!;
  return {...c,conditions:[{feature:0,op:"GE",threshold:-99}],id:"r",signature:"s",parentId:null,version:1,createdAt:now-1000,
    expiresAt:now+HOUR,grammar:"fixture",status:"EXPERIMENTAL",reason:"synthetic",mutation:"CREATE",liveEligible:false,
    estimatedNetRate:.02,stopRate:.02,armRate:.05,
    evidence:{...c.evidence,symbols,rawNet:.02,quality:1}};
}
function candles(now:number):Candle[]{return Array.from({length:25},(_,i)=>({time:(now-(25-i)*BAR_MS)/1000,
  open:100,close:100,high:100.1,low:99.9,volume:100}));}
function market(now:number,symbols=["S0","S1","S2","S3"],price=100){return{
  paths:Object.fromEntries(symbols.map(s=>[s,candles(now)])),
  quotes:Object.fromEntries(symbols.map(s=>[s,{bestBid:price,bestAsk:price+.01,observedAt:now,fresh:true,entryReady:true}])),
  contracts:Object.fromEntries(symbols.map(s=>[s,{quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005}]))};}
function freshState(now:number){const s=initialForward(START);s.rules=[fixtureRule(now)];s.lastFitAt=now;return s;}
function feedback(id:string,now:number,net=-.01):Feedback { return {id,symbol:"S0",family:"15:LONG:0GE",horizon:15,side:"LONG",
  openedAt:now-15*60000,closedAt:now,notional:500,predictedNet:.003,realizedNet:net,costRate:.0014,exitReason:"expiry",policy:EVIDENCE_POLICY}; }

test("ordinary shared positive relation survives robustness checks; not a no-trade design",()=>{
  const {candidate:c}=inspect(rows(()=>.004));assert.ok(c);assert.equal(c.side,"LONG");assert.equal(c.evidence.scope,"CROSS_ASSET");assert.equal(c.evidence.symbols.length,8);
});
test("ordinary shared negative relation can generate a SHORT without loss-triggered reversal",()=>{
  const {candidate:c}=inspect(rows(()=>-.006));assert.ok(c);assert.equal(c.side,"SHORT");assert.equal(c.evidence.calibration.groups,0);
});
test("one enormous coin rally cannot create a shared LONG over losing peers",()=>{
  const {candidate:c}=inspect(rows((_k,j)=>j===0?.5:-.004));assert.ok(!c||c.side!=="LONG");
});
test("a concentrated positive mean that fails removing one symbol is explicitly rejected",()=>{
  const {candidate:c,diagnostics:d}=inspect(rows((_k,j)=>j===0?.03:.0001,4));assert.equal(c,null);assert.ok(d.concentrationRejected>0||d.costRejected>0);
});
test("persistent single-symbol relation remains usable but has no authority on other coins",()=>{
  const data=rows(()=>.012,1);const {candidate:c}=inspect(data,"S0");assert.ok(c);
  const r={...fixtureRule(START),...c};assert.equal(ruleApplies(r,"S0"),true);assert.equal(ruleApplies(r,"S1"),false);
});
test("even a shared rule cannot authorize a never-observed coin",()=>{
  const {candidate:c}=inspect(rows());assert.ok(c);assert.equal(ruleApplies({...fixtureRule(START),...c},"NEW"),false);
});
test("single extreme event is not enough for a single-asset rule",()=>{
  const data=rows((k)=>k===5?.3:-.002,1);assert.equal(inspect(data,"S0").candidate,null);
});
test("duplicate labels cannot increase the number of evidence time groups",()=>{
  const a=rows(),first=inspect(a).candidate,second=inspect([...a,...a,...a]).candidate;assert.deepEqual(second,first);
});
test("unknown future outcomes cannot change the earlier split, cap or rule",()=>{
  const a=rows(),now=Math.max(...a.map(r=>r.availableAt))+1;
  const evaluate=(data:Measurement[])=>inspectCondition({rows:data,conditions,horizon:15,now,feedback:[]},blankDiagnostics());
  assert.deepEqual(evaluate([...a,{...a[0],availableAt:now+HOUR,endAt:now+HOUR,response:100}]),evaluate(a));
});
test("all-flat or below-cost observations do not create paid trades",()=>{
  assert.equal(inspect(rows(()=>0)).candidate,null);assert.equal(inspect(rows(()=>.0005)).candidate,null);
});
test("threshold tweaks cannot erase feedback family identity",()=>{
  const a=fixtureRule(START);const b={...a,version:20,conditions:a.conditions.map(c=>({...c,threshold:-98}))};assert.equal(familyKey(a),familyKey(b));
});
test("same-time copies across coins produce one feedback group, not eight independent trials",()=>{
  const now=START+HOUR,a=feedback("one",now);const copies=Array.from({length:8},(_,i)=>({...a,id:`id${i}`,symbol:`S${i}`}));
  const c=executionCalibration(copies,a.family,copies.map(f=>f.symbol),now);assert.equal(c.groups,1);assert.equal(c.effectiveGroups,1);
});
test("a first loss is shrunk, not a deterministic streak disable",()=>{
  const now=START+HOUR,f=feedback("one",now);const c=executionCalibration([f],f.family,["S0"],now);
  assert.ok(c.penalty>0);assert.ok(c.penalty<Math.abs(f.realizedNet-f.predictedNet));
});
test("past loss influence fades while fresh market observations continue",()=>{
  const now=START+HOUR,f=feedback("one",now);const a=executionCalibration([f],f.family,["S0"],now),b=executionCalibration([f],f.family,["S0"],now+12*HOUR);
  assert.ok(b.penalty<a.penalty);assert.equal(executionCalibration([f],f.family,["S0"],now+25*HOUR).penalty,0);
});
test("positive executions cannot increase forecast or risk via the calibration multiplier",()=>{
  const now=START+HOUR,f=feedback("one",now,.02);assert.equal(executionCalibration([f],f.family,["S0"],now).penalty,0);
});
test("future closures and incompatible scope cannot contaminate present feedback",()=>{
  const now=START+HOUR,f=feedback("one",now+1);assert.equal(executionCalibration([f],f.family,["S0"],now).groups,0);
  assert.equal(executionCalibration([f],f.family,["OTHER"],now+1).groups,0);
});
test("actual negative outcomes lower a still-positive gross relation's net estimate",()=>{
  const data=rows(()=>.004),now=Math.max(...data.map(r=>r.availableAt))+1;
  const bad=Array.from({length:6},(_,i)=>feedback(`loss${i}`,now-(i+1)*15*60000));
  const result=inspectCondition({rows:data,conditions,horizon:15,now,feedback:bad},blankDiagnostics());assert.equal(result,null);
});
test("fees are not subtracted again by the residual calibrator",()=>{
  const now=START+HOUR,f=feedback("equal",now);f.realizedNet=f.predictedNet;f.costRate=.02;
  assert.equal(executionCalibration([f],f.family,["S0"],now).penalty,0);
});
test("remaining edge pays for movement before entry rather than chasing past profit",()=>{
  const r=fixtureRule(START);r.estimatedNetRate=.003;
  assert.ok(entryEconomics(r,100,100.5,.0002).remaining<0);
  assert.ok(entryEconomics(r,100,99,.0002).remaining<=r.estimatedNetRate);
});
test("a large adverse pre-entry move invalidates the old context instead of increasing confidence",()=>{
  const r=fixtureRule(START),result=entryEconomics(r,100,90,.0001);assert.equal(result.contextInvalid,true);assert.equal(result.quality,0);
});
test("a weak expected edge does not receive the strong edge's full 1.5% risk",()=>{
  const now=START+BAR_MS*10,strong=freshState(now),weak=structuredClone(strong);
  weak.rules[0].estimatedNetRate=.003;weak.rules[0].evidence!.rawNet=.003;weak.rules[0].evidence!.quality=.4;
  const m=market(now,["S0"]),a=advanceForward({state:strong,now,...m}).state,b=advanceForward({state:weak,now,...m}).state;
  assert.equal(a.positions.length,1);assert.equal(b.positions.length,1);assert.ok(b.positions[0].notional<a.positions[0].notional);
});
test("shared same-direction same-horizon budget includes new-leg marking costs",()=>{
  const now=START+BAR_MS*10,m=market(now),s=advanceForward({state:freshState(now),now,...m}).state;
  const eq=forwardEquity(s,m.quotes,now).equity;assert.equal(s.positions.length,2);assert.ok(s.positions.reduce((a,t)=>a+t.plannedRisk,0)<=eq*.03+1e-8);
});
test("tiny remaining allocation is skipped rather than creating dust orders",()=>{
  const now=START+BAR_MS*10,m=market(now),s=advanceForward({state:freshState(now),now,...m}).state;
  assert.ok(s.positions.every(t=>t.notional>=s.balance*.05));assert.ok(Object.keys(s.entryDiagnostics!.reasons).some(k=>k.includes("仓位")));
});
test("closed order cannot reopen same symbol and family before original horizon by changing version",()=>{
  const now=START+BAR_MS*10,m=market(now,["S0"]);let s=advanceForward({state:freshState(now),now,...m}).state;
  s=advanceForward({state:s,now:now+BAR_MS,...market(now+BAR_MS,["S0"],90)}).state;assert.equal(s.positions.length,0);
  s.rules=[fixtureRule(now+BAR_MS,["S0"])];s.lastFitAt=now+BAR_MS;s.rules[0].version=99;
  s=advanceForward({state:s,now:now+2*BAR_MS,...market(now+2*BAR_MS,["S0"])}).state;
  assert.equal(s.positions.length,0);assert.ok(Object.keys(s.entryDiagnostics!.reasons).some(k=>k.includes("周期尚未结束")));
});
test("identical evidence and no new closed trades do not mint versions",()=>{
  const s=initialForward(START);s.samples=rows();const now=Math.max(...s.samples.map(r=>r.availableAt))+1;
  synthesizeRules(s,now);const ids=s.rules.filter(r=>r.status==="EXPERIMENTAL").map(r=>r.id),n=s.rules.length;
  synthesizeRules(s,now+1000);assert.deepEqual(s.rules.filter(r=>r.status==="EXPERIMENTAL").map(r=>r.id),ids);assert.equal(s.rules.length,n);
});
test("changed market evidence can still revise rules and directions",()=>{
  const s=initialForward(START);s.samples=rows();const now=Math.max(...s.samples.map(r=>r.availableAt))+1;synthesizeRules(s,now);
  s.samples=rows(()=>-.006);synthesizeRules(s,now+1000);assert.ok(s.rules.some(r=>r.status==="EXPERIMENTAL"&&r.side==="SHORT"));
});
test("old-rule orders preserve entry, amount and stop across an idempotent non-reset upgrade",()=>{
  const now=START+10*BAR_MS,m=market(now,["S0"]);const s=advanceForward({state:freshState(now),now,...m}).state;
  delete s.policyVersion;delete s.positions[0].rule.evidence;const old=structuredClone(s.positions[0]);
  const upgraded=advanceForward({state:s,now:now+10000,paths:{},quotes:{S0:{...m.quotes.S0,observedAt:now+10000}},contracts:{}}).state;
  assert.equal(upgraded.startedAt,s.startedAt);assert.equal(upgraded.balance,s.balance);assert.equal(upgraded.positions[0].stopPrice,old.stopPrice);
  assert.equal(upgraded.positions[0].quantity,old.quantity);assert.equal(upgraded.positions[0].entryPrice,old.entryPrice);
  assert.equal(upgraded.policyVersion,EVIDENCE_POLICY);assert.equal(upgraded.events.filter(e=>e.kind==="UPGRADE").length,1);
  const restored=normalizeForward(JSON.parse(JSON.stringify(upgraded)) as ForwardState,now+11000);
  const second=advanceForward({state:restored,now:now+11000,paths:{},quotes:{},contracts:{}}).state;
  assert.equal(second.events.filter(e=>e.kind==="UPGRADE").length,1);assert.deepEqual(second.policyUpgrade,upgraded.policyUpgrade);
});
test("loss records are preserved and legacy closed outcomes seed only feedback, never fake wins",()=>{
  const now=START+10*BAR_MS,m=market(now,["S0"]);let s=advanceForward({state:freshState(now),now,...m}).state;
  s=advanceForward({state:s,now:now+BAR_MS,...market(now+BAR_MS,["S0"],90)}).state;
  const history=JSON.stringify(s.history),balance=s.balance;delete s.policyVersion;
  const upgraded=advanceForward({state:s,now:now+BAR_MS+10000,paths:{},quotes:{},contracts:{}}).state;
  assert.equal(upgraded.balance,balance);assert.equal(JSON.stringify(upgraded.history),history);assert.equal(upgraded.resolved,1);
  assert.equal(upgraded.feedback!.length,1);assert.equal(upgraded.feedback![0].realizedNet,upgraded.history[0].netPnl!/upgraded.history[0].notional);
  assert.equal(collectFeedback(upgraded.feedback!,upgraded.history,now+BAR_MS+10000).length,1);
});
test("unknown future policy refuses silent downgrade",()=>{
  const s=initialForward(START);s.policyVersion="future";assert.throws(()=>normalizeForward(s,START));assert.throws(()=>advanceForward({state:s,now:START,paths:{},quotes:{},contracts:{}}));
});
test("watch list contains protected positions and only applicable rule opportunities",()=>{
  const s=freshState(START);s.frames={UNKNOWN:{symbol:"UNKNOWN",at:START,seenAt:START,price:100,x:Array(8).fill(0)}};
  assert.deepEqual(forwardWatchSymbols(s,START),[]);
});
test("storage rollback does not publish a candidate, fee, or feedback update",async()=>{
  const now=START+10*BAR_MS,s=freshState(now),before=JSON.stringify(s),next=advanceForward({state:s,now,...market(now,["S0"])}).state;
  await prepareForwardWrite(s,next,now);assert.equal(JSON.stringify(s),before);assert.equal(s.positions.length,0);
});
test("feedback and upgrade marker survive chunked store restart exactly",async()=>{
  const now=START+10*BAR_MS,s=freshState(now);delete s.policyVersion;s.balance=943;
  const next=advanceForward({state:s,now,paths:{},quotes:{},contracts:{}}).state,prepared=await prepareForwardWrite(s,next,now);
  const db=new Map(Object.entries(prepared.entries));const restored=await readForwardStore({async get<T>(key:string){return db.get(key) as T|undefined;}},now+HOUR);
  assert.deepEqual(restored,next);assert.equal(restored.balance,943);
});
test("model is bounded at full rolling capacity with no provider requests",()=>{
  const s=initialForward(START),now=START+40*HOUR;
  s.samples=[15,60,180].flatMap(h=>{const a=rows(()=>.006,32,12,h),shift=now-Math.max(...a.map(r=>r.availableAt))-1;
    return a.map(r=>({...r,at:r.at+shift,endAt:r.endAt+shift,seenAt:r.seenAt+shift,availableAt:r.availableAt+shift}));});
  const start=performance.now();synthesizeRules(s,now);
  assert.ok(performance.now()-start<5000);assert.ok(s.rules.filter(r=>r.status==="EXPERIMENTAL").length<=9);
});
test("large simultaneous archive events are partitioned without losing evidence or account atomicity",async()=>{
  const old=initialForward(START),next=structuredClone(old);next.events=Array.from({length:240},(_,i)=>({
    id:`f${START}-${i+2}`,at:START+1000,kind:"FIT" as const,subject:"stress",reason:"test".repeat(350)}));next.revision=241;
  const prepared=await prepareForwardWrite(old,next,START+1000),archives=Object.entries(prepared.entries).filter(([k])=>k.includes("archive:"));
  assert.ok(archives.length>1);assert.equal(archives.reduce((n,[,v])=>n+((v as {events?:unknown[]}).events?.length??0),0),240);
  assert.ok(archives.every(([,v])=>new TextEncoder().encode(JSON.stringify(v)).length<120*1024));
  const map=new Map(Object.entries(prepared.entries));assert.deepEqual(await readForwardStore({async get<T>(key:string){return map.get(key) as T|undefined;}},START+2000),next);
});