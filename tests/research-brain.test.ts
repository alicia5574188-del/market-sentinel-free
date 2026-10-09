import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Candle, type Quote, type Trade} from '../lib/forward-relations.ts';
import {applyBrainBook, BRAIN_POLICY, readMarket} from '../lib/research-brain.ts';
import {freshBrainLedger} from '../lib/shadow-inverse.ts';
import {applyInverseSourceTrade, assertInverseTrial, newInverseTrial, shadowCapsule, sourceDecisionState} from '../lib/shadow-inverse-ledger.ts';

const T=1_791_500_000_000;
const last=Math.floor(T/1000/300)*300-300;
const quote=(bid:number,ask:number,at=T):Quote=>({bestBid:bid,bestAsk:ask,observedAt:at,fresh:true});
const contract={quantoMultiplier:1,leverageMax:20,maintenanceRate:.005,minContracts:1,fundingRate:0,volume24hUsd:5_000_000};
function path(close:number,opt:Partial<{base:number;priorHigh:number;priorLow:number;open:number;high:number;low:number}>={}):Candle[]{
  const base=opt.base??100,priorHigh=opt.priorHigh??base+.05,priorLow=opt.priorLow??base-.05,open=opt.open??base;
  const bars:Candle[]=[];
  for(let i=7;i>=1;i--)bars.push({time:last-i*300,open:base,high:priorHigh,low:priorLow,close:base,volume:1});
  const high=opt.high??Math.max(open,close,priorHigh)+.01,low=opt.low??Math.min(open,close,priorLow)-.01;
  bars.push({time:last,open,high,low,close,volume:1});
  return bars;
}
function book(){
  const s=initialForward(T-60_000);
  s.inverseTrial=newInverseTrial(s,T-60_000,1000);
  s.inverseTrial.paperPolicy=BRAIN_POLICY;
  return s;
}
function pack(names:string[],close:number){
  return Object.fromEntries(names.map(symbol=>[symbol,path(close)]));
}

test('a split market fades a solo wick, and a rising market does not',()=>{
  const names=['B_USDT','C_USDT','D_USDT','E_USDT','F_USDT','G_USDT'];
  const split={...pack(names.slice(0,3),100.4),...pack(names.slice(3),99.6),
    AAA_USDT:path(100.2,{priorHigh:100.3,priorLow:99.7,high:100.8,low:99.9})};
  const market=readMarket(split,{AAA_USDT:contract},T);
  assert.equal(market.tone,'SPLIT');
  const s=book();
  assert.equal(applyBrainBook(s,split,{},{AAA_USDT:quote(100.15,100.18)},{AAA_USDT:contract},T),true);
  const t=s.positions[0]!;
  assert.equal(s.positions.length,1);assert.equal(t.side,'SHORT');assert.equal(t.exitControl?.policy,BRAIN_POLICY);
  assert.equal(t.entryContext?.mode,'REVERSAL');assert.ok(t.liveEligible===false);
  const up={...pack(names,100.2),AAA_USDT:path(100.2,{priorHigh:100.3,priorLow:99.7,high:100.8,low:99.9})};
  assert.equal(readMarket(up,{},T).tone,'TOGETHER_UP');
  const quiet=book();
  applyBrainBook(quiet,up,{},{AAA_USDT:quote(100.15,100.18)},{AAA_USDT:contract},T);
  assert.equal(quiet.positions.length,0);
});

