import test from "node:test";
import assert from "node:assert/strict";
import { buildProportionalMirror, mirrorPositionRisk } from "../lib/live-parity.ts";
import { PAPER_COST, type Trade } from "../lib/forward-relations.ts";

const T=1_789_612_000_000;
const COST=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate)+PAPER_COST.fundingAllowancePerDay/24;
function source(side:"LONG"|"SHORT"="LONG"):Trade {
  return {id:`risk-${side}`,symbol:"BTC_USDT",side,openedAt:T-60_000,closedAt:null,status:"OPEN",
    entryPrice:100,exitPrice:null,quantity:2,contracts:2000,quantoMultiplier:.001,notional:200,
    leverage:2,margin:100,plannedRisk:200*(.02+COST),stopPrice:side==="LONG"?98:102,
    armPrice:side==="LONG"?101:99,favorable:0,adverse:0,lastPrice:100,lastQuoteAt:T,
    entryFee:.14,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,
    relationFailureBars:0,lastRelationBar:T-60_000,execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,
    rule:{id:"risk-rule",signature:"risk",parentId:null,version:1,createdAt:T-120_000,expiresAt:T+3_600_000,
      status:"EXPERIMENTAL",conditions:[],side,horizon:60,stopRate:.02,armRate:.01,givebackRate:.004,
      exitMode:"REACTION_DECAY",samples:20,trainGroups:3,checkGroups:2,estimatedNetRate:.002,
      priorResponse:.005,recentResponse:.004,standardError:.001,reason:"synthetic risk regression",
      mutation:"CREATE",grammar:"fixture",liveEligible:false}};
}
function input(t=source()):Parameters<typeof buildProportionalMirror>[0] {
  return {source:t,sourceEquity:1000,equity:1000,available:1000,entryPrice:100,
    quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,openRisk:0,sameDirectionRisk:0,
    openMargin:0,openNotional:0,now:T,policy:"risk-regression",mirrorRatio:1,sourceRiskAuthority:true,
    sizeRules:{enableDecimal:false,orderSizeMin:"1",orderSizeMax:"10000000"}};
}
function held(side:"LONG"|"SHORT"="LONG") {
  return {status:"OPEN",side,entryPrice:100,currentStop:side==="LONG"?98:102,notional:200,
    parity:{sourceOpenedAt:T-60_000,sourceDeadline:T+3_540_000}};
}
function near(actual:number,expected:number){assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);}

test("source authority preserves normal proportional quantity and source leverage",()=>{
  for(const side of ["LONG","SHORT"] as const){
    const i=input(source(side));i.equity=95;i.available=95;i.mirrorRatio=.1;
    i.openRisk=8;i.sameDirectionRisk=5;i.openMargin=74;i.openNotional=390;
    const {intent,binding}=buildProportionalMirror(i);
    assert.equal(intent.notional,20);assert.equal(intent.margin,10);assert.equal(intent.leverage,2);
    assert.equal(intent.size,side==="LONG"?200:-200);assert.equal(binding.receipt.ratio,.1);
    assert.deepEqual(binding.sourceAtCopy,i.source);
  }
});
test("source authority cannot bypass actual total risk with a source-safe new order",()=>{
  const i=input();i.openRisk=99;i.sameDirectionRisk=0;
  assert.throws(()=>buildProportionalMirror(i),/实际权益.*风险预算/);
});
test("both LONG and SHORT additions obey the unchanged 6.5% directional cap",()=>{
  for(const side of ["LONG","SHORT"] as const){
    const i=input(source(side));i.openRisk=64;i.sameDirectionRisk=64;
    assert.throws(()=>buildProportionalMirror(i),/实际权益.*风险预算/);
    i.sameDirectionRisk=20;assert.doesNotThrow(()=>buildProportionalMirror(i));
  }
});
test("frozen scale cannot use old mirror equity to cover actual-equity drift",()=>{
  const i=input();i.equity=950;i.openRisk=92;i.sameDirectionRisk=0;
  assert.throws(()=>buildProportionalMirror(i),/实际权益/);
  i.openRisk=90;const result=buildProportionalMirror(i);
  assert.equal(result.intent.notional,200);assert.equal(result.binding.receipt.ratio,1);
});
test("exact cap boundary is allowed; a real excess is not rounded away",()=>{
  const i=input(),risk=buildProportionalMirror(i).intent.plannedRisk;
  i.openRisk=100-risk;i.sameDirectionRisk=65-risk;
  assert.doesNotThrow(()=>buildProportionalMirror(i));
  i.sameDirectionRisk+=1e-6;assert.throws(()=>buildProportionalMirror(i),/风险预算/);
});
test("unresolved risk cannot be treated as zero",()=>{
  for(const field of ["openRisk","sameDirectionRisk"] as const){
    const i=input();i[field]=NaN;assert.throws(()=>buildProportionalMirror(i),/不完整/);
  }
});
test("risk uses actual quantity times mark-to-stop distance, not entry notional divided by mark",()=>{
  near(mirrorPositionRisk(held(),104),12+208*COST);
  near(mirrorPositionRisk(held("SHORT"),96),12+192*COST);
});
test("adverse floating PnL does not release the original remaining-quantity entry-risk floor",()=>{
  near(mirrorPositionRisk(held(),99),4+200*COST);
  near(mirrorPositionRisk(held("SHORT"),101),4+200*COST);
});
test("fractional partial fill and reduction scale the full risk model exactly once",()=>{
  const original=held();
  const partial={...original,notional:50};
  near(mirrorPositionRisk(partial,104),mirrorPositionRisk(original,104)/4);
  near(mirrorPositionRisk(partial,99),mirrorPositionRisk(original,99)/4);
});
test("requested close is still exposure until the exchange position is confirmed closed",()=>{
  const waiting={...held(),exitRequestedAt:T};
  near(mirrorPositionRisk(waiting,100),4+200*COST);
  assert.equal(mirrorPositionRisk({...waiting,status:"CLOSED"},100),0);
});
test("unknown held quantity, stop, quote or horizon remains unknown, not zero risk",()=>{
  for(const p of [{...held(),notional:NaN},{...held(),notional:0},{...held(),currentStop:NaN},
    {...held(),parity:undefined},{...held(),parity:{sourceOpenedAt:T,sourceDeadline:T}}])
    assert.ok(Number.isNaN(mirrorPositionRisk(p,100)));
  assert.ok(Number.isNaN(mirrorPositionRisk(held(),NaN)));
});
