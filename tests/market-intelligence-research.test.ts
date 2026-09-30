import test from "node:test";
import assert from "node:assert/strict";
import { initialForward, type Opportunity, type Quote, type Trade } from "../lib/forward-relations.ts";
import { advanceCounterfactualResearch, counterfactualResearchWrites, initialCounterfactualResearch,
  readCounterfactualResearch } from "../lib/market-intelligence-research.ts";

const T=1_800_000_000_000;
const candle=(start:number,open:number,high:number,low:number,close:number)=>({
  time:start/1000,open,high,low,close,volume:1000,
});
const path=[
  candle(T,100,101,99.8,100.5),
  candle(T+300_000,100.5,102,100.2,101.5),
  candle(T+600_000,101.5,103,101.0,102.2),
  candle(T+900_000,102.2,102.6,100.8,101.0),
  candle(T+1_200_000,101.0,101.2,99.4,99.8),
  candle(T+1_500_000,99.8,100.4,99.0,100.1),
  candle(T+1_800_000,100.1,101.3,99.9,101.0),
  candle(T+2_100_000,101.0,101.8,100.7,101.5),
  candle(T+2_400_000,101.5,102.1,101.2,101.8),
  candle(T+2_700_000,101.8,102.0,101.0,101.1),
  candle(T+3_000_000,101.1,101.6,100.6,101.4),
  candle(T+3_300_000,101.4,102.4,101.2,102.0),
];
const quote=(px:number,at:number):Quote=>({bestBid:px-.01,bestAsk:px+.01,observedAt:at,fresh:true,entryReady:true,
  sourceCount:3,disagreementRate:.0002,sourceBreadth:.5,directionalAgreement:.8,medianShortMove:.0004});

function closedTrade():Trade{
  return {
    id:"trade-1",symbol:"BTC_USDT",side:"LONG",openedAt:T-60*60_000,closedAt:T,status:"CLOSED",
    entryPrice:95,exitPrice:100,quantity:1,contracts:1,quantoMultiplier:1,notional:100,leverage:5,margin:20,
    plannedRisk:5,stopPrice:94,armPrice:105,favorable:.06,adverse:.01,lastPrice:100,lastQuoteAt:T,entryFee:.1,exitFee:.1,
    fundingAllowance:0,grossPnl:5,netPnl:4.8,exitReason:"POSITION_VALUE_EXIT",relationFailureBars:0,lastRelationBar:T,
    execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,firstProfitAt:T-50*60_000,holdScore:50,profitFloorRate:0,
    expectedHoldMinutes:180,peakPnlRate:.06,
    rule:{id:"r",signature:"MARKET_INTELLIGENCE:x:RELATIVE",parentId:null,version:1,createdAt:T-60*60_000,
      expiresAt:T+60_000,status:"EXPERIMENTAL",conditions:[],side:"LONG",horizon:180,stopRate:.01,armRate:0,givebackRate:0,
      exitMode:"HORIZON",samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:.02,priorResponse:null,recentResponse:0,
      standardError:0,reason:"test",mutation:"CREATE",grammar:"market-intelligence-v1",liveEligible:false},
    entryContext:{version:"adaptive-ten-entry-v1",capturedAt:T-60*60_000,timeframe:"5m",side:"LONG",mode:"RELATIVE",reserve:false,
      reason:"test",entryScore:80,directionStrength:80,spaceScore:80,positionScore:80,executionScore:80,remainingSpaceRate:.02,
      pullbackRiskRate:.01,edgeRatio:2,expectedHoldMinutes:180,marketFit:70,regionId:null,portfolioRiskCharge:5,
      strategyVersion:"market-intelligence-v1",clusterId:"corr:BTC_USDT",thesisId:"thesis-trade-1",marketNarrativeId:"mi-test",
      thesisSummary:"BTC long",invalidationSummary:"test",entryResidual:.01,entryRelativeStrength:.7,thesisSince:T-70*60_000,thesisBars:3},
  } as unknown as Trade;
}
function rejectedOpportunity():Opportunity{
  return {
    id:"opp-1",symbol:"ETH_USDT",side:"LONG",mode:"REVERSAL",premium:true,reserve:false,score:84,eligible:false,
    completedAt:T,expiresAt:T+30*60_000,price:100,stopPrice:98,targetPrice:104,stopRate:.02,targetRate:.04,
    directionStrength:82,pathEfficiency:75,momentumPersistence:90,positionScore:80,spaceScore:85,executionScore:90,
    grossRemainingSpaceRate:.04,netRemainingSpaceRate:.038,pullbackRiskRate:.012,edgeRatio:3.16,expectedHoldMinutes:180,marketFit:65,
    regionId:null,regionQuality:null,reason:"候选尚未成熟",strategyVersion:"market-intelligence-v1",regime:"DIVERGENT",
    confirmationStage:"OBSERVE",sourceCount:3,disagreementRate:.0002,clusterId:"corr:ETH_USDT",thesisId:"thesis-rejected-1",
    thesisSummary:"ETH long shadow",invalidationSummary:"test",residual:.01,relativeStrength:.7,dataConfidence:88,
    thesisSince:T,thesisBars:1,
  } as unknown as Opportunity;
}

