import test from "node:test";
import assert from "node:assert/strict";
import { initialForward, type Candle, type Quote, type Trade } from "../lib/forward-relations.ts";
import { advanceShadowResearch, initialShadowResearch, shadowResearchView } from "../lib/market-intelligence-shadow-research.ts";

const T=1_800_000_000_000;
const q=(px:number,at:number):Quote=>({bestBid:px-.01,bestAsk:px+.01,observedAt:at,fresh:true,entryReady:true,sourceCount:3,disagreementRate:.0002});
function candles(entryAt:number){
  const out:Candle[]=[];
  for(let i=24;i>=1;i--){
    const at=entryAt-i*300_000,base=96+(24-i)*.15;
    out.push({time:at/1000,open:base,high:base+.25,low:base-.2,close:base+.12,volume:1000});
  }
  out.push({time:entryAt/1000,open:100,high:105,low:99.8,close:104,volume:1000});
  out.push({time:(entryAt+300_000)/1000,open:104,high:104.2,low:99.2,close:99.5,volume:1000});
  return out;
}
function trade(id:string,status:"OPEN"|"CLOSED",elapsedMs:number,peak:number,exitPrice:number|null,netPnl:number|null):Trade{
  const side="LONG" as const,openedAt=T;
  return{id,symbol:id.includes("BNB")?"BNB_USDT":"RARE_USDT",side,openedAt,closedAt:status==="CLOSED"?T+600_000:null,status,
    entryPrice:100,exitPrice,quantity:1,contracts:1,quantoMultiplier:1,notional:100,leverage:10,margin:10,plannedRisk:1,
    stopPrice:95,armPrice:110,favorable:peak,adverse:.01,lastPrice:exitPrice??99.8,lastQuoteAt:T+600_000,entryFee:.07,exitFee:status==="CLOSED"?.07:0,
    fundingAllowance:0,grossPnl:status==="CLOSED"?(exitPrice!-100):null,netPnl,exitReason:status==="CLOSED"?"POSITION_VALUE_EXIT":null,
    relationFailureBars:0,lastRelationBar:T,execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,firstProfitAt:peak>=.0013?T+10_000:null,
    holdScore:40,profitFloorRate:0,expectedHoldMinutes:240,peakPnlRate:peak,
    rule:{id:"r",signature:"MARKET_INTELLIGENCE:x:RELATIVE",parentId:null,version:1,createdAt:T,expiresAt:T+3_600_000,
      status:"EXPERIMENTAL",conditions:[],side,horizon:240,stopRate:.01,armRate:0,givebackRate:0,exitMode:"HORIZON",samples:0,
      trainGroups:0,checkGroups:0,estimatedNetRate:.02,priorResponse:null,recentResponse:0,standardError:0,reason:"test",
      mutation:"CREATE",grammar:"market-intelligence-v1",liveEligible:false},
    entryContext:{version:"adaptive-ten-entry-v1",capturedAt:T,timeframe:"5m",side,mode:"RELATIVE",reserve:false,reason:"test",
      entryScore:92,directionStrength:90,spaceScore:80,positionScore:80,executionScore:100,remainingSpaceRate:.02,pullbackRiskRate:.006,
      edgeRatio:3,expectedHoldMinutes:240,marketFit:60,regionId:null,portfolioRiskCharge:5,strategyVersion:"market-intelligence-v1",
      regime:"DIVERGENT",confirmationStage:"READY",sourceCount:3,disagreementRate:.0002,postEntryState:status==="CLOSED"?"FAILED":"PENDING",
      entryResponse:{version:"market-intelligence-entry-response-v1",startedAt:T-elapsedMs,confirmedAt:T,elapsedMs,samples:8,
        advanceRate:.001,bestAdvanceRate:.0015,maxAdverseRate:0,supportFamilies:["PRICE","THESIS","FLOW"],fastLane:true},
      clusterId:"corr:test",thesisId:`thesis-${id}`,marketNarrativeId:"n",thesisSummary:"test",invalidationSummary:"test",
      entryResidual:.01,entryRelativeStrength:.75,thesisSince:T-600_000,thesisBars:3},
    forecast:{remainingNetRate:.02,quality:.92,sizingEquity:1000}};
}

