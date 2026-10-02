/* eslint-disable @typescript-eslint/no-explicit-any -- injected real-Worker fault harness, no exchange network */
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {initialForward,type Trade} from '../lib/forward-relations.ts';
import {forwardMirrorSources,buildProportionalMirror,mirrorCoverage,sourceLifecycle,mirrorPositionRisk,mirrorSourceFresh} from '../lib/live-parity.ts';
import {liveProtectionPrice} from '../lib/live-source-policy.ts';
import {buildLiveStopIntent} from '../lib/gate-live.ts';
import {inverseEntryPriceLimit,entryPriceFits} from '../lib/live-entry-price.ts';
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
for(const side of ['LONG','SHORT'] as const)test(`inverse of ${side} keeps exact source identity and has no independent native stop`,()=>{
  const {state,t,inverse}=pair(side,T),before=structuredClone(state),row=forwardMirrorSources(state,1000).TEST_USDT!;
  assert.equal(row.side,side==='LONG'?'SHORT':'LONG');assert.equal(row.id,inverse.id);assert.deepEqual(row.forwardSource,inverse);
  assert.equal(row.activeStopPrice,t.stopPrice);assert.equal(liveProtectionPrice(inverse),null);assert.deepEqual(state,before);
  t.stopPrice=side==='LONG'?120:80;inverse.stopPrice=t.stopPrice;inverse.inverseCopy!.sourceStopPrice=t.stopPrice;
  assert.equal(liveProtectionPrice(inverse),null,'moving source references never become an inverse stop');
  const r=buildProportionalMirror({source:inverse,sourceEquity:1000,equity:100,available:100,entryPrice:100,
    quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,openRisk:0,sameDirectionRisk:0,openMargin:0,openNotional:0,
    now:T+200,policy:'inverse',sourceRiskAuthority:true,quoteObservedAt:T,sizeRules:{enableDecimal:false,orderSizeMin:'1'}});
  assert.equal(Math.sign(r.intent.size),side==='LONG'?-1:1);assert.equal(r.binding.receipt.sourceRole,'INVERSE_PAPER');
  assert.equal(r.binding.receipt.nativeProtectionPrice,null);assert.equal(r.binding.receipt.exitPolicy,'shadow-events-only-v1');assert.equal(r.binding.receipt.shadowSourceId,t.id);
  assert.deepEqual(r.binding.sourceAtCopy,inverse);
  assert.equal(r.intent.leverage,5);assert.equal(r.intent.notional,100);assert.equal(r.intent.margin,20);
  assert.equal(r.binding.receipt.sourceLeverage,10);assert.equal(r.binding.receipt.executionLeverage,5);
});
test('inverse copying does not require fabricated native geometry but still validates inverse identity',()=>{
  const {inverse}=pair('LONG',T);inverse.inverseCopy!.sourceEntryPlan=undefined;
  assert.equal(liveProtectionPrice(inverse),null);
  inverse.inverseCopy!.sourceSide=inverse.side;assert.throws(()=>liveProtectionPrice(inverse),/方向无效/);
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
  const quote=side==='LONG'?100.02:99.98;
  stream.runtime.evidence.TEST_USDT={bestBid:quote,bestAsk:quote,midpoint:quote,observedAt:now,fresh:true};
  stream.saveCheckpoint=async()=>{for(const [key,value]of stream.liveJournal)data.set(key,structuredClone(value));stream.liveJournal.clear();};
  const calls={entries:0,stops:[] as any[],reductions:[] as string[],closes:0,leverage:0,cancels:[] as string[]},positions:any[]=[],priceOrders:any[]=[],orders=new Map<string,any>();
  const gate={snapshot:async()=>({account:{total:'100',available:'90',unrealised_pnl:'0',margin_mode:0},
    positions:structuredClone(positions),orders:[],priceOrders:structuredClone(priceOrders),checkedAt:Date.now()}),
    setLeverage:async(_symbol?:string,leverage=5)=>{calls.leverage++;if(positions[0]){
      positions[0].margin=String(Number(positions[0].margin)*Number(positions[0].leverage)/leverage);
      positions[0].leverage=String(leverage);return structuredClone(positions[0]);}},
    createEntry:async(intent:any,guard:()=>boolean)=>{assert.ok(guard());calls.entries++;
      assert.equal(intent.kind,'MARKET');assert.equal(intent.body.price,'0');assert.equal(intent.body.tif,'ioc');
      const price=String(inverse.side==='LONG'?stream.runtime.evidence.TEST_USDT.bestAsk:stream.runtime.evidence.TEST_USDT.bestBid);
      positions.push({contract:'TEST_USDT',size:String(intent.size),entry_price:price,leverage:String(intent.leverage),margin:String(intent.margin),unrealised_pnl:'0',mark_price:price});
      orders.set('entry',{id_string:'entry',status:'finished',finish_as:'filled',fill_price:price,size:String(intent.size),left:'0'});return'entry';},
    inspectEntry:async(_kind:string,_symbol:string,_tag:string,id:string)=>orders.get(id)??null,
    createStop:async(intent:any)=>{calls.stops.push(intent);const id='stop'+calls.stops.length;
      priceOrders.push({id_string:id,text:intent.tag,initial:intent.body.initial});return id;},
    closePosition:async()=>{calls.closes++;positions.length=0;return'exit';},
    reducePosition:async(_symbol:string,direction:string,text:string)=>{calls.reductions.push(text);
      positions[0]!.size=String((direction==='LONG'?1:-1)*(Math.abs(Number(positions[0]!.size))-Number(text)));return'reduce';},
    cancelOrder:async(_kind:string,id:string)=>{calls.cancels.push(id);const i=priceOrders.findIndex(p=>p.id_string===id);if(i>=0)priceOrders.splice(i,1);},requestCount:0};
  Object.assign(gate,{
    sourceExit:async(_symbol:string,side:'LONG'|'SHORT',tag:string,limit:any,guard:()=>boolean)=>{
      assert.ok(guard());calls.closes++;
      const qty=Math.abs(Number(positions[0]?.size??0)),price=limit?.price??'100';positions.length=0;
      const order={id_string:'exit',status:'finished',finish_as:'filled',fill_price:price,
        size:String((side==='LONG'?-1:1)*qty),left:'0'};orders.set('exit',order);return{orderId:'exit',order};
    },
    position:async()=>structuredClone(positions[0]??{contract:'TEST_USDT',size:'0'}),
  });
  stream.gateLive=async()=>gate;
  return{stream,state,t,inverse,calls,gate,jobs,data,positions,priceOrders};
}
test('committed close executes before slow account reads, including owner OFF, without source mutation',async()=>{
  const h=await harness('LONG');await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  h.inverse.status='CLOSED';h.inverse.closedAt=Date.now();h.inverse.exitPrice=101;
  h.state.positions=[];h.state.history=[h.inverse];h.stream.runtime.live.requestedEnabled=false;
  const original=structuredClone(h.state),snapshot=h.gate.snapshot;
  let release!:()=>void,entered!:()=>void;
  const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
  (h.gate as any).snapshot=async(callback:any)=>{
    const result:any=await snapshot();result.positionsCheckedAt=Date.now();
    await callback(result.positions,result.positionsCheckedAt);entered();await wait;return result;
  };
  const running=h.stream.syncLive(Date.now());await ready;
  assert.equal(h.calls.closes,1);assert.equal(h.positions.length,0);assert.deepEqual(h.state,original);
  const overlapping=h.stream.syncLive(Date.now()); // joins the serialized work
  release();await Promise.all([running,overlapping]);assert.equal(h.stream.runtime.live.requestedEnabled,false);
});
test('real Worker migrates an existing inverse holding once without adding or closing a contract',async()=>{
  const h=await harness('LONG');await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  const position=h.stream.runtime.live.positions.TEST_USDT,before=structuredClone(position),source=structuredClone(h.state);
  h.positions[0].leverage='10';h.positions[0].margin=String(position.notional/10);
  delete position.parity.executionLeverage;delete position.parity.leveragePolicy;
  const counts={...h.calls};await h.stream.syncLive(Date.now());
  assert.equal(h.calls.leverage,counts.leverage+1);assert.equal(h.calls.entries,counts.entries);assert.equal(h.calls.closes,counts.closes);
  assert.equal(h.positions[0].leverage,'5');assert.equal(position.exchangeSize,before.exchangeSize);
  assert.equal(position.notional,before.notional);assert.deepEqual(h.state,source);
  await h.stream.syncLive(Date.now());assert.equal(h.calls.leverage,counts.leverage+1);assert.equal(position.leverage,5);
  assert.equal(position.parity.discrepancy,null);assert.equal(position.parity.leverageAdjustError,null);
});
test('committed reduction uses the early exposure callback without duplicate submission',async()=>{
  const h=await harness('SHORT');await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  const initial=h.inverse.contracts;h.inverse.contracts*=.6;h.inverse.quantity*=.6;
  h.inverse.notional*=.6;h.inverse.margin*=.6;h.inverse.plannedRisk*=.6;
  h.inverse.realization={sequence:1,initialContracts:initial} as Trade['realization'];
  const original=h.gate.snapshot;
  (h.gate as any).snapshot=async(callback:any)=>{
    const result:any=await original();result.positionsCheckedAt=Date.now();
    await callback(result.positions,result.positionsCheckedAt);
    assert.deepEqual(h.calls.reductions,['4']);return result;
  };
  await h.stream.syncLive(Date.now());assert.deepEqual(h.calls.reductions,['4']);assert.equal(h.calls.stops.length,0);
});
test('real Worker keeps an unknown exit identity across reconciliation and never sends a fallback blindly',async()=>{
  const h=await harness('LONG');await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  h.inverse.status='CLOSED';h.inverse.closedAt=Date.now();h.state.positions=[];h.state.history=[h.inverse];
  (h.gate as any).sourceExit=async()=>{h.calls.closes++;throw new Error('unknown exit timeout');};
  await assert.rejects(h.stream.syncLive(Date.now()),/unknown exit/);
  const p=h.stream.runtime.live.positions.TEST_USDT,tag=p.sourceExit.last.tag;
  p.sourceExit=JSON.parse(JSON.stringify(p.sourceExit));await h.stream.syncLive(Date.now());
  assert.equal(h.calls.closes,1);assert.equal(p.sourceExit.last.tag,tag);assert.equal(p.sourceExit.last.terminal,false);
});
for(const side of ['LONG','SHORT'] as const)test(`real Worker copies inverse ${side} open/reduce/close using one resident quote and unique reservation`,async()=>{
  const h=await harness(side),priorFetch=globalThis.fetch;let network=0;
  globalThis.fetch=async()=>{network++;throw new Error('network forbidden');};
  try{
    await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);assert.equal(network,0);
    assert.equal(h.calls.stops.length,0);
    await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);
    const filledBefore=Math.abs(Number(h.positions[0].size)),initial=h.inverse.contracts;h.inverse.contracts*=.6;h.inverse.quantity*=.6;h.inverse.notional*=.6;h.inverse.margin*=.6;h.inverse.plannedRisk*=.6;
    h.inverse.realization={sequence:1,initialContracts:initial} as Trade['realization'];
    await h.stream.syncLive(Date.now());assert.deepEqual(h.calls.reductions,[String(filledBefore-Math.ceil(filledBefore*.6))]);assert.equal(h.calls.entries,1);
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
test('favorable price ticks are exact, including off-grid and exponent prices',()=>{
  for(const [entry,tick,long,short]of [[100,.01,99.99,100.01],[100.005,.01,99.99,100.02],
    [.0000001,.00000001,.00000009,.00000011],[.3,.1,.2,.4]]){
    assert.equal(inverseEntryPriceLimit({side:'LONG',entryPrice:entry},tick).price,long);
    assert.equal(inverseEntryPriceLimit({side:'SHORT',entryPrice:entry},tick).price,short);
    assert.ok(entryPriceFits('LONG',long,long));assert.ok(!entryPriceFits('LONG',entry,long));
    assert.ok(entryPriceFits('SHORT',short,short));assert.ok(!entryPriceFits('SHORT',entry,short));
  }
  assert.throws(()=>inverseEntryPriceLimit({side:'LONG',entryPrice:100},NaN));
  assert.throws(()=>inverseEntryPriceLimit({side:'LONG',entryPrice:.01},.01));
});
for(const side of ['LONG','SHORT']as const)test(`inverse ${side} copies an adverse fresh quote once without source mutation`,async()=>{
  const h=await harness(side),before=structuredClone(h.state);
  const price=h.inverse.side==='LONG'?101:99;
  Object.assign(h.stream.runtime.evidence.TEST_USDT,{bestBid:price,bestAsk:price,midpoint:price});
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);assert.equal(h.calls.leverage,1);
  assert.deepEqual(h.state,before);
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);
});
test('price deterioration during leverage await submits the fresh quote without a favorable wait',async()=>{
  const h=await harness('LONG');h.gate.setLeverage=async()=>{
    Object.assign(h.stream.runtime.evidence.TEST_USDT,{bestBid:99.9,bestAsk:99.9,midpoint:99.9,observedAt:Date.now()});};
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);
  assert.equal(h.stream.runtime.live.entries.TEST_USDT.parity.submitQuotePrice,99.9);
});
test('theoretical profit cannot suspend new copies; sizing fixes the real capital anchor and preserves the session',async()=>{
  const h=await harness('LONG'),activation=h.stream.runtime.live.activation;
  Object.assign(activation,{scaleRatio:1,scaleSourceEquity:1000,scaleLiveEquity:1000,scaleAt:Date.now()-1000});
  const before=structuredClone(activation);await h.stream.syncLive(Date.now());
  assert.equal(h.calls.entries,1);assert.deepEqual(h.stream.runtime.live.activation,before);
  const entry=h.stream.runtime.live.entries.TEST_USDT;
  assert.equal(entry.parity.liveEquity,100);
  assert.ok(entry.parity.ratio<=100/entry.parity.sourceEquity+1e-10);
  assert.ok(entry.notional<=entry.parity.targetNotional+1e-8);assert.ok(entry.notional<110);
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);
});
test('real Worker fixed allocation survives profit/loss and an ordinary OFF-to-ON session after restart',async()=>{
  const first=await harness('LONG');await first.stream.syncLive(Date.now());
  const basis=JSON.parse(JSON.stringify(first.stream.runtime.live.fixedBasis)),original=first.stream.runtime.live.entries.TEST_USDT;
  assert.equal(basis.liveEquity,100);assert.equal(original.parity.sourceEquity,1000);
  for(const equity of [300,50]){
    const h=await harness('LONG'),snapshot=h.gate.snapshot;
    h.stream.runtime.live.fixedBasis=JSON.parse(JSON.stringify(basis));
    h.stream.runtime.live.requestedEnabled=false;
    h.stream.runtime.live.activation=startLiveSession(Date.now()-500,{...h.state,positions:[]});
    h.stream.runtime.live.requestedEnabled=true;
    h.gate.snapshot=async()=>{const s=await snapshot();s.account.total=String(equity);s.account.available=String(equity-10);return s;};
    await h.stream.syncLive(Date.now());
    assert.equal(h.calls.entries,1);assert.equal(h.calls.stops.length,0);assert.equal(h.calls.closes,0);
    const entry=h.stream.runtime.live.entries.TEST_USDT;
    assert.equal(entry.contracts,original.contracts);assert.equal(entry.parity.targetNotional,original.parity.targetNotional);
    assert.equal(entry.parity.fixedLiveEquity,100);assert.equal(entry.parity.liveEquity,equity);
    assert.deepEqual(h.stream.runtime.live.fixedBasis,basis);
  }
});
test('fixed allocation still honors actual available funds and cannot send before its anchor is checkpointed',async()=>{
  const h=await harness('LONG'),snapshot=h.gate.snapshot;
  h.gate.snapshot=async()=>{const s=await snapshot();s.account.total='2';s.account.available='1';return s;};
  h.stream.runtime.live.fixedBasis={version:'fixed-1000-v1',sourceEquity:1000,liveEquity:100,establishedAt:Date.now()-1000,accountKey:'program-account'};
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,0);assert.equal(h.calls.stops.length,0);
  const fault=await harness('LONG');fault.stream.saveCheckpoint=async()=>{if(fault.stream.runtime.live.fixedBasis)throw new Error('fixed anchor checkpoint failed');};
  await assert.rejects(fault.stream.syncLive(Date.now()),/checkpoint failed/);
  assert.equal(fault.calls.entries,0);assert.equal(fault.stream.runtime.live.fixedBasis,undefined);
});
test('actual manual LIVE OFF/ON handler retains the fixed anchor and leaves an existing holding alone',async()=>{
  const h=await harness('SHORT');await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  const basis=structuredClone(h.stream.runtime.live.fixedBasis),source=structuredClone(h.state),size=h.positions[0].size;
  assert.equal((await h.stream.setLiveMode(false)).ok,true);
  assert.deepEqual(h.stream.runtime.live.fixedBasis,basis);assert.equal(h.stream.runtime.live.requestedEnabled,false);
  assert.equal((await h.stream.setLiveMode(true)).ok,true);
  assert.deepEqual(h.stream.runtime.live.fixedBasis,basis);assert.equal(h.positions[0].size,size);
  assert.deepEqual(h.state,source);assert.equal(h.calls.entries,1);assert.equal(h.calls.stops.length,0);assert.equal(h.calls.closes,0);
});
test('final shared quote reprices within reserved capital and never increases staged contract count',async()=>{
  const h=await harness('SHORT');let staged:any;
  h.gate.setLeverage=async()=>{staged=structuredClone(h.stream.runtime.live.entries.TEST_USDT);
    Object.assign(h.stream.runtime.evidence.TEST_USDT,{bestBid:103,bestAsk:103,midpoint:103,observedAt:Date.now()});};
  await h.stream.syncLive(Date.now());const entry=h.stream.runtime.live.entries.TEST_USDT;
  assert.equal(h.calls.entries,1);assert.ok(entry.contracts<=staged.contracts);
  assert.ok(entry.notional<=entry.parity.targetNotional+1e-8);
  assert.equal(entry.parity.submitQuotePrice,103);assert.equal(entry.parity.copyQuotePrice,103);
});
test('a market IOC with zero fills is final and never replayed',async()=>{
  const h=await harness('LONG');h.gate.createEntry=async()=>{h.calls.entries++;return'zero';};
  h.gate.inspectEntry=async()=>({id_string:'zero',status:'finished',finish_as:'ioc',size:'-10',left:'-10'});
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);
  assert.equal(h.stream.runtime.live.entries.TEST_USDT.status,'CANCELLED');assert.equal(h.calls.closes,0);
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);assert.equal(h.positions.length,0);
});
test('market IOC partial fill owns actual exposure, receives source close and is never topped up',async()=>{
  const h=await harness('LONG'),create=h.gate.createEntry;
  h.gate.createEntry=async(intent:any,guard:()=>boolean)=>{
    const id=await create(intent,guard);h.positions[0].size='-4';return id;};
  h.gate.inspectEntry=async()=>({id_string:'entry',status:'finished',finish_as:'ioc',fill_price:'100.01',size:'-10',left:'-6'});
  await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  assert.equal(h.calls.entries,1);assert.equal(h.stream.runtime.live.positions.TEST_USDT.exchangeSize,4);
  assert.equal(h.stream.runtime.live.positions.TEST_USDT.side,'SHORT');
  h.inverse.status='CLOSED';h.inverse.closedAt=Date.now();h.state.positions=[];h.state.history=[h.inverse];
  await h.stream.syncLive(Date.now());assert.equal(h.calls.closes,1);assert.equal(h.calls.entries,1);
});
test('unknown market IOC result retains its identity and risk instead of resubmitting',async()=>{
  const h=await harness('LONG');h.gate.createEntry=async()=>{h.calls.entries++;throw new Error('timeout after send');};
  await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  assert.equal(h.calls.entries,1);assert.ok(h.stream.runtime.live.entries.TEST_USDT.marketSubmittedAt);
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
test('external exchange closure stays an early deviation and the same inverse parent never reopens',async()=>{
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

for(const side of ['LONG','SHORT'] as const)test(`inverse ${side} remains open beyond the removed guard and source reference moves`,async()=>{
  const h=await harness(side);h.gate.createStop=async()=>{throw new Error('independent stop forbidden');};
  await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  const price=side==='LONG'?104:96;
  h.positions[0].mark_price=String(price);h.positions[0].unrealised_pnl='-4';
  Object.assign(h.stream.runtime.evidence.TEST_USDT,{bestBid:price,bestAsk:price,midpoint:price,observedAt:Date.now()});
  h.inverse.stopPrice=side==='LONG'?120:80;h.inverse.inverseCopy!.sourceStopPrice=h.inverse.stopPrice;
  await h.stream.syncLive(Date.now());
  assert.equal(h.calls.closes,0);assert.equal(h.calls.stops.length,0);
  const p=h.stream.runtime.live.positions.TEST_USDT;assert.equal(p.status,'OPEN');assert.equal(p.stopTag,null);assert.equal(p.stopPrice,null);
  assert.ok(Number.isFinite(mirrorPositionRisk(p,price)));
  assert.equal(mirrorSourceFresh(h.inverse,h.inverse.id,h.inverse.openedAt+24*60*60*1000),true,'source alone ends a trend holding');
});

async function oldGuardHarness(){
  const h=await harness('LONG');await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  const p=h.stream.runtime.live.positions.TEST_USDT,e=h.stream.runtime.live.entries.TEST_USDT;
  Object.assign(p,{stopOrderId:'old',stopTag:'old-tag',stopPrice:102,
    replacementStopOrderId:'replacement',replacementStopTag:'replacement-tag',replacementStopPrice:103});
  Object.assign(e,{stopOrderId:'old',stopTag:'old-tag',stopPrice:102});
  h.priceOrders.push({id_string:'old',text:'old-tag'},{id_string:'replacement',text:'replacement-tag'},
    {id_string:'manual',text:'manual-tag'},{id_string:'legacy',text:'legacy-tag'});
  return h;
}
test('migration cancels existing inverse stops once, confirms absence, and preserves manual/legacy orders',async()=>{
  const h=await oldGuardHarness();
  await assert.rejects(h.stream.syncLive(Date.now()),/未纳管挂单/);
  assert.deepEqual(h.calls.cancels,['old','replacement']);assert.deepEqual(h.priceOrders.map(p=>p.id_string),['manual','legacy']);
  const p=h.stream.runtime.live.positions.TEST_USDT;assert.equal(p.stopOrderId,null);assert.equal(p.replacementStopOrderId,null);
  assert.equal(h.stream.runtime.live.entries.TEST_USDT.stopOrderId,null);assert.equal(h.calls.closes,0);
  assert.equal(p.parity.exitPolicy,'shadow-events-only-v1');assert.ok(p.parity.protectionRemovedAt);
  assert.equal(h.calls.stops.length,0);assert.equal(h.stream.runtime.live.requestedEnabled,true);
});
test('old-stop cancellation failure never forces a close, preserves reconciliation identity, and source close still wins',async()=>{
  const h=await oldGuardHarness();h.priceOrders.splice(2);h.gate.cancelOrder=async()=>{throw new Error('cancel timeout');};
  await assert.rejects(h.stream.syncLive(Date.now()),/旧保护/);
  assert.equal(h.calls.closes,0);assert.equal(h.stream.runtime.live.positions.TEST_USDT.stopOrderId,'old');
  h.inverse.status='CLOSED';h.inverse.closedAt=Date.now();h.inverse.exitReason='SHADOW_SOURCE_EXIT';h.state.positions=[];h.state.history=[h.inverse];
  await assert.rejects(h.stream.syncLive(Date.now()),/旧保护/);
  assert.equal(h.calls.closes,1);assert.equal(h.stream.runtime.live.requestedEnabled,true);
});
test('OFF and a restored position still remove inverse protection without flattening or submitting',async()=>{
  const h=await oldGuardHarness();h.priceOrders.splice(2);h.stream.runtime.live.requestedEnabled=false;
  h.stream.runtime.live.positions=structuredClone(h.stream.runtime.live.positions);
  h.stream.runtime.live.entries=structuredClone(h.stream.runtime.live.entries);
  await h.stream.syncLive(Date.now());assert.deepEqual(h.calls.cancels,['old','replacement']);
  assert.equal(h.calls.closes,0);assert.equal(h.calls.entries,1);assert.equal(h.stream.runtime.live.requestedEnabled,false);
});
test('a late old stop is removed by its retired identity after the first cleanup',async()=>{
  const h=await oldGuardHarness();h.priceOrders.splice(2);await h.stream.syncLive(Date.now());
  h.priceOrders.push({id_string:'late',text:'old-tag'});await h.stream.syncLive(Date.now());
  assert.deepEqual(h.calls.cancels,['old','replacement','late']);assert.equal(h.priceOrders.length,0);assert.equal(h.calls.closes,0);
});

test('restart recovers an old immediate stop identity even when its response was never checkpointed',async()=>{
  const h=await harness('LONG');await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  const e=h.stream.runtime.live.entries.TEST_USDT,p=h.stream.runtime.live.positions.TEST_USDT;
  for(const record of [e,p]){record.parity.nativeProtectionPrice=102;record.parity.nativeProtectionPolicy='inverse-paper-live-v1';delete record.parity.exitPolicy;}
  const old=buildLiveStopIntent({id:e.planId,symbol:e.symbol,side:e.side,currentStop:102},.01);
  h.priceOrders.push({id_string:'orphan',initial:{text:old.tag}});h.stream.runtime.live.requestedEnabled=false;
  await h.stream.syncLive(Date.now());assert.deepEqual(h.calls.cancels,['orphan']);assert.equal(h.calls.closes,0);
  assert.ok(p.parity.retiredProtectionTags.includes(old.tag));assert.equal(h.priceOrders.length,0);
});

test('noninverse legacy native stop creation remains intact',async()=>{
  const h=await harness('LONG');
  await h.stream.createImmediateLiveStop(h.gate,{planId:'legacy-source',symbol:'TEST_USDT',side:'LONG',invalidation:98});
  assert.equal(h.calls.stops.length,1);assert.equal(h.calls.stops[0].price,98);assert.equal(h.calls.closes,0);
});

function unifiedFixture(h:Awaited<ReturnType<typeof harness>>,branch:'RETURN'|'CONTINUATION',openedAt=Date.now()-100){
  const t=h.inverse,sourceId=t.inverseCopy!.sourceId,referenceId=t.id;
  delete t.inverseCopy;t.id=`ue-${sourceId}-${branch==='RETURN'?'r':'c'}`;t.openedAt=openedAt;t.leverage=5;t.margin=t.notional/5;
  if(branch==='CONTINUATION'){t.side='LONG';t.stopPrice=98;t.rule.side='LONG';t.entryContext!.side='LONG';t.entryContext!.winnerPlan={...h.t.entryContext!.winnerPlan!,initialStop:98,target:110};}
  t.unified={version:'return-continuation-v1',branch,sourceId,referenceId,region:{lower:98,upper:102,center:100,formedAt:openedAt-600000,balanced:true,basis:'OHLCV_PROXY'},
    epsilon:.01,confirmation:null,initialStop:branch==='CONTINUATION'?98:null,referenceContracts:t.contracts,
    entryReason:'test',holdReason:'test',exitCondition:'test',lastDecisionAt:openedAt,lastBarAt:0,decision:'HOLD',explanationEvents:[]};
  return t;
}
for(const branch of ['RETURN','CONTINUATION'] as const)test(`real Worker executes unified ${branch} at 5x, honors committed reduction/close and deduplicates`,async()=>{
  const h=await harness('LONG'),t=unifiedFixture(h,branch);await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  assert.equal(h.calls.entries,1);assert.equal(h.positions[0].leverage,'5');
  const p=h.stream.runtime.live.positions.TEST_USDT;assert.equal(p.parity.sourceRole,'UNIFIED_PAPER');assert.equal(p.parity.unifiedBranch,branch);
  assert.equal(h.calls.stops.length,branch==='RETURN'?0:1);
  t.contracts*=.6;t.quantity*=.6;t.notional*=.6;t.margin*=.6;t.plannedRisk*=.6;t.realization={sequence:1,initialContracts:100} as Trade['realization'];
  await h.stream.syncLive(Date.now());assert.deepEqual(h.calls.reductions,['4']);
  await h.stream.syncLive(Date.now());assert.deepEqual(h.calls.reductions,['4']);
  t.status='CLOSED';t.closedAt=Date.now();t.exitReason='CONTINUATION_STRUCTURE_EXIT';h.state.positions=[];h.state.history=[t];
  await h.stream.syncLive(Date.now());assert.equal(h.calls.closes,1);assert.equal(h.calls.entries,1);
  assert.equal(h.stream.runtime.live.requestedEnabled,true);
});
test('unified conversion cannot open its opposite exposure while an old close remains unknown',async()=>{
  const h=await harness('LONG'),old=unifiedFixture(h,'RETURN');await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  const newer=structuredClone(old);newer.id=newer.id.slice(0,-1)+'c';newer.side='LONG';newer.unified!.branch='CONTINUATION';newer.openedAt=Date.now();newer.stopPrice=98;
  old.status='CLOSED';old.closedAt=Date.now();h.state.positions=[newer];h.state.history=[old];
  (h.gate as any).sourceExit=async()=>{h.calls.closes++;throw new Error('unknown conversion close');};
  await assert.rejects(h.stream.syncLive(Date.now()),/unknown conversion close/);
  await h.stream.syncLive(Date.now());assert.equal(h.calls.entries,1);assert.equal(h.calls.closes,1);
  assert.equal(h.stream.runtime.live.positions.TEST_USDT.sourceExit.last.terminal,false);
});

test('unified policy migration preserves the manual session and scale; first cutover intent remains eligible without old replay',async()=>{
  const h=await harness('LONG'),enabled=h.stream.runtime.live.activation.enabledAt,oldId=h.inverse.id;
  h.state.unifiedExecution={version:'return-continuation-v1',cutoverAt:Date.now()-120,reference:shadowCapsule(h.state),episodes:{},legacyIds:[oldId],completedConversions:0,droppedEpisodes:0};
  const t=unifiedFixture(h,'RETURN',h.state.unifiedExecution.cutoverAt);
  h.stream.runtime.live.activation.scaleRatio=.1;await h.stream.syncLive(Date.now());await h.stream.syncLive(Date.now());
  assert.equal(h.stream.runtime.live.activation.enabledAt,enabled);assert.equal(h.stream.runtime.live.activation.scaleRatio,.1);
  assert.equal(h.stream.runtime.live.activation.sourcePolicy,'unified-paper-live-v1');assert.equal(h.calls.entries,1);
  assert.equal(sourceAfterEnable({...t,id:oldId,openedAt:h.state.unifiedExecution.cutoverAt-1},h.stream.runtime.live.activation,h.state.startedAt),false);
});

test('member feed carries unified cutover identity and actual branch but no reference wallet; archive close accepts unified IDs',async()=>{
  const h=await harness('LONG');
  h.state.unifiedExecution={version:'return-continuation-v1',cutoverAt:Date.now()-120,reference:shadowCapsule(h.state),episodes:{},legacyIds:[],completedConversions:0,droppedEpisodes:0};
  const t=unifiedFixture(h,'RETURN'),before=structuredClone(h.state);
  const response=await h.stream.fetch(new Request('https://primary/member-feed')),feed=await response.json() as any;
  assert.equal(feed.state.unifiedExecution.version,'return-continuation-v1');assert.equal(feed.state.unifiedExecution.reference,undefined);
  assert.equal(feed.state.positions[0].unified.branch,'RETURN');assert.deepEqual(h.state,before);
  t.status='CLOSED';t.closedAt=Date.now();h.state.positions=[];h.state.history=[t];
  const res=await h.stream.fetch(new Request(`https://primary/member-closed?id=${t.id}&openedAt=${t.openedAt}`));
  assert.equal(res.status,200);assert.equal((await res.json() as any).trade.id,t.id);
});