test("post-exit shadow continues measuring the original direction after the trade closes",()=>{
  const forward=initialForward(T);forward.history=[closedTrade()];
  const result=advanceCounterfactualResearch({state:initialCounterfactualResearch(T),forward,now:T+60*60_000,
    paths:{BTC_USDT:path},quotes:{BTC_USDT:quote(102,T+60*60_000)},observeCandidates:false});
  assert.equal(result.state.postExit.length,1);
  const row=result.state.postExit[0]!;
  assert.deepEqual(row.checkpoints.map(x=>x.minutes),[5,15,30,45,60]);
  const at15=row.checkpoints.find(x=>x.minutes===15)!;
  assert.ok(at15.marketAt<=at15.targetAt,"checkpoint must not use a future candle");
  assert.ok(at15.maxFavorableRate>=.02,"post-exit path should retain extra favorable continuation");
  assert.ok(row.maxAdverseRate>0,"post-exit counter-move is recorded too");
});

test("high-quality opportunity that was not executed gets a counterfactual shadow without mutating PAPER",()=>{
  const forward=initialForward(T);forward.opportunities=[rejectedOpportunity()];
  forward.extremumRegime.narrative.id="mi-test";
  const before=structuredClone(forward);
  const first=advanceCounterfactualResearch({state:initialCounterfactualResearch(T),forward,now:T,
    paths:{ETH_USDT:path},quotes:{ETH_USDT:quote(100,T)},observeCandidates:true});
  assert.deepEqual(forward,before,"research must be read-only with respect to trading authority");
  assert.equal(first.state.rejected.length,1);
  assert.match(first.state.rejected[0]!.reason,/FILTERED_NOT_MATURE/);
  const later=advanceCounterfactualResearch({state:first.state,forward,now:T+60*60_000,
    paths:{ETH_USDT:path},quotes:{ETH_USDT:quote(102,T+60*60_000)},observeCandidates:false});
  const row=later.state.rejected[0]!;
  assert.deepEqual(row.checkpoints.map(x=>x.minutes),[5,15,30,45,60]);
  assert.ok(row.checkpoints.find(x=>x.minutes===60)!.netAfterCostRate>0,
    "research can prove a filtered candidate would have remained profitable after modeled cost");
});

test("rejected-opportunity research samples only the best bounded set per cycle",()=>{
  const forward=initialForward(T);forward.extremumRegime.narrative.id="mi-test";
  forward.opportunities=Array.from({length:8},(_,i)=>({...rejectedOpportunity(),id:`opp-${i}`,thesisId:`thesis-${i}`,symbol:`S${i}_USDT`,score:90-i}));
  const quotes=Object.fromEntries(forward.opportunities.map(o=>[o.symbol,quote(100,T)]));
  const result=advanceCounterfactualResearch({state:initialCounterfactualResearch(T),forward,now:T,paths:{},quotes,observeCandidates:true});
  assert.equal(result.state.rejected.length,2);
  assert.equal(result.state.sampling?.admitted,2);
  assert.equal(result.state.sampling?.notAdmittedAttempts,0);
});

