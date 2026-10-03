import test from 'node:test';
import assert from 'node:assert/strict';
import {initialForward,normalizeForward,forwardSummary,resetForwardAccountPreservingLearning,type Opportunity,type Candle,type Quote} from '../lib/forward-relations.ts';
import {migrateDirectStrategy,researchDirectPlan,openDirectPlan,manageDirectReturn,advanceDirectStrategy,DIRECT_STRATEGY_VERSION} from '../lib/direct-strategy.ts';
import {advanceWinnerManagement} from '../lib/winner-policy.ts';
import {prepareForwardWrite,readForwardStore,prepareForwardProtectionWrite,FORWARD_PROTECTION_STORAGE} from '../lib/forward-store.ts';
import {restoreForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
import {applyInverseSourceTrade,newInverseTrial,sourceDecisionState,shadowCapsule,assertInverseTrial} from '../lib/shadow-inverse-ledger.ts';
import {startLiveSession,fenceLiveSourcePolicy,sourceAfterEnable} from '../lib/live-session.ts';
import {buildProportionalMirror,sourceLifecycle} from '../lib/live-parity.ts';
import {buildReviewSnapshot} from '../lib/research-snapshot.ts';
import {registerHooks} from 'node:module';
import {nextProtectionWriteBudget} from '../lib/forward-write-budget.ts';
import {initialMarketAuthority} from '../lib/market-authority.ts';
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier==='cloudflare:workers')return{url:'data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}',shortCircuit:true};
  if(specifier==='vinext/server/app-router-entry')return{url:'data:text/javascript,export default {fetch:()=>new Response("synthetic")};',shortCircuit:true};
  return nextResolve(specifier,context);
}});
const {MarketStream}=await import('../worker/index-clean.ts');
const B=300000,T=1790947200000,area={lower:98,upper:102,center:100,formedAt:T-B,balanced:true,basis:'OHLCV_PROXY' as const};
const c={quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,minContracts:1,tickSize:.01};
const q=(price=100,at=T):Quote=>({bestBid:price,bestAsk:price+.02,observedAt:at,fresh:true,entryReady:true,sourceCount:3});
const bar=(at:number,o:number,l:number,h:number,close:number):Candle=>({time:at/1000,open:o,low:l,high:h,close,volume:100});
const up=[bar(T,102.5,102.4,103.2,103),bar(T+B,103,102.8,103.7,103.5)];
const down=[bar(T,97.5,96.8,97.6,97),bar(T+B,97,96.3,97.2,96.5)];
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function opportunity(side:'LONG'|'SHORT'='LONG',symbol='TEST_USDT'):Opportunity{
  const d=side==='LONG'?1:-1;
  return{id:`event-${symbol}-${side}`,symbol,side,mode:'RELATIVE',premium:false,score:90,eligible:true,completedAt:T,expiresAt:T+3600000,
    price:100,stopPrice:100-d*2,targetPrice:100+d*10,stopRate:.02,targetRate:.1,directionStrength:90,pathEfficiency:90,
    momentumPersistence:90,positionScore:90,spaceScore:90,executionScore:90,grossRemainingSpaceRate:.1,netRemainingSpaceRate:.098,
    pullbackRiskRate:.02,edgeRatio:5,expectedHoldMinutes:180,marketFit:70,regionId:null,regionQuality:null,reason:'synthetic observed move',
    strategyVersion:'market-intelligence-v1',residual:.02*d,relativeStrength:side==='LONG'?.9:.1,dataConfidence:90,clusterId:symbol,
    winnerPlan:{version:'winner-preservation-v1',intent:'TREND',eventAt:T,initialStop:100-d*2,target:100+d*10,targetArea:null,
      origin:area,riskGroup:symbol,source:'RELATIVE_CORE'}};
}
function fixture(side:'LONG'|'SHORT'='LONG',symbol='TEST_USDT'){
  const s=initialForward(T-10*B);migrateDirectStrategy(s,T);const o=opportunity(side,symbol);
  function input(now=T,price=100,rows:Candle[]=[]){
    s.extremumRegime.updatedAt=now;
    s.extremumRegime.symbols[symbol]={symbol,watchScore:90,regime:side==='LONG'?'TREND_UP':'TREND_DOWN',stage:'READY',clusterId:symbol,
      correlation:.1,beta:1,volatility:.003,dataConfidence:90,actualMove:.03,expectedMove:.01,residual:.02,residualZ:1,
      residualPersistence:1,relativeStrength:.9,longScore:90,shortScore:10,pathLong:.8,pathShort:.2,roomLong:.1,roomShort:.1,
      sourceCount:3,venueAgreement:1,venuePressure:side==='LONG'?1:-1,reasons:[],signalSide:side,signalSince:T,signalBars:3,signalLastBar:now};
    return{state:s,now,quotes:{[symbol]:q(price,now)},paths:{[symbol]:rows},contracts:{[symbol]:c},allowDataCycle:false};
  }
  const i=input(),p=researchDirectPlan(s,o,i);s.directStrategy!.plans[symbol]=p;
  return{s,o,p,input};
}
test('research creates actual return direction without any source order or second wallet',()=>{
  const f=fixture();assert.equal(f.p.side,'SHORT');assert.equal(f.p.branch,'RETURN');
  assert.equal(openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()}),undefined);
  const t=f.s.positions[0]!;assert.equal(t.side,'SHORT');assert.equal(t.unified!.version,DIRECT_STRATEGY_VERSION);
  assert.equal(t.inverseCopy,undefined);assert.equal(f.s.inverseTrial,undefined);assert.equal(f.s.unifiedExecution,undefined);
  near(t.entryPrice,100);near(t.entryFee,t.notional*.0005);near(f.s.balance,1000-t.entryFee);near(t.leverage,5);
  assertInverseTrial(f.s);const v=forwardSummary(f.s,{TEST_USDT:q()},T);
  assert.equal(v.shadowInverse,null);assert.equal(v.unifiedExecution,null);assert.equal(v.directStrategy!.authority,'ONE_ACTUAL_ACCOUNT_NO_COMPANION_ORDERS');
});
test('current held plan explains the actual position even when a later observed move points the other way',()=>{
  const f=fixture();openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});const t=f.s.positions[0]!;
  const p=researchDirectPlan(f.s,opportunity('SHORT'),f.input(T+2000));
  assert.equal(p.side,t.side);assert.equal(p.branch,t.unified!.branch);assert.equal(p.phase,'HOLDING');
  assert.equal(p.reason,t.unified!.entryReason);assert.equal(p.holdReason,t.unified!.holdReason);
  assert.equal(p.exitCondition,t.unified!.exitCondition);assert.equal(p.candidate.side,'SHORT');assert.equal(p.consumed,true);
});
test('trend research is independent of a losing return and uses each symbol own completed path',()=>{
  for(const [side,rows,price] of [['LONG',up,103.5],['SHORT',down,96.5]] as const){
    const f=fixture(side,side==='SHORT'?'MOVR_USDT':'TEST_USDT'),i=f.input(T+2*B,price,[...rows]);
    const p=researchDirectPlan(f.s,f.o,i);assert.equal(p.branch,'CONTINUATION');assert.equal(p.side,side);assert.equal(p.phase,'READY');
    assert.equal(openDirectPlan(f.s,p,i.quotes[f.o.symbol]!,c,i.now,i.quotes),undefined);
    assert.equal(f.s.history.length,0);assert.equal(f.s.positions[0]!.unified!.predecessorId,undefined);assertInverseTrial(f.s);
  }
});
test('future/incomplete/gapped bars and stale flow cannot authorize trend; accepted episode cannot revert into return',()=>{
  const f=fixture();
  for(const i of [f.input(T+2*B-1,103.5,up),f.input(T+3*B,103.5,[up[0]!,{...up[1]!,time:(T+2*B)/1000}])])
    assert.equal(researchDirectPlan(f.s,f.o,i).branch,'RETURN');
  const i=f.input(T+2*B,103.5,up),accepted=researchDirectPlan(f.s,f.o,i);f.s.extremumRegime.updatedAt=i.now-20000;
  const p=researchDirectPlan(f.s,f.o,i,accepted);assert.equal(p.continuationSeen,true);
  assert.match(openDirectPlan(f.s,p,i.quotes.TEST_USDT!,c,i.now,i.quotes)!,/确认延续/);
});
test('return exit preserves the original geometric failure boundary but settles the actual own-side payoff and fees',()=>{
  const f=fixture();openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});const t=f.s.positions[0]!,qty=t.quantity,entryFee=t.entryFee;
  const i=f.input(T+2000,97.8),expected=advanceWinnerManagement({side:'LONG',price:97.8,entryPrice:100.02,openedAt:T,now:i.now,
    plan:f.o.winnerPlan!,currentStop:98,rows:[],cost:.0019,remainingFraction:1,concernFamilies:[],supportFamilies:[],positionExit:false,trendEligible:false});
  assert.equal(expected.action,'EXIT');assert.equal(manageDirectReturn(f.s,t,i.quotes.TEST_USDT!,i),true);
  near(t.exitPrice!,97.82);near(t.grossPnl!,qty*(100-97.82));near(t.exitFee,qty*97.82*.0005);
  near(t.netPnl!,t.grossPnl!-entryFee-t.exitFee);near(f.s.balance,1000+t.netPnl!);
  assert.equal(t.exitReason,'RETURN_EVENT_COMPLETE');assertInverseTrial(f.s);
});
test('return tolerates interim adverse price without a generic own stop, but a confirmed own-symbol trend books loss',()=>{
  const f=fixture();openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});const t=f.s.positions[0]!;
  const i=f.input(T+2000,101);manageDirectReturn(f.s,t,i.quotes.TEST_USDT!,i);assert.equal(t.status,'OPEN');assert.match(t.unified!.holdReason,/容忍浮亏/);
  const next=advanceDirectStrategy(f.input(T+2*B,103.5,up));const closed=next.state.history[0]!;
  assert.equal(closed.exitReason,'RETURN_TREND_CONFIRMED');assert.ok(closed.netPnl!<0);
  near(next.state.balance,1000+closed.netPnl!-(next.state.positions[0]?.entryFee??0));assertInverseTrial(next.state);
});
test('fixed1000 quantities do not compound with rising account equity; lots and margin remain real constraints',()=>{
  const values=[];for(const balance of [1000,3000]){const f=fixture();f.s.balance=balance;openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});values.push(f.s.positions[0]!.contracts);}
  assert.equal(values[0],values[1]);const f=fixture();f.s.balance=20;assert.match(openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()})!,/容量不足/);
});
test('migration preserves active financial/native identity and retires the original wallets; normalization never needs new companion fills',()=>{
  const f=fixture(),s=initialForward(f.s.startedAt);s.inverseTrial=newInverseTrial(s,T-B,1000);
  // A real direct fixture supplies only a shape; this synthetic original trade
  // is explicitly the push-side obligation captured before migration.
  openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});const source=structuredClone(f.s.positions[0]!);
  source.id='old-source';source.side='LONG';delete source.unified;source.entryContext!.side='LONG';source.entryContext!.winnerPlan=f.o.winnerPlan;
  source.entryPrice=100;source.notional=source.quantity*100;source.margin=source.notional/source.leverage;source.entryFee=source.notional*.0007;
  const book=sourceDecisionState(s);book.positions.push(source);book.balance-=source.entryFee;book.fees+=source.entryFee;book.turnover+=source.notional;
  applyInverseSourceTrade(s,source,q(),T);s.inverseTrial.source=shadowCapsule(book);s.inverseTrial.lastSourceRevision=book.revision;
  const before=structuredClone(s.positions[0]!),cash=s.balance,retired=JSON.stringify(s.inverseTrial);migrateDirectStrategy(s,T+1);
  const t=s.positions[0]!;for(const k of ['id','side','entryPrice','contracts','quantity','entryFee','notional','margin'] as const)assert.equal(t[k],before[k]);
  near(s.balance,cash);assert.deepEqual(t.unified!.legacyReceipt,before.inverseCopy);assert.equal(t.inverseCopy,undefined);
  assert.equal(normalizeForward(s,T+2).positions[0]!.id,before.id);
  s.storage.persistedAt=T+1;
  const overlay=prepareForwardProtectionWrite(s).entries[FORWARD_PROTECTION_STORAGE] as {shadow?:unknown;unifiedReference?:unknown};
  assert.equal(overlay.shadow,undefined);assert.equal(overlay.unifiedReference,undefined);
  const next=advanceDirectStrategy({state:s,now:T+2000,quotes:{TEST_USDT:q(97.8,T+2000)},paths:{},contracts:{TEST_USDT:c},allowDataCycle:false});
  assert.equal(JSON.stringify(next.state.inverseTrial),retired);assert.equal(next.state.history[0]!.id,before.id);assertInverseTrial(next.state);
});
test('deployed v1 RETURN migrates source geometry and a committed exit without changing actual identity or money',()=>{
  const f=fixture();openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});const s=f.s,t=s.positions[0]!,before=structuredClone(t),cash=s.balance;
  delete s.directStrategy;t.unified!.version='return-continuation-v1';t.unified!.sourceId='old-push';delete t.unified!.returnLogic;
  s.inverseTrial=newInverseTrial(s,T-B,1000);
  const source=structuredClone(before);source.id='old-push';source.side='LONG';source.entryPrice=100.02;source.favorable=.08;
  source.status='CLOSED';source.exitReason='WINNER_STRUCTURE_EXIT';delete source.unified;
  source.entryContext!.winnerPlan=structuredClone(f.o.winnerPlan!);source.entryContext!.side='LONG';
  s.inverseTrial.source.history=[source];
  s.unifiedExecution={version:'return-continuation-v1',cutoverAt:T,reference:shadowCapsule(s),episodes:{},legacyIds:[],completedConversions:0,droppedEpisodes:0};
  const inactive=JSON.stringify({inverse:s.inverseTrial,reference:s.unifiedExecution});
  migrateDirectStrategy(s,T+1);
  for(const k of ['id','side','entryPrice','contracts','quantity','entryFee','notional','margin'] as const)assert.equal(t[k],before[k]);
  near(s.balance,cash);near(t.unified!.returnLogic!.peakAdvance,.08);
  assert.deepEqual(t.unified!.returnLogic!.plan,f.o.winnerPlan);assert.equal(t.unified!.returnLogic!.pendingExitReason,'WINNER_STRUCTURE_EXIT');
  const i=f.input(T+2000,101);assert.equal(manageDirectReturn(s,t,i.quotes.TEST_USDT!,i),true);
  assert.equal(s.history[0]!.id,before.id);assert.equal(s.history[0]!.exitReason,'WINNER_STRUCTURE_EXIT');
  near(s.balance,1000+s.history[0]!.netPnl!);assert.equal(JSON.stringify({inverse:s.inverseTrial,reference:s.unifiedExecution}),inactive);assertInverseTrial(s);
});
test('restart restores actual plan, own geometric memory, fees and protection without restoring shadow authority',async()=>{
  const f=fixture();openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});const i=f.input(T+2000,101);manageDirectReturn(f.s,f.s.positions[0]!,i.quotes.TEST_USDT!,i);
  f.s.storage.persistedAt=i.now;const w=await prepareForwardWrite(null,f.s,i.now,{compact:true}),db=new Map(Object.entries(w.entries));
  const restored=await readForwardStore({get:async<V>(k:string)=>structuredClone(db.get(k)) as V|undefined},i.now+1);
  assert.deepEqual(restored.positions[0]!.unified,f.s.positions[0]!.unified);near(restored.balance,f.s.balance);assertInverseTrial(restored);
  const overlay=prepareForwardProtectionWrite(f.s),r=restoreForwardProtectionCheckpoint(restored,overlay.entries[FORWARD_PROTECTION_STORAGE]);
  assert.deepEqual(r.positions[0]!.unified,f.s.positions[0]!.unified);assert.ok(Buffer.byteLength(JSON.stringify(overlay.entries))<120*1024);
  const corrupt=structuredClone(r);corrupt.positions[0]!.unified!.returnLogic!.entryPrice=NaN;assert.throws(()=>normalizeForward(corrupt,i.now+2),/依据或资金/);
});
test('manual account reset retains the direct policy and market observer; public review identifies the actual strategy',()=>{
  const f=fixture();f.s.opportunities=[f.o];const v=forwardSummary(f.s,{TEST_USDT:q()},T);assert.equal(v.opportunities[0]!.side,'SHORT');
  const snapshot=buildReviewSnapshot({view:v,exportedAt:T,buildSha:'synthetic',strategyFingerprint:'synthetic'});
  assert.equal(snapshot.research.decisionAccount,'DIRECT_STRATEGY');assert.equal(snapshot.inverseExperiment,null);
  const next=resetForwardAccountPreservingLearning(f.s,T+B);assert.equal(next.directStrategy!.version,DIRECT_STRATEGY_VERSION);
  assert.deepEqual(next.extremumRegime,f.s.extremumRegime);assert.deepEqual(next.directStrategy!.plans,{});near(next.balance,1000);assert.equal(next.inverseTrial,undefined);
});
async function checkpointWorker(){
  const f=fixture();openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});
  // Cutover is committed separately; this fixture exercises subsequent 2s/10s protection.
  f.s.directStrategy!.marketAuthority=initialMarketAuthority(T);
  f.s.directStrategy!.adaptive={version:'adaptive-causal-v1',cutoverAt:T};
  f.s.directStrategy!.specialMove={version:'special-move-v1',cutoverAt:T};
  f.s.paperExecution={version:'live-steps-paper-v1',cutoverAt:T,cancelled:[]};
  f.s.storage={persistedAt:T,error:null};f.s.lastQuoteCycleAt=T;
  const data=new Map<string,unknown>(Object.entries((await prepareForwardWrite(null,f.s,T,{compact:true})).entries)),writes:string[][]=[];
  const storage={get:async<V>(k:string)=>structuredClone(data.get(k)) as V|undefined,put:async(entries:Record<string,unknown>)=>{
    writes.push(Object.keys(entries));for(const [k,v]of Object.entries(entries))data.set(k,structuredClone(v));
  },transaction:async<V>(fn:(s:typeof storage)=>Promise<V>)=>fn(storage)};
  // This test uses the real Worker with only storage/market host inputs injected.
  // No bootstrap, private exchange call, owner mutation or network is allowed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h=new MarketStream({storage,waitUntil(){}} as never,{} as never,true) as any;
  h.forwardState=f.s;h.ensureAdaptiveAccount=async()=>{};h.strategyCandles={};h.turnDailyCandles={};
  h.forwardMinutePaths=()=>({});h.regimeContracts=()=>({TEST_USDT:{...c,enableDecimal:false,orderSizeMin:'1'}});
  h.dispatched=[];h.dispatchCommittedLiveSource=()=>{h.dispatched.push(h.forwardState.positions.map((t:typeof f.s.positions[number])=>sourceLifecycle(h.forwardState,t.id).status));};
  let price=101;h.forwardQuotes=(now:number)=>({TEST_USDT:{...q(price,now),bids:[{price,size:100000}],asks:[{price:price+.02,size:100000}]}});h.forwardAnalysisQuotes=h.forwardQuotes;
  return{h,data,writes,storage,setPrice:(p:number)=>{price=p;}};
}
test('real Worker exposes a consistent fresh depth quote only for its bounded matching window, then restores BBO',async()=>{
  const {h}=await checkpointWorker(),now=T+2000;
  h.runtime.evidence={TEST_USDT:{fresh:true,observedAt:now,bestBid:100,bestAsk:100.02}};
  h.runtime.contractMeta={TEST_USDT:c};h.runtime.tickSize={TEST_USDT:.01};h.symbolEntryReady=()=>true;
  h.gateStream.book=()=>({symbol:'TEST_USDT',observedAt:now,sequence:9,
    bids:[{price:100,size:10}],asks:[{price:100.02,size:10}]});
  h.paperDepthBooks.set('TEST_USDT',{symbol:'TEST_USDT',observedAt:now,sequence:44,
    bids:[{price:99.99,size:10},{price:99.98,size:1000}],asks:[{price:100.03,size:10},{price:100.04,size:1000}]});
  const read=MarketStream.prototype as unknown as {forwardQuotes:(this:unknown,now:number)=>Record<string,Quote>};
  const deep=read.forwardQuotes.call(h,now).TEST_USDT!;
  assert.equal(deep.bookCoverage,'DEPTH20');assert.equal(deep.bestAsk,deep.asks![0]!.price);assert.equal(deep.bookSequence,44);
  assert.equal(deep.observedAt,now);assert.equal(deep.asks!.length,2);
  const stale=read.forwardQuotes.call(h,now+2001).TEST_USDT!;assert.equal(stale.bookCoverage,'BBO');assert.equal(stale.asks!.length,1);
});
test('real2s Worker coalesces transient protection until the durable10s slot without errors or unsaved publication',async()=>{
  const {h,data,writes,setPrice}=await checkpointWorker();
  await h.advanceForwardNow(T+2000,false);assert.equal(h.forwardError,null);assert.equal(writes.length,1);
  const committed=structuredClone(h.forwardState);setPrice(101.2);
  await h.advanceForwardNow(T+4000,false);assert.equal(h.forwardError,null);assert.equal(writes.length,1);
  assert.deepEqual(h.forwardState,committed);assert.ok(h.forwardPendingProtection);setPrice(101.1);
  await h.advanceForwardNow(T+12000,false);assert.equal(h.forwardError,null);assert.equal(writes.length,2);
  assert.equal(h.forwardPendingProtection,null);near(h.forwardState.positions[0].adverse,.0122);
  assert.equal(h.forwardState.positions[0].directExitResearch.version,'actual-exit-research-v1');
  assert.ok(h.forwardState.positions[0].directExitResearch.points.some((p:{at:number})=>p.at===T+4000));
  assert.equal(h.forwardProtectionBudget.writes,2);assert.ok(writes.every(w=>w.length===1&&w[0]===FORWARD_PROTECTION_STORAGE));
  const r=await readForwardStore({get:async<V>(k:string)=>structuredClone(data.get(k)) as V|undefined},T+13000);
  near(r.positions[0]!.adverse,h.forwardState.positions[0].adverse);near(r.balance,committed.balance);
  assert.deepEqual(r.positions[0]!.directExitResearch,h.forwardState.positions[0].directExitResearch);
});
test('a financial exit bypasses a pending10s overlay, while restart retains the durable resource slot',async()=>{
  const {h,data,writes,setPrice}=await checkpointWorker();await h.advanceForwardNow(T+2000,false);
  setPrice(101.2);await h.advanceForwardNow(T+4000,false);assert.ok(h.forwardPendingProtection);
  setPrice(97.8);await h.advanceForwardNow(T+6000,false);assert.equal(h.forwardError,null);
  assert.equal(h.forwardState.positions.length,1);assert.equal(h.forwardState.history.length,0);
  assert.equal(h.forwardState.positions[0].paperOrder.action.kind,'CLOSE');assert.equal(h.forwardPendingProtection,null);
  assert.equal(sourceLifecycle(h.forwardState,h.forwardState.positions[0].id).status,'CLOSED');
  assert.deepEqual(h.dispatched,[['CLOSED']], 'LIVE is dispatched at committed exit intent, before PAPER fills');
  await h.advanceForwardNow(T+8000,false);assert.equal(h.forwardState.positions[0].paperOrder.action.phase,'SUBMITTED');
  await h.advanceForwardNow(T+10000,false);assert.equal(h.forwardError,null);
  assert.equal(h.forwardState.positions.length,0);assert.equal(h.forwardState.history.length,1);assert.equal(h.forwardPendingProtection,null);
  assert.equal(h.forwardProtectionBudget.writes,1);assert.ok(writes.at(-1)!.some(k=>k.endsWith('head')));
  const r=await readForwardStore({get:async<V>(k:string)=>structuredClone(data.get(k)) as V|undefined},T+11000);
  near(r.balance,h.forwardState.balance);near(r.history[0]!.adverse,.0122);
  assert.equal(r.history[0]!.directExitResearch!.finalNet,r.history[0]!.netPnl);
  const fresh=await checkpointWorker();fresh.h.forwardProtectionBudget=nextProtectionWriteBudget(null,T+2000);
  fresh.data.set(FORWARD_PROTECTION_STORAGE,{...(prepareForwardProtectionWrite(fresh.h.forwardState).entries[FORWARD_PROTECTION_STORAGE] as object),
    writeBudget:fresh.h.forwardProtectionBudget});
  const unchanged=structuredClone(fresh.h.forwardState);await fresh.h.advanceForwardNow(T+4000,false);
  assert.equal(fresh.h.forwardError,null);assert.equal(fresh.writes.length,0);assert.deepEqual(fresh.h.forwardState,unchanged);
  await fresh.h.advanceForwardNow(T+12000,false);assert.equal(fresh.h.forwardError,null);assert.equal(fresh.writes.length,1);
  assert.equal(fresh.h.forwardProtectionBudget.writes,2);
});
test('failed intent commit retains financial and LIVE source authority; retry dispatches exactly once before matching',async()=>{
  const {h,storage,setPrice}=await checkpointWorker(),before=structuredClone(h.forwardState),put=storage.put;
  setPrice(97.8);storage.put=async()=>{throw new Error('synthetic failed durable commit');};
  await h.advanceForwardNow(T+2000,false);assert.match(h.forwardError,/failed durable commit/);
  assert.deepEqual(h.forwardState,before);assert.deepEqual(h.dispatched,[]);
  storage.put=put;await h.advanceForwardNow(T+4000,false);assert.equal(h.forwardError,null);
  assert.deepEqual(h.dispatched,[['CLOSED']]);assert.equal(h.forwardState.history.length,0);
});
test('new-only LIVE fence and native sizing use actual direct intent and fixed leverage',()=>{
  const f=fixture();const session=startLiveSession(T-1,f.s),fenced=fenceLiveSourcePolicy({...session,sourcePolicy:'unified-paper-live-v1'},f.s,T);
  assert.equal(fenced.sourcePolicy,'direct-thesis-live-v2');openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});const t=f.s.positions[0]!;
  assert.equal(sourceAfterEnable(t,fenced,f.s.startedAt),true);
  const mirror=buildProportionalMirror({source:t,sourceEquity:1000,equity:300,available:300,entryPrice:100,quantoMultiplier:.1,
    leverageMax:20,maintenanceRate:.005,openRisk:0,sameDirectionRisk:0,openMargin:0,openNotional:0,now:T,
    policy:'direct-thesis-live-v2',mirrorRatio:.3,sourceRiskAuthority:true,sizeRules:{enableDecimal:false,orderSizeMin:'1'}});
  near(mirror.intent.leverage,5);assert.equal(mirror.binding.receipt.unifiedBranch,'RETURN');assert.match(mirror.intent.body.size,/^-/);
});
test('research freezes the event region instead of moving its boundaries after the breakout',()=>{
  const f=fixture(),changed={...f.o,winnerPlan:{...f.o.winnerPlan!,origin:{...area,lower:101,upper:105,formedAt:T+B}}};
  const p=researchDirectPlan(f.s,changed,f.input(T+2*B,103.5,up),f.p);
  assert.deepEqual(p.region,area);assert.equal(p.branch,'CONTINUATION');
});
test('quote-only direct observation does not write a full financial generation or duplicate entry fees',()=>{
  const f=fixture();openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});const i=f.input(T+2000,100);
  const next=advanceDirectStrategy(i);assert.equal(next.changed,false);near(next.state.balance,f.s.balance);near(next.state.fees,f.s.fees);
  assert.equal(next.state.positions.length,1);assert.equal(next.state.inverseTrial,undefined);
});
test('ten held plans and thirty research plans fit existing compact state and single-value protection limits',async()=>{
  const f=fixture();openDirectPlan(f.s,f.p,q(),c,T,{TEST_USDT:q()});const template=f.s.positions[0]!;
  f.s.positions=Array.from({length:10},(_,i)=>{const t=structuredClone(template);t.id=`ue-synthetic-${i}-r`;t.symbol=`CASE${i}_USDT`;return t;});
  f.s.fees=f.s.positions.reduce((n,t)=>n+t.entryFee,0);f.s.balance=1000-f.s.fees;f.s.turnover=f.s.positions.reduce((n,t)=>n+t.notional,0);
  f.s.directStrategy!.plans=Object.fromEntries(Array.from({length:30},(_,i)=>{const p=structuredClone(f.p);p.symbol=`CASE${i}_USDT`;p.id=`case-${i}`;
    p.candidate.symbol=p.symbol;p.candidate.id=p.id;return[p.symbol,p];}));f.s.storage.persistedAt=T;
  f.s.directStrategy!.memory=Object.fromEntries(Object.values(f.s.directStrategy!.plans).map(p=>[p.symbol,{id:p.id,region:p.region,continuationSeen:false}]));
  assertInverseTrial(f.s);const w=await prepareForwardWrite(null,f.s,T,{compact:true}),overlay=prepareForwardProtectionWrite(f.s);
  assert.ok(w.compression.rawBytes<2*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify(overlay.entries))<112*1024);
  const db=new Map(Object.entries(w.entries)),restored=await readForwardStore({get:async<V>(k:string)=>structuredClone(db.get(k)) as V|undefined},T+1);
  assert.equal(restored.positions.length,10);assert.equal(Object.keys(restored.directStrategy!.plans).length,30);assertInverseTrial(restored);
});
test('compact research checkpoint remembers accepted trend across restart without a full account or companion packet',()=>{
  const f=fixture();f.s.storage.persistedAt=T;const base=structuredClone(f.s),i=f.input(T+2*B,103.5,up);
  researchDirectPlan(f.s,f.o,i);const checkpoint=prepareForwardProtectionWrite(f.s);
  assert.equal(checkpoint.writes,1);const restored=restoreForwardProtectionCheckpoint(base,checkpoint.entries[FORWARD_PROTECTION_STORAGE]);
  restored.extremumRegime.updatedAt=i.now-20000;
  const p=researchDirectPlan(restored,f.o,{...i,state:restored},restored.directStrategy!.plans.TEST_USDT);
  assert.equal(p.branch,'RETURN');assert.equal(p.continuationSeen,true);
  assert.match(openDirectPlan(restored,p,i.quotes.TEST_USDT!,c,i.now,i.quotes)!,/确认延续/);near(restored.balance,1000);
});
