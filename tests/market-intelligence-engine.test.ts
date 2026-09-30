import test from "node:test";
import assert from "node:assert/strict";
import {buildMarketIntelligence,initialMarketIntelligenceState,MARKET_INTELLIGENCE_VERSION} from "../lib/market-intelligence-engine.ts";
import {evaluatePositionIntelligence} from "../lib/position-intelligence-engine.ts";
import {entryResponseWindowMs,evaluateEntryResponse} from "../lib/market-intelligence-entry-response.ts";
import {advanceForward,environmentDecayProfitFloor,extremeResidualConfirmationProfile,fillForwardPortfolio,initialForward,normalizeForward,
  entryLocationDecision,resetForwardAccountPreservingLearning,stableEntryLocationDecision,stableEntryThesisProfile} from "../lib/forward-relations.ts";
import {deriveEnvironmentOutlook,deriveFastEnvironmentSignal,environmentModeFit,environmentPerformanceFactor,environmentProbeRetestDecision,initialEnvironmentPerformanceState,
  normalizeEnvironmentPerformanceState,recordEnvironmentOutcome,routeEnvironmentOpportunity} from "../lib/market-intelligence-environment-router.ts";

const T=2_000_000_000_000;
function candles(start:number,step:number,vol=.002){
  const out=[] as Array<{time:number;open:number;high:number;low:number;close:number;volume:number}>;
  let px=start;
  for(let i=0;i<72;i++){const wave=Math.sin(i/5)*vol*.15,move=step+wave,open=px,close=px*(1+move);out.push({
    time:(T-(72-i)*300_000)/1000,open,close,high:Math.max(open,close)*(1+vol*.25),low:Math.min(open,close)*(1-vol*.25),volume:1000+i});px=close;}
  return out;
}
function q(px:number,move=.0002){return{bestBid:px*.99995,bestAsk:px*1.00005,observedAt:T,fresh:true,entryReady:true,sourceCount:4,
  disagreementRate:.00008,sourceBreadth:move>0?.75:-.75,directionalAgreement:.9,medianShortMove:move};}
function daily(start:number,step:number){
  const out=[] as Array<{time:number;open:number;high:number;low:number;close:number;volume:number}>;let px=start;
  for(let i=0;i<90;i++){const open=px,close=px*(1+step);out.push({time:(T-(90-i)*86_400_000)/1000,open,close,
    high:Math.max(open,close)*1.01,low:Math.min(open,close)*.99,volume:10_000+i});px=close;}return out;
}

test("Market Intelligence keeps one same-direction primary inside a highly correlated group",()=>{
  const btc=candles(100,.0012),eth=candles(100,.00155),sol=candles(100,.0010);
  // Make ETH persistently outperform the common market near the end.
  for(let i=58;i<eth.length;i++){eth[i]!.open*=1+(i-57)*.0006;eth[i]!.close*=1+(i-57)*.0006;eth[i]!.high*=1+(i-57)*.0006;eth[i]!.low*=1+(i-57)*.0006;}
  const paths={BTC_USDT:btc,ETH_USDT:eth,SOL_USDT:sol},quotes={BTC_USDT:q(btc.at(-1)!.close),ETH_USDT:q(eth.at(-1)!.close),SOL_USDT:q(sol.at(-1)!.close)};
  const r=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-300_000),now:T});
  assert.equal(r.state.version,MARKET_INTELLIGENCE_VERSION);
  assert.ok(r.state.clusters.some(c=>c.members.length>=2));
  const eligible=r.opportunities.filter(o=>o.eligible&&o.side==="LONG");
  const keys=eligible.map(o=>o.clusterId+":"+o.side);
  assert.equal(new Set(keys).size,keys.length);
  assert.ok(r.state.symbols.ETH_USDT!.residual>r.state.symbols.BTC_USDT!.residual);
});

test("market narrative is stateful and does not mechanically flip on one weaker refresh",()=>{
  const up={BTC_USDT:candles(100,.0015),ETH_USDT:candles(100,.0014),SOL_USDT:candles(100,.0016)};
  const quotes=Object.fromEntries(Object.entries(up).map(([s,v])=>[s,q(v.at(-1)!.close,.00025)]));
  const first=buildMarketIntelligence({paths:up,quotes,previous:initialMarketIntelligenceState(T-600_000),now:T-300_000});
  const mild={BTC_USDT:candles(100,-.00018),ETH_USDT:candles(100,-.00012),SOL_USDT:candles(100,-.0002)};
  const mildQuotes=Object.fromEntries(Object.entries(mild).map(([s,v])=>[s,q(v.at(-1)!.close,-.0001)]));
  const second=buildMarketIntelligence({paths:mild,quotes:mildQuotes,previous:first.state,now:T});
  assert.ok(second.state.narrative.major.score>-.22);
  assert.ok(second.state.history.length>=1);
});

test("Position Intelligence does not let one detail or a market flip kill an independent strong trade",()=>{
  const strong={symbol:"ETH_USDT",watchScore:84,regime:"DIVERGENT" as const,stage:"READY" as const,clusterId:"corr:ETH_USDT",
    correlation:.7,beta:1.1,volatility:.003,dataConfidence:92,actualMove:.008,expectedMove:.002,residual:.006,residualZ:1.1,
    residualPersistence:1,relativeStrength:.72,longScore:84,shortScore:22,pathLong:.72,pathShort:.28,roomLong:.018,roomShort:.008,
    sourceCount:3,venueAgreement:.9,venuePressure:.35,reasons:[],signalSide:"LONG" as const,signalSince:T-900_000,signalBars:4,signalLastBar:T-300_000};
  const bearishMarket={...initialMarketIntelligenceState(T).narrative,
    major:{...initialMarketIntelligenceState(T).narrative.major,bias:"BEARISH" as const,score:-.5},
    short:{...initialMarketIntelligenceState(T).narrative.short,bias:"BEARISH" as const,score:-.45},
    transition:{...initialMarketIntelligenceState(T).narrative.transition,direction:"BEARISH" as const,pressure:60}};
  const p=evaluatePositionIntelligence({now:T,side:"LONG",signedRate:.012,peakFavorableRate:.014,ageMin:55,firstProfit:true,
    expectedHoldMinutes:220,stopRate:.009,entryScore:86,entryResidual:.0055,entryRelativeStrength:.70,entryRemainingSpaceRate:.025,
    state:strong,narrative:bearishMarket,quote:{sourceCount:3,directionalAgreement:.9,sourceBreadth:.6,medianShortMove:.0003,
      bookImbalance:.20,disagreementRate:.0002},minutePath:candles(100,.00035).slice(-10),marketStateAgeMs:30_000});
  assert.equal(p.decision,"HOLD");
  assert.ok(p.assessments.find(x=>x.family==="MARKET")?.stance==="CONCERN");
  assert.ok(!p.concernFamilies.includes("MARKET"),"market context can never count as a self-exit family");
});

test("ZEC-like high-quality reversal can confirm on the 2s lane without waiting for another 5m close",()=>{
  const state={symbol:"ZEC_USDT",watchScore:91,regime:"DIVERGENT" as const,stage:"READY" as const,clusterId:"corr:ZEC_USDT",
    correlation:.6,beta:1,volatility:.004,dataConfidence:94,actualMove:.01,expectedMove:.002,residual:.008,residualZ:1.2,
    residualPersistence:1,relativeStrength:.78,longScore:91,shortScore:20,pathLong:.72,pathShort:.28,roomLong:.025,roomShort:.008,
    sourceCount:3,venueAgreement:.95,venuePressure:.35,reasons:[],signalSide:"LONG" as const,signalSince:T-600_000,signalBars:2,signalLastBar:T-300_000};
  const quote={bestBid:100.12,bestAsk:100.13,observedAt:T+24_000,fresh:true,entryReady:true,sourceCount:3,disagreementRate:.0003,
    sourceBreadth:.7,directionalAgreement:.9,medianShortMove:.0006,bookImbalance:.2,bidLiquidityChange:.14,askLiquidityChange:-.04,liquiditySourceCount:3};
  const profile=entryResponseWindowMs({score:90.3,edgeRatio:3.43,sourceCount:3,disagreementRate:.0003,mode:"REVERSAL"});
  assert.equal(profile.fastLane,true);assert.equal(profile.windowMs,180_000);
  const memory={startedAt:T,deadlineAt:T+profile.windowMs,initialPrice:100,samples:1,bestAdvanceRate:0,maxAdverseRate:0,supportSamples:0,oppositionSamples:0};
  const first=evaluateEntryResponse({now:T+24_000,side:"LONG",score:90.3,edgeRatio:3.43,pullbackRiskRate:.0056,stopRate:.0066,
    sourceCount:3,disagreementRate:.0003,mode:"REVERSAL",price:100.11,memory,state,quote});
  assert.equal(first.action,"WAIT");assert.equal(first.supportSamples,1);
  const second=evaluateEntryResponse({now:T+26_000,side:"LONG",score:90.3,edgeRatio:3.43,pullbackRiskRate:.0056,stopRate:.0066,
    sourceCount:3,disagreementRate:.0003,mode:"REVERSAL",price:100.13,
    memory:{...memory,samples:2,bestAdvanceRate:first.bestAdvanceRate,maxAdverseRate:first.maxAdverseRate,
      supportSamples:first.supportSamples,oppositionSamples:first.oppositionSamples},
    state,quote:{...quote,observedAt:T+26_000}});
  assert.equal(second.action,"PASS");assert.ok(second.supportFamilies.includes("PRICE"));assert.ok(second.supportFamilies.includes("THESIS"));
});

