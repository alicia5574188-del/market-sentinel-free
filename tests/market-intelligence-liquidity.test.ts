import test from "node:test";
import assert from "node:assert/strict";
import {buildMarketLiquidityResearch,buildSymbolLiquidityMap} from "../lib/market-intelligence-liquidity.ts";
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
