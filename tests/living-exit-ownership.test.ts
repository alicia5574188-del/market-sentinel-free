/**
 * "只听大脑，保留止损强平" (2026-10-21): trades opened by the living layer are managed only by living exits/protections.
 * Legacy discretionary exits never touch them; their own stop and isolated liquidation fire every tick; when the living
 * layer is not driving exits (fallback / stale / off / exits switched off) a 1.5x-planned-hold timeout still closes them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {runForward,simInputs,GOLDEN_SYMBOLS} from "./living/forward-sim.ts";
import {bj} from "./living/fixture.ts";
import {advanceForward,type ForwardState,type Trade} from "../lib/forward-relations.ts";
import type {LivingDirective,LivingNote,LivingTradeAction} from "../lib/living/directive.ts";
import {allItems} from "../lib/living/config.ts";

const LIVING_OK=new Set(["LIVING_STOP","LIQUIDATION","LIVING_FALLBACK_TIMEOUT","LIVING_GUARD_STOP"]);
const note=(hold:number):LivingNote=>({v:"living-v2",k:"N",pb:"follow",th:null,ep:null,ev:"normal",mult:1,sc:null,t:null,n:null,per:null,rk:null,
  inv:0,ref:null,hold,why:"test"} as LivingNote);
const markLiving=(state:ForwardState,hold:number,seen:Set<string>)=>{for(const t of state.positions)if(!t.inverseCopy&&!seen.has(t.id)&&t.entryContext){
  seen.add(t.id);t.entryContext.living=note(hold);}};
const W2={from:bj("10-18 20:40"),to:bj("10-18 23:50"),stepMs:8000};
const directive=(actions:LivingTradeAction[]=[],thesisExit=true):LivingDirective=>({version:"living-v2",items:{...allItems(true),thesisExit},actions,orders:[],legacyGate:"open"});

test("legacy exits do not touch living trades (replay where the legacy stack exits)",()=>{
  const base=runForward(W2);
  const legacyExited=base.state.history.filter(t=>!t.unopened&&!t.inverseCopy);
  assert.ok(legacyExited.length>0,"baseline window must have legacy exits");
  const seen=new Set<string>();
  const r=runForward({...W2,extra:state=>{markLiving(state,10_000,seen);return {};}});
  assert.ok(seen.size>0);
  const closed=r.state.history.filter(t=>seen.has(t.id));
  for(const t of closed)assert.ok(LIVING_OK.has(t.exitReason??""),`living trade ${t.id} closed by legacy ${t.exitReason}`);
  // the first trade the legacy stack closed in the baseline is, as a living trade, still open or closed only by its stop/liquidation
  const first=legacyExited.at(-1)!;assert.ok(seen.has(first.id));
  const now=r.state.positions.find(t=>t.id===first.id)??r.state.history.find(t=>t.id===first.id)!;
  assert.ok(now.status==="OPEN"||LIVING_OK.has(now.exitReason??""),`${first.id} ${now.exitReason}`);
  assert.notEqual(now.exitReason,first.exitReason);
});

/** State with at least one open (living-marked) trade from window 1, plus a stepper that continues the same replay. */
let firstOpen:ForwardState|null=null;
function livingStart(hold:number){
  const seen=new Set<string>();
  if(!firstOpen)runForward({from:bj("10-19 05:20"),to:bj("10-19 07:28"),stepMs:6000,onTick:(state)=>{if(!firstOpen&&state.positions.some(t=>!t.inverseCopy))firstOpen=structuredClone(state);}});
  assert.ok(firstOpen,"window must open a trade");const s=structuredClone(firstOpen) as ForwardState;markLiving(s,hold,seen);
  const t=s.positions.find(x=>seen.has(x.id))!;
  const cache={};
  const step=(state:ForwardState,now:number,extra:Record<string,unknown>={})=>{const inp=simInputs(state,now,GOLDEN_SYMBOLS,cache);
    return advanceForward({state,now,paths:inp.paths,minutePaths:inp.minutePaths,quotes:inp.quotes,analysisQuotes:inp.quotes,contracts:inp.contracts,
      entrySymbols:GOLDEN_SYMBOLS,allowDataCycle:inp.allowDataCycle,btc1hPct:inp.btc1hPct,
      referenceMids:{BTC_USDT:inp.mids.BTC_USDT??null,ETH_USDT:inp.mids.ETH_USDT??null},...extra}).state;};
  return {s,t,step,at:s.lastCycleAt??t.openedAt};
}
const find=(s:ForwardState,id:string)=>s.history.find(t=>t.id===id)??null;
const nowOf=(t:Trade)=>t.lastQuoteAt??t.openedAt;

