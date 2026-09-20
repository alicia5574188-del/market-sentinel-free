import test from "node:test";
import assert from "node:assert/strict";
import { advanceForward, initialForward, forwardEquity, PAPER_COST, type ForwardState, type Trade } from "../lib/forward-relations.ts";
import { newExitControl } from "../lib/forward-protection.ts";
import { marketRiskBudget, updateMarketState, updateTurnForecast } from "../lib/forward-market-state.ts";
import { type MarketTurnProtection } from "../lib/forward-turn-protection.ts";
import { buildForwardProtectionCheckpoint, restoreForwardProtectionCheckpoint, forwardProtectionChanged } from "../lib/forward-protection-checkpoint.ts";

const T=1_790_100_000_000;
function position(id="p",side:Trade["side"]="LONG",risk=10):Trade {
  return {id,symbol:`${id}_USDT`,side,openedAt:T,closedAt:null,status:"OPEN",entryPrice:100,exitPrice:null,
    quantity:2,contracts:2000,quantoMultiplier:.001,notional:200,leverage:2,margin:100,
    plannedRisk:risk,stopPrice:side==="LONG"?95.22:104.78,armPrice:side==="LONG"?101.5:98.5,
    favorable:0,adverse:0,lastPrice:100,lastQuoteAt:T,entryFee:.14,exitFee:0,fundingAllowance:0,
    grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:T,
    execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,exitControl:newExitControl(),
    rule:{id:`r-${id}`,signature:id,parentId:null,version:1,createdAt:T-1000,expiresAt:T+3600000,
      status:"EXPERIMENTAL",conditions:[],side,horizon:60,stopRate:.0478,armRate:.015,givebackRate:.007,
      exitMode:"REACTION_DECAY",samples:20,trainGroups:3,checkGroups:2,estimatedNetRate:.01,
      priorResponse:.02,recentResponse:.02,standardError:.003,reason:"Synthetic correctness fixture, not profit evidence",
      mutation:"CREATE",grammar:"fixture",liveEligible:false}};
}
function account(positions=[position()]):ForwardState {
  const s=initialForward(T-3600000);s.positions=positions;s.lastCycleAt=T+90000;s.lastFitAt=T+90000;
  s.storage.persistedAt=T+90000;
  s.exitPolicyUpgrade={policy:"timely-protection-v1",at:T-1,equity:1000,balance:1000,resolved:0,inheritedPositionIds:[]};
  return s;
}
function turn(side:Trade["side"]):MarketTurnProtection {
  return {version:"market-turn-shield-v1",threatenedSide:side,detectedAt:T+90000,completedBarAt:T,
    until:T+900000,markets:12,adverseShare:1,strongAdverseShare:1,medianAdverseMove:.01,
    medianAcceleration:3,directionalRiskRate:.06,concentration:1,reason:"Synthetic correctness fixture"};
}
function step(s:ForwardState,dt=100000,prices:number|Record<string,number>=99.8,stale:string[]=[]){
  return advanceForward({state:s,now:T+dt,paths:{},contracts:{},quotes:Object.fromEntries(s.positions.map(t=>{
    const px=typeof prices==="number"?prices:prices[t.id]??100;
    return[t.symbol,{bestBid:px,bestAsk:px+.01,observedAt:T+dt,fresh:!stale.includes(t.id)}];
  }))});
}
function neutral(s:ForwardState){s.marketState={...updateMarketState({},null,T),mode:"NEUTRAL",rawMode:"NEUTRAL",markets:12,observedAt:T+90000};return s;}

