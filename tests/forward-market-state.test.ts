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
  assert.ok(budget.longRate>0&&budget.longRate<.065);assert.ok(budget.shortRate>=.02);
  assert.ok(budget.totalRate>.06&&budget.totalRate<=.075);assert.ok(budget.netDirectionalRate>.025&&budget.netDirectionalRate<=.045);
  assert.equal(budget.allocationScale,1);
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
  assert.equal(budget.longRate,.02);assert.equal(budget.totalRate,.05);assert.equal(budget.netDirectionalRate,.015);
  assert.equal(budget.allocationScale,.7);
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
  const second=updateMarketState(market(T+3*BAR,()=>-.0015),transition,T+3*BAR);
  assert.equal(second.mode,"TRANSITION");assert.equal(second.candidateBars,2);assert.equal(second.candidateRequiredBars,3);
  const repeated=updateMarketState(market(T+3*BAR,()=>-.0015),second,T+3*BAR+10_000);
  assert.equal(repeated.mode,"TRANSITION");assert.equal(repeated.candidateBars,2);
  const short=updateMarketState(market(T+4*BAR,()=>-.0015),JSON.parse(JSON.stringify(repeated)),T+4*BAR);
  assert.equal(short.mode,"TREND_SHORT");
});
test("wide alternating range confirms NEUTRAL and lowers net directional exposure",()=>{
  const oscillate=(i:number)=>i%2?.004:-.004;
  const a=updateMarketState(market(T,oscillate),null,T);
  assert.equal(a.rawMode,"NEUTRAL");
  const b=updateMarketState(market(T+BAR,oscillate),a,T+BAR);
  assert.equal(b.mode,"NEUTRAL");
  const budget=marketRiskBudget(b,1000,1000);
  assert.equal(budget.totalRate,.055);assert.equal(budget.longRate,.0325);assert.equal(budget.shortRate,.0325);
  assert.equal(budget.netDirectionalRate,.025);
});
test("drawdown scales new allocation without tightening regime caps into a trading pause",()=>{
  const transition={...updateMarketState(market(T,()=>.0015),null,T),mode:"TRANSITION" as const};
  const b=marketRiskBudget(transition,950,1000);
  assert.equal(b.totalRate,.065);assert.equal(b.longRate,.045);assert.equal(b.netDirectionalRate,.035);
  assert.equal(b.allocationScale,.7);
  const trend={...transition,mode:"TREND_LONG" as const};
  const t=marketRiskBudget(trend,950,1000);
  assert.equal(t.longRate,.065);assert.equal(t.totalRate,.075);assert.equal(t.allocationScale,.7);
  assert.ok(t.allocationScale>0);
});
test("opposite-side risk can reduce net exposure but cannot overshoot the regime cap",()=>{
  const neutral={...updateMarketState(market(T,(i)=>i%2?.004:-.004),null,T),mode:"NEUTRAL" as const};
  const b=marketRiskBudget(neutral,1000,1000);
  assert.equal(sideRiskHeadroom("SHORT",30,0,1000,b),25);
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

for(const side of ["LONG","SHORT"] as const){
  const direction=side==="LONG"?1:-1,other=side==="LONG"?"SHORT":"LONG";
  const warning=(i:number)=>direction*(i>=10?-.004:.003);
  test(`${side}: missing breadth is UNKNOWN, not recovery, and never freezes both directions`,()=>{
    const before=updateTurnForecast(market(T,warning),null,T);
    assert.equal(before.threatenedSide,side);
    const missing=updateTurnForecast(market(T+BAR,warning,7),before,T+BAR);
    assert.equal(missing.phase,"UNKNOWN");assert.equal(missing.fresh,false);
    assert.equal(missing.threatenedSide,side);assert.equal(missing.clearBars,0);
    assert.match(turnForecastEntryGuard(missing,side,60,null)??"",/数据未知/);
    assert.equal(turnForecastEntryGuard(missing,other,60,null),null);
    // Missing observations preserve, rather than relax, the entry budget. The
    // position manager independently requires fresh evidence before reducing.
    const beforeBudget=marketRiskBudget(null,1000,1000,before),unknownBudget=marketRiskBudget(null,1000,1000,missing);
    for(const field of ["totalRate","longRate","shortRate","netDirectionalRate"] as const)
      assert.equal(unknownBudget[field],beforeBudget[field]);
    const recoveredOne=updateTurnForecast(market(T+2*BAR,()=>direction*.003),missing,T+2*BAR);
    assert.notEqual(recoveredOne.phase,"CLEAR");assert.equal(recoveredOne.clearBars,1);
    const recoveredTwo=updateTurnForecast(market(T+3*BAR,()=>direction*.003),recoveredOne,T+3*BAR);
    assert.equal(recoveredTwo.phase,"CLEAR");assert.equal(turnForecastEntryGuard(recoveredTwo,side,60,null),null);
  });
  test(`${side}: a chronological trend reversal cannot masquerade as recovery when 60-minute context changes sign`,()=>{
    let price=100;
    const tape=Array.from({length:35},(_,i)=>{
      price*=1+direction*(i<16?.003:-.004);
      return {time:T/1000+(i-13)*300,close:price};
    });
    let forecast:ReturnType<typeof updateTurnForecast>|null=null;
    let state:ReturnType<typeof updateMarketState>|null=null;
    let warned=false,confirmed=false;
    for(let i=12;i<tape.length;i++){
      const now=(tape[i].time+300)*1000;
      const paths=Object.fromEntries(Array.from({length:12},(_,n)=>[`M${n}_USDT`,tape.slice(0,i+1)]));
      forecast=updateTurnForecast(paths,forecast,now);state=updateMarketState(paths,state,now);
      if(forecast.threatenedSide===side)warned=true;
      if(warned){
        assert.notEqual(forecast.phase,"CLEAR",`unexpected recovery at bar ${i}`);
        assert.ok(turnForecastEntryGuard(forecast,side,60,state));
        assert.equal(turnForecastEntryGuard(forecast,other,60,state),null);
      }
      if(forecast.reversalConfirmed){
        confirmed=true;assert.equal(forecast.phase,"REVERSAL_RISK");
        assert.equal(forecast.threatenedSide,side);assert.match(forecast.reason,/反转确认/);
      }
    }
    assert.ok(warned);assert.ok(confirmed);
    assert.equal(state!.mode,other==="LONG"?"TREND_LONG":"TREND_SHORT");
    assert.equal(turnForecastEntryGuard(forecast,other,180,state),null);
  });
  test(`${side}: two genuinely neutral observations release the warning without selecting a trade side`,()=>{
    const before=updateTurnForecast(market(T,warning),null,T);
    const range=(i:number)=>i%2?.004:-.004;
    const one=updateTurnForecast(market(T+BAR,range),before,T+BAR);
    assert.equal(one.clearBars,1);assert.equal(one.threatenedSide,side);
    const two=updateTurnForecast(market(T+2*BAR,range),one,T+2*BAR);
    assert.equal(two.phase,"CLEAR");assert.equal(two.threatenedSide,null);
    assert.equal(turnForecastEntryGuard(two,"LONG",60,null),null);
    assert.equal(turnForecastEntryGuard(two,"SHORT",60,null),null);
  });
}

test("cold UNKNOWN has no invented threatened direction or blanket entry veto",()=>{
  const f=updateTurnForecast({},null,T);
  assert.equal(f.phase,"UNKNOWN");assert.equal(f.threatenedSide,null);assert.equal(f.fresh,false);
  for(const side of ["LONG","SHORT"] as const)assert.equal(turnForecastEntryGuard(f,side,180,null),null);
});

test("duplicate callbacks cannot confirm a trend, escalate a warning or count as two recovery bars",()=>{
  const trending=market(T,()=>.003),firstState=updateMarketState(trending,null,T);
  const state=updateMarketState(trending,firstState,T+10_000);
  assert.equal(state.mode,"UNKNOWN");assert.equal(state.candidateBars,1);
  const severe=market(T,i=>i>=10?-.004:.003),warning=updateTurnForecast(severe,null,T);
  const duplicate=updateTurnForecast(severe,warning,T+10_000);
  assert.equal(duplicate.phase,"PULLBACK");assert.equal(duplicate.confirmations,1);
  const restored=market(T+BAR,()=>.003),one=updateTurnForecast(restored,warning,T+BAR);
  const again=updateTurnForecast(restored,one,T+BAR+10_000);
  assert.equal(again.phase,"PULLBACK");assert.equal(again.clearBars,1);
  assert.equal(updateTurnForecast(market(T+2*BAR,()=>.003),again,T+2*BAR).phase,"CLEAR");
});

test("missing or skipped completed bars break consecutive recovery and trend confirmation",()=>{
  const f=updateTurnForecast(market(T,i=>i>=10?-.004:.003),null,T);
  const one=updateTurnForecast(market(T+BAR,()=>.003),f,T+BAR);
  const skipped=updateTurnForecast(market(T+3*BAR,()=>.003),one,T+3*BAR);
  assert.equal(skipped.clearBars,1);assert.notEqual(skipped.phase,"CLEAR");
  const first=updateMarketState(market(T,()=>.003),null,T);
  const unknown=updateMarketState({},first,T+BAR);
  const next=updateMarketState(market(T+2*BAR,()=>.003),unknown,T+2*BAR);
  assert.equal(next.mode,"UNKNOWN");assert.equal(next.candidateBars,1);
});

test("switching the threatened side is confirmed on two distinct bars without an intervening CLEAR",()=>{
  const long=updateTurnForecast(market(T,i=>i>=10?-.004:.003),null,T);
  const shortWarning=(i:number)=>i>=10?.004:-.003;
  const first=updateTurnForecast(market(T+BAR,shortWarning),long,T+BAR);
  assert.equal(first.threatenedSide,"LONG");assert.equal(first.candidateSide,"SHORT");
  assert.notEqual(first.phase,"CLEAR");
  const duplicate=updateTurnForecast(market(T+BAR,shortWarning),first,T+BAR+10_000);
  assert.equal(duplicate.candidateBars,1);assert.equal(duplicate.threatenedSide,"LONG");
  const second=updateTurnForecast(market(T+2*BAR,shortWarning),duplicate,T+2*BAR);
  assert.equal(second.threatenedSide,"SHORT");assert.equal(second.phase,"PULLBACK");
  assert.equal(turnForecastEntryGuard(second,"LONG",60,null),null);
});

test("persisted v1 forecasts without new optional fields retain their warning through data loss",()=>{
  const current=updateTurnForecast(market(T,i=>i>=10?-.004:.003),null,T);
  const legacy=JSON.parse(JSON.stringify(current)) as typeof current;
  delete legacy.completedBarAt;delete legacy.lastFreshPhase;delete legacy.reversalConfirmed;
  const unknown=updateTurnForecast({},legacy,T+BAR);
  const roundTrip=JSON.parse(JSON.stringify(unknown)) as typeof unknown;
  assert.equal(roundTrip.phase,"UNKNOWN");assert.equal(roundTrip.threatenedSide,"LONG");
  const fresh=updateTurnForecast(market(T+2*BAR,()=>-.004),roundTrip,T+2*BAR);
  assert.equal(fresh.phase,"REVERSAL_RISK");assert.equal(fresh.threatenedSide,"LONG");
});

test("gap, duplicate, out-of-order, invalid and unsynchronized candles cannot vote as a current 60-minute path",()=>{
  const base=market(T,i=>i>=10?-.004:.003);
  const corruptions:Record<string,(rows:ReturnType<typeof path>)=>ReturnType<typeof path>>={
    tenMinuteGap:rows=>rows.map((r,i)=>({...r,time:r.time-(12-i)*300})),
    duplicate:rows=>rows.map((r,i)=>i===8?{...r,time:rows[7].time}:r),
    outOfOrder:rows=>rows.map((r,i)=>i===7?rows[8]:i===8?rows[7]:r),
    shiftedClock:rows=>rows.map(r=>({...r,time:r.time-60})),
    invalidClose:rows=>rows.map((r,i)=>i===8?{...r,close:NaN}:r),
    stale:rows=>rows.map(r=>({...r,time:r.time-300})),
  };
  for(const [name,corrupt] of Object.entries(corruptions)){
    const paths=Object.fromEntries(Object.entries(base).map(([name,rows])=>[name,corrupt(rows)]));
    const forecast=updateTurnForecast(paths,null,T),state=updateMarketState(paths,null,T);
    assert.equal(forecast.fresh,false,name);assert.equal(forecast.phase,"UNKNOWN",name);
    assert.equal(state.rawMode,"UNKNOWN",name);assert.equal(forecast.markets,0,name);
  }
  const partial=Object.fromEntries(Object.entries(base).map(([name,rows],i)=>[name,i<7?rows:corruptions.shiftedClock(rows)]));
  assert.equal(updateTurnForecast(partial,null,T).markets,7);
  assert.equal(updateTurnForecast(partial,null,T).fresh,false);
  partial.M7_USDT=base.M7_USDT;
  assert.equal(updateTurnForecast(partial,null,T).markets,8);
  assert.equal(updateTurnForecast(partial,null,T).fresh,true);
});

test("unfinished future candle is not an observation and cannot alter the completed-path forecast",()=>{
  const base=market(T,i=>i>=10?-.004:.003);
  const future=Object.fromEntries(Object.entries(base).map(([name,rows])=>[name,[...rows,{time:T/1000,close:1}]]));
  assert.deepEqual(updateTurnForecast(future,null,T),updateTurnForecast(base,null,T));
});
