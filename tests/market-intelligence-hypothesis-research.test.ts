import assert from "node:assert/strict";
import test from "node:test";
import { initialMarketIntelligenceState, type MarketEvidence } from "../lib/market-intelligence-engine.ts";
import { initialForward } from "../lib/forward-relations.ts";
import { prepareForwardWrite } from "../lib/forward-store.ts";
import { advanceMarketHypothesisResearch, entryHypothesisGuidance, initialMarketHypothesisResearch,
  MARKET_HYPOTHESIS_ACTIVE_LIMIT, MARKET_HYPOTHESIS_MEMORY_LIMIT, MARKET_HYPOTHESIS_RESOLVED_LIMIT,
  normalizeMarketHypothesisResearch, positionHypothesisGuidance } from "../lib/market-intelligence-hypothesis-research.ts";

const T=1_790_572_400_000;
const ev=(type:string,direction:"BULLISH"|"BEARISH"|"MIXED",severity:number,family:"BREADTH"|"LEADERSHIP"|"RELATIVE"|"FLOW"|"CORRELATION"):MarketEvidence=>({
  id:type,at:T,type,direction,severity,summary:type,symbols:[],sourceCount:3,expiresAt:T+45*60_000,
  family,firstAt:T-60_000,lastAt:T,samples:12,trend:"STABLE"
});
function market(){
  const m=initialMarketIntelligenceState(T);
  m.narrative.major={...m.narrative.major,bias:"BULLISH",score:.42,confidence:.62};
  m.narrative.short={...m.narrative.short,bias:"NEUTRAL",score:.04,phase:"BALANCED"};
  m.narrative.transition={...m.narrative.transition,direction:"BEARISH",pressure:26,confidence:.5,stage:"EARLY"};
  m.internals={breadth3:-.35,breadth12:.65,breadthSlope:-.82,dispersion:.55,synchrony:.72,venuePressure:-.28,residualBalance:-.12,
    leaderPersistence:.38,bookImbalance:-.22,bidLiquidityChange:-.34,askLiquidityChange:.04,spreadRate:.0004};
  m.evidence=[
    ev("BREADTH_CONTRACTION","BEARISH",.86,"BREADTH"),
    ev("LEADERSHIP_ROTATION","MIXED",.72,"LEADERSHIP"),
    ev("BID_LIQUIDITY_WITHDRAWAL","BEARISH",.64,"CORRELATION"),
    ev("FLOW_WITH_PRICE_PROGRESS","BEARISH",.62,"FLOW"),
    ev("RESIDUAL_DISTRIBUTION_SHIFT","BEARISH",.55,"RELATIVE"),
  ];
  return m;
}

test("forward research can detect pullback risk before the broad direction flips",()=>{
  const state=advanceMarketHypothesisResearch(initialMarketHypothesisResearch(T-60_000),market(),T);
  const h=state.active.find(x=>x.kind==="PULLBACK_AHEAD");
  assert.ok(h);
  assert.equal(h.direction,"SHORT");
  assert.ok(h.confidence>=.42);
  assert.equal(market().narrative.major.bias,"BULLISH");
});

test("future hypotheses require sustained confirmation instead of reacting to one detail change",()=>{
  const first=advanceMarketHypothesisResearch(initialMarketHypothesisResearch(T-60_000),market(),T);
  const nextMarket=market();
  nextMarket.narrative.short={...nextMarket.narrative.short,bias:"BEARISH",score:-.35,phase:"PULLBACK_BUILDING"};
  const second=advanceMarketHypothesisResearch(first,nextMarket,T+5*60_000);
  const early=second.active.find(x=>x.kind==="PULLBACK_AHEAD");
  assert.ok(early);
  assert.notEqual(early?.status,"CONFIRMED");
  assert.equal(early?.confirmedAt,null);
  const third=advanceMarketHypothesisResearch(second,nextMarket,T+10*60_000);
  const h=third.active.find(x=>x.kind==="PULLBACK_AHEAD");
  assert.ok(h?.confirmedAt);
  assert.equal(h?.status,"CONFIRMED");
  assert.ok((h?.targetHitStreak??0)>=2);
  assert.ok((h?.observations??0)>=3);
});