for(const side of ["LONG","SHORT"] as const){
  test(`${side}: two risk reducers act on one remaining portfolio, not twice on original risk`,()=>{
    const base=neutral(account(Array.from({length:6},(_,i)=>position(`p${i}`,side))));
    const price=side==="LONG"?99.8:100.2;
    const onlyState=step(base,100000,price).state;
    const both=step({...base,turnProtection:turn(side)},100000,price).state;
    assert.equal(onlyState.positions.length,1);assert.equal(both.positions.length,1);
    assert.deepEqual(both.positions.map(p=>p.id),onlyState.positions.map(p=>p.id));
    assert.equal(both.resolved,5);assert.equal(new Set(both.history.map(t=>t.id)).size,5);
    assert.equal(both.history.filter(t=>t.exitAudit?.trigger==="MARKET_TURN").length,3);
    assert.equal(both.history.filter(t=>t.exitAudit?.trigger==="MARKET_STATE").length,2);
  });
  test(`${side}: an already-due protected winner does not force an unrelated extra portfolio exit`,()=>{
    const due=position("due",side,12),keep=position("keep",side,12);
    due.openedAt=T-3600000;due.favorable=.02;due.rule.exitMode="HORIZON";
    const s=neutral(account([due,keep]));s.turnProtection=turn(side);
    const n=step(s,100000,{due:side==="LONG"?102:98,keep:side==="LONG"?99.8:100.2}).state;
    assert.deepEqual(n.positions.map(p=>p.id),["keep"]);
    assert.equal(n.history.length,1);assert.equal(n.history[0].exitAudit?.trigger,"HORIZON");
  });
  test(`${side}: normal stop has priority over overlapping portfolio reductions`,()=>{
    const s=neutral(account(Array.from({length:6},(_,i)=>position(`p${i}`,side))));s.turnProtection=turn(side);
    const prices=Object.fromEntries(s.positions.map((p,i)=>[p.id,i<3?(side==="LONG"?90:110):(side==="LONG"?99.8:100.2)]));
    const n=step(s,100000,prices).state;
    assert.equal(n.history.filter(p=>p.exitAudit?.trigger==="HARD_STOP").length,3);
    assert.equal(n.history.filter(p=>p.exitAudit?.trigger==="MARKET_TURN").length,0);
    assert.equal(n.positions.length,1);assert.equal(n.history.length,5);
  });
  test(`${side}: a newly observed protected peak survives restart with identical next exit`,()=>{
    const p=position("peak",side),base=step(account([p]),100000,side==="LONG"?102:98).state;
    const peak=step(base,110000,side==="LONG"?104:96);
    assert.equal(peak.changed,false);assert.equal(peak.protectionChanged,true);
    const overlay=buildForwardProtectionCheckpoint(peak.state);
    const restarted=restoreForwardProtectionCheckpoint(base,overlay);
    assert.deepEqual(restarted.positions,peak.state.positions);
    const price=side==="LONG"?103:97;
    const uninterrupted=step(peak.state,120000,price).state,afterRestart=step(restarted,120000,price).state;
    assert.equal(afterRestart.history[0].exitAudit?.trigger,"PROFIT_GIVEBACK");
    assert.deepEqual(afterRestart,uninterrupted);
    assert.equal(step(base,120000,price).state.positions.length,1,"old full checkpoint loses the newer peak");
  });
  test(`${side}: HORIZON account peak and 2.5% giveback preserve the same risk budget through both restarts`,()=>{
    const p=position("horizon",side);p.rule.exitMode="HORIZON";
    const full=step(neutral(account([p])),100000,side==="LONG"?102:98).state;
    const peak=step(full,110000,side==="LONG"?120:80);
    assert.equal(peak.changed,false);assert.equal(peak.protectionChanged,true);
    assert.equal(peak.state.positions[0].exitControl?.armedAt,null,"HORIZON never becomes a trailing exit");
    const peakOverlay=buildForwardProtectionCheckpoint(peak.state);
    const restartedPeak=restoreForwardProtectionCheckpoint(full,peakOverlay);
    assert.equal(restartedPeak.peakEquity,peak.state.peakEquity);
    const target=peak.state.peakEquity*.975,dt=120000;
    const funding=p.notional*PAPER_COST.fundingAllowancePerDay*dt/86400000;
    const price=side==="LONG"
      ?(target-full.balance+p.quantity*p.entryPrice+funding)/(p.quantity*(1-PAPER_COST.slippageRate)*(1-PAPER_COST.feeRate))
      :(full.balance+p.quantity*p.entryPrice-funding-target)/(p.quantity*(1+PAPER_COST.slippageRate)*(1+PAPER_COST.feeRate))-.01;
    const uninterrupted=step(peak.state,dt,price),afterRestart=step(restartedPeak,dt,price);
    assert.deepEqual(afterRestart,uninterrupted);
    assert.equal(afterRestart.changed,false);assert.equal(afterRestart.protectionChanged,true,"new maximum account drawdown is durable too");
    assert.equal(afterRestart.state.positions.length,1,"HORIZON geometry is unchanged");
    const quotes={[p.symbol]:{bestBid:price,bestAsk:price+.01,observedAt:T+dt,fresh:true}};
    const equity=forwardEquity(afterRestart.state,quotes,T+dt).equity;
    assert.ok(Math.abs(1-equity/afterRestart.state.peakEquity-.025)<1e-12);
    const budget=marketRiskBudget(afterRestart.state.marketState,equity,afterRestart.state.peakEquity);
    assert.equal(budget.totalRate,.05);assert.equal(budget.netDirectionalRate,.02);assert.equal(budget.allocationScale,.85);
    const lostPeakBudget=marketRiskBudget(full.marketState,equity,full.peakEquity);
    assert.equal(lostPeakBudget.totalRate,.05);assert.equal(lostPeakBudget.allocationScale,1,
      "losing the persisted peak would wrongly restore full new-entry allocation");
    const restoredDrawdown=restoreForwardProtectionCheckpoint(full,buildForwardProtectionCheckpoint(afterRestart.state));
    assert.equal(restoredDrawdown.maxDrawdown,afterRestart.state.maxDrawdown);
    assert.deepEqual(marketRiskBudget(restoredDrawdown.marketState,equity,restoredDrawdown.peakEquity),budget);
    assert.equal(restoredDrawdown.balance,full.balance);assert.deepEqual(restoredDrawdown.history,full.history);
    assert.deepEqual(restoredDrawdown.positions[0].rule,p.rule);
  });
}

