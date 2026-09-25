import test from "node:test";
import assert from "node:assert/strict";
import { advanceStructuralInterrupt, detectOuterRegion, initialStructuralInterruptState,
  structuralInterruptBlockReason, structuralInterruptCandidates, type StructuralInterruptState } from "../lib/forward-structural-interrupt.ts";
import { advanceForward, initialForward, type Trade } from "../lib/forward-relations.ts";

const T=1_790_343_000_000;
const q=(mid:number,at:number)=>({bestBid:mid-.0001,bestAsk:mid+.0001,observedAt:at,fresh:true,entryReady:true});
const region=(symbol:string)=>({id:`rg-${symbol}`,symbol,lower:99.6,upper:100.4,center:100,widthRate:.008,bars:12,quality:70,
  state:"IN_REGION" as const,lastSeenAt:T,atrRate:.004,outerLower:99,outerUpper:101,outerCenter:100,outerWidthRate:.02,outerBars:24,outerQuality:70});

test("outer region must contain the inner range and come from a longer mature window",()=>{
  const rows=Array.from({length:36},(_,i)=>{
    const close=i%2?100.35:99.65,open=i%2?99.72:100.28;
    return{time:1_700_000_000+i*300,open,close,high:i%6===1?101:Math.max(open,close)+.18,
      low:i%6===4?99:Math.min(open,close)-.18,volume:1000};
  });
  const outer=detectOuterRegion(rows,{lower:99.6,upper:100.4,widthRate:.008},.004);
  assert.ok(outer);assert.ok(outer!.bars>=18);assert.ok(outer!.lower<=99.6);assert.ok(outer!.upper>=100.4);
});

test("a synchronized pre-alert vetoes stale opposite entries but creates no structural order by itself",()=>{
  let state=initialStructuralInterruptState();
  const regions=Object.fromEntries(["A_USDT","B_USDT","C_USDT","D_USDT"].map(symbol=>[symbol,region(symbol)]));
  const quotes=Object.fromEntries(Object.keys(regions).map(symbol=>[symbol,q(98.85,T)]));
  state=advanceStructuralInterrupt({state,regions,quotes,now:T});
  assert.equal(state.vetoSide,"SHORT");
  assert.match(structuralInterruptBlockReason(state,"A_USDT","LONG",T)??"",/突变预警/);
  assert.equal(structuralInterruptCandidates({state,regions,quotes,now:T}).length,0);
});

test("an ordinary local displacement can confirm its path without gaining sample-bypass authority",()=>{
  let state=initialStructuralInterruptState();const regions={A_USDT:region("A_USDT")};
  for(const [dt,px] of [[0,98.85],[2000,98.75],[4000,98.70],[6000,98.68]] as const)
    state=advanceStructuralInterrupt({state,regions,quotes:{A_USDT:q(px,T+dt)},now:T+dt});
  assert.equal(state.tracks.A_USDT?.phase,"CONFIRMED");
  assert.equal(structuralInterruptCandidates({state,regions,quotes:{A_USDT:q(98.68,T+6000)},now:T+6000}).length,0,
    "a small single-symbol move must not become a structural bypass");
});

test("a true outer-boundary shock confirms from distinct 2s quotes without waiting for a 1m close",()=>{
  let state=initialStructuralInterruptState();const regions={A_USDT:region("A_USDT")};
  for(const [dt,px] of [[0,98.85],[2000,98.55],[4000,98.25]] as const)
    state=advanceStructuralInterrupt({state,regions,quotes:{A_USDT:q(px,T+dt)},now:T+dt});
  const track=state.tracks.A_USDT;assert.equal(track?.phase,"CONFIRMED");assert.ok((track?.confirmedAt??Infinity)-T<=4000);
  const candidates=structuralInterruptCandidates({state,regions,quotes:{A_USDT:q(98.25,T+4000)},now:T+4000});
  assert.equal(candidates.length,1);assert.equal(candidates[0]!.side,"SHORT");assert.equal(candidates[0]!.marketWide,false);
  assert.match(candidates[0]!.reason,/2秒路径/);
});

