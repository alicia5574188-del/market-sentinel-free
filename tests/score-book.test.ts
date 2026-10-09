import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Candle, type Quote, type Trade} from '../lib/forward-relations.ts';
import {applyScoreBook, chooseScore, SCORE_POLICY, scoreCoinNet} from '../lib/score-book.ts';
import {freshScoreLedger} from '../lib/shadow-inverse.ts';
import {applyInverseSourceTrade, newInverseTrial, type ScoreCoin, type ScoreSample} from '../lib/shadow-inverse-ledger.ts';

const WINDOW=30*60_000;
const T=1_800_000_000_000;
const quote=(bid:number,ask:number,at=T+5_000):Quote=>({bestBid:bid,bestAsk:ask,observedAt:at,fresh:true});
const contract={quantoMultiplier:1,leverageMax:20,maintenanceRate:.005,minContracts:1,volume24hUsd:5_000_000};
function bars(close:number,open=close):Candle[]{
  const sec=T/1000,rows:Candle[]=[];
  for(let i=6;i>=1;i--){
    const time=sec-i*300,o=i===6?open:close;
    rows.push({time,open:o,high:Math.max(o,close),low:Math.min(o,close),close,volume:1});
  }
  return rows;
}
function book(){
  const s=initialForward(T-60_000);
  s.inverseTrial=newInverseTrial(s,T-60_000,1000);
  s.inverseTrial.paperPolicy=SCORE_POLICY;
  return s;
}
function ready(n=40,med=.002,crowd=8){
  const s=book();
  const samples:ScoreSample[]=[];
  for(let i=n;i>=1;i--)samples.push({start:T-i*WINDOW,n:crowd,med:[med,med,med,med]});
  s.inverseTrial!.scoreSamples=samples;
  return s;
}
function market(up:number,flat:number){
  const paths:Record<string,Candle[]>={};
  const quotes:Record<string,Quote>={};
  const contracts:Record<string,typeof contract>={};
  for(let i=0;i<flat;i++){
    const symbol=`F${i}_USDT`;
    paths[symbol]=bars(100);quotes[symbol]=quote(99.98,100);contracts[symbol]=contract;
  }
  for(let i=0;i<up;i++){
    const symbol=`U${i}_USDT`;
    paths[symbol]=bars(100,98);quotes[symbol]=quote(99.98,100);contracts[symbol]=contract;
  }
  return {paths,quotes,contracts};
}
const coin=(up:number,dn:number):ScoreCoin=>({symbol:'U',residual:.02,ref:100,dir:1,up:[0,0,up,0],dn:[dn,0,0,0]});

test('one window is one sample, and nothing trades before forty windows',()=>{
  const s=book();
  const {paths,quotes,contracts}=market(6,10);
  assert.equal(applyScoreBook(s,paths,{},quotes,contracts,T+5_000),true);
  assert.equal(s.positions.length,0);
  assert.equal(s.inverseTrial?.scoreOpen?.coins.length,6);
  assert.equal(applyScoreBook(s,paths,{},quotes,contracts,T+WINDOW+5_000),true);
  assert.equal(s.inverseTrial?.scoreSamples?.length,1);
  assert.equal(s.inverseTrial?.scoreSamples?.[0]?.n,6);
  assert.equal(s.positions.length,0);
});

test('a window with no outlier is not a sample',()=>{
  const s=book();
  const {paths,quotes,contracts}=market(0,10);
  applyScoreBook(s,paths,{},quotes,contracts,T+5_000);
  applyScoreBook(s,paths,{},quotes,contracts,T+WINDOW+5_000);
  assert.equal(s.inverseTrial?.scoreSamples?.length??0,0);
  assert.equal(s.positions.length,0);
});

test('same bar is a loss, and the earlier barrier wins',()=>{
  assert.ok(scoreCoinNet(coin(100,100),0)<0);
  assert.ok(scoreCoinNet(coin(100,200),0)>0);
  assert.ok(scoreCoinNet(coin(0,0),0)<0);
});

test('confirm must be the same pair and side, and a thin crowd does not trade',()=>{
  const thin:ScoreSample[]=[];
  for(let i=0;i<40;i++)thin.push({start:i,n:i<20?8:4,med:[.002,.002,.002,.002]});
  assert.equal(chooseScore(thin),null);
  const fail:ScoreSample[]=[];
  for(let i=0;i<20;i++)fail.push({start:i,n:8,med:[.001,.004,.001,.001]});
  for(let i=0;i<20;i++)fail.push({start:20+i,n:8,med:[.003,-.001,.003,.003]});
  assert.equal(chooseScore(fail),null);
  const pass:ScoreSample[]=[];
  for(let i=0;i<40;i++)pass.push({start:i,n:8,med:[.002,-.001,.001,.001]});
  assert.equal(chooseScore(pass),0);
});

