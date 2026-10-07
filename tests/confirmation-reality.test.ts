import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmationRealityView,inverseEntryHalted,type ConfirmationRealityTrade} from '../lib/confirmation-reality.ts';

const H=60*60*1000;
function trade(openedHour:number,kind:'FAKE'|'REAL',persistence:number,expansion:'HIGH'|'NORMAL'|'LOW'):ConfirmationRealityTrade{
  const openedAt=openedHour*H,closedAt=openedAt+30*60*1000;
  return {status:'CLOSED',exitReason:kind==='REAL'?'INVERSE_SOFT_LOSS_EXIT':'SHADOW_SOURCE_EXIT',netPnl:kind==='REAL'?-6:3,
    openedAt,closedAt,inverseCopy:{sourceEntryPlan:{environmentPersistenceScore:persistence,environmentTransitionPressure:.2,environmentProfitExpansion:expansion}}};
}
test('certainty then a rollover stops new inverse entries',()=>{
  const trades:ConfirmationRealityTrade[]=[];
  for(let i=0;i<8;i++)trades.push(trade(10+i,i%5===0?'REAL':'FAKE',.58,'NORMAL'));
  for(let i=0;i<6;i++)trades.push(trade(18, 'FAKE',.74,'HIGH'));
  for(let i=0;i<8;i++)trades.push(trade(22, 'REAL',.58,'NORMAL'));
  const view=confirmationRealityView(trades,23*H);
  assert.equal(view.ordersAffected,false);
  assert.equal(view.state,'REAL_MAJORITY');
  assert.equal(view.entryHalted,true);
  assert.equal(view.certainty.seen,true);
  assert.equal(view.rollover.seen,true);
  assert.match(view.sentence,/顺着确认方向开/);
});
test('ordinary fake confirmations keep opening',()=>{
  const trades=Array.from({length:12},(_,i)=>trade(10+i,i===3?'REAL':'FAKE',.58,'NORMAL'));
  const view=confirmationRealityView(trades,30*H);
  assert.equal(view.state,'FAKE_MAJORITY');
  assert.equal(view.entryHalted,false);
  assert.match(view.sentence,/继续开/);
});
test('high persistence while confirmations are still fake does not stop entries',()=>{
  const trades=[...Array.from({length:8},(_,i)=>trade(10+i,'FAKE',.58,'NORMAL')),
    ...Array.from({length:6},()=>trade(20,'FAKE',.74,'HIGH'))];
  const view=confirmationRealityView(trades,21*H);
  assert.equal(view.state,'CERTAINTY');
  assert.equal(view.entryHalted,false);
  assert.match(view.sentence,/还没到停开/);
});
test('after real share falls back under 30 percent, a new loss streak without a fresh rise does not stop entries',()=>{
  const trades:ConfirmationRealityTrade[]=[];
  for(let i=0;i<6;i++)trades.push(trade(18,'FAKE',.74,'HIGH'));
  for(let i=0;i<12;i++)trades.push(trade(22,'REAL',.58,'NORMAL'));
  assert.equal(inverseEntryHalted(trades,24*H).halted,true);
  for(let i=0;i<12;i++)trades.push(trade(30+i,'FAKE',.55,'NORMAL'));
  assert.equal(inverseEntryHalted(trades,50*H).halted,false);
  for(let i=0;i<12;i++)trades.push(trade(60+i,'REAL',.55,'NORMAL'));
  assert.equal(inverseEntryHalted(trades,80*H).halted,false);
});
