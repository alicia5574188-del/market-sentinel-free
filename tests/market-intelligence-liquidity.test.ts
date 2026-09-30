import test from "node:test";
import assert from "node:assert/strict";
import {buildMarketLiquidityResearch,buildSymbolLiquidityMap,deriveRapidLiquidityAuthorization} from "../lib/market-intelligence-liquidity.ts";
import {buildMarketIntelligence,initialMarketIntelligenceState} from "../lib/market-intelligence-engine.ts";

const T=2_100_000_000_000;
type C={time:number;open:number;high:number;low:number;close:number;volume:number};

function rangeBase(n=96,center=100,amp=.65){
  const rows:C[]=[];let prior=center;
  for(let i=0;i<n;i++){
    const close=center+Math.sin(i*.82)*amp,open=prior,
      high=Math.max(open,close)+.28,low=Math.min(open,close)-.28,
      volume=900+(i%7===0?850:180)+(i%5)*35;
    rows.push({time:(T-(n+8-i)*300_000)/1000,open,high,low,close,volume});prior=close;
  }
  return rows;
}
function append(rows:C[],values:number[]){
  let prior=rows.at(-1)!.close;
  for(let i=0;i<values.length;i++){
    const close=values[i]!,open=prior;
    rows.push({time:(T-(values.length-i)*300_000)/1000,open,high:Math.max(open,close)+.22,low:Math.min(open,close)-.18,
      close,volume:1800+i*120});prior=close;
  }
  return rows;
}
function quote(px:number){return{bestBid:px*.99995,bestAsk:px*1.00005,observedAt:T,fresh:true,entryReady:true,
  sourceCount:4,disagreementRate:.0002,sourceBreadth:.8,directionalAgreement:.9,medianShortMove:.001};}

test("liquidity map refuses to invent zones without enough completed 5m history",()=>{
  const map=buildSymbolLiquidityMap(rangeBase(60),T);
  assert.equal(map.ready,false);
  assert.equal(map.globalZones.length,0);
  assert.match(map.reason,/至少需要72根/);
});

test("multi-scale liquidity map recognizes accepted departure from a repeatedly traded region",()=>{
  const rows=append(rangeBase(),[101.55,102.05,102.55,102.95]);
  const map=buildSymbolLiquidityMap(rows,T);
  assert.equal(map.ready,true);
  assert.ok(map.globalZones.length>=1);
  assert.ok(map.activeZone,"departure must retain the recently traded origin zone");
  assert.equal(map.departure.side,"UP");
  assert.equal(map.departure.state,"ACCEPTED");
  assert.ok(map.departure.confidence>=.60);
  assert.ok(map.activeZone!.strength>=.30);
});

test("a failed excursion that returns into the density region is classified as rejection, not trend",()=>{
  const rows=append(rangeBase(),[102.45,100.45]);
  const map=buildSymbolLiquidityMap(rows,T);
  assert.equal(map.ready,true);
  assert.ok(map.activeZone);
  assert.equal(map.departure.state,"REJECTED");
  assert.equal(map.departure.side,"UP");
  assert.ok(map.departure.confidence>=.60);
});

test("whole-market liquidity research distinguishes migration from accumulation without a new data feed",()=>{
  const paths:Record<string,C[]>={};
  for(let i=0;i<10;i++)paths["C"+i+"_USDT"]=append(rangeBase(96,100+i*.2),[101.55+i*.2,102.05+i*.2,102.55+i*.2,102.95+i*.2]);
  const research=buildMarketLiquidityResearch(paths,T);
  assert.equal(research.market.ready,true);
  assert.ok(research.market.acceptedShare>.5);
  assert.ok(research.market.migrationBreadth>.3);
});

test("relative strength alone stays observation-only when no liquidity migration/rejection/family-turn plan exists",()=>{
  const paths={
    BTC_USDT:rangeBase(96,100,.65),
    ETH_USDT:rangeBase(96,110,.70),
    SOL_USDT:rangeBase(96,90,.60)
  };
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,rows])=>[s,quote(rows.at(-1)!.close)]));
  const result=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-300_000),now:T});
  assert.ok(result.opportunities.length>=3);
  assert.ok(result.opportunities.every(o=>o.tradePlan==="OBSERVE_ONLY"));
  assert.ok(result.opportunities.every(o=>!o.eligible));
});


test("strong 1m departure can authorize migration early without redefining the larger liquidity zone",()=>{
  const map=buildSymbolLiquidityMap(rangeBase(),T);
  assert.ok(map.ready&&map.activeZone);
  const upper=map.activeZone!.upper,rows:C[]=[];
  const closes=[upper*.9978,upper*.9980,upper*.9982,upper*.9981,upper*.9984,upper*1.0065,upper*1.0082,upper*1.0094];
  let prior=closes[0]!*0.9998;
  for(let i=0;i<closes.length;i++){
    const close=closes[i]!,open=prior;
    rows.push({time:(T-(closes.length-i)*60_000)/1000,open,close,high:Math.max(open,close)*1.0005,low:Math.min(open,close)*.9995,volume:120+i*15});
    prior=close;
  }
  const rapid=deriveRapidLiquidityAuthorization({map,minuteRows:rows,price:upper*1.0100,now:T});
  assert.equal(rapid.ready,true);
  assert.equal(rapid.side,"UP");
  assert.ok(rapid.outsideMinutes>=2);
  assert.ok(rapid.confidence>=.62);
  assert.match(rapid.reason,/提前授权/);
  assert.equal(map.departure.state,"INSIDE","1m execution evidence must not rewrite the completed-5m liquidity map itself");
});

test("a one-minute spike that re-enters the origin zone cannot receive rapid migration authority",()=>{
  const map=buildSymbolLiquidityMap(rangeBase(),T);
  assert.ok(map.ready&&map.activeZone);
  const upper=map.activeZone!.upper,rows:C[]=[];
  const closes=[upper*.9980,upper*.9981,upper*.9982,upper*.9983,upper*1.0070,upper*.9990,upper*1.0010,upper*1.0040];
  let prior=closes[0]!*0.9999;
  for(let i=0;i<closes.length;i++){
    const close=closes[i]!,open=prior;
    rows.push({time:(T-(closes.length-i)*60_000)/1000,open,close,high:Math.max(open,close)*1.0004,low:Math.min(open,close)*.9996,volume:120+i*10});
    prior=close;
  }
  const rapid=deriveRapidLiquidityAuthorization({map,minuteRows:rows,price:upper*1.0045,now:T});
  assert.equal(rapid.ready,false);
  assert.match(rapid.reason,/重新收回|证据还不完整/);
});
