import test from "node:test";
import assert from "node:assert/strict";
import { marketRiskBudget, selectDirectionalCandidates, sideRiskHeadroom, turnForecastEntryGuard, updateMarketState, updateTurnForecast } from "../lib/forward-market-state.ts";

const BAR=300_000,T=1_790_100_000_000;
function path(now:number,step:(i:number)=>number){
  const start=now/1000-13*300;let price=100;
  return Array.from({length:13},(_,i)=>{if(i)price*=1+step(i);return {time:start+i*300,close:price};});
}
function market(now:number,step:(i:number)=>number,n=12){
  return Object.fromEntries(Array.from({length:n},(_,i)=>[`M${i}_USDT`,path(now,j=>step(j+i*0))]));
}

test("15-minute broad weakness inside a still-positive 60-minute trend raises an early pullback warning",()=>{
  const latePullback=(i:number)=>i>=10?-.002:.0015;
  const f=updateTurnForecast(market(T,latePullback),null,T);
  assert.equal(f.phase,"PULLBACK");assert.equal(f.threatenedSide,"LONG");assert.ok(f.breadth15<.5);assert.ok(f.median60>0);
  const a=updateMarketState(market(T,()=>.0015),null,T),trend=updateMarketState(market(T+BAR,()=>.0015),a,T+BAR);
  const budget=marketRiskBudget(trend,1000,1000,f);
  assert.equal(budget.longRate,.03);assert.equal(budget.shortRate,.02);assert.equal(budget.totalRate,.06);assert.equal(budget.netDirectionalRate,.025);
});
test("pullback warning needs two clear completed bars before re-enabling the threatened direction",()=>{
  const latePullback=(i:number)=>i>=10?-.002:.0015;
  const f=updateTurnForecast(market(T,latePullback),null,T);
  const one=updateTurnForecast(market(T+BAR,()=>.0015),f,T+BAR);
  assert.equal(one.phase,"PULLBACK");assert.equal(one.clearBars,1);
  const two=updateTurnForecast(market(T+2*BAR,()=>.0015),one,T+2*BAR);
  assert.equal(two.phase,"CLEAR");
});
test("persistent severe short-term damage upgrades from pullback to reversal risk without instantly flipping the portfolio",()=>{
  const severe=(i:number)=>i>=10?-.004:.003;
  const one=updateTurnForecast(market(T,severe),null,T);
  assert.equal(one.phase,"PULLBACK");assert.equal(one.rawPhase,"REVERSAL_RISK");
  const two=updateTurnForecast(market(T+BAR,severe),one,T+BAR);
  assert.equal(two.phase,"REVERSAL_RISK");assert.equal(two.threatenedSide,"LONG");
  const budget=marketRiskBudget(null,960,1000,two);
  assert.equal(budget.longRate,.015);assert.equal(budget.totalRate,.04);assert.equal(budget.netDirectionalRate,.01);
});
test("turn forecast blocks adding to the threatened side and only permits short-horizon independent countertrend entries",()=>{
  const f=updateTurnForecast(market(T,i=>i>=10?-.002:.0015),null,T);
  assert.match(turnForecastEntryGuard(f,"LONG",15,null)??"",/暂不增加/);
  assert.equal(turnForecastEntryGuard(f,"SHORT",60,null),null);
  assert.match(turnForecastEntryGuard(f,"SHORT",180,null)??"",/180分钟/);
  const shortTrend={...updateMarketState(market(T,()=>-.0015),null,T),mode:"TREND_SHORT" as const};
  assert.equal(turnForecastEntryGuard(f,"SHORT",180,shortTrend),null);
});
test("broad trend requires confirmation but keeps the original 6.5% aligned risk budget",()=>{
  const p=market(T,()=>.0015),a=updateMarketState(p,null,T);
  assert.equal(a.mode,"UNKNOWN");assert.equal(a.rawMode,"TREND_LONG");
  const b=updateMarketState(market(T+BAR,()=>.0015),a,T+BAR);
  assert.equal(b.mode,"TREND_LONG");
  const budget=marketRiskBudget(b,1000,1000);
  assert.equal(budget.longRate,.065);assert.equal(budget.shortRate,.015);assert.equal(budget.totalRate,.075);
});
test("a strong opposite regime passes through TRANSITION instead of instant full reversal",()=>{
  const first=updateMarketState(market(T,()=>.0015),null,T);
  const long=updateMarketState(market(T+BAR,()=>.0015),first,T+BAR);
  const transition=updateMarketState(market(T+2*BAR,()=>-.0015),long,T+2*BAR);
  assert.equal(transition.mode,"TRANSITION");assert.equal(transition.rawMode,"TREND_SHORT");
  const short=updateMarketState(market(T+3*BAR,()=>-.0015),transition,T+3*BAR);
  assert.equal(short.mode,"TREND_SHORT");
});
test("wide alternating range confirms NEUTRAL and lowers net directional exposure",()=>{
  const oscillate=(i:number)=>i%2?.004:-.004;
  const a=updateMarketState(market(T,oscillate),null,T);
  assert.equal(a.rawMode,"NEUTRAL");
  const b=updateMarketState(market(T+BAR,oscillate),a,T+BAR);
  assert.equal(b.mode,"NEUTRAL");
  const budget=marketRiskBudget(b,1000,1000);
  assert.equal(budget.totalRate,.05);assert.equal(budget.longRate,.03);assert.equal(budget.shortRate,.03);
  assert.equal(budget.netDirectionalRate,.02);
});
test("profit giveback tightens transition/range budgets without changing trend caps",()=>{
  const transition={...updateMarketState(market(T,()=>.0015),null,T),mode:"TRANSITION" as const};
  const b=marketRiskBudget(transition,950,1000);
  assert.equal(b.totalRate,.05);assert.equal(b.longRate,.035);assert.equal(b.netDirectionalRate,.025);
  const trend={...transition,mode:"TREND_LONG" as const};
  const t=marketRiskBudget(trend,950,1000);
  assert.equal(t.longRate,.065);assert.equal(t.totalRate,.075);
});
test("opposite-side risk can reduce net exposure but cannot overshoot the regime cap",()=>{
  const neutral={...updateMarketState(market(T,(i)=>i%2?.004:-.004),null,T),mode:"NEUTRAL" as const};
  const b=marketRiskBudget(neutral,1000,1000);
  assert.equal(sideRiskHeadroom("SHORT",30,0,1000,b),20);
  assert.equal(sideRiskHeadroom("LONG",30,0,1000,b),0);
});
test("directional selection preserves the original top two and adds at most one qualified opposite family",()=>{
  const shared=[
    {side:"LONG" as const,evidence:{family:"L1"},score:3},
    {side:"LONG" as const,evidence:{family:"L2"},score:2},
    {side:"SHORT" as const,evidence:{family:"S1"},score:1},
    {side:"SHORT" as const,evidence:{family:"S2"},score:0},
  ];
  const selected=selectDirectionalCandidates(shared,2);
  assert.deepEqual(selected.map(x=>x.evidence.family),["L1","L2","S1"]);
  const mixed=selectDirectionalCandidates([shared[0],shared[2],shared[1]],2);
  assert.deepEqual(mixed.map(x=>x.evidence.family),["L1","S1"]);
});