test('decision does not chase, does not stack one coin, and does not stop at three positions',()=>{
  const names=['B_USDT','C_USDT','D_USDT','E_USDT','F_USDT','G_USDT'];
  const wick=(symbol:string)=>path(100.1,{priorHigh:100.25,priorLow:99.7,high:100.7,low:99.9});
  const paths={...pack(names.slice(0,3),100.4),...pack(names.slice(3),99.6),
    A_USDT:wick('A'),H_USDT:wick('H'),I_USDT:wick('I'),J_USDT:wick('J')};
  const q=(px:number)=>quote(px,px+.03);
  const quotes={A_USDT:q(100.05),H_USDT:q(100.05),I_USDT:q(100.05),J_USDT:q(100.05)};
  const contracts=Object.fromEntries(['A_USDT','H_USDT','I_USDT','J_USDT'].map(symbol=>[symbol,contract]));
  const s=book();
  applyBrainBook(s,paths,{},quotes,contracts,T);
  assert.equal(s.positions.length,4);
  const id=s.positions.map(t=>t.symbol).sort().join();
  applyBrainBook(s,paths,{},quotes,contracts,T+1000);
  assert.equal(s.positions.map(t=>t.symbol).sort().join(),id);
  const ran=book();
  applyBrainBook(ran,paths,{},{A_USDT:quote(99.4,99.43),H_USDT:q(100.05),I_USDT:q(100.05),J_USDT:q(100.05)},contracts,T);
  assert.equal(ran.positions.some(t=>t.symbol==='A_USDT'),false);
  assert.equal(ran.positions.length,3);
  assert.equal(ran.inverseTrial?.brainPasses?.some(row=>row.symbol==='A_USDT'&&row.whyNot.includes('离开')),true);
  const heavy=book();
  applyBrainBook(heavy,{...pack(names.slice(0,3),100.4),...pack(names.slice(3),99.6),A_USDT:wick('A')},{},{A_USDT:q(100.05)},{A_USDT:contract},T);
  const held=structuredClone(heavy.positions[0]!);
  held.id='pad';held.symbol='ZZ_USDT';held.margin=470;
  heavy.positions.push(held);
  applyBrainBook(heavy,{...pack(names.slice(0,3),100.4),...pack(names.slice(3),99.6),A_USDT:wick('A'),H_USDT:wick('H')},{},
    {A_USDT:q(100.05),H_USDT:q(100.05)},{A_USDT:contract,H_USDT:contract},T+1000);
  assert.equal(heavy.positions.some(t=>t.symbol==='H_USDT'),false);
});

test('a fresh turn follows the leader, and a committed market buys the coin that has not moved',()=>{
  const names=['B_USDT','C_USDT','D_USDT','E_USDT','F_USDT','G_USDT'];
  const leadPaths={...pack(names,100.2),AAA_USDT:path(100.4,{open:100,high:100.42,low:99.98})};
  const lead=book();
  applyBrainBook(lead,leadPaths,{},{AAA_USDT:quote(100.38,100.4)},{AAA_USDT:contract},T);
  assert.equal(lead.positions.length,1);assert.equal(lead.positions[0]!.side,'LONG');
  assert.equal(lead.positions[0]!.entryContext?.mode,'CONTINUATION');
  assert.equal(lead.positions[0]!.entryContext?.clusterId,'TOGETHER_UP');
  assert.equal(lead.positions[0]!.entryContext?.researchMoveAge,'STARTED');
  assert.equal(lead.positions[0]!.entryContext?.researchCrowd,'NONE');
  const catchPaths={...pack(names,100.5),ZZ_USDT:path(100)};
  const caught=book();
  applyBrainBook(caught,catchPaths,{},{ZZ_USDT:quote(100,100.02)},{ZZ_USDT:contract},T);
  assert.equal(caught.positions.length,1);assert.equal(caught.positions[0]!.side,'LONG');
  assert.equal(caught.positions[0]!.entryContext?.mode,'RELATIVE');
  const crowded=book();
  const hot={...contract,fundingRate:.0003};
  const metas=Object.fromEntries([...names,'ZZ_USDT'].map(symbol=>[symbol,hot]));
  applyBrainBook(crowded,catchPaths,{},{ZZ_USDT:quote(100,100.02)},metas,T);
  assert.equal(crowded.positions.length,0);
});