test("already-planned opposite-side exit is removed from net risk before choosing additional cuts",()=>{
  const longs=[position("l0","LONG",15),position("l1","LONG",15)],short=position("short","SHORT",15);
  short.openedAt=T-3600000;short.rule.exitMode="HORIZON";
  const s=neutral(account([...longs,short]));
  const n=step(s,100000,{l0:99.8,l1:99.8,short:100}).state;
  assert.deepEqual(n.positions.map(p=>p.id),["l1"]);
  assert.equal(n.history.find(p=>p.id==="short")?.exitAudit?.trigger,"HORIZON");
  assert.equal(n.history.find(p=>p.id==="l0")?.exitAudit?.trigger,"MARKET_STATE");
});
test("incomplete account valuation retains portfolio risk without using stale marks to liquidate another position",()=>{
  const s=neutral(account(Array.from({length:6},(_,i)=>position(`p${i}`))));s.turnProtection=turn("LONG");
  const old=structuredClone(s.positions[0]),n=step(s,100000,99.8,["p0"]).state;
  assert.deepEqual(n.positions[0],old);assert.equal(n.positions.length,6);assert.equal(n.history.length,0);
  const recovered=step(n,110000,99.8).state;
  assert.equal(recovered.positions.length,1);assert.equal(recovered.history.length,5,"fresh valuation restores the original portfolio budget");
});
test("different stale fallback marks cannot change extra exits of fresh positions or suppress their own hard stop",()=>{
  const base=neutral(account(Array.from({length:6},(_,i)=>position(`p${i}`))));base.turnProtection=turn("LONG");
  const low=structuredClone(base),high=structuredClone(base);
  low.positions[0].lastPrice=10;high.positions[0].lastPrice=1000;
  const prices={p0:99.8,p1:90,p2:99.8,p3:99.8,p4:99.8,p5:99.8};
  const a=step(low,100000,prices,["p0"]).state,b=step(high,100000,prices,["p0"]).state;
  for(const n of [a,b]){
    assert.equal(n.history.length,1);assert.equal(n.history[0].id,"p1");
    assert.equal(n.history[0].exitAudit?.trigger,"HARD_STOP");assert.equal(n.positions.length,5);
    assert.equal(n.positions[0].lastQuoteAt,T,"stale position never acquires an invented quote or fill");
  }
  assert.deepEqual(a.history,b.history);assert.equal(a.balance,b.balance);
  const freshA=step(a,110000,99.8).state,freshB=step(b,110000,99.8).state;
  assert.deepEqual(freshA,freshB,"same executable valuation restores identical remaining-risk decisions after restart");
  assert.equal(freshA.positions.length,1);
});
for(const trigger of ["HORIZON","PROFIT_GIVEBACK","RELATION_CHANGE"] as const){
  test(`a stale portfolio mark does not suppress a fresh position's own ${trigger} exit`,()=>{
    const stale=position("stale"),fresh=position("fresh");
    if(trigger==="HORIZON")fresh.openedAt=T-3600000;
    if(trigger==="PROFIT_GIVEBACK")fresh.favorable=.03;
    if(trigger==="RELATION_CHANGE")fresh.relationFailureBars=2;
    const s=neutral(account([stale,fresh]));s.turnProtection=turn("LONG");
    const n=step(s,100000,100,["stale"]).state;
    assert.deepEqual(n.positions,[stale]);assert.equal(n.history.length,1);
    assert.equal(n.history[0].id,"fresh");assert.equal(n.history[0].exitAudit?.trigger,trigger);
  });
}
test("missing market observations do not turn a retained old regime label into new liquidation authority",()=>{
  const s=neutral(account(Array.from({length:6},(_,i)=>position(`p${i}`))));
  s.marketState=updateMarketState({},s.marketState,T+90000);
  assert.equal(s.marketState.mode,"NEUTRAL");assert.equal(s.marketState.rawMode,"UNKNOWN");
  const n=step(s).state;assert.equal(n.positions.length,6);assert.equal(n.history.length,0);
});
test("an UNKNOWN forecast retains entry caution but does not tighten existing-position exits",()=>{
  const s=neutral(account(Array.from({length:3},(_,i)=>position(`p${i}`,"LONG",6))));
  s.turnForecast={...updateTurnForecast({},null,T+90000),lastFreshPhase:"REVERSAL_RISK",threatenedSide:"LONG"};
  const n=step(s).state;assert.equal(n.positions.length,3);assert.equal(n.history.length,0);
});
test("previous valid classification expires after one normal evaluation interval without changing hard stops",()=>{
  const s=neutral(account([position("stopped"),position("kept")]));
  s.marketState!.observedAt=T-300000;
  const n=step(s,100000,{stopped:90,kept:99.8}).state;
  assert.deepEqual(n.positions.map(p=>p.id),["kept"]);
  assert.equal(n.history[0].exitAudit?.trigger,"HARD_STOP");
});
test("ordinary quotes inside saved account extrema and below the trail arm do not request another write",()=>{
  const a=account();a.peakEquity=1100;a.maxDrawdown=.1;
  for(const price of [100,100.3,99.8]){
    const n=step(a,100000,price);assert.equal(n.changed,false);assert.equal(n.protectionChanged,false);
  }
  const armed=step(a,100000,102).state;
  const n=step(armed,110000,101.9);assert.equal(n.protectionChanged,false);assert.equal(n.state.positions.length,1);
});
test("only actual finite increases of account extrema trigger protection persistence",()=>{
  const a=account();
  assert.equal(forwardProtectionChanged(a,structuredClone(a)),false);
  for(const field of ["peakEquity","maxDrawdown"] as const){
    for(const value of [a[field],a[field]-1,Number.NaN,Number.POSITIVE_INFINITY]){
      const unchanged=structuredClone(a);unchanged[field]=value;
      assert.equal(forwardProtectionChanged(a,unchanged),false);
    }
    const increased=structuredClone(a);increased[field]=a[field]+1e-10;
    assert.equal(forwardProtectionChanged(a,increased),true,"no hidden rounding/threshold may discard a real extremum");
  }
});
test("compact restart does not alter frozen rules, ledger, history or original legacy timing",()=>{
  const p=position();delete p.exitControl;
  const armed=step(account([p]),100000,102).state,peak=step(armed,110000,104).state;
  const overlay=buildForwardProtectionCheckpoint(peak),restored=restoreForwardProtectionCheckpoint(armed,overlay);
  assert.deepEqual(restored.positions[0].rule,p.rule);assert.equal(restored.positions[0].exitControl,undefined);
  assert.equal(restored.balance,armed.balance);assert.deepEqual(restored.history,armed.history);
  assert.equal(step(restored,120000,103).state.positions.length,1,"legacy five-minute embargo remains");
  assert.equal(step(restored,300000,103).state.history[0].exitReason,"反应回吐：有利波动后触发生成的回吐边界");
  assert.ok(JSON.stringify(overlay).length<1500,"bounded compact record, not the full research state");
});
test("confirmation progress survives restart, while repeated quote callbacks add no confirmations",()=>{
  const a=account(),b=structuredClone(a);
  b.positions[0].relationFailureBars=1;b.positions[0].lastRelationBar=T+60000;b.lastQuoteCycleAt=T+100000;
  assert.equal(forwardProtectionChanged(a,b),true);
  const restored=restoreForwardProtectionCheckpoint(a,buildForwardProtectionCheckpoint(b));
  assert.equal(restored.positions[0].relationFailureBars,1);
  assert.equal(step(restored,110000,100).state.positions[0].relationFailureBars,1);
});
test("stale checkpoints cannot contaminate another account, later full commit or replacement position",()=>{
  const a=step(account(),100000,102).state,b=step(a,110000,104).state,c=buildForwardProtectionCheckpoint(b);
  for(const base of [{...a,startedAt:a.startedAt+1},{...a,revision:a.revision+1},
    {...a,storage:{...a.storage,persistedAt:a.storage.persistedAt+1}}])
    assert.equal(restoreForwardProtectionCheckpoint(base,c),base);
  const obsolete={...c,baseRevision:c.baseRevision-1,version:"old-corrupt-format",positions:null};
  assert.equal(restoreForwardProtectionCheckpoint(a,obsolete),a,"a provably obsolete payload cannot poison a later full commit");
  const replaced=structuredClone(a);replaced.positions[0].openedAt++;
  assert.throws(()=>restoreForwardProtectionCheckpoint(replaced,c),/检查点异常/);
});
test("matching malformed checkpoint fails without mutating or resetting the account",()=>{
  const a=step(account(),100000,102).state,b=step(a,110000,104).state,c=buildForwardProtectionCheckpoint(b);
  const original=structuredClone(a);
  for(const mutate of [
    (v:typeof c)=>{v.positions[0].favorable=Number.NaN;},
    (v:typeof c)=>{v.positions[0].lastPrice=0;},
    (v:typeof c)=>{v.positions[0].lastQuoteAt=T+999999;},
    (v:typeof c)=>{v.positions[0].exitControl!.armedAt=null;},
    (v:typeof c)=>{v.positions.push(v.positions[0]);},
  ]){
    const bad=structuredClone(c);mutate(bad);assert.throws(()=>restoreForwardProtectionCheckpoint(a,bad),/检查点异常/);
    assert.deepEqual(a,original);
  }
});
test("checkpoint restoration copies only protection fields, never injected financial/strategy fields",()=>{
  const a=step(account(),100000,102).state,b=step(a,110000,104).state,c=buildForwardProtectionCheckpoint(b);
  Object.assign(c.positions[0],{quantity:1e9,plannedRisk:0,rule:{stopRate:1},status:"CLOSED"});
  Object.assign(c,{balance:1e9,rules:[],history:[]});
  const restored=restoreForwardProtectionCheckpoint(a,c);
  assert.equal(restored.balance,a.balance);assert.equal(restored.positions[0].quantity,a.positions[0].quantity);
  assert.equal(restored.positions[0].plannedRisk,a.positions[0].plannedRisk);assert.equal(restored.positions[0].status,"OPEN");
  assert.deepEqual(restored.positions[0].rule,a.positions[0].rule);
});
test("ordinary continuing trends keep all positions and unchanged rule/size geometry",()=>{
  let s=account([position("long","LONG"),position("short","SHORT")]);const original=structuredClone(s.positions);
  for(const [dt,change] of [[100000,.02],[110000,.03],[120000,.04]]){
    const n=step(s,dt,{long:100*(1+change),short:100*(1-change)});s=n.state;
    assert.equal(s.positions.length,2);assert.equal(s.resolved,0);
    for(let i=0;i<2;i++)for(const key of ["rule","quantity","contracts","plannedRisk","stopPrice","armPrice","leverage","notional"] as const)
      assert.deepEqual(s.positions[i][key],original[i][key]);
  }
});
