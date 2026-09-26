import test from "node:test";
import assert from "node:assert/strict";
import {buildExtremumRegime,extremumExitDecision,EXTREMUM_REGIME_VERSION,type ExtremumSymbolState} from "../lib/extremum-regime-engine.ts";
import {advanceForward,fillForwardPortfolio,forwardEquity,initialForward,type Candle,type Opportunity,type Quote} from "../lib/forward-relations.ts";
import {PREDICTIVE_PATH_VERSION} from "../lib/predictive-path-types.ts";
import {forwardMirrorSources} from "../lib/live-parity.ts";
import {selectAnchorOpportunityUniverse} from "../lib/multi-turn-universe.ts";

const START=Date.parse("2026-09-26T00:00:00Z")/1000;
function trend(direction:"UP"|"DOWN",lastImpulse=0){
  const out:Candle[]=[];let price=100;
  for(let i=0;i<40;i++){
    const step=i===39&&lastImpulse?lastImpulse:(direction==="UP"?.0025:-.0025),open=price,close=open*(1+step);
    out.push({time:START+i*300,open,close,high:Math.max(open,close)*1.00015,low:Math.min(open,close)*.99985,volume:1000+i*3});
    price=close;
  }
  return out;
}
function minuteRestart(side:"LONG"|"SHORT",center:number,pullback=true){
  const out:Candle[]=[];let price=center*(side==="LONG"?.998:1.002);
  for(let i=0;i<9;i++){
    const step=side==="LONG"?.00022:-.00022,open=price,close=open*(1+step);
    out.push({time:START+40*300-12*60+i*60,open,close,high:Math.max(open,close)*1.00008,low:Math.min(open,close)*.99992,volume:100+i});
    price=close;
  }
  const moves=side==="LONG"
    ?(pullback?[-.00125,-.00025,.00175]:[.00025,.00025,.001])
    :(pullback?[.00125,.00025,-.00175]:[-.00025,-.00025,-.001]);
  for(let j=0;j<3;j++){
    const open=price,close=open*(1+moves[j]!);
    out.push({time:START+40*300-3*60+j*60,open,close,high:Math.max(open,close)*1.00008,low:Math.min(open,close)*.99992,volume:130+j});
    price=close;
  }
  return out;
}
function quote(price:number,side:"UP"|"DOWN"):Quote{
  const now=(START+40*300)*1000+1000;
  return{bestBid:price*.99995,bestAsk:price*1.00005,observedAt:now,fresh:true,entryReady:true,sourceCount:4,disagreementRate:.0002,
    sourceBreadth:side==="UP"?1:-1,directionalAgreement:1,medianShortMove:side==="UP"?.001:-.001};
}
function state(partial:Partial<ExtremumSymbolState>):ExtremumSymbolState{
  return{symbol:"SOL_USDT",updatedAt:1,regime:"SWING",priorRegime:null,trendBias:null,topPressure:20,bottomPressure:20,upSurvival:50,downSurvival:50,
    pathEfficiency:.5,atrRate:.003,normalizedMove:1,pullbackRate:0,microPullbackRate:0,recoveryScore:.5,followThrough:.5,stage:"WATCH",
    candidateSide:null,candidateExtreme:null,breakLevel:null,sourceCount:4,disagreementRate:.0002,sourceQuality:1,momentumOverride:false,
    watchScore:50,reason:"fixture",nextAction:"wait",...partial};
}

test("clean one-way trends stay directionally asymmetric instead of fading every local extreme",()=>{
  for(const side of ["UP","DOWN"] as const){
    const five=trend(side),last=five.at(-1)!,now=(last.time+300)*1000+1000,
      result=buildExtremumRegime({paths:{SOL_USDT:five},quotes:{SOL_USDT:quote(last.close,side)},now});
    const s=result.state.symbols.SOL_USDT;assert.ok(s);
    assert.equal(s!.regime,side==="UP"?"TREND_UP":"TREND_DOWN");
    assert.equal(s!.trendBias,side);
    assert.equal(result.opportunities.some(o=>o.side===(side==="UP"?"SHORT":"LONG")),false);
  }
});

test("trend mode actively re-enters after a shallow 1m pullback restart",()=>{
  const five=trend("UP"),last=five.at(-1)!,now=(last.time+300)*1000+1000,
    minute=minuteRestart("LONG",last.close,true),
    result=buildExtremumRegime({paths:{SOL_USDT:five},minutePaths:{SOL_USDT:minute},quotes:{SOL_USDT:quote(last.close,"UP")},now}),
    s=result.state.symbols.SOL_USDT;
  assert.ok(s);assert.equal(s!.regime,"TREND_UP");assert.ok(s!.microPullbackRate>0);
  assert.ok(result.opportunities.some(o=>o.mode==="TREND_PULLBACK"&&o.side==="LONG"),JSON.stringify(result.opportunities));
  assert.equal(result.opportunities.some(o=>o.side==="SHORT"),false);
});