test("shadow research classifies rotational market geometry and records causal entry location without mutating Forward",()=>{
  const f=initialForward(T-3_600_000);f.extremumRegime.updatedAt=T-60_000;
  f.extremumRegime.narrative.short.phase="BALANCED";f.extremumRegime.narrative.major.bias="NEUTRAL";
  f.extremumRegime.narrative.short.bias="BEARISH";f.extremumRegime.internals={breadth3:-.1,breadth12:.1,breadthSlope:-.2,
    dispersion:.55,synchrony:.39,venuePressure:.2,residualBalance:0,leaderPersistence:.2,bookImbalance:0,bidLiquidityChange:0,askLiquidityChange:0,spreadRate:0};
  const rare=trade("RARE-loss","CLOSED",12_000,.05,99.5,-1);f.history=[rare];
  const before=structuredClone(f),result=advanceShadowResearch({state:initialShadowResearch(T),forward:f,now:T+600_000,
    paths:{RARE_USDT:candles(T)},quotes:{RARE_USDT:q(99.5,T+600_000)}});
  assert.deepEqual(f,before,"shadow research must never mutate trading authority");
  assert.equal(result.state.market[0]?.label,"ROTATIONAL");
  const row=result.state.trades[0]!;
  assert.equal(row.entryGeometryProvenance,"CAUSAL_5M");assert.deepEqual(row.entryLocation.map(x=>x.minutes),[30,60,120]);
  assert.ok(row.entryLocation.every(x=>Number.isFinite(x.sidePosition)&&Number.isFinite(x.pathEfficiency)));
  assert.equal(row.response?.tempo,"IMMEDIATE");assert.equal(row.profit.state,"PROFIT_LOST");
  assert.ok(row.profit.peakFavorableRate>=.05);assert.ok((row.profit.capturedNetVsPeakRatio??0)<0);
});

test("late near-deadline response remains distinct from a fast response and gross-only floating profit is not mislabeled as net opportunity",()=>{
  const f=initialForward(T-3_600_000);f.extremumRegime.updatedAt=T-60_000;f.extremumRegime.narrative.short.phase="BALANCED";
  f.extremumRegime.internals={breadth3:0,breadth12:0,breadthSlope:0,dispersion:.5,synchrony:.4,venuePressure:0,residualBalance:0,leaderPersistence:.5};
  const bnb=trade("BNB-open","OPEN",148_000,.00013,null,null);f.positions=[bnb];
  const quiet=candles(T).slice(0,24);quiet.push({time:T/1000,open:100,high:100.01,low:99.8,close:99.9,volume:1000});
  const result=advanceShadowResearch({state:initialShadowResearch(T),forward:f,now:T+300_000,
    paths:{BNB_USDT:quiet},quotes:{BNB_USDT:q(99.8,T+300_000)}});
  const row=result.state.trades[0]!;
  assert.equal(row.response?.tempo,"LATE");assert.ok((row.response?.elapsedFraction??0)>.8);
  assert.equal(row.profit.state,"GROSS_ONLY");assert.ok(row.profit.modeledCurrentNetRate<0);
});

test("shadow view exposes conversion and response summaries without creating trading instructions",()=>{
  const f=initialForward(T-3_600_000),rare=trade("RARE-loss","CLOSED",12_000,.05,99.5,-1),bnb=trade("BNB-open","OPEN",148_000,.00013,null,null);
  f.history=[rare];f.positions=[bnb];f.extremumRegime.updatedAt=T-60_000;f.extremumRegime.narrative.short.phase="BALANCED";
  f.extremumRegime.internals={breadth3:0,breadth12:0,breadthSlope:0,dispersion:.6,synchrony:.3,venuePressure:0,residualBalance:0,leaderPersistence:.3};
  const state=advanceShadowResearch({state:initialShadowResearch(T),forward:f,now:T+600_000,
    paths:{RARE_USDT:candles(T),BNB_USDT:candles(T)},quotes:{RARE_USDT:q(99.5,T+600_000),BNB_USDT:q(99.8,T+600_000)}}).state,
    view=shadowResearchView(state);
  assert.equal(view.summary.profitLostAfterCostCoverage,1);assert.equal(view.summary.lateResponses,1);
  assert.match(view.purpose,/不参与任何交易决策/);
});