test("counterfactual research persists in independent keys and restores without touching ForwardState",async()=>{
  const state=initialCounterfactualResearch(T);
  state.postExit.push({...advanceCounterfactualResearch({state:initialCounterfactualResearch(T),forward:Object.assign(initialForward(T),{history:[closedTrade()]}),
    now:T,paths:{BTC_USDT:path},quotes:{BTC_USDT:quote(100,T)},observeCandidates:false}).state.postExit[0]!});
  const entries=counterfactualResearchWrites(state,true,true),memory=new Map(Object.entries(entries));
  const restored=await readCounterfactualResearch({get:async<T>(key:string)=>memory.get(key) as T|undefined},T+1);
  assert.equal(restored.postExit.length,1);
  assert.equal(restored.postExit[0]!.tradeId,"trade-1");
  assert.equal(restored.rejected.length,0);
});


test("old post-exit trades never backfill checkpoints with a many-hours-later current quote",()=>{
  const forward=initialForward(T),old=closedTrade();old.closedAt=T;old.exitPrice=100;forward.history=[old];
  const now=T+10*60*60_000;
  const result=advanceCounterfactualResearch({state:initialCounterfactualResearch(now),forward,now,
    paths:{BTC_USDT:[]},quotes:{BTC_USDT:quote(135,now)},observeCandidates:false});
  const row=result.state.postExit[0]!;
  assert.equal(row.checkpoints.length,0,"no historical market observation means no synthetic checkpoint");
  assert.deepEqual(row.unavailableCheckpoints,[5,15,30,45,60]);
  assert.equal(row.pathCoverage,"PARTIAL");
  assert.equal(row.completed,true);
});

test("legacy polluted checkpoints are quarantined during restore and excluded from 60m statistics",async()=>{
  const bad={
    id:"post:legacy",tradeId:"legacy",symbol:"BTC_USDT",side:"LONG" as const,openedAt:T-3_600_000,exitAt:T,exitPrice:100,
    exitReason:"POSITION_VALUE_EXIT",actualNetPnl:1,actualGrossPnl:2,notional:100,peakBeforeExitRate:.01,startedAt:T,
    lastObservedAt:T+10*60*60_000,maxFavorableRate:.2,maxAdverseRate:.1,completed:true,
    checkpoints:[{minutes:60,targetAt:T+60*60_000,observedAt:T+10*60*60_000,marketAt:T+10*60*60_000,price:130,
      signedRate:.3,netAfterCostRate:.298,maxFavorableRate:.3,maxAdverseRate:0,stopHit:false}]
  };
  const memory=new Map<string,unknown>([["market-intelligence:research:v1:post-exit",
    {version:"market-intelligence-counterfactual-v1",updatedAt:T+10*60*60_000,items:[bad]}]]);
  const restored=await readCounterfactualResearch({get:async<T>(key:string)=>memory.get(key) as T|undefined},T+10*60*60_000);
  assert.equal(restored.postExit[0]!.checkpoints.length,0);
  assert.deepEqual(restored.postExit[0]!.unavailableCheckpoints,[60]);
  assert.equal(restored.postExit[0]!.pathCoverage,"PARTIAL");
  const view=(await import("../lib/market-intelligence-research.ts")).counterfactualResearchView(restored);
  assert.equal(view.summary.postExitValid60m,0);
  assert.equal(view.summary.postExitUnavailable60m,1);
  assert.equal(view.summary.averagePostExitExtraFavorable60m,null);
});

test("a checkpoint may use a fresh quote only when the quote is actually near the target time",()=>{
  const forward=initialForward(T);forward.history=[closedTrade()];
  const first=advanceCounterfactualResearch({state:initialCounterfactualResearch(T),forward,now:T+5*60_000+30_000,
    paths:{BTC_USDT:[]},quotes:{BTC_USDT:quote(101,T+5*60_000+30_000)},observeCandidates:false});
  const at5=first.state.postExit[0]!.checkpoints.find(x=>x.minutes===5);
  assert.ok(at5);
  assert.equal(first.state.postExit[0]!.pathCoverage,"FULL");
  assert.ok(Math.abs(at5!.marketAt-at5!.targetAt)<=90_000);
  assert.equal(first.state.postExit[0]!.unavailableCheckpoints.length,0);
});