function sourceTrade(mode:"RELATION"|"BREAKOUT"="RELATION"):Trade{
  return{id:"ft-existing",symbol:"A_USDT",side:"LONG",openedAt:T-30_000,closedAt:null,status:"OPEN",entryPrice:100,exitPrice:null,
    quantity:1,contracts:1,quantoMultiplier:1,notional:100,leverage:10,margin:10,plannedRisk:2,stopPrice:98,armPrice:102,
    favorable:0,adverse:0,lastPrice:100,lastQuoteAt:T-2_000,entryFee:.07,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,
    exitReason:null,relationFailureBars:0,lastRelationBar:T-30_000,execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,
    firstProfitAt:null,holdScore:70,profitFloorRate:0,expectedHoldMinutes:30,peakPnlRate:0,
    entryContext:{version:"adaptive-ten-entry-v1",capturedAt:T-30_000,timeframe:"5m",side:"LONG",mode,reserve:false,
      reason:"fixture",entryScore:80,directionStrength:80,spaceScore:80,positionScore:80,executionScore:90,remainingSpaceRate:.01,
      pullbackRiskRate:.01,edgeRatio:1,expectedHoldMinutes:30,marketFit:80,regionId:null,portfolioRiskCharge:2},
    forecast:{remainingNetRate:.01,quality:.8,sizingEquity:1000},
    rule:{id:"fr-existing",signature:"fixture",parentId:null,version:1,createdAt:T-60_000,expiresAt:T+1_800_000,status:"EXPERIMENTAL",
      conditions:[],side:"LONG",horizon:30,stopRate:.02,armRate:.01,givebackRate:.004,exitMode:"REACTION_DECAY",
      samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:.01,priorResponse:null,recentResponse:0,standardError:0,
      reason:"fixture",mutation:"CREATE",grammar:"fixture",liveEligible:false,authority:"FORWARD_RELATION",turnTimeframe:"5m"}};
}

test("only a confirmed same-symbol opposite shock may force the old position out",()=>{
  const s=initialForward(T-60_000);s.positions=[sourceTrade()];
  s.structuralInterrupt={version:"forward-structural-interrupt-v1",tracks:{A_USDT:{symbol:"A_USDT",side:"SHORT",phase:"CONFIRMED",boundary:99,
    startedAt:T-6_000,lastAt:T,lastQuoteAt:T,samples:4,outsideSamples:4,firstPrice:98.9,lastPrice:98.5,extremePrice:98.4,
    currentOutsideRate:.005,maxExcursionRate:.006,maxPullbackRate:.0005,hadPullback:false,restartSeen:false,confirmedAt:T-2_000,cooldownUntil:0}},
    marketEvent:null,vetoSide:"SHORT",vetoUntil:T+15_000,vetoBreadth:.25} satisfies StructuralInterruptState;
  const next=advanceForward({state:s,now:T,paths:{},quotes:{A_USDT:q(98.5,T)},contracts:{},allowDataCycle:false}).state;
  assert.equal(next.positions.length,0);assert.equal(next.history[0]?.exitReason,"STRUCTURAL_INTERRUPT_REVERSAL");
});

test("strong-structure entries that never produce feedback fail fast instead of waiting for a full sample horizon",()=>{
  const s=initialForward(T-60_000),t=sourceTrade("BREAKOUT");t.openedAt=T-20_000;t.entryContext!.capturedAt=t.openedAt;s.positions=[t];
  const next=advanceForward({state:s,now:T,paths:{},quotes:{A_USDT:q(99.70,T)},contracts:{},allowDataCycle:false}).state;
  assert.equal(next.positions.length,0);assert.equal(next.history[0]?.exitReason,"FAST_STRUCTURE_FAILURE");
});
