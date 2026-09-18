import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { advanceForward, initialForward, normalizeForward, BAR_MS, PAPER_COST,
  type ForwardState, type Trade } from "../lib/forward-relations.ts";
import { TIMELY_PROTECTION_POLICY, newExitControl, protectedExitDecision } from "../lib/forward-protection.ts";
import { prepareForwardWrite, readForwardStore } from "../lib/forward-store.ts";
import { forwardMirrorSources, buildProportionalMirror } from "../lib/live-parity.ts";

const T = 1_790_000_100_000;
function position(timely=true, side:Trade["side"]="LONG"):Trade {
  return {id:"synthetic-timing-fixture",symbol:"BTC_USDT",side,openedAt:T,closedAt:null,status:"OPEN",
    entryPrice:100,exitPrice:null,quantity:2,contracts:2000,quantoMultiplier:.001,notional:200,
    leverage:2,margin:100,plannedRisk:4.44,stopPrice:side==="LONG"?98:102,armPrice:side==="LONG"?101.5:98.5,
    favorable:0,adverse:0,lastPrice:100,lastQuoteAt:T,entryFee:.14,exitFee:0,fundingAllowance:0,
    grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:T,
    execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,...(timely?{exitControl:newExitControl()}:{}),
    rule:{id:"synthetic-rule",signature:"s",parentId:null,version:1,createdAt:T-1000,expiresAt:T+10*BAR_MS,
      status:"EXPERIMENTAL",conditions:[],side,horizon:60,stopRate:.02,armRate:.015,givebackRate:.007,
      exitMode:"REACTION_DECAY",samples:20,trainGroups:3,checkGroups:2,estimatedNetRate:.01,
      priorResponse:.02,recentResponse:.02,standardError:.003,reason:"Synthetic functional example, not market evidence",
      mutation:"CREATE",grammar:"fixture",liveEligible:false}};
}
function account(t=position()):ForwardState {
  const s=initialForward(T-3600000);s.balance=1000-t.entryFee;s.fees=t.entryFee;s.turnover=t.notional;
  s.lastCycleAt=T;s.lastFitAt=T;s.positions=[t];
  s.exitPolicyUpgrade={policy:TIMELY_PROTECTION_POLICY,at:T-1,equity:1000,balance:1000,resolved:0,inheritedPositionIds:[]};
  return s;
}
function step(s:ForwardState,dt:number,px:number,fresh=true,age=0){
  return advanceForward({state:s,now:T+dt,paths:{},contracts:{},
    quotes:{BTC_USDT:{bestBid:px,bestAsk:px+.01,observedAt:T+dt-age,fresh}}});
}