test('a wrong idea exits now, a noise profit stays, a real move can give back half, and a dead idea expires',()=>{
  const names=['B_USDT','C_USDT','D_USDT','E_USDT','F_USDT','G_USDT'];
  const paths={...pack(names.slice(0,3),100.4),...pack(names.slice(3),99.6),
    AAA_USDT:path(100.2,{priorHigh:100.3,priorLow:99.7,high:100.8,low:99.9})};
  const s=book();
  applyBrainBook(s,paths,{},{AAA_USDT:quote(100.15,100.18)},{AAA_USDT:contract},T);
  const entry=s.positions[0]!.entryPrice;
  const noise=structuredClone(s);
  applyBrainBook(noise,paths,{},{AAA_USDT:quote(100,100.03,T+60_000)},{AAA_USDT:contract},T+60_000);
  assert.equal(noise.positions[0]?.status,'OPEN');
  const wrong=structuredClone(s);
  applyBrainBook(wrong,{},{},{AAA_USDT:quote(100.85,100.88,T+1000)},{},T+1000);
  assert.equal(wrong.history[0]?.exitReason,'BRAIN_WRONG_EXIT');
  const winner=structuredClone(s);
  winner.positions[0]!.favorable=.01;winner.positions[0]!.peakPnlRate=.01;
  const heldPx=entry*.992;
  applyBrainBook(winner,{},{},{AAA_USDT:quote(heldPx,heldPx+.02,T+40*60_000)},{},T+40*60_000);
  assert.equal(winner.positions[0]?.status,'OPEN');
  const backPx=entry*.996;
  applyBrainBook(winner,{},{},{AAA_USDT:quote(backPx,backPx+.02,T+41*60_000)},{},T+41*60_000);
  assert.equal(winner.history[0]?.exitReason,'BRAIN_GIVEBACK_EXIT');
  const stale=structuredClone(s);
  const due=(stale.positions[0]!.entryContext!.thesisSince??T)+30*60_000+1000;
  applyBrainBook(stale,{},{},{AAA_USDT:quote(100.1,100.13,due)},{},due);
  assert.equal(stale.history[0]?.exitReason,'BRAIN_STALE_EXIT');
});

test('a skipped idea is marked once more after 30 minutes',()=>{
  const s=book();
  s.inverseTrial!.brainPasses=[{id:'A:fade:1',at:T,symbol:'AAA_USDT',side:'SHORT',kind:'FADE',tone:'SPLIT',age:'ONGOING',crowd:'NONE',price:100,whyNot:'价差太大'}];
  const due=T+31*60_000,barTime=(T+30*60_000-300_000)/1000;
  applyBrainBook(s,{AAA_USDT:[{time:barTime,open:100,high:101,low:99,close:99,volume:1}]},{},{},{},due);
  const row=s.inverseTrial!.brainPasses![0]!;
  assert.equal(row.laterPrice,99);
  assert.ok((row.laterMove??0)>0);
});

test('a brain book does not open a proposal copy, and a reset starts at 1000',()=>{
  const s=book();
  const source=structuredClone(sourceDecisionState(s));
  const t={id:'src-1',symbol:'AAA_USDT',side:'LONG',status:'OPEN',openedAt:T,closedAt:null,entryPrice:100,exitPrice:null,
    quantity:1,contracts:1,quantoMultiplier:1,notional:100,leverage:5,margin:20,plannedRisk:1,stopPrice:99,armPrice:101,
    favorable:0,adverse:0,lastPrice:100,lastQuoteAt:T,entryFee:.05,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,
    exitReason:null,relationFailureBars:0,lastRelationBar:T,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
    rule:{id:'src-1',signature:'x',parentId:null,version:1,createdAt:T,expiresAt:T+1,status:'EXPERIMENTAL',conditions:[],side:'LONG',horizon:30,
      stopRate:.01,armRate:.01,givebackRate:.01,exitMode:'HORIZON',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:0,
      priorResponse:null,recentResponse:0,standardError:0,reason:'x',mutation:'CREATE',grammar:'x',liveEligible:false}} as Trade;
  source.positions.push(t);
  applyInverseSourceTrade(s,t,quote(100,100),T);
  assert.equal(s.positions.length,0);
  assert.ok(s.inverseTrial!.entryHaltSkipped?.includes('src-1'));
  s.inverseTrial!.source=shadowCapsule(source);s.inverseTrial!.lastSourceRevision=source.revision;
  assert.doesNotThrow(()=>assertInverseTrial(s));
  s.balance=811;s.resolved=4;
  const next=freshBrainLedger(s,T+1000);
  assert.equal(next.balance,1000);assert.equal(next.resolved,0);assert.equal(next.positions.length,0);
  assert.equal(next.inverseTrial?.paperPolicy,BRAIN_POLICY);
});