test("RELATIVE opportunities cannot use fastLane while continuation keeps the large-winner path",()=>{
  const common={score:96,edgeRatio:2.8,sourceCount:5,disagreementRate:.0004};
  const relative=entryResponseWindowMs({...common,mode:"RELATIVE"});
  const continuation=entryResponseWindowMs({...common,mode:"CONTINUATION"});
  assert.equal(relative.fastLane,false);
  assert.equal(relative.windowMs,180_000,"tightening RELATIVE confirmation must not shorten its existing observation window");
  assert.equal(continuation.fastLane,true);
  assert.equal(continuation.windowMs,180_000);
});

test("a transient favorable tick cannot pass entry response while cross-venue flow opposes the thesis",()=>{
  const state={symbol:"LINK_USDT",watchScore:88,regime:"DIVERGENT" as const,stage:"READY" as const,clusterId:"corr:LINK_USDT",
    correlation:.6,beta:1,volatility:.003,dataConfidence:92,actualMove:.008,expectedMove:.002,residual:.006,residualZ:1,
    residualPersistence:1,relativeStrength:.72,longScore:88,shortScore:25,pathLong:.7,pathShort:.3,roomLong:.018,roomShort:.008,
    sourceCount:3,venueAgreement:.9,venuePressure:-.55,reasons:[],signalSide:"LONG" as const,signalSince:T-600_000,signalBars:4,signalLastBar:T-300_000};
  const quote={bestBid:100.17,bestAsk:100.18,observedAt:T+30_000,fresh:true,entryReady:true,sourceCount:3,disagreementRate:.0004,
    sourceBreadth:-.8,directionalAgreement:.9,medianShortMove:-.001,bookImbalance:-.3,bidLiquidityChange:-.12,askLiquidityChange:.14,liquiditySourceCount:3};
  const memory={startedAt:T,deadlineAt:T+180_000,initialPrice:100,samples:2,bestAdvanceRate:.0018,maxAdverseRate:0,supportSamples:0,oppositionSamples:0};
  const result=evaluateEntryResponse({now:T+30_000,side:"LONG",score:87,edgeRatio:2.1,pullbackRiskRate:.005,stopRate:.007,
    sourceCount:3,disagreementRate:.0004,price:100.18,memory,state,quote});
  assert.equal(result.action,"WAIT");assert.ok(result.concernFamilies.includes("FLOW"));
  const expired=evaluateEntryResponse({now:T+180_001,side:"LONG",score:87,edgeRatio:2.1,pullbackRiskRate:.005,stopRate:.007,
    sourceCount:3,disagreementRate:.0004,price:100.18,memory:{...memory,deadlineAt:T+180_000},state,quote:{...quote,observedAt:T+180_001}});
  assert.equal(expired.action,"CANCEL");
});

test("response-gated unconfirmed trades cannot use a huge Remaining Space estimate to override converged failure evidence",()=>{
  const broken={symbol:"GRAM_USDT",watchScore:35,regime:"TRANSITION" as const,stage:"OBSERVE" as const,clusterId:"corr:GRAM_USDT",
    correlation:.7,beta:1,volatility:.004,dataConfidence:94,actualMove:-.01,expectedMove:.001,residual:-.009,residualZ:-1.3,
    residualPersistence:1,relativeStrength:.25,longScore:24,shortScore:82,pathLong:.22,pathShort:.78,roomLong:.035,roomShort:.02,
    sourceCount:3,venueAgreement:1,venuePressure:-.7,reasons:[],signalSide:"SHORT" as const,signalSince:T-300_000,signalBars:2,signalLastBar:T-300_000};
  const quote={sourceCount:3,directionalAgreement:1,sourceBreadth:-1,medianShortMove:-.001,bookImbalance:-.35,
    bidLiquidityChange:-.15,askLiquidityChange:.15,liquiditySourceCount:3,disagreementRate:.0002};
  const minute=candles(100,-.0008).slice(-10);
  const first=evaluatePositionIntelligence({now:T,side:"LONG",signedRate:-.001,peakFavorableRate:0,ageMin:8,firstProfit:false,
    expectedHoldMinutes:240,stopRate:.012,entryScore:92,entryResidual:.012,entryRelativeStrength:.8,entryRemainingSpaceRate:.04,
    state:broken,quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true});
  assert.equal(first.decision,"REVIEW");assert.ok(first.continuationRatio>2.5);
  const second=evaluatePositionIntelligence({now:T+300_000,side:"LONG",signedRate:-.0015,peakFavorableRate:0,ageMin:13,firstProfit:false,
    expectedHoldMinutes:240,stopRate:.012,entryScore:92,entryResidual:.012,entryRelativeStrength:.8,entryRemainingSpaceRate:.04,
    state:{...broken,signalLastBar:T},quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true,previous:first});
  assert.equal(second.reviewBars,2);assert.equal(second.decision,"EXIT");
});

test("severe 30m chase is rejected without blocking the extended shape seen in a large winner",()=>{
  const late=entryLocationDecision({sidePosition30:1.6346,breakoutRate30:.00672,confirmationAdvanceRate:.00215});
  assert.equal(late.action,"WAIT_RETEST");
  const largeWinnerShape=entryLocationDecision({sidePosition30:1.1821,breakoutRate30:.00411,confirmationAdvanceRate:.00246});
  assert.equal(largeWinnerShape.action,"DIRECT");
  const strongContinuation=entryLocationDecision({sidePosition30:1.55,breakoutRate30:.006,confirmationAdvanceRate:.0032});
  assert.equal(strongContinuation.action,"DIRECT","strong fresh continuation may justify an otherwise extended breakout");
});