test('a confirmed window opens the crowd up to half the equity, about 400U each',()=>{
  const s=ready();
  const {paths,quotes,contracts}=market(20,30);
  applyScoreBook(s,paths,{},quotes,contracts,T+5_000);
  assert.equal(s.positions.length,12);
  assert.ok(s.positions.every(t=>t.side==='LONG'&&t.exitControl?.policy===SCORE_POLICY&&t.liveEligible===false));
  assert.ok(s.positions.every(t=>t.notional===400&&t.margin===40));
  const used=s.positions.reduce((n,t)=>n+t.margin,0);
  assert.ok(used<=500);
  applyScoreBook(s,paths,{},quotes,contracts,T+8_000);
  assert.equal(s.positions.length,12);
});

test('stop, target, and the half hour each close at the price that was written',()=>{
  const stopCase=ready();
  const m=market(6,10);
  applyScoreBook(stopCase,m.paths,{},m.quotes,m.contracts,T+5_000);
  const held=stopCase.positions[0]!;
  const bar:Candle={time:Math.floor(T/1000)+60,open:100,high:100,low:held.stopPrice-1,close:100,volume:1};
  const at=T+5_000+120_000;
  applyScoreBook(stopCase,{...m.paths,[held.symbol]:[...m.paths[held.symbol]!,bar]},{[held.symbol]:[bar]},
    {...m.quotes,[held.symbol]:quote(99.9,100,at)},m.contracts,at);
  const closed=stopCase.history.find(t=>t.id===held.id)!;
  assert.equal(closed.exitReason,'SCORE_STOP_EXIT');
  assert.ok(Math.abs((closed.exitPrice??0)-held.stopPrice)<1e-9);

  const targetCase=ready();
  applyScoreBook(targetCase,m.paths,{},m.quotes,m.contracts,T+5_000);
  const long=targetCase.positions[0]!;
  const up:Candle={time:Math.floor(T/1000)+60,open:100,high:long.armPrice+1,low:100,close:100,volume:1};
  applyScoreBook(targetCase,{...m.paths,[long.symbol]:[...m.paths[long.symbol]!,up]},{[long.symbol]:[up]},
    {...m.quotes,[long.symbol]:quote(long.armPrice+1,long.armPrice+1.02,at)},m.contracts,at);
  const won=targetCase.history.find(t=>t.id===long.id)!;
  assert.equal(won.exitReason,'SCORE_TARGET_EXIT');
  assert.ok(Math.abs((won.exitPrice??0)-long.armPrice)<1e-9);

  const timeCase=ready();
  applyScoreBook(timeCase,m.paths,{},m.quotes,m.contracts,T+5_000);
  const id=timeCase.positions[0]!.id;
  const due=T+5_000+WINDOW;
  const quotes=Object.fromEntries(Object.entries(m.quotes).map(([k,q])=>[k,quote(q.bestBid,q.bestAsk,due)]));
  applyScoreBook(timeCase,m.paths,{},quotes,m.contracts,due);
  assert.equal(timeCase.history.find(t=>t.id===id)?.exitReason,'SCORE_TIME_EXIT');
});

test('a wide spread is skipped, and proposal opens are not copied',()=>{
  const s=ready();
  const {paths,contracts}=market(6,10);
  const quotes=Object.fromEntries(Object.keys(paths).map(symbol=>[symbol,quote(100,100.2)]));
  applyScoreBook(s,paths,{},quotes,contracts,T+5_000);
  assert.equal(s.positions.length,0);
  applyInverseSourceTrade(s,{id:'src',symbol:'U0_USDT',openedAt:T,status:'OPEN'} as Trade,undefined,T);
  assert.equal(s.positions.length,0);
  assert.ok(s.inverseTrial?.entryHaltSkipped?.includes('src'));
});

test('the paper book resets to 1000 and starts with an empty score',()=>{
  const prior=ready();
  prior.balance=800;prior.positions=[];
  const next=freshScoreLedger(prior,T);
  assert.equal(next.initialEquity,1000);
  assert.equal(next.balance,1000);
  assert.equal(next.inverseTrial?.paperPolicy,SCORE_POLICY);
  assert.equal(next.inverseTrial?.scoreSamples?.length??0,0);
  assert.equal(next.positions.length,0);
});