test("new long protection executes a confirmed early giveback without waiting five minutes",()=>{
  const a=step(account(),60000,102);assert.equal(a.state.positions.length,1);assert.equal(a.changed,true);
  const n=step(a.state,120000,101).state;assert.equal(n.positions.length,0);assert.equal(n.history[0].closedAt,T+120000);
  assert.equal(n.history[0].exitAudit!.trigger,"PROFIT_GIVEBACK");assert.ok(n.history[0].netPnl!>0);
  assert.equal(n.history[0].exitControl!.armedAt,T+60000);
  assert.equal(n.history[0].exitAudit!.executionPrice,101*(1-PAPER_COST.slippageRate));
});
test("new short protection has symmetric price/overshoot signs",()=>{
  const a=step(account(position(true,"SHORT")),60000,98).state;
  const n=step(a,120000,99).state,t=n.history[0];assert.ok(t.netPnl!>0);
  assert.equal(t.exitAudit!.trigger,"PROFIT_GIVEBACK");assert.ok(t.exitAudit!.overshootRate!>0);
  assert.ok(t.exitAudit!.triggerPrice!<t.exitPrice!);
});
test("inherited positions retain the original five-minute embargo and immutable geometry",()=>{
  const s=account(position(false)),old=structuredClone(s.positions[0].rule);
  const n=step(step(s,60000,102).state,120000,101).state;
  assert.equal(n.positions.length,1);assert.deepEqual(n.positions[0].rule,old);
  assert.equal(n.positions[0].exitControl,undefined);
  assert.equal(step(n,5*60000,101).state.history[0].exitReason,"反应回吐：有利波动后触发生成的回吐边界");
});
test("arming is not a fixed take-profit; a continuing trend keeps its whole position",()=>{
  let s=account();for(const [dt,px]of [[30000,101],[60000,102],[120000,103],[180000,104],[360000,105]]){
    s=step(s,dt,px).state;assert.equal(s.positions.length,1);assert.equal(s.positions[0].quantity,2);
  }
});
test("small alternating moves below the original arm do not produce new protection exits",()=>{
  let s=account();for(let i=1;i<=18;i++){s=step(s,i*10000,i%2?100.4:99.7).state;assert.equal(s.positions.length,1);}
  assert.equal(s.resolved,0);assert.equal(s.positions[0].exitControl!.armedAt,null);
});
test("giveback smaller than the original width does not trigger after arming",()=>{
  let s=step(account(),60000,102).state;s=step(s,120000,101.8).state;
  assert.equal(s.positions.length,1);assert.equal(s.positions[0].stopPrice,98);
});
test("HORIZON rules do not acquire a trailing-profit strategy",()=>{
  const t=position();t.rule.exitMode="HORIZON";
  const s=step(step(account(t),60000,102).state,120000,101).state;
  assert.equal(s.positions.length,1);assert.equal(s.positions[0].exitControl!.armedAt,null);
});
test("already confirmed opposite evidence does not wait for an extra fifteen-minute age",()=>{
  const t=position();t.relationFailureBars=2;
  assert.equal(protectedExitDecision(t,-.003,T+10*60000)?.trigger,"RELATION_CHANGE");
  const legacy=position(false);legacy.relationFailureBars=2;
  assert.equal(protectedExitDecision(legacy,-.003,T+10*60000),null);
});
test("one opposite completed bar or a single adverse quote is not a direction flip",()=>{
  const t=position();t.relationFailureBars=1;
  assert.equal(protectedExitDecision(t,-.003,T+10*60000),null);
  assert.equal(protectedExitDecision(t,-.01,T+10000),null);
});
test("repeated callbacks on one opposing bar cannot manufacture two confirmations",()=>{
  let s=account();s.frames.BTC_USDT={symbol:"BTC_USDT",at:T+BAR_MS,seenAt:T+BAR_MS,price:100,x:Array(8).fill(0)};
  const contrary=structuredClone(s.positions[0].rule);contrary.side="SHORT";
  contrary.evidence={policy:s.policyVersion!,scope:"CROSS_ASSET",symbols:["BTC_USDT"],sourceKey:"x",family:"x",cap:.02,
    rawNet:.01,costRate:.0022,quality:1,worstWithoutSymbol:0,
    calibration:{groups:0,effectiveGroups:0,penalty:0,meanResidual:0,meanNet:0,latestAt:0,sourceKey:"x"}};
  s.rules=[contrary];s.lastCycleAt=T+BAR_MS;s.lastFitAt=T+BAR_MS;
  for(const dt of [BAR_MS+10000,BAR_MS+20000,BAR_MS+30000]){
    s=step(s,dt,100).state;assert.equal(s.positions.length,1);assert.equal(s.positions[0].relationFailureBars,1);
  }
});
test("early source exit cannot reopen the same symbol within the same five-minute candle",()=>{
  const s=step(step(account(),60000,102).state,120000,101).state;
  assert.equal(s.lastEntryBars.BTC_USDT,Math.floor((T+120000)/BAR_MS)*BAR_MS);
  assert.equal(s.positions.length,0);assert.equal(s.resolved,1);
});
test("hard stop still precedes all profit/confirmation/holding-time conditions",()=>{
  const t=position();t.favorable=.03;t.relationFailureBars=2;
  assert.equal(protectedExitDecision(t,-.04,T+1000)?.trigger,"HARD_STOP");
  const s=step(account(t),1000,95).state;assert.ok(s.history[0].netPnl!<0);
});
test("a quote gap still books the real observed loss; audit is not an ideal stop fill",()=>{
  let s=step(account(),60000,102).state;s=step(s,120000,90).state;const t=s.history[0],a=t.exitAudit!;
  assert.equal(a.trigger,"HARD_STOP");assert.ok(t.exitPrice!<t.stopPrice);assert.ok(a.lossAbovePlan>0);
  assert.equal(a.observationGapMs,60000);assert.equal(a.quoteAgeMs,0);assert.equal(a.decisionAt,T+120000);
  assert.ok(Math.abs(s.balance-(1000+t.netPnl!))<1e-9);
});
test("stale and future quotes never arm, close or backdate a new-policy position",()=>{
  const s=account();const old=structuredClone(s.positions[0]);
  for(const a of [step(s,10000,90,true,9000),step(s,10000,90,false),step(s,10000,102,true,-2000)]){
    assert.deepEqual(a.state.positions[0],old);assert.equal(a.state.history.length,0);
  }
});
test("expiry still uses the original source open timestamp, not policy deployment",()=>{
  const s=account(),n=step(s,60*60000+1,100).state;
  assert.equal(n.history[0].exitAudit!.trigger,"HORIZON");assert.equal(n.history[0].openedAt,T);
});
test("policy installation is one-time, causes no refit/cold-start and does not modify inherited records",()=>{
  const s=account(position(false));delete s.exitPolicyUpgrade;s.lastCycleAt=T;s.lastFitAt=T;
  s.history=[{...position(false),id:"old-closed",status:"CLOSED",closedAt:T-10000,netPnl:-2}];
  const a=step(s,10000,100).state,b=step(a,20000,100).state;
  assert.equal(a.startedAt,s.startedAt);assert.equal(a.balance,s.balance);assert.equal(a.lastFitAt,s.lastFitAt);
  assert.equal(a.lastCycleAt,s.lastCycleAt);assert.deepEqual(a.history,s.history);assert.equal(a.positions[0].exitControl,undefined);
  assert.deepEqual(a.exitPolicyUpgrade,b.exitPolicyUpgrade);
  assert.equal(b.events.filter(e=>e.kind==="UPGRADE"&&e.subject===TIMELY_PROTECTION_POLICY).length,1);
});
test("new-policy arming and actual audit round-trip with the entire atomic source state",async()=>{
  const s=step(account(),60000,102).state,w=await prepareForwardWrite(null,s,T+60000);
  const db=new Map(Object.entries(w.entries));
  const restored=await readForwardStore({async get<V>(key:string){return db.get(key) as V|undefined;}},T+70000);
  assert.deepEqual(restored,s);const n=step(restored,120000,101).state;
  const final=await prepareForwardWrite(s,n,T+120000);
  for(const[k,v]of Object.entries(final.entries))db.set(k,v);
  assert.deepEqual(await readForwardStore({async get<V>(k:string){return db.get(k) as V|undefined;}},T+130000),n);
});
test("an unknown exit policy cannot silently overwrite a source account",()=>{
  const s=account();s.exitPolicyUpgrade!.policy="unknown";assert.throws(()=>step(s,10000,100),/未知/);
});
test("full new exit metadata and original geometry survive the LIVE adapter and binding",()=>{
  const s=account(),t=s.positions[0],view=forwardMirrorSources(s,1000);
  assert.deepEqual(view.BTC_USDT.forwardSource,t);const r=buildProportionalMirror({source:t,sourceEquity:1000,equity:100,
    available:100,entryPrice:100,quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,openRisk:0,
    sameDirectionRisk:0,openMargin:0,openNotional:0,now:T+1000,policy:s.policyVersion!,
    sizeRules:{enableDecimal:false,orderSizeMin:"1"}});
  assert.deepEqual(r.binding.sourceAtCopy.exitControl,t.exitControl);assert.deepEqual(r.binding.sourceAtCopy.rule,t.rule);
  assert.equal(r.intent.leverage,2);assert.equal(r.intent.notional,20);
});
test("a synthetic whipsaw can rebound after early exit: earlier protection is NOT a profit guarantee",()=>{
  let quick=step(account(),60000,102).state,legacy=step(account(position(false)),60000,102).state;
  quick=step(quick,120000,101).state;legacy=step(legacy,120000,101).state;
  assert.equal(quick.history.length,1);assert.equal(legacy.positions.length,1);
  legacy=step(legacy,3600000,105).state;assert.ok(legacy.history[0].netPnl!>quick.history[0].netPnl!);
});
test("rule evidence/discovery, owner and member execution bytes remain at the pre-patch baseline",()=>{
  const checks={"lib/forward-evidence.ts":"d586dbee7ada97df8948c830a9ffe8582f11e85ebb3376a45235e90c8fdc3ca3"};
  for(const[path,sha]of Object.entries(checks))assert.equal(createHash("sha256").update(readFileSync(new URL("../"+path,import.meta.url))).digest("hex"),sha);
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  assert.doesNotMatch(core,/GateLiveClient|setLiveMode\(|fetch\(|client\.close/);
  assert.match(core,/if\(dataDue\)openTrades/);assert.match(core,/now-s\.lastFitAt>=15\*60_000/);
  assert.equal(normalizeForward(account(),T).initialEquity,1000);
});