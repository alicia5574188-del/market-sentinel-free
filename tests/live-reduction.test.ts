import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceReductionTarget,reconcileSourceReduction,type SourceReduction} from '../lib/live-reduction.ts';
import type {Trade} from '../lib/forward-relations.ts';
import type {MirrorReceipt} from '../lib/live-parity.ts';
import {matchSettlements} from '../lib/live-settlement.ts';
import {GateEntryCancelledError,GateLiveClient,liveExitTag} from '../lib/gate-live.ts';
const T=1790809800000;
const source={id:'source',status:'OPEN',contracts:60,realization:{sequence:1}} as Trade;
const receipt={sourceId:'source',sourceContractsAtCopy:100,roundedContracts:50} as MirrorReceipt;
const spec={enableDecimal:false,orderSizeMin:'1'};
test('committed remaining source ratio reduces the immutable copied live quantity, never adds',()=>{
  assert.deepEqual(sourceReductionTarget(source,receipt,50,spec),{targetContracts:30,contractsText:'20',sequence:1});
  assert.equal(sourceReductionTarget(source,receipt,29,spec),null);assert.equal(receipt.roundedContracts,50);
});
test('decimal reduction is rounded down and tiny remainders are not rounded into extra sells',()=>{
  assert.deepEqual(sourceReductionTarget(source,{...receipt,roundedContracts:1.25},1.25,{enableDecimal:true,orderSizeMin:'0.01'}),{targetContracts:.75,contractsText:'0.5',sequence:1});
  assert.equal(sourceReductionTarget(source,{...receipt,roundedContracts:1},.6001,{enableDecimal:false,orderSizeMin:'1'}),null);
});
test('copying after an already committed source reduction starts at the smaller quantity',()=>{
  assert.equal(sourceReductionTarget(source,{...receipt,sourceContractsAtCopy:60,roundedContracts:30},30,spec),null);
});
test('old receipts without a size baseline and ended or mismatched sources cannot issue partial orders',()=>{
  for(const s of [{...source,status:'CLOSED'}, {...source,id:'other'}])assert.equal(sourceReductionTarget(s as Trade,receipt,50,spec),null);
  assert.equal(sourceReductionTarget(source,{...receipt,sourceContractsAtCopy:undefined},50,spec),null);
});
test('ambiguous submission survives restart without a duplicate reduction; later exchange position confirms it',async()=>{
  let journal:SourceReduction|undefined,sends=0;
  const base={source,receipt,actualContracts:50,observedAt:T,now:T,spec,stillOpen:()=>true,inspect:async()=>null,
    persist:async(s:SourceReduction)=>{journal=structuredClone(s);},submit:async()=>{sends++;throw new Error('ambiguous timeout');}};
  await assert.rejects(reconcileSourceReduction(base),/ambiguous/);assert.equal(journal?.state,'SUBMITTED');assert.equal(sends,1);
  await reconcileSourceReduction({...base,prior:JSON.parse(JSON.stringify(journal)),now:T+10000,observedAt:T+9000});assert.equal(journal?.state,'UNRESOLVED');assert.equal(sends,1);
  await reconcileSourceReduction({...base,prior:journal,actualContracts:30,now:T+12000,observedAt:T+11000});assert.equal(journal?.state,'CONFIRMED');assert.equal(sends,1);
});
test('durable reserve failure prevents sending; closed source takes precedence over pending reduction',async()=>{
  let sends=0;const base={source,receipt,actualContracts:50,observedAt:T,now:T,spec,stillOpen:()=>true,inspect:async()=>null,
    persist:async()=>{throw new Error('write failed');},submit:async()=>{sends++;return '1';}};
  await assert.rejects(reconcileSourceReduction(base),/write failed/);assert.equal(sends,0);
  await reconcileSourceReduction({...base,stillOpen:()=>false});assert.equal(sends,0);
});
test('partial IOC residual is only sent after a terminal order plus a post-settlement snapshot',async()=>{
  let journal:SourceReduction|undefined;const sent:string[]=[];
  const base={source,receipt,actualContracts:50,observedAt:T,now:T,spec,stillOpen:()=>true,
    inspect:async()=>({status:'finished',finish_time:(T+1000)/1000}),persist:async(s:SourceReduction)=>{journal=structuredClone(s);},
    submit:async(text:string)=>{sent.push(text);return 'order-id';}};
  await reconcileSourceReduction(base);assert.deepEqual(sent,['20']);
  await reconcileSourceReduction({...base,prior:journal,actualContracts:35,now:T+9000,observedAt:T+500});assert.equal(journal?.state,'SUBMITTED');
  await reconcileSourceReduction({...base,prior:journal,actualContracts:35,now:T+10000,observedAt:T+9000});assert.equal(journal?.state,'SHORTFALL');assert.equal(sent.length,1);
  await reconcileSourceReduction({...base,prior:journal,actualContracts:35,now:T+12000,observedAt:T+11000});assert.deepEqual(sent,['20','5']);assert.equal(journal?.attempt,2);
});
test('Gate adapter emits reduce-only signed IOC for both sides and checks cancellation after signing',async()=>{
  const old=globalThis.fetch;const bodies:Record<string,unknown>[]=[];
  globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({id_string:'789'}),{status:200});};
  try{const c=new GateLiveClient({apiKey:'test-only',apiSecret:'test-only',environment:'testnet'});
    await c.reducePosition('TEST_USDT','LONG','0.25','t-ms-x-fixture',()=>true);
    await c.reducePosition('TEST_USDT','SHORT','0.25','t-ms-x-fixture',()=>true);
    assert.equal(bodies[0]!.size,'-0.25');assert.equal(bodies[1]!.size,'0.25');
    for(const b of bodies){assert.equal(b.reduce_only,true);assert.equal(b.close,false);assert.equal(b.tif,'ioc');assert.equal(b.price,'0');}
    await assert.rejects(c.reducePosition('TEST_USDT','LONG','0.25','t-ms-x-fixture',()=>false),GateEntryCancelledError);assert.equal(bodies.length,2);
    await assert.rejects(c.reducePosition('TEST_USDT','LONG','-0.25','t-ms-x-fixture',()=>true));assert.equal(bodies.length,2);
  }finally{globalThis.fetch=old;}
});


test('program partial realization matches a single native cycle, while manual additions stay unassigned',()=>{
  const p={id:'source-a',symbol:'BTC_USDT',side:'LONG' as const,status:'CLOSED',entryAt:T+10000,exitAt:T+610000,entryPrice:100,exchangeSize:.06,
    parity:{sourceId:'source-a',copiedAt:T,roundedContracts:.1},sourceReduction:{version:'source-reduction-v1'}};
  const native={contract:'BTC_USDT',side:'long',time:(T+605000)/1000,first_open_time:T/1000,pnl:'-0.07',pnl_pnl:'0.03',pnl_fee:'-0.1',pnl_fund:'0',text:liveExitTag('source-a'),max_size:'0.1',accum_size:'0.1',long_price:'100',short_price:'103'};
  const result=matchSettlements([p],[native],T+620000);assert.equal(result[p.id].pnl,-.07);
  assert.deepEqual(matchSettlements([p],[{...native,accum_size:'0.2'}],T+620000),{});
});
