import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Candle, type Quote} from '../lib/forward-relations.ts';
import {applyLsrBook} from '../lib/lsr-book.ts';
import {freshLsrLedger} from '../lib/shadow-inverse.ts';
import {newInverseTrial} from '../lib/shadow-inverse-ledger.ts';
import {forwardEquity} from '../lib/forward-relations.ts';

const T=1_791_600_000_000;
const contract={quantoMultiplier:1,leverageMax:20,maintenanceRate:.005,minContracts:1,volume24hUsd:5_000_000};
function quote(bid:number,ask:number,at:number):Quote{
  return {bestBid:bid,bestAsk:ask,observedAt:at,fresh:true,sourceCount:2,disagreementRate:0};
}
function bars():Candle[]{
  const sec=Math.floor(T/1000),out:Candle[]=[];
  for(let i=40;i>=1;i--)out.push({time:sec-i*300-300,open:100,high:100,low:100,close:100,volume:i===1?5_000:10});
  return out;
}
function book(){
  const s=initialForward(T-60_000);
  s.inverseTrial=newInverseTrial(s,T-60_000,1000);
  s.inverseTrial.paperPolicy='lsr-v1';
  s.balance=1000;
  return s;
}
function warm(s:ReturnType<typeof book>,bid=100,ask=100.02){
  const paths={ETH_USDT:bars()};
  for(let i=0;i<31;i++)applyLsrBook(s,paths,{ETH_USDT:quote(bid,ask,T+i*2_000)},{ETH_USDT:contract},T+i*2_000);
  return paths;
}
test('a sharp drop rests inside the spread and fills after six seconds at the stop price if price gaps',()=>{
  const s=book(),paths=warm(s);
  const at=T+31*2_000;
  applyLsrBook(s,paths,{ETH_USDT:quote(99,99.02,at)},{ETH_USDT:contract},at);
  assert.equal(s.positions.length,0);
  assert.equal(s.inverseTrial?.lsrWork?.length,1);
  const limit=s.inverseTrial!.lsrWork![0]!.price;
  assert.ok(Math.abs(limit-(99+0.02*0.25))<1e-9,`limit ${limit}`);
  applyLsrBook(s,paths,{ETH_USDT:quote(99,99.02,at+3_000)},{ETH_USDT:contract},at+3_000);
  assert.equal(s.positions.length,0);
  assert.equal(s.inverseTrial?.lsrWork?.length,1);
  applyLsrBook(s,paths,{ETH_USDT:quote(98.9,99,at+6_000)},{ETH_USDT:contract},at+6_000);
  const t=s.positions[0];
  assert.equal(t?.side,'LONG');
  assert.equal(t?.entryPrice,limit);
  assert.ok(t&&t.notional>=70&&t.notional<=150,`notional ${t?.notional}`);
  const marked=forwardEquity(s,{ETH_USDT:quote(limit,limit+0.02,at+6_000)},at+6_000);
  assert.ok(Math.abs(marked.equity-(1000-t!.entryFee))<0.02,`equity ${marked.equity}`);
  applyLsrBook(s,paths,{ETH_USDT:quote(limit*0.99,limit*0.9902,at+8_000)},{ETH_USDT:contract},at+8_000);
  assert.equal(s.history[0]?.exitReason,'LSR_SL_EXIT');
  assert.ok(Math.abs((s.history[0]?.exitPrice??0)-limit*0.998)<1e-6);
});
test('an untouched maker is cancelled, a wide spread is skipped, and a new book starts at 1000',()=>{
  const s=book(),paths=warm(s);
  const at=T+31*2_000;
  applyLsrBook(s,paths,{ETH_USDT:quote(99,99.02,at)},{ETH_USDT:contract},at);
  applyLsrBook(s,paths,{ETH_USDT:quote(99.2,99.22,at+6_000)},{ETH_USDT:contract},at+6_000);
  assert.equal(s.positions.length,0);
  assert.equal(s.inverseTrial?.lsrWork?.length??0,0);
  const wide=book();
  const widePaths=warm(wide);
  applyLsrBook(wide,widePaths,{ETH_USDT:quote(99,99.3,T+31*2_000)},{ETH_USDT:contract},T+31*2_000);
  assert.equal(wide.inverseTrial?.lsrWork?.length??0,0);
  const next=freshLsrLedger(s,T);
  assert.equal(next.balance,1000);
  assert.equal(next.inverseTrial?.paperPolicy,'lsr-v1');
});
test('a falling bitcoin blocks a long',()=>{
  const s=book(),paths={ETH_USDT:bars(),BTC_USDT:bars()};
  for(let i=0;i<31;i++){
    const at=T+i*2_000;
    applyLsrBook(s,paths,{ETH_USDT:quote(100,100.02,at),BTC_USDT:quote(100,100.02,at)},{ETH_USDT:contract,BTC_USDT:contract},at);
  }
  const at=T+31*2_000;
  applyLsrBook(s,paths,{ETH_USDT:quote(99,99.02,at),BTC_USDT:quote(97,97.02,at)},{ETH_USDT:contract,BTC_USDT:contract},at);
  assert.equal(s.inverseTrial?.lsrWork?.length??0,0);
});
test('three misses in five minutes stop the next order',()=>{
  const s=book(),paths=warm(s);
  const at=T+31*2_000;
  s.inverseTrial!.lsrMiss=[{s:'ETH_USDT',at:at-3_000},{s:'ETH_USDT',at:at-2_000},{s:'ETH_USDT',at:at-1_000}];
  applyLsrBook(s,paths,{ETH_USDT:quote(99,99.02,at)},{ETH_USDT:contract},at);
  assert.equal(s.inverseTrial?.lsrWork?.length??0,0);
});