test("vertical expansion uses momentum override and attacks with the trend rather than guessing a top",()=>{
  const five=trend("UP",.014),last=five.at(-1)!,now=(last.time+300)*1000+1000,
    minute=minuteRestart("LONG",last.close,false),
    result=buildExtremumRegime({paths:{SOL_USDT:five},minutePaths:{SOL_USDT:minute},quotes:{SOL_USDT:quote(last.close,"UP")},now}),
    s=result.state.symbols.SOL_USDT;
  assert.ok(s);assert.equal(s!.momentumOverride,true);assert.equal(s!.stage,"IMPULSE");
  assert.ok(result.opportunities.some(o=>o.mode==="IMPULSE"&&o.side==="LONG"),JSON.stringify(result.opportunities));
  assert.equal(result.opportunities.some(o=>o.side==="SHORT"),false);
});

test("weakening preserves the parent trend direction instead of treating every WEAKENING state as upward",()=>{
  const five=trend("DOWN"),last=five.at(-1)!,now=(last.time+300)*1000+1000,
    first=buildExtremumRegime({paths:{SOL_USDT:five},quotes:{SOL_USDT:quote(last.close,"DOWN")},now}),
    down=first.state.symbols.SOL_USDT;assert.ok(down);
  const prior={...down!,regime:"WEAKENING" as const,trendBias:"DOWN" as const};
  const next=buildExtremumRegime({paths:{SOL_USDT:five},quotes:{SOL_USDT:quote(last.close,"DOWN")},previous:{version:EXTREMUM_REGIME_VERSION,updatedAt:now-1000,symbols:{SOL_USDT:prior}},now});
  assert.equal(next.state.symbols.SOL_USDT?.trendBias,"DOWN");
  assert.notEqual(next.state.symbols.SOL_USDT?.regime,"TREND_UP");
});

test("a local top in a healthy uptrend protects profit but does not itself authorize trend reversal",()=>{
  const decision=extremumExitDecision({side:"LONG",mode:"TREND_PULLBACK",ageMin:12,signedRate:.01,peakFavorableRate:.018,firstProfit:true,
    stopRate:.01,stopped:false,profitFloorRate:0,expectedHoldMinutes:30,maxHoldMinutes:60,
    state:state({regime:"TREND_UP",trendBias:"UP",topPressure:90,upSurvival:91,downSurvival:12,stage:"READY",candidateSide:"SHORT"})});
  assert.equal(decision.reason,null);assert.equal(decision.trendDeath,false);assert.ok(decision.floorCandidate>.01);
});

test("trend death requires transition plus opposite structure confirmation",()=>{
  const decision=extremumExitDecision({side:"LONG",mode:"TREND_PULLBACK",ageMin:12,signedRate:.002,peakFavorableRate:.012,firstProfit:true,
    stopRate:.01,stopped:false,profitFloorRate:0,expectedHoldMinutes:30,maxHoldMinutes:60,
    state:state({regime:"TRANSITION",trendBias:"UP",topPressure:86,upSurvival:30,downSurvival:70,stage:"READY",candidateSide:"SHORT"})});
  assert.equal(decision.reason,"TREND_DEATH");assert.equal(decision.trendDeath,true);
});

test("entry that fails to produce fast positive feedback exits before the full structural stop",()=>{
  const decision=extremumExitDecision({side:"LONG",mode:"TREND_PULLBACK",ageMin:4,signedRate:-.003,peakFavorableRate:0,firstProfit:false,
    stopRate:.012,stopped:false,profitFloorRate:0,expectedHoldMinutes:30,maxHoldMinutes:60,
    state:state({regime:"WEAKENING",trendBias:"UP",topPressure:76,upSurvival:44,stage:"STRUCTURE_BREAK",candidateSide:"SHORT"})});
  assert.equal(decision.reason,"ENTRY_FEEDBACK_FAILED");assert.equal(decision.feedbackFailed,true);
});

test("SWING uses the confirmed opposite extremum as an exit event",()=>{
  const decision=extremumExitDecision({side:"LONG",mode:"SWING",ageMin:8,signedRate:.004,peakFavorableRate:.009,firstProfit:true,
    stopRate:.009,stopped:false,profitFloorRate:0,expectedHoldMinutes:30,maxHoldMinutes:60,
    state:state({regime:"SWING",topPressure:78,upSurvival:48,stage:"READY",candidateSide:"SHORT"})});
  assert.equal(decision.reason,"OPPOSITE_EXTREMUM");assert.equal(decision.swingOpposite,true);
});