test("big-winner-quality independent opportunities keep the original fast path",()=>{
  const state=advanceMarketHypothesisResearch(initialMarketHypothesisResearch(T-60_000),market(),T);
  const guidance=entryHypothesisGuidance(state,{side:"LONG",score:94,residualZ:1.4,residualPersistence:1,sourceCount:3,dataConfidence:91});
  assert.equal(guidance.extendedConfirmation,false);
  assert.notEqual(guidance.action,"CONFIRM_MORE");
});

test("a newly detected opposite hypothesis remains research-only and cannot slow an ordinary entry immediately",()=>{
  const state=advanceMarketHypothesisResearch(initialMarketHypothesisResearch(T-60_000),market(),T);
  const h=state.active.find(x=>x.kind==="PULLBACK_AHEAD");
  assert.ok(h);
  h!.confidence=.86;
  const guidance=entryHypothesisGuidance(state,{side:"LONG",score:77,residualZ:.45,residualPersistence:.67,sourceCount:2,dataConfidence:78});
  assert.notEqual(guidance.action,"CONFIRM_MORE");
  assert.equal(guidance.extendedConfirmation,false);
});


test("ordinary opportunities facing a strong opposite hypothesis get more live confirmation, not a hard veto",()=>{
  const state=advanceMarketHypothesisResearch(initialMarketHypothesisResearch(T-60_000),market(),T);
  for(const h of state.active)if(h.kind==="PULLBACK_AHEAD"){h.confidence=.82;h.status="CONFIRMED";h.confirmedAt=T;h.observations=4;h.targetHits=3;h.targetHitStreak=2;}
  const guidance=entryHypothesisGuidance(state,{side:"LONG",score:77,residualZ:.45,residualPersistence:.67,sourceCount:2,dataConfidence:78});
  assert.equal(guidance.action,"CONFIRM_MORE");
  assert.equal(guidance.extendedConfirmation,true);
});

test("forward hypotheses can strengthen protection context but cannot independently command exit",()=>{
  const state=advanceMarketHypothesisResearch(initialMarketHypothesisResearch(T-60_000),market(),T);
  for(const h of state.active)if(h.kind==="PULLBACK_AHEAD"){h.confidence=.80;h.status="CONFIRMED";h.confirmedAt=T;h.observations=4;h.targetHits=3;h.targetHitStreak=2;}
  const g=positionHypothesisGuidance(state,"LONG");
  assert.equal(g.confirmedAdverse,true);
  assert.ok(g.adverseConfidence>=.68);
  assert.match(g.reason,/不能单独强制平仓/);
});

test("hypothesis storage is hard bounded even if malformed oversized state is restored",()=>{
  const base=initialMarketHypothesisResearch(T);
  const active=Array.from({length:80},(_,i)=>({
    id:`a${i}`,key:`ROTATION_AHEAD:MIXED:${i}`,kind:"ROTATION_AHEAD" as const,direction:"MIXED" as const,status:"FORMING" as const,
    confidence:.5,startedAt:T-i,updatedAt:T-i,expiresAt:T+60_000,confirmedAt:null,horizonMinutes:[5,15,30] as [number,number,number],
    families:["FLOW"],evidenceTypes:["FLOW_ABSORBED_OR_STALLED"],thesis:"x",expectedNext:["x"],invalidation:"x"
  }));
  const resolved=Array.from({length:100},(_,i)=>({id:`r${i}`,key:`k${i}`,kind:"ROTATION_AHEAD" as const,direction:"MIXED" as const,
    outcome:"EXPIRED" as const,startedAt:T-i,resolvedAt:T-i,confidence:.5,leadMinutes:null}));
  const memory=Array.from({length:100},(_,i)=>({key:`m${i}`,kind:"ROTATION_AHEAD" as const,direction:"MIXED" as const,observations:1,
    confirmed:0,invalidated:0,expired:1,averageLeadMinutes:null,lastAt:T-i}));
  const restored=normalizeMarketHypothesisResearch({...base,active,resolved,memory},T);
  assert.equal(restored.active.length,MARKET_HYPOTHESIS_ACTIVE_LIMIT);
  assert.equal(restored.resolved.length,MARKET_HYPOTHESIS_RESOLVED_LIMIT);
  assert.equal(restored.memory.length,MARKET_HYPOTHESIS_MEMORY_LIMIT);
});