test("fresh entry can exit immediately only when its own evidence fully falsifies the location",()=>{
  const broken={symbol:"TRB_USDT",watchScore:30,regime:"TRANSITION" as const,stage:"OBSERVE" as const,clusterId:"corr:TRB_USDT",
    correlation:.6,beta:1,volatility:.004,dataConfidence:96,actualMove:-.012,expectedMove:.001,residual:-.010,residualZ:-1.4,
    residualPersistence:1,relativeStrength:.20,longScore:20,shortScore:86,pathLong:.18,pathShort:.82,roomLong:.025,roomShort:.02,
    sourceCount:4,venueAgreement:1,venuePressure:-.8,reasons:[],signalSide:"SHORT" as const,signalSince:T-300_000,signalBars:2,signalLastBar:T-300_000};
  const quote={sourceCount:4,directionalAgreement:1,sourceBreadth:-1,medianShortMove:-.0015,bookImbalance:-.4,
    bidLiquidityChange:-.20,askLiquidityChange:.18,liquiditySourceCount:3,disagreementRate:.0002};
  const minute=candles(100,-.0010).slice(-10);
  const failed=evaluatePositionIntelligence({now:T,side:"LONG",signedRate:-.006,peakFavorableRate:.0002,ageMin:.4,firstProfit:false,
    expectedHoldMinutes:240,stopRate:.012,entryScore:93,entryResidual:.012,entryRelativeStrength:.82,entryRemainingSpaceRate:.04,
    state:broken,quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true});
  assert.equal(failed.reviewBars,1,"fast falsification must not depend on waiting for two completed 5m bars");
  assert.equal(failed.decision,"EXIT");
  assert.match(failed.summary,/入场位置失败/);

  const proved=evaluatePositionIntelligence({now:T,side:"LONG",signedRate:-.006,peakFavorableRate:.004,ageMin:.4,firstProfit:true,
    expectedHoldMinutes:240,stopRate:.012,entryScore:93,entryResidual:.012,entryRelativeStrength:.82,entryRemainingSpaceRate:.04,
    state:broken,quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true});
  assert.equal(proved.decision,"REVIEW","a trade that already proved itself keeps the normal multi-bar anti-whipsaw gate");

  const slow={...broken,residual:.004,residualZ:.45,relativeStrength:.70,longScore:72,shortScore:38,pathLong:.55,pathShort:.45,
    venuePressure:.02,signalSide:"LONG" as const};
  const waiting=evaluatePositionIntelligence({now:T+30*60_000,side:"LONG",signedRate:-.001,peakFavorableRate:.0002,ageMin:30,firstProfit:false,
    expectedHoldMinutes:240,stopRate:.012,entryScore:86,entryResidual:.008,entryRelativeStrength:.72,entryRemainingSpaceRate:.04,
    state:slow,quote:{...quote,sourceBreadth:0,medianShortMove:0,bookImbalance:0,bidLiquidityChange:0,askLiquidityChange:0},
    minutePath:candles(100,0).slice(-10),marketStateAgeMs:20_000,entryResponseValidated:true});
  assert.notEqual(waiting.decision,"EXIT","elapsed time without profit is not itself an entry-failure trigger");
});

test("an unproven starter stays in REVIEW until its own STRUCTURE also turns against the entry",()=>{
  const neutralStructure={symbol:"ETH_USDT",watchScore:35,regime:"TRANSITION" as const,stage:"OBSERVE" as const,clusterId:"corr:ETH_USDT",
    correlation:.7,beta:1,volatility:.004,dataConfidence:96,actualMove:-.01,expectedMove:.001,residual:-.009,residualZ:-1.3,
    residualPersistence:1,relativeStrength:.25,longScore:50,shortScore:60,pathLong:.22,pathShort:.78,roomLong:.035,roomShort:.02,
    sourceCount:4,venueAgreement:1,venuePressure:-.7,reasons:[],signalSide:"LONG" as const,signalSince:T-300_000,signalBars:2,signalLastBar:T-300_000};
  const quote={sourceCount:4,directionalAgreement:1,sourceBreadth:-1,medianShortMove:-.001,bookImbalance:-.35,
    bidLiquidityChange:-.15,askLiquidityChange:.15,liquiditySourceCount:3,disagreementRate:.0002};
  const minute=candles(100,-.0008).slice(-10);
  const first=evaluatePositionIntelligence({now:T,side:"LONG",signedRate:-.001,peakFavorableRate:0,ageMin:8,firstProfit:false,
    expectedHoldMinutes:240,stopRate:.012,entryScore:92,entryResidual:.012,entryRelativeStrength:.8,entryRemainingSpaceRate:.04,
    state:neutralStructure,quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true});
  assert.equal(first.decision,"REVIEW");
  assert.equal(first.assessments.find(x=>x.family==="STRUCTURE")?.stance,"NEUTRAL");
  assert.ok(first.concernFamilies.includes("RELATIVE"));
  assert.ok(first.concernFamilies.includes("PATH")||first.concernFamilies.includes("FLOW"));

  const second=evaluatePositionIntelligence({now:T+300_000,side:"LONG",signedRate:-.0015,peakFavorableRate:0,ageMin:13,firstProfit:false,
    expectedHoldMinutes:240,stopRate:.012,entryScore:92,entryResidual:.012,entryRelativeStrength:.8,entryRemainingSpaceRate:.04,
    state:{...neutralStructure,signalLastBar:T},quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true,previous:first});
  assert.equal(second.reviewBars,2);
  assert.equal(second.decision,"REVIEW","relative/path/flow deterioration alone must not kill a slow starter while structure is neutral");

  const structureBroken={...neutralStructure,shortScore:82,signalSide:"SHORT" as const,signalLastBar:T+300_000};
  const third=evaluatePositionIntelligence({now:T+600_000,side:"LONG",signedRate:-.006,peakFavorableRate:0,ageMin:18,firstProfit:false,
    expectedHoldMinutes:240,stopRate:.012,entryScore:92,entryResidual:.012,entryRelativeStrength:.8,entryRemainingSpaceRate:.04,
    state:structureBroken,quote,minutePath:minute,marketStateAgeMs:20_000,entryResponseValidated:true,previous:second});
  assert.equal(third.assessments.find(x=>x.family==="STRUCTURE")?.stance,"CONCERN");
  assert.equal(third.decision,"EXIT");
  assert.match(third.summary,/入场位置失败/);
});

test("Position Intelligence requires independent concerns and two completed 5m reviews before active exit",()=>{
  const broken={symbol:"ETH_USDT",watchScore:35,regime:"TRANSITION" as const,stage:"OBSERVE" as const,clusterId:"corr:ETH_USDT",
    correlation:.7,beta:1.1,volatility:.004,dataConfidence:90,actualMove:-.009,expectedMove:.001,residual:-.008,residualZ:-1.1,
    residualPersistence:1,relativeStrength:.30,longScore:28,shortScore:78,pathLong:.25,pathShort:.75,roomLong:.003,roomShort:.018,
    sourceCount:3,venueAgreement:1,venuePressure:-.65,reasons:[],signalSide:"SHORT" as const,signalSince:T-300_000,signalBars:2,signalLastBar:T-300_000};
  const minute=candles(100,-.0007).slice(-10);
  const first=evaluatePositionIntelligence({now:T,side:"LONG",signedRate:.004,peakFavorableRate:.018,ageMin:80,firstProfit:true,
    expectedHoldMinutes:220,stopRate:.009,entryScore:88,entryResidual:.007,entryRelativeStrength:.75,entryRemainingSpaceRate:.022,
    state:broken,narrative:initialMarketIntelligenceState(T).narrative,quote:{sourceCount:3,directionalAgreement:1,sourceBreadth:-1,
      medianShortMove:-.001,bookImbalance:-.35,disagreementRate:.0002},minutePath:minute,marketStateAgeMs:20_000});
  assert.equal(first.decision,"REVIEW");
  assert.ok(first.concernFamilies.length>=2);
  const secondState={...broken,signalLastBar:T};
  const second=evaluatePositionIntelligence({now:T+300_000,side:"LONG",signedRate:.002,peakFavorableRate:.018,ageMin:85,firstProfit:true,
    expectedHoldMinutes:220,stopRate:.009,entryScore:88,entryResidual:.007,entryRelativeStrength:.75,entryRemainingSpaceRate:.022,
    state:secondState,narrative:initialMarketIntelligenceState(T).narrative,quote:{sourceCount:3,directionalAgreement:1,sourceBreadth:-1,
      medianShortMove:-.001,bookImbalance:-.35,disagreementRate:.0002},minutePath:minute,marketStateAgeMs:20_000,previous:first});
  assert.equal(second.reviewBars,2);
  assert.equal(second.decision,"EXIT");
});

