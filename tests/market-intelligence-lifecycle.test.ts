import assert from "node:assert/strict";
import test from "node:test";
import { initialMarketIntelligenceState, type MarketSymbolState } from "../lib/market-intelligence-engine.ts";
import { deriveMarketEvolution, deriveOpportunityLifecycle, deriveProfitLifecycle, extendedEntryConfirmationReady,
  type MarketEvolutionState } from "../lib/market-intelligence-lifecycle.ts";
import type { PositionIntelligenceState } from "../lib/position-intelligence-engine.ts";

const T=1_790_556_000_000;

function marketBase(){
  const m=initialMarketIntelligenceState(T);
  m.narrative.short={...m.narrative.short,bias:"NEUTRAL",score:.05,phase:"BALANCED"};
  m.narrative.transition={...m.narrative.transition,direction:"NEUTRAL",pressure:10,confidence:.4,stage:"STABLE"};
  m.internals={breadth3:.03,breadth12:.02,breadthSlope:.01,dispersion:.85,synchrony:.32,venuePressure:.02,
    residualBalance:0,leaderPersistence:.22,bookImbalance:0,bidLiquidityChange:0,askLiquidityChange:0,spreadRate:.001};
  return m;
}
function symbol(z=2.6,bars=2):MarketSymbolState{
  return{symbol:"SOON_USDT",watchScore:96,regime:"DIVERGENT",stage:"READY",clusterId:"corr:SOON_USDT",correlation:.5,beta:1,
    volatility:.02,dataConfidence:90,actualMove:.08,expectedMove:0,residual:.08,residualZ:z,residualPersistence:1,
    relativeStrength:.5+z/6,longScore:100,shortScore:20,pathLong:.8,pathShort:.2,roomLong:.06,roomShort:.02,
    sourceCount:3,venueAgreement:.9,venuePressure:.4,reasons:[],signalSide:"LONG",signalSince:T-10*60_000,
    signalBars:bars,signalLastBar:T};
}
function position(overrides:Partial<PositionIntelligenceState>={}):PositionIntelligenceState{
  return{version:"position-intelligence-v1",updatedAt:T,decision:"HOLD",phase:"HEALTHY",reviewSince:null,reviewBars:0,lastCompletedBar:T,
    entryAdvantage:90,currentAdvantage:82,advantageChange:-8,remainingSpaceRate:.04,expectedPullbackRate:.01,continuationRatio:4,
    holdValueScore:88,exitValueScore:12,dataConfidence:90,counterfactualNewEntry:true,
    supportFamilies:["RELATIVE","PATH","FLOW"],concernFamilies:[],assessments:[],reasons:[],concerns:[],summary:"",...overrides};
}
const rollingRotational={state:"ROTATIONAL" as const,rotationScore:.76,stabilityScore:.24,
  leadershipRotationShare60:.9,mixedShare60:1,trendingShare60:0};

test("rotational extreme extension is not vetoed but requires stronger live confirmation",()=>{
  const market=marketBase(),evolution=deriveMarketEvolution(market,{rolling:rollingRotational});
  assert.equal(evolution.phase,"ROTATIONAL");
  const lifecycle=deriveOpportunityLifecycle({side:"LONG",symbol:symbol(),thesisBars:2,market:evolution});
  assert.equal(lifecycle.phase,"OVEREXTENDED");
  assert.equal(lifecycle.extendedConfirmation,true);
});

test("the same extreme symbol remains eligible for normal continuation once rotation is becoming trend",()=>{
  const market=marketBase();
  market.narrative.short={...market.narrative.short,bias:"BULLISH",score:.52,phase:"ADVANCING"};
  market.narrative.transition={...market.narrative.transition,direction:"BULLISH",pressure:61,confidence:.82,stage:"CONFIRMED"};
  market.internals={...market.internals!,breadth3:.62,breadthSlope:.34,dispersion:.42,synchrony:.72,leaderPersistence:.82,venuePressure:.38};
  const evolution=deriveMarketEvolution(market,{rolling:rollingRotational});
  assert.ok(evolution.phase==="TREND_FORMING"||evolution.phase==="EXPANDING");
  const lifecycle=deriveOpportunityLifecycle({side:"LONG",symbol:symbol(),thesisBars:2,market:evolution});
  assert.notEqual(lifecycle.phase,"OVEREXTENDED");
  assert.equal(lifecycle.extendedConfirmation,false);
});