test("30-market selector balances Gate liquidity, usable movement and multi-source data quality while preserving core anchors",()=>{
  const row=(symbol:string,volume:number,range:number,move:number,sources:number,disagreement:number)=>({symbol,last:100,high24h:100*(1+range/2),low24h:100*(1-range/2),change24hRate:move,
    volume24hUsd:volume,executionVolume24hUsd:volume,fundingRate:0,openInterest:1,sourceCount:sources,sourceDisagreementRate:disagreement});
  const rows=[
    row("BTC_USDT",80_000_000,.018,.006,4,.0003),
    row("STATIC_USDT",900_000_000,.012,.001,4,.0002),
    row("MOVE_USDT",45_000_000,.080,.045,4,.0004),
    row("NOISY_USDT",60_000_000,.090,.050,1,.020),
  ];
  const picked=selectAnchorOpportunityUniverse({rows,limit:3,coreSymbols:["BTC_USDT"],explorationSlots:0,liquiditySlots:0});
  assert.equal(picked[0]?.symbol,"BTC_USDT");
  assert.ok(picked.some(x=>x.symbol==="MOVE_USDT"),JSON.stringify(picked));
  const moving=picked.find(x=>x.symbol==="MOVE_USDT"),staticRow=picked.find(x=>x.symbol==="STATIC_USDT"),
    noisy=picked.find(x=>x.symbol==="NOISY_USDT");
  assert.ok(moving);assert.ok(staticRow);assert.ok(moving!.activityScore>staticRow!.activityScore);
  assert.equal(noisy,undefined,"poor one-source/high-disagreement market should lose the final activity slot");
});


test("new causal predictive strategy emits a complete source trade consumable by the unchanged LIVE mirror",()=>{
  const now=(START+40*300)*1000+1000,q=quote(100,"UP"),start=initialForward(now-60_000),
    forecast={version:PREDICTIVE_PATH_VERSION,symbol:"SOL_USDT",at:now,lastBarTime:now-1000,
      upProbability:{m15:.62,m30:.66,m60:.70,m120:.72},expectedReturn:{m15:.004,m30:.007,m60:.016,m120:.024},
      long:{mfe60:.027,mae60:.006,targetBeforeRisk60:.68,entryRegret10:.001,netEv60:.011},
      short:{mfe60:.006,mae60:.027,targetBeforeRisk60:.25,entryRegret10:.004,netEv60:-.012},
      crossVenue:{sourceCount:4,agreement:.9,breadth:.8,disagreementRate:.0002},
      evidence:{price:.7,technical:.6,derivatives:.45,liquidation:.2,multiVenue:.75,context:.55,persistence:.82,uncertainty:.8},
      rawSide:"LONG" as const,stableSide:"LONG" as const,directionProbability:.70,entryQuality:.82,enterNow:true,waitReason:null,confidence:.78},
    opportunity:Opportunity={id:"causal-fixture",symbol:"SOL_USDT",side:"LONG",mode:"PREDICTIVE",premium:true,reserve:false,score:78,eligible:true,
      completedAt:now,expiresAt:now+300_000,price:100,stopPrice:99.2,targetPrice:102,stopRate:.008,targetRate:.02,directionStrength:70,
      pathEfficiency:.7,momentumPersistence:72,positionScore:85,spaceScore:80,executionScore:90,grossRemainingSpaceRate:.016,
      netRemainingSpaceRate:.014,pullbackRiskRate:.008,edgeRatio:1.75,expectedHoldMinutes:60,marketFit:78,regionId:null,regionQuality:null,
      reason:"predictive source contract fixture",strategyVersion:PREDICTIVE_PATH_VERSION,sourceCount:4,disagreementRate:.0002,predictiveForecast:forecast};
  start.opportunities=[opportunity];
  const opened=fillForwardPortfolio(start,{SOL_USDT:q},{SOL_USDT:{quantoMultiplier:.01,leverageMax:20,maintenanceRate:.005,minContracts:1}},now,1000,false);
  assert.equal(opened,1,JSON.stringify(start.entryDiagnostics));assert.equal(start.positions.length,1);
  const trade=start.positions[0]!;
  assert.equal(trade.entryContext?.strategyVersion,PREDICTIVE_PATH_VERSION);
  assert.equal(trade.exitControl?.policy,PREDICTIVE_PATH_VERSION);
  const equity=forwardEquity(start,{SOL_USDT:q},now).equity,mirror=forwardMirrorSources(start,equity);
  assert.equal(mirror.SOL_USDT?.id,trade.id);
  assert.equal(mirror.SOL_USDT?.forwardSource?.entryContext?.strategyVersion,PREDICTIVE_PATH_VERSION);
  assert.equal(mirror.SOL_USDT?.forwardSource?.stopPrice,trade.stopPrice);
});
