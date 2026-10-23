/**
 * Fixed paper notional for unified-pool orders: stops / leverage / take-profit prices stay price-percentage rules and identical to the
 * original sizing; only the size actually traded changes. Records carry notional_fixed / sizing_notional_virtual / sizing_risk_virtual.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {FIXED_NOTIONAL_CFG,fixedNotionalActive,fixedTargetNotional,virtualSizing} from "../lib/fixed-notional.ts";
import {advanceForward,gateRisk,type ForwardState} from "../lib/forward-relations.ts";
import {htfPaperLeverage} from "../lib/paper-leverage.ts";
import {livingFields} from "../lib/living/run-log-fields.ts";
import {slimPosition} from "../lib/living/runlog-export.ts";
import {PRED_ALLOC} from "../lib/dynamic/allocator.ts";
import type {LivingDirective,LivingOrder} from "../lib/living/directive.ts";
import {allItems} from "../lib/living/config.ts";
import {runForward,simInputs,GOLDEN_SYMBOLS} from "./living/forward-sim.ts";
import {bj} from "./living/fixture.ts";

const RT=.0019;
test("default is fixed 500 U, gates on the original (virtual) size, no extra cap; only pool-style notes (hx / bh) are covered",()=>{
  assert.deepEqual({...FIXED_NOTIONAL_CFG},{usdt:500,gates:"virtual",maxRiskRate:null});
  assert.equal(fixedNotionalActive(FIXED_NOTIONAL_CFG,{hx:1}),true);assert.equal(fixedNotionalActive(FIXED_NOTIONAL_CFG,{bh:1}),true);
  assert.equal(fixedNotionalActive(FIXED_NOTIONAL_CFG,{}),false,"ordinary living orders keep the original sizing");
  assert.equal(fixedNotionalActive({...FIXED_NOTIONAL_CFG,usdt:0},{hx:1}),false,"usdt 0 switches it off");
});
test("pure sizing: virtual gates keep 500; actual gates shrink to the headroom; maxRiskRate caps the real risk; virtual size keeps the original risk",()=>{
  const i={equity:960,stopRate:.3,costRate:RT,virtualNotional:13,gateHeadroomNotional:240};
  assert.equal(fixedTargetNotional({usdt:500,gates:"virtual",maxRiskRate:null},i),500);
  assert.equal(fixedTargetNotional({usdt:500,gates:"actual",maxRiskRate:null},i),240);
  assert.equal(fixedTargetNotional({usdt:500,gates:"actual",maxRiskRate:null},{...i,gateHeadroomNotional:5000}),500);
  const cap=fixedTargetNotional({usdt:500,gates:"virtual",maxRiskRate:.02},i);
  assert.ok(Math.abs(cap*(i.stopRate+RT)-.02*960)<1e-9);
  const v=virtualSizing(13,.3,RT,1);assert.ok(Math.abs(v.risk-13*(.3+RT))<1e-12);assert.equal(v.margin,13);
});
test("slim export keeps the fixed-notional columns; livingFields writes them only for fixed orders",()=>{
  const n={v:"living-v2",k:"N",pb:"p",hx:1,dp:1,inv:9,fx:500,szn:13.2,szr:4.1};
  const f=livingFields(n,null);assert.equal(f.notional_fixed,500);assert.equal(f.sizing_notional_virtual,13.2);assert.equal(f.sizing_risk_virtual,4.1);
  assert.equal(livingFields({...n,fx:undefined,szn:undefined,szr:undefined},null).notional_fixed,undefined,"older rows are unchanged");
  const row=slimPosition({id:"a",notional:500,...f,junk:1});assert.equal(row.notional_fixed,500);assert.equal(row.sizing_notional_virtual,13.2);assert.equal(row.junk,undefined);
});

let base:ForwardState|null=null;
function forwardStart(){
  if(!base)runForward({from:bj("10-19 05:20"),to:bj("10-19 05:50"),stepMs:6000,onTick:(state)=>{base=structuredClone(state);}});
  const s=structuredClone(base!) as ForwardState,cache={};
  const step=(state:ForwardState,now:number,living?:LivingDirective)=>{const inp=simInputs(state,now,GOLDEN_SYMBOLS,cache);
    return advanceForward({state,now,paths:inp.paths,minutePaths:inp.minutePaths,quotes:inp.quotes,analysisQuotes:inp.quotes,contracts:inp.contracts,
      entrySymbols:GOLDEN_SYMBOLS,allowDataCycle:inp.allowDataCycle,btc1hPct:inp.btc1hPct,referenceMids:{BTC_USDT:inp.mids.BTC_USDT??null,ETH_USDT:inp.mids.ETH_USDT??null},...(living?{living}:{})});};
  return {s,step,at:(s.lastCycleAt??Date.now())};
}
const dir=(orders:LivingOrder[]):LivingDirective=>({version:"living-v2",items:{...allItems(true)},actions:[],orders,legacyGate:"note"});
function poolOrder(sym:string,ask:number,stopRate:number,risk=.005):LivingOrder{
  const stop=ask*(1-stopRate);
  return {id:`ld-vwap15m-long-${sym}-1`,symbol:sym,side:"LONG",stop,riskRate:risk,multiple:1,kind:"N",episodeId:null,episodeCap:null,winner:false,reason:"pool test",
    note:{v:"living-v2",k:"N",pb:"vwap15m-long",th:null,ep:null,ev:"normal",mult:1,sc:null,t:null,n:null,per:null,rk:null,inv:stop,ref:ask,hold:1440,why:"pool test",hx:1,dp:1,rr:risk}};
}
function openWith(cfg:Partial<typeof FIXED_NOTIONAL_CFG>,stopRate:number,risk=.005){
  const {s,step,at}=forwardStart();const now=at+6000;
  const inp=simInputs(s,now,GOLDEN_SYMBOLS,{});
  const sym=GOLDEN_SYMBOLS.find(x=>!s.positions.some(p=>p.symbol===x)&&inp.quotes[x]?.bestAsk&&(inp.contracts[x]?.maintenanceRate??1)<=.02)!;
  const ask=inp.quotes[sym]!.bestAsk,saved={...FIXED_NOTIONAL_CFG};
  Object.assign(FIXED_NOTIONAL_CFG,cfg);
  try{
    const before=structuredClone(s.positions);
    const n=step(structuredClone(s),now,dir([poolOrder(sym,ask,stopRate,risk)]));
    const t=n.state.positions.find(p=>p.symbol===sym&&!s.positions.some(q=>q.id===p.id));
    return {t,n,before,contract:inp.contracts[sym]!,price:ask,equity:t?.forecast?.sizingEquity??0,rejected:n.living?.rejected};
  }finally{Object.assign(FIXED_NOTIONAL_CFG,saved);}
}
test("forward: a pool order opens at 500 U; stop price, leverage and stop distance are identical to the original sizing; both sizes are recorded",()=>{
  const orig=openWith({usdt:0},.02),fx=openWith({},.02);
  assert.ok(orig.t&&fx.t,JSON.stringify([orig.rejected,fx.rejected]));
  const mult=fx.t!.quantoMultiplier,oneContract=fx.price*mult;
  assert.ok(fx.t!.notional<=500+1e-9&&fx.t!.notional>500-oneContract-1e-9,`notional ${fx.t!.notional}`);
  assert.equal(fx.t!.stopPrice,orig.t!.stopPrice,"stop price unchanged");
  assert.equal(fx.t!.leverage,orig.t!.leverage,"leverage unchanged");
  assert.equal(fx.t!.leverage,htfPaperLeverage(.02,fx.contract.leverageMax,fx.contract.maintenanceRate,.40,"LONG"));
  assert.equal(fx.t!.liquidationPrice,orig.t!.liquidationPrice);
  assert.equal(fx.t!.armPrice,orig.t!.armPrice);
  const l=fx.t!.entryContext!.living!;
  assert.equal(l.fx,500);
  assert.ok(Math.abs(l.szn!-orig.t!.notional)<=orig.price*mult*1.01+1e-9,"virtual notional = what the original formula opened");
  assert.ok(Math.abs(l.szr!-l.szn!*(.02+RT))<1e-9);
  assert.ok(Math.abs(fx.t!.plannedRisk-fx.t!.notional*(.02+RT))<1e-9,"planned risk is the real one (R stays scale-free)");
  assert.ok(Math.abs(fx.t!.entryFee-fx.t!.notional*.0007)<1e-9,"fee on the real notional");
  assert.equal(gateRisk(fx.t!),l.szr,"the gates read the original risk");
  assert.equal(orig.t!.entryContext!.living!.fx,undefined,"switched off: no new fields, original behaviour");
  assert.equal(fx.t!.entryContext!.portfolioRiskCharge,orig.t!.entryContext!.portfolioRiskCharge,"risk charge unchanged");
  assert.ok(fx.before.every(p=>JSON.stringify(fx.n.state.positions.find(q=>q.id===p.id)?.notional)===JSON.stringify(p.notional)),"open positions untouched");
});
test("forward: wide stop — gates \"virtual\" opens the full 500 (real risk ≫ gate risk); gates \"actual\" shrinks to the 5-minute headroom; maxRiskRate caps it",()=>{
  const v=openWith({},.30,PRED_ALLOC.riskFloor),a=openWith({gates:"actual"},.30),c=openWith({maxRiskRate:.02},.30,PRED_ALLOC.riskFloor);
  assert.ok(v.t&&a.t&&c.t,JSON.stringify([v.rejected,a.rejected,c.rejected]));
  const eq=v.equity;
  assert.ok(v.t!.notional>450,"virtual gates: fixed size is opened");
  assert.ok(v.t!.plannedRisk>eq*.12,"real risk of a 30% stop on 500 U is ~30% of the notional");
  assert.ok(gateRisk(v.t!)<eq*.01,"…while the gates only see the original budget");
  assert.ok(a.t!.notional<v.t!.notional*.6,"actual gates: shrunk below the fixed size");
  assert.ok(a.t!.plannedRisk<=eq*.075*1.0001,`5-minute gate honoured (${a.t!.plannedRisk} vs ${eq*.075})`);
  assert.equal(a.t!.entryContext!.living!.szr,undefined,"actual mode: gates read the real risk");
  assert.ok(c.t!.plannedRisk<=eq*.02*1.0001&&c.t!.notional<v.t!.notional,"maxRiskRate 2% caps the real risk");
  assert.equal(a.t!.stopPrice,v.t!.stopPrice);
});