test("extended confirmation prevents a five-second chase but accepts sustained response",()=>{
  assert.equal(extendedEntryConfirmationReady({required:true,elapsedMs:6_000,supportSamples:2,currentAdvanceRate:.003,bestAdvanceRate:.003}),false);
  assert.equal(extendedEntryConfirmationReady({required:true,elapsedMs:14_000,supportSamples:3,currentAdvanceRate:.0024,bestAdvanceRate:.003}),true);
  assert.equal(extendedEntryConfirmationReady({required:false,elapsedMs:4_000,supportSamples:2,currentAdvanceRate:.001,bestAdvanceRate:.001}),true);
});

test("healthy trend pullback preserves a large winner instead of forcing profit protection",()=>{
  const market:MarketEvolutionState={version:"market-intelligence-lifecycle-v1",phase:"STABLE_TREND",trendSide:"LONG",
    expansionScore:.82,rotationRisk:.18,reason:""};
  const life=deriveProfitLifecycle({side:"LONG",signedRate:.08,peakFavorableRate:.12,pullbackRiskRate:.02,firstProfit:true,costRate:.0019,
    position:position(),market});
  assert.equal(life.action,"WATCH");
  assert.equal(life.floorRate,0);
});

test("a strong independent runner is allowed to keep running even while the broad market remains rotational",()=>{
  const market:MarketEvolutionState={version:"market-intelligence-lifecycle-v1",phase:"ROTATIONAL",trendSide:"LONG",
    expansionScore:.34,rotationRisk:.76,reason:""};
  const life=deriveProfitLifecycle({side:"LONG",signedRate:.045,peakFavorableRate:.065,pullbackRiskRate:.02,firstProfit:true,costRate:.0019,
    position:position({decision:"HOLD",phase:"HEALTHY",advantageChange:-12,continuationRatio:2.2,
      supportFamilies:["RELATIVE","PATH","FLOW","STRUCTURE"],concernFamilies:[]}),market});
  assert.ok(life.action==="HOLD"||life.action==="WATCH");
  assert.equal(life.floorRate,0);
});

test("rotational profit decay becomes executable protection before profit returns to zero",()=>{
  const market:MarketEvolutionState={version:"market-intelligence-lifecycle-v1",phase:"ROTATIONAL",trendSide:"LONG",
    expansionScore:.3,rotationRisk:.78,reason:""};
  const life=deriveProfitLifecycle({side:"LONG",signedRate:.010,peakFavorableRate:.018,pullbackRiskRate:.02,firstProfit:true,costRate:.0019,
    position:position({decision:"REVIEW",phase:"DECAYING",reviewBars:2,reviewSince:T-600_000,advantageChange:-35,
      supportFamilies:[],concernFamilies:["RELATIVE","FLOW"]}),market});
  assert.equal(life.action,"PROTECT");
  assert.ok(life.floorRate>.0019);
  assert.ok(life.retentionRate>=.55);
});

test("deep giveback plus independent deterioration exits a previously proven trade",()=>{
  const market:MarketEvolutionState={version:"market-intelligence-lifecycle-v1",phase:"DECAYING",trendSide:"LONG",
    expansionScore:.28,rotationRisk:.72,reason:""};
  const life=deriveProfitLifecycle({side:"LONG",signedRate:.001,peakFavorableRate:.020,pullbackRiskRate:.015,firstProfit:true,costRate:.0019,
    position:position({decision:"EXIT",phase:"AT_RISK",advantageChange:-42,supportFamilies:[],concernFamilies:["RELATIVE","PATH","FLOW"]}),market});
  assert.equal(life.action,"EXIT");
  assert.equal(life.phase,"INVALIDATED");
});