test("stale market intelligence can review but cannot trigger an active intelligent exit",()=>{
  const broken={symbol:"ETH_USDT",watchScore:30,regime:"TRANSITION" as const,stage:"OBSERVE" as const,clusterId:"corr:ETH_USDT",
    correlation:.7,beta:1,volatility:.004,dataConfidence:95,actualMove:-.01,expectedMove:0,residual:-.009,residualZ:-1.2,
    residualPersistence:1,relativeStrength:.25,longScore:25,shortScore:80,pathLong:.2,pathShort:.8,roomLong:.002,roomShort:.02,
    sourceCount:3,venueAgreement:1,venuePressure:-.7,reasons:[],signalSide:"SHORT" as const,signalSince:T-600_000,signalBars:3,signalLastBar:T};
  const prior=evaluatePositionIntelligence({now:T,side:"LONG",signedRate:.002,peakFavorableRate:.02,ageMin:90,firstProfit:true,
    expectedHoldMinutes:220,stopRate:.01,entryScore:90,entryResidual:.008,entryRelativeStrength:.8,entryRemainingSpaceRate:.025,
    state:broken,quote:{sourceCount:3,bookImbalance:-.4,disagreementRate:.0001},minutePath:candles(100,-.0008).slice(-10),marketStateAgeMs:20_000});
  const next=evaluatePositionIntelligence({now:T+300_000,side:"LONG",signedRate:.001,peakFavorableRate:.02,ageMin:95,firstProfit:true,
    expectedHoldMinutes:220,stopRate:.01,entryScore:90,entryResidual:.008,entryRelativeStrength:.8,entryRemainingSpaceRate:.025,
    state:{...broken,signalLastBar:T+300_000},quote:{sourceCount:3,bookImbalance:-.4,disagreementRate:.0001},
    minutePath:candles(100,-.0008).slice(-10),marketStateAgeMs:20*60_000,previous:prior});
  assert.notEqual(next.decision,"EXIT");
  assert.equal(next.dataConfidence,0);
});


test("L0 macro stays unconfirmed until real daily coverage exists",()=>{
  const paths={BTC_USDT:candles(100,.0012),ETH_USDT:candles(100,.0011),SOL_USDT:candles(100,.0013)};
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,q(v.at(-1)!.close)]));
  const cold=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-300_000),now:T});
  assert.equal(cold.state.coverage.intradayMarkets,3);
  assert.equal(cold.state.coverage.dailyMarkets,0);
  assert.equal(cold.state.narrative.macro.phase,"UNCERTAIN");
  assert.equal(cold.state.narrative.macro.score,0);
  assert.match(cold.state.narrative.macro.detail,/日线覆盖 0 个市场/);
  const d={BTC_USDT:daily(100,.006),ETH_USDT:daily(100,.0055),SOL_USDT:daily(100,.0065)};
  const warm=buildMarketIntelligence({paths,daily:d,quotes,previous:cold.state,now:T+300_000});
  assert.equal(warm.state.coverage.dailyMarkets,3);
  assert.equal(warm.state.coverage.multiVenueMarkets,3);
  assert.ok(warm.state.narrative.macro.score>0);
  assert.doesNotMatch(warm.state.narrative.macro.detail,/不会用分钟级走势代替牛熊判断/);
});


test("Worker warm restart keeps the last confirmed market map until broad 5m coverage returns",()=>{
  const paths={BTC_USDT:candles(100,.0010),ETH_USDT:candles(100,.0012),SOL_USDT:candles(100,.0009)};
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,q(v.at(-1)!.close,.0002)]));
  const built=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-300_000),now:T-1000});
  const state=initialForward(T-60_000);
  state.extremumRegime=built.state;state.opportunities=built.opportunities;state.selectedSymbols=Object.keys(built.state.symbols);
  const beforeSymbols=Object.keys(state.extremumRegime.symbols).sort();
  const next=advanceForward({state,now:T,paths:{},quotes:{},contracts:{},
    entrySymbols:Array.from({length:30},(_,i)=>`S${i}_USDT`),allowDataCycle:false}).state;
  assert.deepEqual(Object.keys(next.extremumRegime.symbols).sort(),beforeSymbols);
  assert.equal(next.opportunities.length,0,"partial restart coverage must not create or retain executable entries");
  assert.equal(next.extremumRegime.coverage.intradayMarkets,0);
  assert.match(next.latestReason,/沿用上一份市场叙事/);
});


test("same market anomaly keeps one thesis id across completed bars and matures instead of respawning",()=>{
  const firstPaths={BTC_USDT:candles(100,.0010),ETH_USDT:candles(100,.0018),SOL_USDT:candles(100,.0009)};
  for(let i=56;i<firstPaths.ETH_USDT.length;i++){const k=1+(i-55)*.0008;for(const key of["open","high","low","close"] as const)firstPaths.ETH_USDT[i]![key]*=k;}
  const quotes=Object.fromEntries(Object.entries(firstPaths).map(([s,v])=>[s,q(v.at(-1)!.close,.0003)]));
  const first=buildMarketIntelligence({paths:firstPaths,quotes,previous:initialMarketIntelligenceState(T-600_000),now:T});
  const shifted=Object.fromEntries(Object.entries(firstPaths).map(([s,rows])=>[s,rows.map(r=>({...r,time:r.time+300}))]));
  const quotes2=Object.fromEntries(Object.entries(shifted).map(([s,v])=>[s,{...q(v.at(-1)!.close,.0003),observedAt:T+300_000}]));
  const second=buildMarketIntelligence({paths:shifted,quotes:quotes2,previous:first.state,now:T+300_000});
  const a=first.state.symbols.ETH_USDT!,b=second.state.symbols.ETH_USDT!;
  assert.equal(b.signalSide,a.signalSide);assert.ok(b.signalBars>=a.signalBars+1);
  const o1=first.opportunities.find(o=>o.symbol==="ETH_USDT"),o2=second.opportunities.find(o=>o.symbol==="ETH_USDT");
  assert.equal(o2?.thesisId,o1?.thesisId,"same anomaly episode must keep one thesis identity");
});

test("major market direction uses hysteresis instead of flipping neutral on small counter-moves",()=>{
  const up={BTC_USDT:candles(100,.0015),ETH_USDT:candles(100,.0014),SOL_USDT:candles(100,.0016)};
  const qUp=Object.fromEntries(Object.entries(up).map(([s,v])=>[s,q(v.at(-1)!.close,.00025)]));
  let state=initialMarketIntelligenceState(T-1_800_000);const now=T-1_500_000;
  for(let i=0;i<4;i++){const r=buildMarketIntelligence({paths:up,quotes:qUp,previous:state,now:now+i*300_000});state=r.state;}
  assert.equal(state.narrative.major.bias,"BULLISH");
  const mild={BTC_USDT:candles(100,-.00008),ETH_USDT:candles(100,-.00006),SOL_USDT:candles(100,-.00009)};
  const qMild=Object.fromEntries(Object.entries(mild).map(([s,v])=>[s,q(v.at(-1)!.close,-.00005)]));
  const next=buildMarketIntelligence({paths:mild,quotes:qMild,previous:state,now:T+600_000});
  assert.equal(next.state.narrative.major.bias,"BULLISH","minor counter-move should update details without rewriting the major narrative");
});


test("PAPER balance reset clears the wallet ledger but preserves the live Market Intelligence brain",()=>{
  const paths={BTC_USDT:candles(100,.0010),ETH_USDT:candles(100,.0015),SOL_USDT:candles(100,.0009)};
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,q(v.at(-1)!.close,.00025)]));
  const built=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-600_000),now:T});
  const prior=initialForward(T-900_000);
  prior.balance=742;prior.initialEquity=1000;prior.turnover=12345;prior.fees=9;prior.resolved=12;prior.wins=7;
  prior.extremumRegime=built.state;prior.marketPulse=built.pulse;prior.selectedSymbols=Object.keys(built.state.symbols);
  prior.opportunities=built.opportunities;prior.lastCandleAt=T;prior.lastCycleAt=T-1000;prior.lastQuoteCycleAt=T-500;
  prior.lastEntryAt.ETH_USDT=T-120_000;prior.lastSide.ETH_USDT="LONG";prior.lastExitAt.ETH_USDT=T-60_000;
  prior.consumedTheses["old-thesis"]=T-120_000;
  prior.fitDiagnostics={tested:30,qualified:4,trainGroups:3,checkGroups:6,latestAt:T,rapidQualified:2,activeLong:8,activeShort:5};

  const reset=resetForwardAccountPreservingLearning(prior,T+10_000);
  assert.equal(reset.balance,1000);assert.equal(reset.initialEquity,1000);
  assert.equal(reset.turnover,0);assert.equal(reset.fees,0);assert.equal(reset.resolved,0);assert.equal(reset.wins,0);
  assert.equal(reset.positions.length,0);assert.equal(reset.history.length,0);assert.equal(reset.opportunities.length,0);
  assert.deepEqual(reset.extremumRegime,prior.extremumRegime);
  assert.deepEqual(reset.marketPulse,prior.marketPulse);
  assert.deepEqual(reset.selectedSymbols,prior.selectedSymbols);
  assert.equal(reset.lastCandleAt,prior.lastCandleAt);assert.equal(reset.lastCycleAt,prior.lastCycleAt);
  assert.deepEqual(reset.fitDiagnostics,prior.fitDiagnostics);
  assert.equal(reset.lastEntryAt.ETH_USDT,prior.lastEntryAt.ETH_USDT);
  assert.equal(reset.lastExitAt.ETH_USDT,prior.lastExitAt.ETH_USDT);
  assert.equal(reset.lastSide.ETH_USDT,"LONG");
  assert.equal(reset.consumedTheses["old-thesis"],T-120_000);
  assert.match(reset.latestReason,/保留 Market Intelligence 市场叙事、证据、相关组和异常生命周期/);
});

