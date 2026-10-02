import test from 'node:test';
import assert from 'node:assert/strict';
import {initialForward,forwardEquity,forwardSummary,normalizeForward,closeForwardForReset,type Quote,type Opportunity} from '../lib/forward-relations.ts';
import {migrateDirectStrategy,researchDirectPlan,openDirectPlan} from '../lib/direct-strategy.ts';
import {advancePaperExecution,executionTiming,paperBookFill,paperFilled,queuePaperAction,PAPER_EXECUTION_VERSION} from '../lib/paper-execution.ts';
import {forwardMirrorSources,sourceLifecycle} from '../lib/live-parity.ts';
import {sourceReductionTarget} from '../lib/live-reduction.ts';
import {closeUnifiedTrade} from '../lib/unified-execution.ts';
import {startLiveSession,sourceAfterEnable} from '../lib/live-session.ts';
import {prepareForwardWrite,readForwardStore} from '../lib/forward-store.ts';
import {captureTradeReviews} from '../lib/review-trace.ts';

const T=1790951454000,c={quantoMultiplier:1,leverageMax:20,maintenanceRate:.005,minContracts:1,tickSize:.01,
  enableDecimal:true,orderSizeMin:'0.1',orderSizeMax:'100000',marketOrderSizeMax:'100000'};
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const quote=(at:number,price=100,depth=100000):Quote=>({bestBid:price,bestAsk:price+.02,observedAt:at,fresh:true,entryReady:true,sourceCount:3,
  bids:[{price,size:depth}],asks:[{price:price+.02,size:depth}]});
