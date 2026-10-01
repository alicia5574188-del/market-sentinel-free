import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileSourceClose,sourceExitFillPrice,type SourceExit} from '../lib/live-exit.ts';
import {GateLiveClient,GateEntryCancelledError,type GateLiveOrder} from '../lib/gate-live.ts';
import {liveExitPriceLimit} from '../lib/live-entry-price.ts';
import {matchSettlements} from '../lib/live-settlement.ts';
const T=1790809800000;
function fixture(){
  let state:SourceExit|undefined,quantity=10;const sent:('LIMIT'|'MARKET')[]=[];
  const input={id:'source',sourceClosedAt:T-400,sourceExitPrice:100,actualContracts:10,observedAt:T,now:T,
    limit:{price:'99.98',contractsText:'10'},stillClosed:()=>true,
    persist:async(s:SourceExit)=>{state=structuredClone(s);},inspect:async()=>null as GateLiveOrder|null,
    remaining:async()=>({contracts:quantity,observedAt:T+10}),
    submit:async(_tag:string,limit:{price:string;contractsText:string}|null,guard:()=>boolean)=>{
      assert.ok(guard());assert.ok(state,'durable reservation precedes exchange write');sent.push(limit?'LIMIT':'MARKET');
      const filled=quantity;quantity=0;
      return{orderId:String(sent.length),order:{status:'finished',size:String(filled),left:'0',fill_price:'100'} as GateLiveOrder};
    }};
  return{input,sent,get state(){return state;},set quantity(q:number){quantity=q;}};
}
test('full IOC exit finishes with a verified fill and no market fallback',async()=>{
  const h=fixture();await reconcileSourceClose(h.input);assert.deepEqual(h.sent,['LIMIT']);
  assert.equal(h.state?.confirmedAt,T+10);assert.equal(sourceExitFillPrice(h.state),100);
});
test('known partial IOC immediately completes the verified residual and records weighted fills',async()=>{
  const h=fixture(),submit=h.input.submit;
  h.input.submit=async(tag,limit,guard)=>{
    if(limit){h.sent.push('LIMIT');h.quantity=6;return{orderId:'1',order:{status:'finished',size:'10',left:'6',fill_price:'101'}};}
    return submit(tag,limit,guard);
  };
  await reconcileSourceClose(h.input);assert.deepEqual(h.sent,['LIMIT','MARKET']);
  assert.equal(h.state?.attempt,2);assert.equal(sourceExitFillPrice(h.state),100.4);
});
test('nonterminal partial fill is accounted only after its final cumulative fill is verified',async()=>{
  const h=fixture();h.input.submit=async()=>({orderId:'1',order:{status:'open',size:'10',left:'6',fill_price:'101'}});
  await reconcileSourceClose(h.input);assert.equal(h.state?.knownFilled,0);
  h.quantity=0;await reconcileSourceClose({...h.input,prior:h.state,now:T+100,observedAt:T+100,
    inspect:async()=>({status:'finished',size:'10',left:'0',fill_price:'100.5'})});
  assert.equal(sourceExitFillPrice(h.state),100.5);
});
test('unknown result survives restart and does not duplicate a close or force a market fallback',async()=>{
  const h=fixture();h.input.submit=async()=>{h.sent.push('LIMIT');throw new Error('timeout after send');};
  await assert.rejects(reconcileSourceClose(h.input),/timeout/);
  await reconcileSourceClose({...h.input,prior:JSON.parse(JSON.stringify(h.state)),observedAt:T+10000,now:T+10000});
  assert.deepEqual(h.sent,['LIMIT']);assert.equal(h.state?.last.terminal,false);
});
test('a restored terminal partial is completed only after a fresh position read',async()=>{
  const h=fixture();h.input.submit=async()=>{h.sent.push('LIMIT');throw new Error('timeout');};
  await assert.rejects(reconcileSourceClose(h.input));h.quantity=6;
  const initial=h.state!,submit=async()=>{h.sent.push('MARKET');return{orderId:'2',order:{status:'finished',size:'6',left:'0',fill_price:'100'}};};
  const restored={...h.input,prior:initial,actualContracts:10,observedAt:T+1000,now:T+1000,submit,
    inspect:async()=>({status:'finished',size:'10',left:'6',fill_price:'101'})};
  await reconcileSourceClose({...restored,remaining:async()=>({contracts:6,observedAt:T-1})});assert.deepEqual(h.sent,['LIMIT']);
  await reconcileSourceClose({...restored,prior:h.state,remaining:async()=>({contracts:6,observedAt:T+1000})});
  assert.deepEqual(h.sent,['LIMIT','MARKET']);assert.equal(sourceExitFillPrice(h.state),100.4);
});
test('durable failure or missing committed source prevents sending; stale quote uses market without a wait',async()=>{
  const h=fixture();await assert.rejects(reconcileSourceClose({...h.input,persist:async()=>{throw new Error('storage');}}));
  assert.equal(h.sent.length,0);await reconcileSourceClose({...h.input,stillClosed:()=>false});assert.equal(h.sent.length,0);
  await reconcileSourceClose({...h.input,limit:null});assert.deepEqual(h.sent,['MARKET']);
});
test('only a definitive unsent rejection can release the prior close reservation',async()=>{
  const h=fixture();h.input.submit=async()=>{throw new GateEntryCancelledError();};
  await assert.rejects(reconcileSourceClose(h.input));assert.equal(h.state?.last.terminal,true);
});
test('exit limits have correct direction and exact ticks for both long and short',()=>{
  assert.equal(liveExitPriceLimit('LONG',100,100.01,.01),'99.98');
  assert.equal(liveExitPriceLimit('SHORT',100,100.01,.01),'100.04');
  assert.equal(liveExitPriceLimit('LONG',.00001,.00002,.000001),'0.000009');
});
test('real Gate adapter prioritizes confirmed positions before a delayed account, and drains the exit callback on error',async()=>{
  const old=globalThis.fetch;let release!:()=>void,exitRelease!:()=>void,positionSeen=false,callbackFinished=false;
  const account=new Promise<void>(r=>{release=r;}),exit=new Promise<void>(r=>{exitRelease=r;});
  let requests=0;
  globalThis.fetch=async(input)=>{requests++;const path=new URL(String(input)).pathname;
    if(path.endsWith('/accounts')){await account;return new Response('error',{status:500});}
    return new Response(path.endsWith('/positions')?'[{"contract":"TEST_USDT","size":"10"}]':'[]');};
  try{
    const client=new GateLiveClient({apiKey:'fake',apiSecret:'fake',environment:'testnet'});
    const task=client.snapshot(async positions=>{assert.equal(positions[0]!.size,'10');positionSeen=true;await exit;callbackFinished=true;});
    const rejection=assert.rejects(task,/Gate 500/);
    while(!positionSeen)await new Promise<void>(r=>setTimeout(r,0));
    assert.equal(requests,4);assert.equal(callbackFinished,false);release();
    await new Promise<void>(r=>setTimeout(r,0));assert.equal(callbackFinished,false);
    exitRelease();await rejection;assert.equal(callbackFinished,true);
  }finally{globalThis.fetch=old;}
});
test('source exit adapter emits price-bounded reduce-only IOC then canonical full market close, with signing guard',async()=>{
  const old=globalThis.fetch,bodies:Record<string,unknown>[]=[];
  globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response('{"id":9223372036854775807,"status":"finished","size":"10","left":"0"}');};
  try{
    const c=new GateLiveClient({apiKey:'fake',apiSecret:'fake',environment:'testnet'});
    const a=await c.sourceExit('TEST_USDT','LONG','t-ms-x-fixture',{price:'99.98',contractsText:'0.25'},()=>true);
    assert.equal(a.orderId,'9223372036854775807');assert.equal(bodies[0]!.size,'-0.25');assert.equal(bodies[0]!.price,'99.98');
    await c.sourceExit('TEST_USDT','SHORT','t-ms-x-fixture',{price:'100.04',contractsText:'0.25'},()=>true);
    assert.equal(bodies[1]!.size,'0.25');
    await c.sourceExit('TEST_USDT','SHORT','t-ms-x-fixture',null,()=>true);
    assert.equal(bodies[2]!.close,true);assert.equal(bodies[2]!.size,0);assert.equal(bodies[2]!.price,'0');
    for(const b of bodies){assert.equal(b.reduce_only,true);assert.equal(b.tif,'ioc');}
    await assert.rejects(c.sourceExit('TEST_USDT','SHORT','t-ms-x-fixture',null,()=>false),GateEntryCancelledError);
    assert.equal(bodies.length,3);
  }finally{globalThis.fetch=old;}
});
test('multi-stage source exit native settlement matches final program tag and initial quantity without inventing final-order price',()=>{
  const h=fixture(),p={id:'source',symbol:'TEST_USDT',side:'LONG' as const,status:'CLOSED',entryAt:T+1000,exitAt:T+60000,
    entryPrice:100,exchangeSize:6,parity:{sourceId:'source',copiedAt:T,roundedContracts:10},
    sourceExit:{version:'priority-bounded-exit-v1',initialContracts:10,last:{tag:'t-ms-x-final'}}};
  const native={contract:'TEST_USDT',side:'long',first_open_time:T/1000,time:(T+59999)/1000,max_size:'10',accum_size:'10',
    long_price:'100',short_price:'100.4',pnl:'3',pnl_pnl:'4',pnl_fee:'-1',pnl_fund:'0',text:'t-ms-x-final'};
  assert.equal(matchSettlements([p],[native],T+61000).source.exitPrice,100.4);
  assert.equal(sourceExitFillPrice(h.state),null);
});
