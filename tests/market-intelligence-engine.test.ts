import test from "node:test";
import assert from "node:assert/strict";
import {buildMarketIntelligence,initialMarketIntelligenceState,intelligenceExitDecision,MARKET_INTELLIGENCE_VERSION} from "../lib/market-intelligence-engine.ts";

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
    sourceCount:4,venueAgreement:.9,venuePressure:.4,reasons:[]};
  const hold=intelligenceExitDecision({side:"LONG",ageMin:90,signedRate:.012,peakFavorableRate:.018,firstProfit:true,stopRate:.009,stopped:false,
    profitFloorRate:0,expectedHoldMinutes:180,maxHoldMinutes:360,state:healthy});
  assert.equal(hold.reason,null);assert.ok(hold.floorCandidate>0);
  const broken={...healthy,longScore:35,shortScore:72,residualZ:-.8};
  const exit=intelligenceExitDecision({side:"LONG",ageMin:30,signedRate:-.003,peakFavorableRate:.002,firstProfit:false,stopRate:.009,stopped:false,
    profitFloorRate:0,expectedHoldMinutes:180,maxHoldMinutes:360,state:broken});
  assert.equal(exit.reason,"THESIS_INVALIDATED");
});
