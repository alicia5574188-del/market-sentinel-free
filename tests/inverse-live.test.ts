/* eslint-disable @typescript-eslint/no-explicit-any -- injected real-Worker fault harness, no exchange network */
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {initialForward,type Trade} from '../lib/forward-relations.ts';
import {forwardMirrorSources,buildProportionalMirror,mirrorCoverage,sourceLifecycle} from '../lib/live-parity.ts';
import {liveProtectionPrice} from '../lib/live-source-policy.ts';
import {startLiveSession,fenceLiveSourcePolicy,sourceAfterEnable,sameLiveSession} from '../lib/live-session.ts';
import {newInverseTrial,sourceDecisionState,shadowCapsule,applyInverseSourceTrade} from '../lib/shadow-inverse-ledger.ts';
registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return{shortCircuit:true,url:'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}'};
  if(specifier==='vinext/server/app-router-entry')return{shortCircuit:true,url:'data:text/javascript,export default {fetch(){return new Response("fake shell")}}'};
  return next(specifier,context);
}});
const {MarketStream}=await import('../worker/index-clean.ts?inverse-live-tests');
const T=1790809800000;
function sourceTrade(side:'LONG'|'SHORT',now:number):Trade {
  const stop=side==='LONG'?98:102;
  return {id:'source-'+side,symbol:'TEST_USDT',side,status:'OPEN',openedAt:now,closedAt:null,entryPrice:100,exitPrice:null,
    quantity:10,contracts:100,quantoMultiplier:.1,notional:1000,leverage:10,margin:100,plannedRisk:22,
    stopPrice:stop,armPrice:side==='LONG'?105:95,lastPrice:100,lastQuoteAt:now,favorable:0,adverse:0,
    entryFee:.7,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
    rule:{id:'rule',horizon:180,side,stopRate:.02,exitMode:'REACTION_DECAY',givebackRate:.01,reason:'test source'},
    entryContext:{winnerPlan:{initialStop:stop},strategyVersion:'market-intelligence-v1',side,mode:'RELATIVE'}
  } as Trade;
}
function pair(side:'LONG'|'SHORT',now:number){
  const state=initialForward(now-100000);state.inverseTrial=newInverseTrial(state,now,1000);
  const source=sourceDecisionState(state),t=sourceTrade(side,now);
  source.positions=[t];source.balance-=.7;source.fees+=.7;
  applyInverseSourceTrade(state,t,undefined,now);state.inverseTrial.source=shadowCapsule(source);
  return{state,t,inverse:state.positions[0]!};
}
for(const side of ['LONG','SHORT'] as const)test(`inverse of ${side} keeps exact source identity and valid opposite native risk geometry`,()=>{
  const {state,t,inverse}=pair(side,T),before=structuredClone(state),row=forwardMirrorSources(state,1000).TEST_USDT!;
  assert.equal(row.side,side==='LONG'?'SHORT':'LONG');assert.equal(row.id,inverse.id);assert.deepEqual(row.forwardSource,inverse);
  assert.equal(row.activeStopPrice,side==='LONG'?102:98);assert.deepEqual(state,before);
  t.stopPrice=side==='LONG'?120:80;inverse.stopPrice=t.stopPrice;inverse.inverseCopy!.sourceStopPrice=t.stopPrice;
  assert.equal(liveProtectionPrice(inverse),side==='LONG'?102:98,'source profit reference never trails the inverse guard');
  const r=buildProportionalMirror({source:inverse,sourceEquity:1000,equity:100,available:100,entryPrice:100,
    quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,openRisk:0,sameDirectionRisk:0,openMargin:0,openNotional:0,
    now:T+200,policy:'inverse',sourceRiskAuthority:true,quoteObservedAt:T,sizeRules:{enableDecimal:false,orderSizeMin:'1'}});
  assert.equal(Math.sign(r.intent.size),side==='LONG'?-1:1);assert.equal(r.binding.receipt.sourceRole,'INVERSE_PAPER');
  assert.equal(r.binding.receipt.nativeProtectionPrice,row.activeStopPrice);assert.equal(r.binding.receipt.shadowSourceId,t.id);
  assert.deepEqual(r.binding.sourceAtCopy,inverse);
});
test('missing initial geometry fails closed and never uses the moving source price',()=>{
  const {inverse}=pair('LONG',T);inverse.inverseCopy!.sourceEntryPlan=undefined;
  assert.throws(()=>liveProtectionPrice(inverse),/原始风险/);
});
test('source policy migration excludes old inverse rows, preserves enable/scale, and fences in-flight intents',()=>{
  const {state,inverse}=pair('LONG',T),old={...startLiveSession(T-2000,initialForward(T-100000)),scaleRatio:.1};
  const fenced=fenceLiveSourcePolicy(old,state,T+1000);
  assert.equal(fenced.enabledAt,old.enabledAt);assert.equal(fenced.scaleRatio,.1);assert.equal(fenced.sourceStartedAt,old.sourceStartedAt);
  assert.equal(sourceAfterEnable(inverse,fenced,state.startedAt),false);assert.equal(sameLiveSession(old,fenced),false);
  assert.equal(fenceLiveSourcePolicy(fenced,state,T+2000),fenced);
  assert.equal(sourceAfterEnable({...inverse,id:'new',openedAt:T+2000},fenced,state.startedAt),true);
  const off=mirrorCoverage(state,{requestedEnabled:false,activation:fenced,entries:{},positions:{},entrySkips:{}},null);
  assert.equal(off.accountRole,'INVERSE_PAPER');assert.equal(off.rows[0]!.status,'OWNER_OFF');
});
async function harness(side:'LONG'|'SHORT') {
  const now=Date.now(),{state,t,inverse}=pair(side,now-100),data=new Map<string,unknown>(),jobs:Promise<unknown>[]=[];
  const storage={get:async(k:string)=>data.get(k),put:async(k:string|Record<string,unknown>,v?:unknown)=>{
    if(typeof k==='string')data.set(k,structuredClone(v));else for(const [key,val]of Object.entries(k))data.set(key,structuredClone(val));
  },transaction:async(fn:(s:unknown)=>Promise<unknown>)=>fn(storage)};
  // Skip primary bootstrap and inject every external dependency.
  const stream=new MarketStream({storage,waitUntil:(p:Promise<unknown>)=>jobs.push(p)} as never,{} as never,true) as any;
  stream.forwardState=state;stream.forwardError=null;stream.liveBindingError=null;stream.authorityReady=true;
  stream.runtime.live.requestedEnabled=true;stream.runtime.live.activation=startLiveSession(now-500,{...state,positions:[]});
  stream.runtime.tickSize.TEST_USDT=.01;
  stream.runtime.contractMeta.TEST_USDT={quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,enableDecimal:false,orderSizeMin:'1',orderSizeMax:'100000'};
  stream.runtime.evidence.TEST_USDT={bestBid:100,bestAsk:100,midpoint:100,observedAt:now,fresh:true};
  stream.saveCheckpoint=async()=>{for(const [key,value]of stream.liveJournal)data.set(key,structuredClone(value));stream.liveJournal.clear();};
  const calls={entries:0,stops:[] as any[],reductions:[] as string[],closes:0,leverage:0},positions:any[]=[],priceOrders:any[]=[],orders=new Map<string,any>();
  const gate={snapshot:async()=>({account:{total:'100',available:'90',unrealised_pnl:'0',margin_mode:0},
    positions:structuredClone(positions),orders:[],priceOrders:structuredClone(priceOrders),checkedAt:Date.now()}),
    setLeverage:async()=>{calls.leverage++;},
    createEntry:async(intent:any,guard:()=>boolean)=>{assert.ok(guard());calls.entries++;
      positions.push({contract:'TEST_USDT',size:String(intent.size),entry_price:'100',leverage:'10',margin:'10',unrealised_pnl:'0',mark_price:'100'});
      orders.set('entry',{id_string:'entry',status:'finished',finish_as:'filled',fill_price:'100',size:String(intent.size),left:'0'});return'entry';},
    inspectEntry:async(_kind:string,_symbol:string,_tag:string,id:string)=>orders.get(id)??null,
    createStop:async(intent:any)=>{calls.stops.push(intent);const id='stop'+calls.stops.length;
      priceOrders.push({id_string:id,text:intent.tag,initial:intent.body.initial});return id;},
    closePosition:async()=>{calls.closes++;positions.length=0;return'exit';},
    reducePosition:async(_symbol:string,direction:string,text:string)=>{calls.reductions.push(text);
      positions[0]!.size=String((direction==='LONG'?1:-1)*(Math.abs(Number(positions[0]!.size))-Number(text)));return'reduce';},
    cancelOrder:async(_kind:string,id:string)=>{const i=priceOrders.findIndex(p=>p.id_string===id);if(i>=0)priceOrders.splice(i,1);},requestCount:0};
  stream.gateLive=async()=>gate;
  return{stream,state,t,inverse,calls,gate,jobs,data};
}
for(const side of ['LONG','SHORT'] as const)test(`real Worker copies inverse ${side} open/reduce/close using one resident quote and unique reservation`,async()=>{
  const h=await harness(side),priorFetch=globalThis.fetch;let network=0;
  globalThis.fetch=async()=>{network++;throw new Error('network forbidden');};
  try{
    await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);assert.equal(network,0);
    assert.equal(h.calls.stops.length,1);assert.equal(Number(h.calls.stops[0]!.body.trigger.price),side==='LONG'?102:98);
    assert.equal(h.calls.stops[0]!.body.trigger.rule,side==='LONG'?1:2);
    await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);
    const initial=h.inverse.contracts;h.inverse.contracts*=.6;h.inverse.quantity*=.6;h.inverse.notional*=.6;h.inverse.margin*=.6;h.inverse.plannedRisk*=.6;
    h.inverse.realization={sequence:1,initialContracts:initial} as Trade['realization'];
    await h.stream.syncLive(Date.now());assert.deepEqual(h.calls.reductions,['4']);assert.equal(h.calls.entries,1);
    h.inverse.status='CLOSED';h.inverse.closedAt=Date.now();h.inverse.exitReason='SHADOW_SOURCE_EXIT';h.state.positions=[];h.state.history=[h.inverse];
    assert.equal(sourceLifecycle(h.state,h.inverse.id).status,'CLOSED');
    await h.stream.syncLive(Date.now());assert.equal(h.calls.closes,1);assert.equal(h.calls.entries,1);
    assert.equal(h.stream.runtime.live.requestedEnabled,true);
  }finally{globalThis.fetch=priorFetch;}
});
test('source close during leverage await cancels before the single market network boundary',async()=>{
  const h=await harness('LONG');h.gate.setLeverage=async()=>{
    h.inverse.status='CLOSED';h.inverse.closedAt=Date.now();h.state.positions=[];h.state.history=[h.inverse];};
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,0);assert.equal(h.calls.stops.length,0);
});
test('source dispatch coalesces concurrent events and runs a later pass after the first private await',async()=>{
  const h=await harness('LONG');let calls=0,release!:()=>void;
  h.stream.syncLive=async()=>{calls++;if(calls===1)await new Promise<void>(r=>{release=r;});};
  h.stream.dispatchCommittedLiveSource();h.stream.dispatchCommittedLiveSource();h.stream.dispatchCommittedLiveSource();
  assert.equal(calls,1);release();await Promise.all(h.jobs);assert.equal(calls,2);
  assert.equal(h.stream.liveSourceQueued,false);
});
test('a durable OFF wins over source-policy adoption and cannot be overwritten or submit an entry',async()=>{
  const h=await harness('LONG');delete h.stream.runtime.live.activation.sourcePolicy;delete h.stream.runtime.live.activation.sourcePolicyAt;
  h.data.set('live-parity:v1:owner-intent',{enabled:false,changedAt:Date.now(),activation:h.stream.runtime.live.activation});
  await assert.rejects(h.stream.syncLive(Date.now()),/所有者意图未对齐/);
  assert.equal((h.data.get('live-parity:v1:owner-intent') as {enabled:boolean}).enabled,false);assert.equal(h.calls.entries,0);
});
test('exchange protective closure stays an early deviation and the same inverse parent never reopens',async()=>{
  const h=await harness('LONG');await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  const original=h.gate.snapshot;h.gate.snapshot=async()=>({...await original(),positions:[]});
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);
  assert.equal(h.stream.runtime.live.positions.TEST_USDT.status,'CLOSED');
  assert.equal(h.stream.liveMirrorView().rows[0].status,'SOURCE_ENDED_EARLY');
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);assert.equal(h.state.positions.length,1);
});
test('member feed carries only strict source marks, values the same inverse account, and is read-only',async()=>{
  const h=await harness('LONG');h.stream.runtime.lastSuccessAt=Date.now();const before=structuredClone(h.state);
  const response=await h.stream.fetch(new Request('https://primary/member-feed')),feed=await response.json() as any;
  assert.ok(feed.state.inverseTrial.source.positions.length===1);assert.equal(feed.state.inverseTrial.source.balance,undefined);
  assert.equal(feed.state.inverseTrial.source.history,undefined);assert.deepEqual(h.state,before);assert.equal(h.calls.entries,0);
});