test("PAPER balance reset cannot turn the already-processed 5m bar into a fresh entry cycle",()=>{
  const firstPaths={BTC_USDT:candles(100,.0010),ETH_USDT:candles(100,.0018),SOL_USDT:candles(100,.0009)};
  for(let i=56;i<firstPaths.ETH_USDT.length;i++){const k=1+(i-55)*.0008;for(const key of["open","high","low","close"] as const)firstPaths.ETH_USDT[i]![key]*=k;}
  const firstQuotes=Object.fromEntries(Object.entries(firstPaths).map(([s,v])=>[s,q(v.at(-1)!.close,.0003)]));
  const first=buildMarketIntelligence({paths:firstPaths,quotes:firstQuotes,previous:initialMarketIntelligenceState(T-600_000),now:T});

  const paths=Object.fromEntries(Object.entries(firstPaths).map(([s,rows])=>[s,rows.map(r=>({...r,time:r.time+300}))]));
  const now=T+300_000;
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,{...q(v.at(-1)!.close,.0003),observedAt:now}]));
  const second=buildMarketIntelligence({paths,quotes,previous:first.state,now});
  const executable={...second.opportunities[0]!,eligible:true,mode:"CONTINUATION" as const,tradePlan:"LIQUIDITY_MIGRATION" as const,
    thesisId:"reset-liquidity-migration-thesis",thesisSince:now-300_000,thesisBars:2};
  assert.ok(executable.symbol,"fixture must contain a liquidity-plan opportunity shape");

  const prior=initialForward(T-600_000);
  prior.extremumRegime=second.state;prior.marketPulse=second.pulse;prior.opportunities=[executable];
  prior.selectedSymbols=Object.keys(second.state.symbols);
  prior.lastCandleAt=Math.max(...Object.values(paths).map(rows=>(rows.at(-1)!.time+300)*1000));
  prior.lastCycleAt=now;prior.lastQuoteCycleAt=now;

  const reset=resetForwardAccountPreservingLearning(prior,now+1000);
  const contracts=Object.fromEntries(Object.keys(paths).map(s=>[s,{quantoMultiplier:1,leverageMax:10,maintenanceRate:.005,minContracts:1}]));
  const next=advanceForward({state:reset,now,paths,quotes,contracts,entrySymbols:Object.keys(paths)}).state;
  assert.equal(next.positions.length,0,"reset must not make the same completed 5m step executable again");
  assert.equal(next.entryDiagnostics.opened,0);
});


test("Market evidence is eventized: repeated observations merge into one evolving episode",()=>{
  const paths={BTC_USDT:candles(100,.0011),ETH_USDT:candles(100,.0012),SOL_USDT:candles(100,.0010)};
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,q(v.at(-1)!.close,.0004)]));
  const first=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-600_000),now:T});
  const second=buildMarketIntelligence({paths,quotes,previous:first.state,now:T+30_000});
  const byKey=(rows:typeof second.state.evidence)=>rows.filter(x=>x.type==="BREADTH_EXPANSION"||x.type==="BREADTH_CONTRACTION");
  const episodes=byKey(second.state.evidence);
  assert.ok(episodes.length<=1,"same breadth condition must be one episode, not repeated bullish/bearish votes");
  if(episodes[0]){assert.ok((episodes[0].samples??1)>=1);assert.ok((episodes[0].firstAt??episodes[0].at)<=(episodes[0].lastAt??episodes[0].at));}
});


test("cold-archived history cannot make an already-consumed thesis executable again",()=>{
  const paths={BTC_USDT:candles(100,.0010),ETH_USDT:candles(100,.0018),SOL_USDT:candles(100,.0009)};
  for(let i=56;i<paths.ETH_USDT.length;i++){const k=1+(i-55)*.0008;for(const key of["open","high","low","close"] as const)paths.ETH_USDT[i]![key]*=k;}
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,q(v.at(-1)!.close,.0003)]));
  const first=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-600_000),now:T});
  const shifted=Object.fromEntries(Object.entries(paths).map(([s,rows])=>[s,rows.map(r=>({...r,time:r.time+300}))]));
  const now=T+300_000,shiftQuotes=Object.fromEntries(Object.entries(shifted).map(([s,v])=>[s,{...q(v.at(-1)!.close,.0003),observedAt:now}]));
  const second=buildMarketIntelligence({paths:shifted,quotes:shiftQuotes,previous:first.state,now});
  const opportunity={...second.opportunities[0]!,eligible:true,mode:"CONTINUATION" as const,tradePlan:"LIQUIDITY_MIGRATION" as const,
    thesisId:"consumed-liquidity-migration-thesis",thesisSince:now-300_000,thesisBars:2};
  assert.ok(opportunity.thesisId,"fixture must contain an executable persistent liquidity thesis shape");
  const s=initialForward(T-600_000);s.extremumRegime=second.state;s.opportunities=[opportunity];
  s.consumedTheses[opportunity.thesisId]=now-60_000;
  const contracts={[opportunity.symbol]:{quantoMultiplier:.001,leverageMax:10,maintenanceRate:.005,minContracts:1}};
  const opened=fillForwardPortfolio(s,{[opportunity.symbol]:shiftQuotes[opportunity.symbol]!},contracts,now,1000,false);
  assert.equal(opened,0);
  assert.equal(s.positions.length,0,"thesis dedupe must survive even after the full closed trade leaves hot history");
});


test("new liquidity trades size risk and stop at the frozen hypothesis invalidation boundary",()=>{
  const paths={BTC_USDT:candles(100,.0010),ETH_USDT:candles(100,.0013),SOL_USDT:candles(100,.0009)};
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,q(v.at(-1)!.close,.0003)]));
  const built=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-300_000),now:T});
  const base=built.opportunities[0]!,quote=quotes[base.symbol]!,entry=base.side==="LONG"?quote.bestAsk:quote.bestBid,
    invalidation=base.side==="LONG"?entry*.990:entry*1.010,
    opportunity={...base,eligible:true,tradePlan:"LIQUIDITY_MIGRATION" as const,environmentForceRetest:false,
      strategyVersion:MARKET_INTELLIGENCE_VERSION,thesisId:"frozen-liquidity-stop",thesisSince:T-300_000,
      netRemainingSpaceRate:.04,grossRemainingSpaceRate:.045,edgeRatio:4,targetRate:.04,
      liquidityInvalidationPrice:invalidation,liquidityInvalidationRate:.01,rapidLiquidityAuthorization:true};
  const state=initialForward(T-600_000);state.extremumRegime=built.state;state.opportunities=[opportunity];
  const contracts={[opportunity.symbol]:{quantoMultiplier:.001,leverageMax:10,maintenanceRate:.005,minContracts:1}};
  const opened=fillForwardPortfolio(state,{[opportunity.symbol]:quote},contracts,T,1000,false);
  assert.equal(opened,1);
  const trade=state.positions[0]!;
  assert.ok(Math.abs(trade.stopPrice-invalidation)<entry*1e-9);
  assert.equal(trade.entryContext?.liquidityInvalidationPrice,invalidation);
  assert.equal(trade.liquidityLifecycle?.invalidationPrice,invalidation);
  assert.ok(trade.plannedRisk<=6.5,"position size must be reduced to keep risk budget correct when the liquidity invalidation is wider");
});

