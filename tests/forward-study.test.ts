import test from 'node:test';
import assert from 'node:assert/strict';
import {describeForwardStudy,noteForwardStudy} from '../lib/forward-study.ts';
import type {InverseTrial} from '../lib/shadow-inverse-ledger.ts';

const T=1791275080690;
function trial(){
  return {source:{positions:[],history:[],resolved:0,wins:0}} as unknown as InverseTrial;
}
function closed(id:string,net:number,extra:Record<string,unknown>={}){
  return {id,symbol:'BTC_USDT',side:'LONG',status:'CLOSED',openedAt:T,closedAt:T+3_600_000,netPnl:net,exitReason:'STRUCTURE_STOP',
    entryContext:{environment:'TREND',environmentPersistenceScore:0.82,environmentProfitExpansion:'HIGH',tradePlan:'WINNER_TREND'},...extra};
}

test('a closed forward result is booked once and stays booked after the receipt is dropped',()=>{
  const book=trial();
  book.source.history=[closed('a',12.5) as never];
  noteForwardStudy(book,T+4_000_000);
  assert.equal(book.forwardStudy!.total.n,1);
  assert.equal(book.forwardStudy!.total.wins,1);
  assert.equal(book.forwardStudy!.total.net,12.5);
  assert.equal(book.forwardStudy!.hours[16]!.n,1);
  assert.equal(book.forwardStudy!.persistence.high.n,1);
  noteForwardStudy(book,T+5_000_000);
  assert.equal(book.forwardStudy!.total.n,1);
  book.source.history=[];
  noteForwardStudy(book,T+6_000_000);
  assert.equal(book.forwardStudy!.total.n,1);
  assert.equal(book.forwardStudy!.rows.some(row=>row.id==='a'),true);
});

test('an open forward trade is not a sample until it closes',()=>{
  const book=trial();
  const open={id:'b',symbol:'ETH_USDT',side:'SHORT',status:'OPEN',openedAt:T,closedAt:null,netPnl:null,entryPrice:100,lastPrice:90,quantity:1,
    entryContext:{environmentPersistenceScore:0.2,environmentProfitExpansion:'LOW',environment:'ROTATION'}};
  book.source.positions=[open as never];
  noteForwardStudy(book,T+1000);
  assert.equal(book.forwardStudy!.total.n,0);
  assert.equal(book.forwardStudy!.rows.length,1);
  open.status='CLOSED';open.closedAt=T+5000;(open as {netPnl:number}).netPnl=-3;
  book.source.positions=[];book.source.history=[open as never];
  noteForwardStudy(book,T+6000);
  assert.equal(book.forwardStudy!.total.n,1);
  assert.equal(book.forwardStudy!.total.wins,0);
  assert.equal(book.forwardStudy!.persistence.low.n,1);
  const view=describeForwardStudy(book.forwardStudy!,1);
  assert.equal(view.ready,false);
  assert.match(view.note,/继续只做正向/);
  assert.equal(JSON.stringify(view).includes('影子'),false);
});

test('a manual reset close is not a forward research sample',()=>{
  const book=trial();
  book.source.history=[closed('r',100,{exitReason:'ACCOUNT_RESET'}) as never];
  noteForwardStudy(book,T+1);
  assert.equal(book.forwardStudy!.total.n,0);
  assert.equal(book.forwardStudy!.rows.length,0);
});
