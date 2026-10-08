import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Candle, type Quote, type Trade} from '../lib/forward-relations.ts';
import {applyNeedleBook, findNeedle, NEEDLE_POLICY} from '../lib/needle-book.ts';
import {freshNeedleLedger} from '../lib/shadow-inverse.ts';
import {applyInverseSourceTrade, assertInverseTrial, newInverseTrial, shadowCapsule, sourceDecisionState} from '../lib/shadow-inverse-ledger.ts';

const T=1_791_500_000_000;
const quote=(bid:number,ask:number,at:number):Quote=>({bestBid:bid,bestAsk:ask,observedAt:at,fresh:true});
function bars(tipLow:number):Candle[]{
  const start=Math.floor((T-31*60_000)/1000);
  const prior=Array.from({length:30},(_,i)=>({time:start+i*60,open:100.1,high:100.4,low:99.8,close:100.1,volume:1}));
  prior.push({time:start+30*60,open:100.1,high:100.3,low:tipLow,close:100,volume:1});
  return prior;
}
function book(){
  const s=initialForward(T-60_000);
  s.inverseTrial=newInverseTrial(s,T-60_000,1000);
  s.inverseTrial.paperPolicy='needle-v1';
  return s;
}
const contract={quantoMultiplier:1,leverageMax:10,maintenanceRate:.005,minContracts:1};

test('a down wick that closes back inside is a long, and a tiny giveback does not exit',()=>{
  const mark=findNeedle(bars(99.6),T);
  assert.equal(mark?.dir,'DOWN');assert.equal(mark?.tip,99.6);
  const s=book();
  assert.equal(applyNeedleBook(s,{AAA_USDT:bars(99.6)},{AAA_USDT:quote(99.98,100,T)},{AAA_USDT:contract},T),true);
  const t=s.positions[0]!;
  assert.equal(t.side,'LONG');assert.equal(t.exitControl?.policy,NEEDLE_POLICY);
  assert.ok(Math.abs(t.entryPrice-100)<1e-9);
  assert.ok(Math.abs((t.entryPrice-t.stopPrice)/t.entryPrice-.004)<1e-9);
  const up=T+60_000;
  t.favorable=.002;t.peakPnlRate=.002;
  assert.equal(applyNeedleBook(s,{AAA_USDT:bars(99.6)},{AAA_USDT:quote(100.05,100.08,up)},{AAA_USDT:contract},up),false);
  assert.equal(t.status,'OPEN');
});

test('losers leave at the tip, after five quiet minutes, or at a 4U loss; winners can give back only after 0.8%',()=>{
  const s=book();
  applyNeedleBook(s,{AAA_USDT:bars(99.6)},{AAA_USDT:quote(99.98,100,T)},{AAA_USDT:contract},T);
  const tip=structuredClone(s);
  assert.equal(applyNeedleBook(tip,{},{AAA_USDT:quote(99.6,99.62,T+1000)},{},T+1000),true);
  assert.equal(tip.history[0]?.exitReason,'NEEDLE_TIP_EXIT');
  const quiet=structuredClone(s);
  assert.equal(applyNeedleBook(quiet,{},{AAA_USDT:quote(99.99,100.01,T+5*60_000)},{},T+5*60_000),true);
  assert.equal(quiet.history[0]?.exitReason,'NEEDLE_NO_FOLLOW_EXIT');
  const held=structuredClone(s);
  held.positions[0]!.favorable=.002;
  assert.equal(applyNeedleBook(held,{},{AAA_USDT:quote(100.15,100.16,T+5*60_000)},{},T+5*60_000),false);
  assert.equal(held.positions[0]?.status,'OPEN');
  const winner=structuredClone(s);
  winner.positions[0]!.favorable=.009;
  assert.equal(applyNeedleBook(winner,{},{AAA_USDT:quote(100.85,100.87,T+10*60_000)},{},T+10*60_000),false);
  assert.equal(applyNeedleBook(winner,{},{AAA_USDT:quote(100.4,100.42,T+11*60_000)},{},T+11*60_000),true);
  assert.equal(winner.history[0]?.exitReason,'NEEDLE_GIVEBACK_EXIT');
  const hard=structuredClone(s);
  hard.positions[0]!.quantity=1000;hard.positions[0]!.stopPrice=1;
  assert.equal(applyNeedleBook(hard,{},{AAA_USDT:quote(99.5,99.6,T+1000)},{},T+1000),true);
  assert.equal(hard.history[0]?.exitReason,'NEEDLE_LOSS_CAP_EXIT');
});

test('the same wick, a wide wick, and a fresh stop do not open again',()=>{
  const s=book();
  const paths={AAA_USDT:bars(99.6)};
  applyNeedleBook(s,paths,{AAA_USDT:quote(99.98,100,T)},{AAA_USDT:contract},T);
  const id=s.positions[0]!.id;
  applyNeedleBook(s,paths,{AAA_USDT:quote(99.98,100,T+1000)},{AAA_USDT:contract},T+1000);
  assert.equal(s.positions.length,1);assert.equal(s.positions[0]!.id,id);
  const wide=book();
  assert.equal(applyNeedleBook(wide,{AAA_USDT:bars(99)},{AAA_USDT:quote(99.98,100,T)},{AAA_USDT:contract},T),true);
  assert.equal(wide.positions.length,0);
  const cooled=book();
  cooled.inverseTrial!.needleCooldown={AAA_USDT:T-1000};
  assert.equal(applyNeedleBook(cooled,paths,{AAA_USDT:quote(99.98,100,T)},{AAA_USDT:contract},T),false);
  assert.equal(cooled.positions.length,0);
});

test('a needle book does not open a proposal copy, and a reset starts at 1000',()=>{
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
  applyInverseSourceTrade(s,t,quote(100,100,T),T);
  assert.equal(s.positions.length,0);
  assert.ok(s.inverseTrial!.entryHaltSkipped?.includes('src-1'));
  s.inverseTrial!.source=shadowCapsule(source);s.inverseTrial!.lastSourceRevision=source.revision;
  assert.doesNotThrow(()=>assertInverseTrial(s));
  s.balance=811;s.resolved=4;
  const next=freshNeedleLedger(s,T+1000);
  assert.equal(next.balance,1000);assert.equal(next.resolved,0);assert.equal(next.positions.length,0);
  assert.equal(next.inverseTrial?.paperPolicy,'needle-v1');
});