test("family-turn entries also require and preserve a frozen liquidity invalidation boundary",()=>{
  const paths={BTC_USDT:candles(100,.0010),ETH_USDT:candles(100,.0013),SOL_USDT:candles(100,.0009)};
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,q(v.at(-1)!.close,.0003)]));
  const built=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-300_000),now:T});
  const base=built.opportunities[0]!,quote=quotes[base.symbol]!,entry=base.side==="LONG"?quote.bestAsk:quote.bestBid,
    invalidation=base.side==="LONG"?entry*.989:entry*1.011,
    opportunity={...base,eligible:true,tradePlan:"FAMILY_TURN" as const,environmentForceRetest:false,
      strategyVersion:MARKET_INTELLIGENCE_VERSION,thesisId:"family-turn-liquidity-stop",thesisSince:T-300_000,
      netRemainingSpaceRate:.04,grossRemainingSpaceRate:.045,edgeRatio:4,targetRate:.04,
      liquidityInvalidationPrice:invalidation,liquidityInvalidationRate:.011,rapidLiquidityAuthorization:false};
  const state=initialForward(T-600_000);state.extremumRegime=built.state;state.opportunities=[opportunity];
  const contracts={[opportunity.symbol]:{quantoMultiplier:.001,leverageMax:10,maintenanceRate:.005,minContracts:1}};
  const opened=fillForwardPortfolio(state,{[opportunity.symbol]:quote},contracts,T,1000,false);
  assert.equal(opened,1);
  const trade=state.positions[0]!;
  assert.ok(Math.abs(trade.stopPrice-invalidation)<entry*1e-9);
  assert.equal(trade.entryContext?.liquidityInvalidationPrice,invalidation);
  assert.equal(trade.liquidityLifecycle?.invalidationPrice,invalidation);
});

test("stable market narrative advances only on a new completed five-minute step",()=>{
  const paths={BTC_USDT:candles(100,.0011),ETH_USDT:candles(100,.0013),SOL_USDT:candles(100,.0010)};
  const quotes1=Object.fromEntries(Object.entries(paths).map(([sym,rows])=>[sym,{...q(rows.at(-1)!.close,.0004),observedAt:T}]));
  const first=advanceForward({state:initialForward(T-600_000),now:T,paths,quotes:quotes1,contracts:{},
    entrySymbols:Object.keys(paths)}).state;
  const narrative=structuredClone(first.extremumRegime.narrative),history=structuredClone(first.extremumRegime.history);
  const quotes2=Object.fromEntries(Object.entries(paths).map(([sym,rows])=>[sym,{
    ...q(rows.at(-1)!.close,-.003),observedAt:T+2_000,sourceBreadth:-1,directionalAgreement:1,medianShortMove:-.004,
    bookImbalance:-.9,bidLiquidityChange:-.7,askLiquidityChange:.7
  }]));
  const second=advanceForward({state:first,now:T+2_000,paths,quotes:quotes2,contracts:{},
    entrySymbols:Object.keys(paths)}).state;
  assert.deepEqual(second.extremumRegime.narrative,narrative,
    "quote-level detail may update observations but cannot rewrite the stable market narrative inside the same 5m bucket");
  assert.deepEqual(second.extremumRegime.history,history);
});

test("BTW-like extreme residual requires substantially stronger live proof instead of treating magnitude as quality",()=>{
  const risky=extremeResidualConfirmationProfile({residual:.075,sourceCount:4,dataConfidence:83,
    disagreementRate:.0044,recentExtremeLosses:2});
  assert.equal(risky.required,true);
  assert.ok(risky.minimumElapsedMs>=120_000);
  assert.ok(risky.minimumSupportSamples>=9);
  assert.ok(risky.minimumRetainedRate>=.76);
  const ordinary=extremeResidualConfirmationProfile({residual:.012,sourceCount:5,dataConfidence:95,
    disagreementRate:.0005,recentExtremeLosses:0});
  assert.equal(ordinary.required,false);
});


test("ZEC-like stable short thesis survives a shallow 2s opposition burst as RETEST instead of being cancelled",()=>{
  const state={symbol:"ZEC_USDT",watchScore:86,regime:"DIVERGENT" as const,stage:"READY" as const,clusterId:"corr:ADA_USDT",
    correlation:.77,beta:1.38,volatility:.0034,dataConfidence:100,actualMove:-.023,expectedMove:-.012,residual:-.0116,residualZ:-1.39,
    residualPersistence:1,relativeStrength:.27,longScore:10,shortScore:90,pathLong:.5,pathShort:.5,roomLong:.029,roomShort:.0085,
    sourceCount:5,venueAgreement:.8,venuePressure:.38,reasons:[],signalSide:"SHORT" as const,signalSince:T-900_000,signalBars:3,signalLastBar:T-300_000};
  const quote={bestBid:1446.60,bestAsk:1446.61,observedAt:T+8_000,fresh:true,entryReady:true,sourceCount:5,disagreementRate:.001,
    sourceBreadth:.7,directionalAgreement:.8,medianShortMove:.0005,bookImbalance:.25,bidLiquidityChange:.12,askLiquidityChange:-.05,liquiditySourceCount:4};
  const memory={startedAt:T,deadlineAt:T+12*60_000,initialPrice:1446.09,samples:4,bestAdvanceRate:0,maxAdverseRate:.0002,
    supportSamples:0,oppositionSamples:1};
  const sticky=evaluateEntryResponse({now:T+8_000,side:"SHORT",score:86.1,edgeRatio:1.66,pullbackRiskRate:.00849,stopRate:.0100,
    sourceCount:5,disagreementRate:.001,price:1446.61,memory,state,quote,allowRetest:true});
  assert.equal(sticky.action,"RETEST");
  assert.match(sticky.reason,/保留武装状态/);
  const ordinary=evaluateEntryResponse({now:T+8_000,side:"SHORT",score:76,edgeRatio:1.4,pullbackRiskRate:.00849,stopRate:.0100,
    sourceCount:5,disagreementRate:.001,price:1446.61,memory,state,quote,allowRetest:false});
  assert.equal(ordinary.action,"CANCEL");
});

test("ZEC-like thesis is armed early but cannot chase after the original location has been consumed",()=>{
  const profile=stableEntryThesisProfile({score:86.12,premium:true,thesisBars:3,stage:"READY",edgeRatio:1.661,sourceCount:5,
    dataConfidence:100,netRemainingSpaceRate:.014111,pullbackRiskRate:.008495});
  assert.equal(profile.stable,true);
  assert.ok(profile.maxChaseRate>.005&&profile.maxChaseRate<.007,
    "ZEC-like thesis should stop chasing after roughly the first ~0.6% directional move");
  const lateAdvance=1446.09/1393.08-1;
  const late=stableEntryLocationDecision({currentAdvanceRate:lateAdvance,bestAdvanceRate:lateAdvance,
    expectedNetRate:.014111,pullbackRiskRate:.008495,maxChaseRate:profile.maxChaseRate,
    retestPullbackMin:profile.retestPullbackMin,restartMin:profile.restartMin,retestBaseReady:false});
  assert.equal(late.action,"WAIT_PULLBACK","a 1446 -> 1393 move must never be treated as a fresh market-order location");
  assert.ok(late.requiredPullback>.02,"after such a large missed move the system must wait for a material retrace, not a tiny tick");

  const missedButRecoverable=stableEntryLocationDecision({currentAdvanceRate:.0040,bestAdvanceRate:.0080,
    expectedNetRate:.014111,pullbackRiskRate:.008495,maxChaseRate:profile.maxChaseRate,
    retestPullbackMin:profile.retestPullbackMin,restartMin:profile.restartMin,retestBaseReady:false});
  assert.equal(missedButRecoverable.action,"SET_RETEST_BASE");
  const restarted=stableEntryLocationDecision({currentAdvanceRate:.0053,bestAdvanceRate:.0080,
    expectedNetRate:.014111,pullbackRiskRate:.008495,maxChaseRate:profile.maxChaseRate,
    retestPullbackMin:profile.retestPullbackMin,restartMin:profile.restartMin,retestBaseReady:true,
    restartAdvanceRate:profile.restartMin+.0002});
  assert.equal(restarted.action,"READY_AFTER_RETEST");
});