test("historical big-winner profiles are dynamically repriced as runners instead of capped by entry estimates",()=>{
  const market:MarketEvolutionState={version:"market-intelligence-lifecycle-v1",phase:"ROTATIONAL",trendSide:"LONG",
    expansionScore:.42,rotationRisk:.64,decisionStable:false,stabilityScore:.36,reason:""};
  const profiles=[
    {name:"FIL",expected:.0191,peak:.1251,current:.101},
    {name:"ZEC",expected:.0191,peak:.0801,current:.062},
    {name:"SUI",expected:.0219,peak:.0723,current:.056},
    {name:"SOON",expected:.0550,peak:.1448,current:.112},
  ];
  for(const p of profiles){
    const life=deriveProfitLifecycle({side:"LONG",signedRate:p.current+.0019,peakFavorableRate:p.peak+.0019,
      pullbackRiskRate:.012,firstProfit:true,costRate:.0019,initialExpectedNetRate:p.expected,
      position:position({decision:"HOLD",reviewBars:0,advantageChange:-10,remainingSpaceRate:.035,continuationRatio:2.1,
        supportFamilies:["RELATIVE","PATH","STRUCTURE"],concernFamilies:[]}),market});
    assert.equal(life.runner,true,p.name+" must be recognized as a runner after materially exceeding its entry estimate");
    assert.equal(life.trajectory,"RUNNER",p.name+" must stay in runner trajectory");
    assert.ok(life.revaluedPotentialRate>p.expected,p.name+" must reprice future potential above the original estimate");
    assert.ok(life.action==="HOLD"||life.action==="WATCH",p.name+" must not receive mechanical profit protection");
    assert.equal(life.floorRate,0,p.name+" must preserve the historical no-lock runner path while healthy");
  }
});

test("one noisy deterioration review cannot protect a healthy winner",()=>{
  const market:MarketEvolutionState={version:"market-intelligence-lifecycle-v1",phase:"TRANSITIONAL",trendSide:"LONG",
    expansionScore:.45,rotationRisk:.55,decisionStable:false,stabilityScore:.42,reason:""};
  const life=deriveProfitLifecycle({side:"LONG",signedRate:.015,peakFavorableRate:.026,pullbackRiskRate:.012,firstProfit:true,
    costRate:.0019,initialExpectedNetRate:.022,
    position:position({decision:"REVIEW",reviewBars:1,reviewSince:T,advantageChange:-26,remainingSpaceRate:.018,
      supportFamilies:["STRUCTURE"],concernFamilies:["FLOW"]}),market,
    forwardResearch:{supportConfidence:0,adverseConfidence:.74,confirmedAdverse:false}});
  assert.notEqual(life.action,"PROTECT");
  assert.notEqual(life.action,"EXIT");
  assert.equal(life.floorRate,0);
});

test("meaningful profit plus persistent thesis deterioration protects before profit can round-trip to a loss",()=>{
  const market:MarketEvolutionState={version:"market-intelligence-lifecycle-v1",phase:"ROTATIONAL",trendSide:"LONG",
    expansionScore:.30,rotationRisk:.76,decisionStable:false,stabilityScore:.24,reason:""};
  const life=deriveProfitLifecycle({side:"LONG",signedRate:.012,peakFavorableRate:.025,pullbackRiskRate:.014,firstProfit:true,
    costRate:.0019,initialExpectedNetRate:.024,
    position:position({decision:"REVIEW",phase:"DECAYING",reviewBars:2,reviewSince:T-600_000,advantageChange:-38,
      remainingSpaceRate:.005,continuationRatio:.7,supportFamilies:[],concernFamilies:["RELATIVE","FLOW","STRUCTURE"]}),market,
    forwardResearch:{supportConfidence:0,adverseConfidence:.76,confirmedAdverse:true}});
  assert.equal(life.runner,false);
  assert.equal(life.trajectory,"DECAYING");
  assert.equal(life.action,"PROTECT");
  assert.ok(life.floorRate>.0019);
  assert.match(life.reason,/浮盈转亏|保护利润|保护已兑现空间/);
});