test("a living trade's own stop and isolated liquidation still close it (no directive at all)",()=>{
  {const {s,t,step}=livingStart(10_000),x=s.positions.find(p=>p.id===t.id)!;
    x.stopPrice=x.side==="LONG"?x.lastPrice*1.05:x.lastPrice*.95; // already through the stop
    const n=step(s,nowOf(t)+6000);const c=find(n,t.id);assert.equal(c?.exitReason,"LIVING_STOP");
    assert.equal(n.positions.some(p=>p.id===t.id),false);assert.equal(n.history.filter(h=>h.id===t.id).length,1);}
  {const {s,t,step}=livingStart(10_000),x=s.positions.find(p=>p.id===t.id)!;
    x.stopPrice=0;x.liquidationPrice=x.side==="LONG"?x.lastPrice*1.05:x.lastPrice*.95;
    const n=step(s,nowOf(t)+6000);assert.equal(find(n,t.id)?.exitReason,"LIQUIDATION");}
});

test("living EXIT closes a living trade exactly once",()=>{
  const {s,t,step}=livingStart(10_000);let n=step(s,nowOf(t)+6000,{living:directive([{tradeId:t.id,action:"EXIT",code:"LIVING_INTENT_GONE",reason:"x"}])});
  for(let i=2;i<6;i++)n=step(n,nowOf(t)+6000*i,{living:directive()});
  assert.deepEqual(n.history.filter(h=>h.id===t.id).map(h=>h.exitReason),["LIVING_INTENT_GONE"]);
  assert.equal(n.positions.some(p=>p.id===t.id),false);
});

test("fallback: when the living layer stops driving exits, the trade is closed at 1.5x its planned hold after a 2-minute grace",()=>{
  const hold=4,{s,t,step}=livingStart(hold);const t0=t.openedAt;let n=s;
  // living layer driving (directive with exits on) well past 1.5x hold: no forward timeout, the layer owns it
  let now=Math.max(nowOf(t),t0)+6000;
  for(;now<t0+1.5*hold*60_000+3*60_000;now+=6000){n=step(n,now,{living:directive()});if(find(n,t.id))break;}
  const early=find(n,t.id);assert.ok(!early||early.exitReason!=="LIVING_FALLBACK_TIMEOUT","no fallback timeout while the layer drives");
  assert.equal(early,null,"fixture trade should survive the driven phase");
  // layer falls back (no directive): nothing for the first 2 minutes, then the fallback timeout
  const lost=now-6000;let closedAt:number|null=null;
  for(now+=6000;now<lost+5*60_000;now+=6000){n=step(n,now);const c=find(n,t.id);if(c){closedAt=now;assert.ok(LIVING_OK.has(c.exitReason??""));break;}}
  assert.ok(closedAt!=null,"fallback must close the trade");
  const c=find(n,t.id)!;
  assert.equal(c.exitReason,"LIVING_FALLBACK_TIMEOUT");assert.ok(closedAt!-lost>=120_000,"grace respected");
});
test("fallback also applies when the layer runs with exits switched off",()=>{
  const hold=2,{s,t,step}=livingStart(hold);let n=s,now=Math.max(nowOf(t),t.openedAt+1.5*hold*60_000)+6000;
  for(let i=0;i<40&&!find(n,t.id);i++,now+=6000)n=step(n,now,{living:directive([],false)});
  assert.ok(find(n,t.id),"exits-off layer must not orphan the trade");assert.ok(LIVING_OK.has(find(n,t.id)!.exitReason??""));
});