test("armed thesis fields survive forward normalization instead of silently losing execution authority",()=>{
  const state=initialForward(T);
  state.entryValidations.zec={id:"zec",candidateId:"zec",symbol:"ZEC_USDT",side:"SHORT",startedAt:T-10_000,expiresAt:T+600_000,
    deadlineAt:T+500_000,initialPrice:1446.09,lastPrice:1446.61,lastQuoteAt:T,samples:8,bestAdvanceRate:.0006,maxAdverseRate:.0004,
    supportSamples:0,oppositionSamples:2,extendedConfirmation:true,extremeResidual:false,minimumElapsedMs:12_000,
    minimumSupportSamples:3,minimumRetainedRate:.70,stableThesis:true,phase:"RETEST_WAIT",initialExpectedNetRate:.014111,
    pullbackRiskRateAtArm:.008495,maxChaseRate:.0063,retestPullbackMin:.0025,restartMin:.0012,retestBasePrice:1448,
    retestBaseAt:T-2_000,status:"WAITING",reason:"x"};
  const restored=normalizeForward(state,T+1_000).entryValidations.zec!;
  assert.equal(restored.stableThesis,true);assert.equal(restored.phase,"RETEST_WAIT");
  assert.equal(restored.extendedConfirmation,true);assert.equal(restored.minimumSupportSamples,3);
  assert.equal(restored.maxChaseRate,.0063);assert.equal(restored.retestBasePrice,1448);
});


test("environment outlook preserves a strong aligned continuation lane while uncertain countertrend logic stays smaller",()=>{
  const market=initialMarketIntelligenceState(T);
  market.narrative.short={...market.narrative.short,bias:"BULLISH",score:.48,phase:"ADVANCING"};
  market.narrative.major={...market.narrative.major,bias:"BULLISH",score:.42};
  market.narrative.transition={...market.narrative.transition,direction:"NEUTRAL",pressure:8,stage:"STABLE"};
  market.internals={...market.internals!,breadth3:.33,synchrony:.64,dispersion:.50,venuePressure:-.12,leaderPersistence:1};
  const symbol={symbol:"GRASS_USDT",watchScore:95,regime:"DIVERGENT" as const,stage:"READY" as const,clusterId:"corr:GRASS_USDT",
    correlation:.75,beta:1,volatility:.004,dataConfidence:96,actualMove:.04,expectedMove:.002,residual:.038,residualZ:2.1,
    residualPersistence:1,relativeStrength:.85,longScore:96,shortScore:20,pathLong:.78,pathShort:.22,roomLong:.05,roomShort:.01,
    sourceCount:5,venueAgreement:.9,venuePressure:.25,reasons:[],signalSide:"LONG" as const,signalSince:T-600_000,signalBars:2,signalLastBar:T-300_000};
  const trend={version:"market-intelligence-lifecycle-v1" as const,phase:"TRANSITIONAL" as const,trendSide:"LONG" as const,
    expansionScore:.58,rotationRisk:.37,reason:"",decisionStable:false,stabilityScore:.63};
  const outlook=deriveEnvironmentOutlook(market,trend);
  assert.equal(outlook.horizonMinutes,60);
  assert.ok(outlook.persistenceScore>.80);
  const capture=routeEnvironmentOpportunity({market,evolution:trend,symbol,opportunity:{side:"LONG",mode:"CONTINUATION",tradePlan:"LIQUIDITY_MIGRATION",score:95,premium:true,
    edgeRatio:2.2,netRemainingSpaceRate:.04,pullbackRiskRate:.018,thesisBars:2,confirmationStage:"READY"}});
  assert.equal(capture.playbook,"TREND_CAPTURE");assert.equal(capture.mainline,true);
  assert.ok(capture.riskScale>.95);assert.ok(capture.modeFit>.80);

  market.narrative.major={...market.narrative.major,bias:"BEARISH",score:-.35};
  market.internals={...market.internals!,leaderPersistence:.2};
  const mixed={...trend,trendSide:"LONG" as const,rotationRisk:.46,stabilityScore:.54};
  const cautious=routeEnvironmentOpportunity({market,evolution:mixed,symbol,opportunity:{side:"LONG",mode:"CONTINUATION",tradePlan:"LIQUIDITY_MIGRATION",score:97,premium:true,
    edgeRatio:2.3,netRemainingSpaceRate:.03,pullbackRiskRate:.012,thesisBars:2,confirmationStage:"READY"}});
  assert.equal(cautious.mainline,false);
  assert.ok(cautious.riskScale>=.55&&cautious.riskScale<capture.riskScale);
  assert.equal(cautious.forceRetest,true,"short-horizon/counter-aligned continuation must wait for pullback and restart");
});

test("synchronized market expansion keeps a 60m mainline continuation path",()=>{
  const market=initialMarketIntelligenceState(T);
  market.narrative.short={...market.narrative.short,bias:"BULLISH",score:.58,phase:"ADVANCING"};
  market.narrative.major={...market.narrative.major,bias:"BULLISH",score:.52};
  market.narrative.transition={...market.narrative.transition,direction:"NEUTRAL",pressure:6,stage:"STABLE"};
  market.internals={...market.internals!,breadth3:.82,breadth12:.70,synchrony:.84,venuePressure:.55,leaderPersistence:.78,dispersion:.25};
  const evolution={version:"market-intelligence-lifecycle-v1" as const,phase:"EXPANDING" as const,trendSide:"LONG" as const,
    expansionScore:.82,rotationRisk:.18,reason:"expanding",decisionStable:true,stabilityScore:.78};
  const symbol={symbol:"BTC_USDT",watchScore:76,regime:"MARKET_TREND" as const,stage:"OBSERVE" as const,clusterId:"corr:BTC_USDT",
    correlation:.9,beta:1,volatility:.003,dataConfidence:98,actualMove:.012,expectedMove:.011,residual:.001,residualZ:.12,
    residualPersistence:1,relativeStrength:.53,longScore:78,shortScore:22,pathLong:.75,pathShort:.25,roomLong:.02,roomShort:.006,
    sourceCount:5,venueAgreement:.95,venuePressure:.5,reasons:[],signalSide:"LONG" as const,signalSince:T-300_000,signalBars:1,signalLastBar:T-300_000};
  const route=routeEnvironmentOpportunity({market,evolution,symbol,opportunity:{side:"LONG",mode:"CONTINUATION",tradePlan:"LIQUIDITY_MIGRATION",score:76,premium:false,
    edgeRatio:1.8,netRemainingSpaceRate:.018,pullbackRiskRate:.008,thesisBars:1,confirmationStage:"OBSERVE"}});
  assert.equal(route.environment,"SHOCK");assert.equal(route.playbook,"SHOCK_PARTICIPATION");
  assert.equal(route.outlook.horizonMinutes,60);assert.equal(route.mainline,true);assert.equal(route.forceRetest,false);
});

test("rotation makes relative/reversal logic more suitable than continuation without banning any mode",()=>{
  const market=initialMarketIntelligenceState(T);
  market.narrative.short={...market.narrative.short,bias:"NEUTRAL",score:.02,phase:"DIVERGING"};
  market.narrative.major={...market.narrative.major,bias:"NEUTRAL",score:.01};
  market.narrative.transition={...market.narrative.transition,direction:"NEUTRAL",pressure:12,stage:"STABLE"};
  market.internals={...market.internals!,breadth3:.05,synchrony:.35,venuePressure:0,dispersion:.9,leaderPersistence:.35};
  const evolution={version:"market-intelligence-lifecycle-v1" as const,phase:"ROTATIONAL" as const,trendSide:null,
    expansionScore:.30,rotationRisk:.82,reason:"rotation",decisionStable:false,stabilityScore:.18};
  const symbol={symbol:"XLM_USDT",watchScore:82,regime:"DIVERGENT" as const,stage:"READY" as const,clusterId:"corr:XLM_USDT",
    correlation:.4,beta:.7,volatility:.004,dataConfidence:96,actualMove:-.008,expectedMove:-.001,residual:-.007,residualZ:-1.1,
    residualPersistence:1,relativeStrength:.3,longScore:25,shortScore:84,pathLong:.3,pathShort:.7,roomLong:.008,roomShort:.022,
    sourceCount:5,venueAgreement:.9,venuePressure:-.3,reasons:[],signalSide:"SHORT" as const,signalSince:T-600_000,signalBars:3,signalLastBar:T-300_000};
  const outlook=deriveEnvironmentOutlook(market,evolution),
    rel=environmentModeFit({market,evolution,outlook,side:"SHORT",mode:"RELATIVE"}),
    cont=environmentModeFit({market,evolution,outlook,side:"SHORT",mode:"CONTINUATION"});
  assert.ok(rel>cont);
  const route=routeEnvironmentOpportunity({market,evolution,symbol,opportunity:{side:"SHORT",mode:"RELATIVE",score:82,premium:true,
    edgeRatio:2,netRemainingSpaceRate:.022,pullbackRiskRate:.01,thesisBars:3,confirmationStage:"READY"}});
  assert.equal(route.playbook,"ROTATION_RELATIVE");assert.ok(route.riskScale>=.55);assert.equal(route.forceRetest,true);
});