test("max-bounded hypothesis research remains far below the hot account storage ceiling",async()=>{
  const state=initialForward(T),template=advanceMarketHypothesisResearch(initialMarketHypothesisResearch(T-60_000),market(),T);
  state.hypothesisResearch=normalizeMarketHypothesisResearch({...template,
    active:Array.from({length:MARKET_HYPOTHESIS_ACTIVE_LIMIT},(_,i)=>({...template.active[0]!,id:"max-a-"+i,key:"PULLBACK_AHEAD:SHORT:"+i,updatedAt:T-i})),
    resolved:Array.from({length:MARKET_HYPOTHESIS_RESOLVED_LIMIT},(_,i)=>({id:"max-r-"+i,key:"PULLBACK_AHEAD:SHORT:"+i,kind:"PULLBACK_AHEAD",direction:"SHORT",outcome:"EXPIRED",startedAt:T-i*1000,resolvedAt:T-i,confidence:.7,leadMinutes:null})),
    memory:Array.from({length:MARKET_HYPOTHESIS_MEMORY_LIMIT},(_,i)=>({key:"PULLBACK_AHEAD:SHORT:"+i,kind:"PULLBACK_AHEAD",direction:"SHORT",observations:999999,confirmed:500000,invalidated:300000,expired:199999,averageLeadMinutes:12.5,lastAt:T-i}))},T);
  const write=await prepareForwardWrite(null,state,T,{compact:true});
  assert.ok(write.compression.utilization<.35,`hypothesis memory must stay comfortably bounded, got ${write.compression.utilization}`);
  assert.ok(write.compression.rawBytes<write.compression.accountBudgetBytes);
});


test("realtime loops inside one five-minute bucket do not accumulate fake persistence",()=>{
  const bucket=Math.floor(T/(5*60_000))*(5*60_000);
  const first=advanceMarketHypothesisResearch(initialMarketHypothesisResearch(bucket-60_000),market(),bucket+10_000);
  const h1=first.active.find(x=>x.kind==="PULLBACK_AHEAD");
  assert.ok(h1);
  const second=advanceMarketHypothesisResearch(first,market(),bucket+20_000);
  const h2=second.active.find(x=>x.kind==="PULLBACK_AHEAD");
  assert.equal(h2?.observations,h1?.observations);
  assert.equal(second.lastDecisionBucketAt,first.lastDecisionBucketAt);
});

test("a previously confirmed hypothesis becomes WEAKENING when confidence support disappears",()=>{
  const base=initialMarketHypothesisResearch(T);
  base.active=[{
    id:"old",key:"TREND_EXPANSION_AHEAD:SHORT",kind:"TREND_EXPANSION_AHEAD",direction:"SHORT",status:"CONFIRMED",
    confidence:.002,startedAt:T-30*60_000,updatedAt:T,expiresAt:T+30*60_000,confirmedAt:T-20*60_000,
    observations:8,targetHits:6,targetHitStreak:0,invalidationHitStreak:0,lastTargetAt:T-5*60_000,
    horizonMinutes:[5,15,30],families:["BREADTH","FLOW"],evidenceTypes:["BREADTH_CONTRACTION"],thesis:"x",expectedNext:["x"],invalidation:"x"
  }];
  const restored=normalizeMarketHypothesisResearch(base,T);
  assert.equal(restored.active[0]?.status,"WEAKENING");
  const g=positionHypothesisGuidance(restored,"LONG");
  assert.equal(g.confirmedAdverse,false,"weakening/near-zero-confidence research cannot influence a position as confirmed");
});

test("forward research version 2 starts with completed-bar persistence instead of legacy realtime counters",()=>{
  const state=initialMarketHypothesisResearch(T);
  assert.equal(state.version,"market-hypothesis-research-v2");
  assert.equal(state.lastDecisionBucketAt,0);
  assert.match(state.summary,/完成5m证据块/);
});
