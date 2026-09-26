import test from "node:test";
import assert from "node:assert/strict";
import {buildMarketIntelligence,initialMarketIntelligenceState,intelligenceExitDecision,MARKET_INTELLIGENCE_VERSION} from "../lib/market-intelligence-engine.ts";
import {advanceForward,initialForward,resetForwardAccountPreservingLearning} from "../lib/forward-relations.ts";

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

test("trade lifecycle exits only when its own thesis degrades or risk boundary is hit",()=>{
  const healthy={symbol:"ETH_USDT",watchScore:80,regime:"DIVERGENT" as const,stage:"READY" as const,clusterId:"corr:BTC_USDT",
    correlation:.9,beta:1.1,volatility:.004,dataConfidence:90,actualMove:.01,expectedMove:.004,residual:.006,residualZ:1.2,
    residualPersistence:.9,relativeStrength:.7,longScore:82,shortScore:28,pathLong:.75,pathShort:.25,roomLong:.02,roomShort:.01,
    sourceCount:4,venueAgreement:.9,venuePressure:.4,reasons:[],signalSide:"LONG" as const,signalSince:T-600_000,signalBars:3,signalLastBar:T-300_000};
  const hold=intelligenceExitDecision({side:"LONG",ageMin:90,signedRate:.012,peakFavorableRate:.018,firstProfit:true,stopRate:.009,stopped:false,
    expectedHoldMinutes:180,maxHoldMinutes:450,invalidationBars:0,state:healthy});
  assert.equal(hold.reason,null);assert.equal(hold.floorCandidate,0,"Market Intelligence must never trail/lock profit");
  const broken={...healthy,longScore:35,shortScore:72,residualZ:-.8,signalSide:"SHORT" as const};
  const firstWarning=intelligenceExitDecision({side:"LONG",ageMin:30,signedRate:-.003,peakFavorableRate:.002,firstProfit:false,stopRate:.009,stopped:false,
    expectedHoldMinutes:180,maxHoldMinutes:450,invalidationBars:1,state:broken});
  assert.equal(firstWarning.reason,null,"one contradictory completed bar is observation, not an exit");
  const exit=intelligenceExitDecision({side:"LONG",ageMin:35,signedRate:-.003,peakFavorableRate:.002,firstProfit:false,stopRate:.009,stopped:false,
    expectedHoldMinutes:180,maxHoldMinutes:450,invalidationBars:2,state:broken});
  assert.equal(exit.reason,"THESIS_INVALIDATED");
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
  assert.match(reset.latestReason,/市场叙事、证据、相关组和异常生命周期保持连续/);
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