test("historical environment PnL stays diagnostic; live routing is driven by current market condition",()=>{
  const perf=initialEnvironmentPerformanceState();
  for(let i=0;i<6;i++)recordEnvironmentOutcome(perf,{environment:"TRANSITION",playbook:"TRANSITION_PROBE",netPnl:-5,plannedRisk:5,now:T+i});
  const factor=environmentPerformanceFactor(perf,"TRANSITION","TRANSITION_PROBE");
  assert.ok(factor>=.55&&factor<.8);
  const market=initialMarketIntelligenceState(T),symbol={symbol:"LINK_USDT",watchScore:82,regime:"DIVERGENT" as const,stage:"READY" as const,
    clusterId:"corr:ADA_USDT",correlation:.7,beta:1,volatility:.004,dataConfidence:96,actualMove:.008,expectedMove:.001,residual:.007,
    residualZ:1,residualPersistence:1,relativeStrength:.7,longScore:84,shortScore:25,pathLong:.7,pathShort:.3,roomLong:.02,roomShort:.008,
    sourceCount:5,venueAgreement:.9,venuePressure:.3,reasons:[],signalSide:"LONG" as const,signalSince:T-600_000,signalBars:3,signalLastBar:T-300_000};
  market.narrative.short={...market.narrative.short,bias:"BEARISH",score:-.4,phase:"DECLINING"};
  market.narrative.major={...market.narrative.major,bias:"BULLISH",score:.25};
  market.internals={...market.internals!,leaderPersistence:.4,dispersion:.7,synchrony:.5};
  const evolution={version:"market-intelligence-lifecycle-v1" as const,phase:"TRANSITIONAL" as const,trendSide:"SHORT" as const,
    expansionScore:.4,rotationRisk:.6,reason:"",decisionStable:false,stabilityScore:.3};
  const a=routeEnvironmentOpportunity({market,evolution,symbol,performanceFactor:1,opportunity:{side:"LONG",mode:"REVERSAL",
    score:82,premium:true,edgeRatio:2,netRemainingSpaceRate:.025,pullbackRiskRate:.011,thesisBars:3,confirmationStage:"READY"}});
  const b=routeEnvironmentOpportunity({market,evolution,symbol,performanceFactor:factor,opportunity:{side:"LONG",mode:"REVERSAL",
    score:82,premium:true,edgeRatio:2,netRemainingSpaceRate:.025,pullbackRiskRate:.011,thesisBars:3,confirmationStage:"READY"}});
  assert.equal(a.riskScale,b.riskScale);
  assert.ok(a.riskScale>=.55,"environment can reduce size but cannot turn trading off");
});

test("one-minute fast pressure can shorten the future window without flipping the formal market label",()=>{
  const market=initialMarketIntelligenceState(T);
  market.narrative.short={...market.narrative.short,bias:"BULLISH",score:.50,phase:"ADVANCING"};
  market.narrative.major={...market.narrative.major,bias:"BULLISH",score:.44};
  market.narrative.transition={...market.narrative.transition,direction:"NEUTRAL",pressure:8,stage:"STABLE"};
  market.internals={...market.internals!,leaderPersistence:.85,synchrony:.72,dispersion:.32};
  const evolution={version:"market-intelligence-lifecycle-v1" as const,phase:"STABLE_TREND" as const,trendSide:"LONG" as const,
    expansionScore:.72,rotationRisk:.22,reason:"",decisionStable:true,stabilityScore:.78};
  const prior=deriveEnvironmentOutlook(market,evolution);
  assert.equal(prior.horizonMinutes,60);
  const fast=deriveFastEnvironmentSignal(Array.from({length:10},()=>({medianShortMove:-.002,directionalAgreement:.92,sourceCount:4}))),
    stressed=deriveEnvironmentOutlook(market,evolution,{fast,previous:prior});
  assert.ok(stressed.transitionPressure>prior.transitionPressure);
  assert.ok(stressed.persistenceScore<prior.persistenceScore);
  assert.ok(stressed.horizonMinutes<=45);
  assert.equal(stressed.pressureTarget,prior.pressureTarget,"fast pressure changes the usable window, not the formal environment family");
});

test("future environment support can remove fastLane without shortening the ordinary confirmation window",()=>{
  const normal=entryResponseWindowMs({score:96,edgeRatio:2.5,sourceCount:5,disagreementRate:.0004,mode:"CONTINUATION",fastLaneAllowed:false});
  const mainline=entryResponseWindowMs({score:96,edgeRatio:2.5,sourceCount:5,disagreementRate:.0004,mode:"CONTINUATION",fastLaneAllowed:true});
  assert.equal(normal.fastLane,false);assert.equal(normal.windowMs,180_000);
  assert.equal(mainline.fastLane,true);assert.equal(mainline.windowMs,180_000);
});

test("environment decay profit floor is wide, profit-only and inactive in long future windows",()=>{
  const protectedFloor=environmentDecayProfitFloor({peakFavorableRate:.032,originalStopRate:.012,modeFit:.30,horizonMinutes:15,costRate:.0019});
  assert.ok(protectedFloor>.012&&protectedFloor<.02,"15m low-fit decay should retain roughly half of proven net profit");
  assert.equal(environmentDecayProfitFloor({peakFavorableRate:.032,originalStopRate:.012,modeFit:.30,horizonMinutes:60,costRate:.0019}),0);
  assert.equal(environmentDecayProfitFloor({peakFavorableRate:.004,originalStopRate:.012,modeFit:.20,horizonMinutes:15,costRate:.0019}),0);
});

test("Probe-Prove-Expand entry path requires impulse, pullback and restart in that order",()=>{
  const base={side:"LONG" as const,price:100,bestAdvanceRate:.001,currentAdvanceRate:.001,retestSeen:false,
    impulseMin:.002,pullbackMin:.001,restartMin:.0008};
  assert.equal(environmentProbeRetestDecision(base).action,"WAIT_IMPULSE");
  assert.equal(environmentProbeRetestDecision({...base,bestAdvanceRate:.003,currentAdvanceRate:.0026}).action,"WAIT_PULLBACK");
  assert.equal(environmentProbeRetestDecision({...base,bestAdvanceRate:.003,currentAdvanceRate:.0018}).action,"SET_RETEST_BASE");
  assert.equal(environmentProbeRetestDecision({...base,retestSeen:true,retestBasePrice:100,price:99.95,bestAdvanceRate:.003,currentAdvanceRate:.0015}).action,"UPDATE_RETEST_BASE");
  assert.equal(environmentProbeRetestDecision({...base,retestSeen:true,retestBasePrice:99.95,price:99.99,bestAdvanceRate:.003,currentAdvanceRate:.0018}).action,"WAIT_RESTART");
  assert.equal(environmentProbeRetestDecision({...base,retestSeen:true,retestBasePrice:99.95,price:100.05,bestAdvanceRate:.003,currentAdvanceRate:.0022}).action,"READY");
});

test("environment performance memory bootstraps from historical losses and survives account reset",()=>{
  const history=Array.from({length:5},(_,i)=>({closedAt:T-i,netPnl:-5,plannedRisk:5,entryContext:{
    marketEvolutionPhase:"TRANSITIONAL" as const,mode:"REVERSAL"}}));
  const memory=normalizeEnvironmentPerformanceState(undefined,history,T);
  assert.ok(environmentPerformanceFactor(memory,"TRANSITION","TRANSITION_PROBE")<1);
  const state=initialForward(T);state.environmentPerformance=memory;
  const reset=resetForwardAccountPreservingLearning(state,T+1_000);
  assert.deepEqual(reset.environmentPerformance,memory);
});
