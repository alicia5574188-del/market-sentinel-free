import test from "node:test";
import assert from "node:assert/strict";
import {buildMarketIntelligence,initialMarketIntelligenceState,MARKET_INTELLIGENCE_VERSION} from "../lib/market-intelligence-engine.ts";
import {evaluatePositionIntelligence} from "../lib/position-intelligence-engine.ts";
import {entryResponseWindowMs,evaluateEntryResponse} from "../lib/market-intelligence-entry-response.ts";
import {advanceForward,extremeResidualConfirmationProfile,fillForwardPortfolio,initialForward,resetForwardAccountPreservingLearning} from "../lib/forward-relations.ts";

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
  const profile=entryResponseWindowMs({score:90.3,edgeRatio:3.43,sourceCount:3,disagreementRate:.0003});
  assert.equal(profile.fastLane,true);assert.equal(profile.windowMs,180_000);
  const memory={startedAt:T,deadlineAt:T+profile.windowMs,initialPrice:100,samples:1,bestAdvanceRate:0,maxAdverseRate:0,supportSamples:0,oppositionSamples:0};
  const first=evaluateEntryResponse({now:T+24_000,side:"LONG",score:90.3,edgeRatio:3.43,pullbackRiskRate:.0056,stopRate:.0066,
    sourceCount:3,disagreementRate:.0003,price:100.11,memory,state,quote});
  assert.equal(first.action,"WAIT");assert.equal(first.supportSamples,1);
  const second=evaluateEntryResponse({now:T+26_000,side:"LONG",score:90.3,edgeRatio:3.43,pullbackRiskRate:.0056,stopRate:.0066,
    sourceCount:3,disagreementRate:.0003,price:100.13,
    memory:{...memory,samples:2,bestAdvanceRate:first.bestAdvanceRate,maxAdverseRate:first.maxAdverseRate,
      supportSamples:first.supportSamples,oppositionSamples:first.oppositionSamples},
    state,quote:{...quote,observedAt:T+26_000}});
  assert.equal(second.action,"PASS");assert.ok(second.supportFamilies.includes("PRICE"));assert.ok(second.supportFamilies.includes("THESIS"));
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
  assert.ok(second.opportunities.some(o=>o.eligible),"fixture must contain a mature executable opportunity");

  const prior=initialForward(T-600_000);
  prior.extremumRegime=second.state;prior.marketPulse=second.pulse;prior.opportunities=second.opportunities;
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
  const opportunity=second.opportunities.find(o=>o.eligible&&o.thesisId);
  assert.ok(opportunity?.thesisId,"fixture must produce an executable persistent thesis");
  const s=initialForward(T-600_000);s.extremumRegime=second.state;s.opportunities=[opportunity!];
  s.consumedTheses[opportunity!.thesisId!]=now-60_000;
  const contracts={[opportunity!.symbol]:{quantoMultiplier:.001,leverageMax:10,maintenanceRate:.005,minContracts:1}};
  const opened=fillForwardPortfolio(s,{[opportunity!.symbol]:shiftQuotes[opportunity!.symbol]!},contracts,now,1000,false);
  assert.equal(opened,0);
  assert.equal(s.positions.length,0,"thesis dedupe must survive even after the full closed trade leaves hot history");
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