function fixture(){
  const s=initialForward(T-300000);migrateDirectStrategy(s,T);s.paperExecution={version:PAPER_EXECUTION_VERSION,cutoverAt:T,cancelled:[]};
  const o:Opportunity={id:'test-event',symbol:'TEST_USDT',side:'LONG',mode:'RELATIVE',premium:false,score:90,eligible:true,completedAt:T,expiresAt:T+3600000,
    price:100,stopPrice:98,targetPrice:110,stopRate:.02,targetRate:.1,directionStrength:90,pathEfficiency:90,momentumPersistence:90,
    positionScore:90,spaceScore:90,executionScore:90,grossRemainingSpaceRate:.1,netRemainingSpaceRate:.098,pullbackRiskRate:.02,
    edgeRatio:5,expectedHoldMinutes:180,marketFit:70,regionId:null,regionQuality:null,reason:'synthetic',strategyVersion:'market-intelligence-v1',
    winnerPlan:{version:'winner-preservation-v1',intent:'TREND',eventAt:T,initialStop:98,target:110,targetArea:null,
      origin:{lower:98,upper:102,center:100,formedAt:T-300000,balanced:true,basis:'OHLCV_PROXY'},riskGroup:'test',source:'RELATIVE_CORE'}};
  const q=quote(T),input={state:s,now:T,paths:{},quotes:{TEST_USDT:q},contracts:{TEST_USDT:c}},p=researchDirectPlan(s,o,input);
  s.directStrategy!.plans[p.symbol]=p;
  assert.equal(openDirectPlan(s,p,q,c,T,input.quotes),undefined);
  const t=s.positions[0]!;
  const advance=(at:number,price=100,depth=100000)=>advancePaperExecution(s,{TEST_USDT:quote(at,price,depth)},{TEST_USDT:c},at);
  return{s,t,advance};
}
test('signal is a committed instruction, not a paid PAPER fill; LIVE starts before PAPER confirmation',()=>{
  const {s,t,advance}=fixture();near(s.balance,1000);near(s.fees,0);near(s.turnover,0);
  assert.equal(paperFilled(t),false);near(forwardEquity(s,{TEST_USDT:quote(T,120)},T).equity,1000);
  assert.equal(forwardSummary(s,{TEST_USDT:quote(T)},T).positions.length,0);
  assert.equal(forwardMirrorSources(s,1000).TEST_USDT!.id,t.id);assert.equal(sourceLifecycle(s,t.id).status,'OPEN');
  advance(T);assert.equal(t.paperOrder!.phase,'PREPARING');advance(T+2000);assert.equal(t.paperOrder!.phase,'SUBMITTED');
  near(s.balance,1000);advance(T+4000,100.5);assert.equal(t.paperOrder!.phase,'FILLED');near(t.entryPrice,100.5);
  near(s.balance,1000-t.entryFee);near(s.fees,t.entryFee);near(s.turnover,t.notional);
  assert.equal(t.openedAt,T+4000);const actual=JSON.stringify(s);advance(T+4000,100.5);assert.equal(JSON.stringify(s),actual);
});
test('same LIVE lot/spec/account checks gate simulation; missing metadata never fabricates leverage success',()=>{
  const {s,t}=fixture();
  advancePaperExecution(s,{TEST_USDT:quote(T+2000)},{TEST_USDT:{...c,enableDecimal:undefined}},T+2000);
  assert.equal(t.paperOrder!.phase,'PREPARING');near(s.balance,1000);assert.match(t.paperOrder!.reason,/规格/);
  const q=quote(T+3000);s.balance=1;
  advancePaperExecution(s,{TEST_USDT:q},{TEST_USDT:c},T+3000);assert.equal(t.paperOrder!.phase,'PREPARING');near(s.fees,0);
});
test('fresh post-submit own-side book determines partial IOC and no entry remainder is replayed',()=>{
  const {s,t,advance}=fixture();advance(T+2000);
  const wanted=t.contracts,q=quote(T+4000,101,101*.6);advancePaperExecution(s,{TEST_USDT:q},{TEST_USDT:c},T+4000);
  near(t.contracts,.6);assert.ok(t.paperOrder!.unfilledContracts!>0);near(t.entryPrice,101);assert.ok(wanted>.6);
  const before=s.balance;advance(T+6000,101,100000);near(t.contracts,.6);near(s.balance,before);
  const restored=normalizeForward(structuredClone(s),T+6000);near(restored.positions[0]!.contracts,.6);
});
test('multi-level VWAP includes adverse depth, exact decimal lots and never synthesizes unobserved liquidity',()=>{
  const {t}=fixture(),q=quote(T);
  q.bids=[{price:100,size:100},{price:99,size:198}];const f=paperBookFill(t,q,c,2,true)!;near(f.contracts,2);near(f.price,99.5);
  assert.equal(paperBookFill(t,{...q,bids:undefined},c,2,true),null);
  assert.equal(paperBookFill(t,{...q,bids:[{price:101,size:1000}]},c,2,true),null);
  const long={...t,side:'LONG' as const};q.asks=[{price:100.02,size:100.02},{price:101,size:202}];
  near(paperBookFill(long,q,c,2,true)!.price,100.51);
});
test('close instruction wakes LIVE immediately, but PAPER exposure and floating persist until matching confirmation',()=>{
  const {s,t,advance}=fixture();advance(T+2000);advance(T+4000);
  const before=s.balance;assert.equal(closeUnifiedTrade(s,t,quote(T+6000),T+6000,'EXIT','synthetic exit'),false);
  assert.equal(sourceLifecycle(s,t.id).status,'CLOSED');assert.equal(forwardMirrorSources(s,forwardEquity(s,{},T+6000).equity).TEST_USDT,undefined);
  assert.equal(s.history.length,0);assert.equal(t.status,'OPEN');near(s.balance,before);
  const value=forwardEquity(s,{TEST_USDT:quote(T+6000,102)},T+6000).floating;assert.ok(value<0);
  advance(T+8000,101);assert.equal(s.history.length,0);advance(T+10000,101);
  assert.equal(s.positions.length,0);assert.equal(s.history.length,1);near(t.exitPrice!,101.02);
  near(s.balance,1000+t.netPnl!);near(s.grossPnl,t.grossPnl!);near(s.fees,t.entryFee+t.exitFee);
});
test('partial close keeps the remainder open, coalesces fragments and survives exact money restoration',async()=>{
  const {s,t,advance}=fixture();advance(T+2000);advance(T+4000);
  const original=t.contracts;
  queuePaperAction(s,t,T+6000,'CLOSE','EXIT','synthetic exit');advance(T+8000);
  advance(T+10000,101,(101.02)*.5);near(t.contracts,original-.5);assert.equal(t.status,'OPEN');assert.equal(s.resolved,0);
  const firstBalance=s.balance;
  advance(T+12000,102,(102.02)*.5);near(t.contracts,original-1);assert.ok(s.balance<firstBalance);
  assert.equal(t.realization!.fills.length,1);near(t.realization!.fills[0]!.price,101.52);
  const state=normalizeForward(structuredClone(s),T+12000);near(state.positions[0]!.quantity,t.quantity);
  s.storage.persistedAt=T+12000;const write=await prepareForwardWrite(null,s,T+12000,{compact:true}),db=new Map(Object.entries(write.entries));
  const r=await readForwardStore({get:async<V>(k:string)=>structuredClone(db.get(k)) as V|undefined},T+13000);
  advancePaperExecution(r,{TEST_USDT:quote(T+14000,103)},{TEST_USDT:c},T+14000);
  assert.equal(r.positions.length,0);const closed=r.history[0]!;near(r.balance,1000+closed.netPnl!);
  near(r.fees,closed.entryFee+closed.exitFee);assert.ok(closed.exitPrice!>101.52&&closed.exitPrice!<103.02);
});
test('REDUCE exposes requested quantity/sequence before settlement; no completed-trim claim until filled',()=>{
  const {s,t,advance}=fixture();advance(T+2000);advance(T+4000);const original=t.contracts;
  assert.equal(queuePaperAction(s,t,T+6000,'REDUCE','TRIM','trim',.3,c),true);
  const source=sourceLifecycle(s,t.id).trade!;assert.equal(source.realization,undefined);
  const receipt={sourceId:t.id,sourceContractsAtCopy:original,roundedContracts:original};
  const target=sourceReductionTarget(source,receipt as never,original,{enableDecimal:true,orderSizeMin:'0.1'});
  assert.ok(target&&target.targetContracts<original);assert.equal(target.sequence,1);
  const before=s.balance;advance(T+8000,99);near(s.balance,before);advance(T+10000,99);
  assert.equal(t.paperOrder!.action,undefined);assert.equal(t.paperOrder!.completedActions,1);
  near(sourceLifecycle(s,t.id).trade!.contracts,source.contracts);assert.ok(s.balance>before);
});
test('LIVE activation uses signal identity, so delayed confirmation never backfills a pre-enable order',()=>{
  const {s,t,advance}=fixture(),session=startLiveSession(T+1000,s);advance(T+2000);advance(T+4000);
  assert.equal(sourceAfterEnable(t,session,s.startedAt),false);session.excludedSourceIds=[];
  assert.equal(sourceAfterEnable(t,session,s.startedAt),false);assert.equal(sourceLifecycle(s,t.id).trade!.openedAt,T);
});
test('pending orders do not generate review PnL, stale quotes never fill, restart does not lose pending identity',async()=>{
  const {s,t,advance}=fixture(),before=structuredClone(s);advance(T+2000);
  captureTradeReviews(before,s,T+2000,'synthetic','synthetic',{TEST_USDT:quote(T+2000)});assert.equal(t.review,undefined);
  advancePaperExecution(s,{TEST_USDT:{...quote(T+4000),fresh:false}},{TEST_USDT:c},T+4000);assert.equal(paperFilled(t),false);
  s.storage.persistedAt=T+2000;const write=await prepareForwardWrite(null,s,T+2000,{compact:true}),db=new Map(Object.entries(write.entries));
  const restored=await readForwardStore({get:async<V>(k:string)=>structuredClone(db.get(k)) as V|undefined},T+3000);
  assert.equal(restored.positions[0]!.id,t.id);near(restored.balance,1000);
  advancePaperExecution(restored,{TEST_USDT:quote(T+4000)},{TEST_USDT:c},T+4000);
  captureTradeReviews(s,restored,T+4000,'synthetic','synthetic',{TEST_USDT:quote(T+4000)});
  assert.equal(restored.positions[0]!.review!.fromEntry,true);
});
test('manual reset cancels pending without paid fees or fictional market exits; old filled entry remains exact',()=>{
  const {s,t}=fixture(),closed=closeForwardForReset(s,{TEST_USDT:quote(T+1000,110)},T+1000);
  near(closed.balance,1000);near(closed.fees,0);assert.equal(closed.resolved,0);assert.equal(closed.positions.length,0);
  assert.equal(closed.paperExecution!.cancelled[0]!.id,t.id);
  assert.equal(sourceLifecycle(closed,t.id).status,'CLOSED');
});
test('latency model is based on bounded observed receipts, with explicit execution-clock fallback',()=>{
  assert.deepEqual(executionTiming([]),{prepareMs:2000,confirmMs:0,basis:'EXECUTION_CLOCK',samples:0});
  assert.deepEqual(executionTiming([{submitDelayMs:3000,submittedAt:T,exchangeEntryAt:T+1000},
    {submitDelayMs:2000,submittedAt:T,exchangeEntryAt:T+500}, {submitDelayMs:1000,submittedAt:T,exchangeEntryAt:T+200}]),
    {prepareMs:2000,confirmMs:500,basis:'OBSERVED_LIVE',samples:3});
});
test('transport heartbeats cannot consume the same partial-close depth twice, including after restore',()=>{
  const {s,t,advance}=fixture();advance(T+2000);advance(T+4000);
  queuePaperAction(s,t,T+6000,'CLOSE','EXIT','synthetic');advance(T+8000);
  const book={...quote(T+10000,101,101.02*.5),bookSequence:10};
  advancePaperExecution(s,{TEST_USDT:book},{TEST_USDT:c},T+10000);const remaining=t.contracts,cash=s.balance;
  const r=normalizeForward(structuredClone(s),T+11000);
  advancePaperExecution(r,{TEST_USDT:{...book,observedAt:T+12000}},{TEST_USDT:c},T+12000);
  near(r.positions[0]!.contracts,remaining);near(r.balance,cash);
  advancePaperExecution(r,{TEST_USDT:{...book,observedAt:T+14000,bookSequence:11}},{TEST_USDT:c},T+14000);
  near(r.positions[0]!.contracts,remaining-.5);
});
test('corrupt pending monetary authority is rejected, never rebuilt as an instantaneous fill',()=>{
  const {s,t}=fixture();t.paperOrder!.requestedContracts=NaN;
  assert.throws(()=>normalizeForward(s,T+1000),/模拟执行记录损坏/);
});
test('entry confirmation does not change the committed LIVE signal price or requested source size',()=>{
  const {s,t,advance}=fixture(),before=structuredClone(sourceLifecycle(s,t.id).trade!);
  advance(T+2000);advance(T+4000,101,101*.6);
  const after=sourceLifecycle(s,t.id).trade!;
  near(after.entryPrice,before.entryPrice);near(after.contracts,before.contracts);near(after.plannedRisk,before.plannedRisk);
  near(t.contracts,.6);near(t.entryPrice,101);
});
test('close supersedes a partially filled reduction without coalescing different orders or double money',()=>{
  const {s,t,advance}=fixture();advance(T+2000);advance(T+4000);
  queuePaperAction(s,t,T+6000,'REDUCE','TRIM','trim',.3,c);advance(T+8000);advance(T+10000,99,99.02*.1);
  const reduction=t.realization!.fills[0]!.executionOrderId;
  queuePaperAction(s,t,T+12000,'CLOSE','EXIT','exit');advance(T+14000);advance(T+16000,98,98.02*.1);
  assert.equal(t.realization!.fills.length,2);assert.notEqual(t.realization!.fills[1]!.executionOrderId,reduction);
  normalizeForward(structuredClone(s),T+16000);advance(T+18000,97);
  near(s.balance,1000+s.history[0]!.netPnl!);normalizeForward(structuredClone(s),T+18000);
});
test('confirmed delayed return close releases the original continuation handoff only after paid settlement',()=>{
  const {s,t,advance}=fixture();advance(T+2000);advance(T+4000);
  const plan=s.directStrategy!.plans[t.symbol]!;assert.equal(plan.consumed,true);assert.ok(s.consumedTheses[plan.id]);
  queuePaperAction(s,t,T+6000,'CLOSE','RETURN_TREND_CONFIRMED','confirmed trend');advance(T+8000);
  assert.equal(plan.consumed,true);assert.equal(s.directStrategy!.completedConversions,0);
  advance(T+10000,101);assert.equal(s.positions.length,0);assert.equal(plan.consumed,false);
  assert.equal(s.consumedTheses[plan.id],undefined);assert.equal(s.directStrategy!.completedConversions,1);
  near(s.balance,1000+s.history[0]!.netPnl!);
});
