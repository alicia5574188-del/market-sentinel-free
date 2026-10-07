import test from 'node:test';
import assert from 'node:assert/strict';
import {makerFirstEntry,remainingContractsText,makerEntryTag,MakerStateUnknownError,type MakerClient} from '../lib/live-maker-entry.ts';
import type {GateLiveOrder} from '../lib/gate-live.ts';
function harness(script:{place?:()=>Promise<string|null>;orders:(GateLiveOrder|null)[]}){
  let t=0;const calls:string[]=[];const bodies:Record<string,unknown>[]=[];let i=0;
  const client:MakerClient={placeMaker:async(b)=>{bodies.push(b);calls.push('place');return script.place?script.place():'42';},
    inspect:async()=>{calls.push('inspect');const o=script.orders[Math.min(i,script.orders.length-1)];i++;return o;},
    cancel:async()=>{calls.push('cancel');}};
  const run=(side:'LONG'|'SHORT'='SHORT',contracts='10')=>makerFirstEntry(client,{symbol:'ETH_USDT',side,contractsText:contracts,bestBid:99,bestAsk:100,
    tag:makerEntryTag('t-ms-e-abc'),beforeSend:()=>true,sleep:async ms=>{t+=ms;},now:()=>t});
  return {run,calls,bodies};
}
test('maker rests on own side: short sells at ask, long buys at bid, post-only, entry tag family',async()=>{
  const h=harness({orders:[{status:'finished',finish_as:'filled',size:-10,left:0,fill_price:100}]});
  const r=await h.run('SHORT');assert.equal(h.bodies[0].price,'100');assert.equal(h.bodies[0].tif,'poc');assert.equal(h.bodies[0].size,'-10');
  assert.ok(String(h.bodies[0].text).startsWith('t-ms-e-'));assert.equal(r.remainingText,'0');assert.equal(r.filledContracts,10);assert.equal(r.fillPrice,100);
  const l=harness({orders:[{status:'finished',finish_as:'filled',size:10,left:0,fill_price:99}]});await l.run('LONG');assert.equal(l.bodies[0].price,'99');
});
test('unfilled maker is cancelled after the window and the FULL quantity remains for market',async()=>{
  const h=harness({orders:[{status:'open',size:-10,left:-10},{status:'open',size:-10,left:-10},{status:'open',size:-10,left:-10},{status:'open',size:-10,left:-10},{status:'open',size:-10,left:-10},{status:'open',size:-10,left:-10},{status:'finished',finish_as:'cancelled',size:-10,left:-10}]});
  const r=await h.run();assert.ok(h.calls.includes('cancel'));assert.equal(r.remainingText,'10');assert.equal(r.filledContracts,0);
});
test('partial maker fill leaves exact decimal remainder',async()=>{
  const h=harness({orders:[{status:'finished',finish_as:'cancelled',size:-1.5,left:-0.4,fill_price:100}]});
  const r=await h.run('SHORT','1.5');assert.equal(r.remainingText,'0.4');assert.equal(remainingContractsText('0.30',0.1),'0.20');
});
test('definitive post-only rejection means full market, never a skipped entry',async()=>{
  const h=harness({place:async()=>{throw new Error('Gate 400 ORDER_POC_IMMEDIATE');},orders:[null]});
  const r=await h.run();assert.equal(r.rejected,true);assert.equal(r.remainingText,'10');
});
test('ambiguous submission or unconfirmed cancel throws instead of stacking a market order',async()=>{
  await assert.rejects(harness({place:async()=>{throw new Error('network timeout');},orders:[null]}).run(),MakerStateUnknownError);
  await assert.rejects(harness({orders:[{status:'open',size:-10,left:-10}]}).run(),MakerStateUnknownError);
});
