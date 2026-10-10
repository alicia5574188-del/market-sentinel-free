import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Candle, type Quote} from '../lib/forward-relations.ts';
import {applyLsrBook,lsrLogBook} from '../lib/lsr-book.ts';
import {buildRunLogExport} from '../lib/run-log.ts';
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
  assert.ok(Math.abs(limit-(99+0.02*0.5))<1e-9,`limit ${limit}`);
  applyLsrBook(s,paths,{ETH_USDT:quote(99,99.02,at+3_000)},{ETH_USDT:contract},at+3_000);
  assert.equal(s.positions.length,0);
  assert.equal(s.inverseTrial?.lsrWork?.length,1);
  applyLsrBook(s,paths,{ETH_USDT:quote(98.9,99,at+6_000)},{ETH_USDT:contract},at+6_000);
  const t=s.positions[0];
  assert.equal(t?.side,'LONG');
  assert.equal(t?.entryPrice,limit);
  assert.ok(t&&t.notional>=250&&t.notional<=500,`notional ${t?.notional}`);
  const marked=forwardEquity(s,{ETH_USDT:quote(limit,limit+0.02,at+6_000)},at+6_000);
  assert.ok(Math.abs(marked.equity-(1000-t!.entryFee))<0.02,`equity ${marked.equity}`);
  const stop=limit*0.998,bid=limit*0.99,fill=Math.min(stop,bid*(1-0.0005));
  applyLsrBook(s,paths,{ETH_USDT:quote(bid,bid+0.0002,at+8_000)},{ETH_USDT:contract},at+8_000);
  assert.equal(s.history[0]?.exitReason,'LSR_SL_EXIT');
  assert.ok(Math.abs((s.history[0]?.exitPrice??0)-fill)<1e-6);
  const gap=((s.history[0]?.exitPrice??0)-stop)/stop*10_000;
  assert.ok(gap<-5,`gap ${gap}`);
  const packed=lsrLogBook(s,{ETH_USDT:quote(bid,bid+0.0002,at+8_000)},at+8_000);
  const file=buildRunLogExport({events:s.inverseTrial?.lsrLog??[],funnel:s.inverseTrial?.lsrFunnel??null,health:{},gate:{},exportedAt:at+8_000,liveEnabled:false,
    positions:packed.positions,fills:packed.fills,curve:packed.curve,equity:packed.equity,initial:packed.initial,closedNet:packed.closedNet,priorAdjustment:packed.priorAdjustment,places:packed.places});
  assert.equal(file.version,'lsr-run-log-v2');
  assert.equal(file.positions.length,1);
  assert.equal(file.fills.length,2);
  assert.equal(file.stop_loss_stats.count,1);
  assert.ok(file.stop_loss_stats.gapbps_median>5);
  assert.ok(Math.abs(file.invariants.identity_error??99)<0.5);
  assert.equal(file.invariants.checks.fees_match,true);
  assert.ok(file.logs.some(row=>row.event==='stop_sample_short'));
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
test('cash lost before the full ledger stays as one prior row',()=>{
  const s=book();
  s.balance=973.16;
  s.inverseTrial!.lsrClosedNet=-6.6646;
  applyLsrBook(s,{ETH_USDT:bars()},{ETH_USDT:quote(100,100.02,T)},{ETH_USDT:contract},T);
  const packed=lsrLogBook(s,{ETH_USDT:quote(100,100.02,T)},T);
  const file=buildRunLogExport({events:[],funnel:null,health:{},gate:{},exportedAt:T,liveEnabled:false,
    positions:packed.positions,fills:packed.fills,curve:packed.curve,equity:packed.equity,initial:packed.initial,closedNet:packed.closedNet,priorAdjustment:packed.priorAdjustment,places:packed.places});
  assert.ok(Math.abs(file.invariants.identity_error??99)<0.5,`identity ${file.invariants.identity_error}`);
  assert.equal(file.invariants.checks.positions_sum_match,true);
  assert.equal(file.invariants.checks.fees_match,true);
  assert.ok(Math.abs(file.invariants.prior_adjustment-(-26.84))<0.02,`prior ${file.invariants.prior_adjustment}`);
  assert.equal(file.positions.some(row=>row.exit_reason==='prior'),false);
  assert.equal(file.invariants.closed_pnl_sum,0);
});
test('placing stats count the whole session, not the last order',()=>{
  const s=book();
  s.inverseTrial!.lsrLog=Array.from({length:60},(_,i)=>({ts:T+i,level:'INFO' as const,cat:'EXEC' as const,symbol:'ETH_USDT',event:'order_placing',reason:null,
    fields:{side:'LONG',spread_bps:4,submitted_vs_mid_bps:-1,fallback_used:i<6,post_only_rejected:false,bid:100,ask:100.04,submitted:100.02},trace:'old'}));
  applyLsrBook(s,{ETH_USDT:bars()},{ETH_USDT:quote(100,100.02,T)},{ETH_USDT:contract},T);
  const packed=lsrLogBook(s,{ETH_USDT:quote(100,100.02,T)},T);
  const file=buildRunLogExport({events:s.inverseTrial?.lsrLog??[],funnel:null,health:{},gate:{},exportedAt:T,liveEnabled:false,
    positions:packed.positions,fills:packed.fills,curve:packed.curve,equity:packed.equity,initial:packed.initial,closedNet:packed.closedNet,priorAdjustment:packed.priorAdjustment,places:packed.places});
  assert.ok(file.execution_quality.placed>=60,`placed ${file.execution_quality.placed}`);
  assert.equal(file.execution_quality.avg_spread_bps,4);
  assert.equal(file.execution_quality.fallback_rate,0.1);
});
