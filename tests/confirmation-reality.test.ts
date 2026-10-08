import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmationRealityView,bookRegime,type ConfirmationRealityTrade} from '../lib/confirmation-reality.ts';

const H=60*60*1000;
function trade(openedHour:number,kind:'FAKE'|'REAL',persistence:number,expansion:'HIGH'|'NORMAL'|'LOW'):ConfirmationRealityTrade{
  const openedAt=openedHour*H,closedAt=openedAt+30*60*1000;
  return {status:'CLOSED',exitReason:kind==='REAL'?'INVERSE_SOFT_LOSS_EXIT':'SHADOW_SOURCE_EXIT',netPnl:kind==='REAL'?-6:3,
    openedAt,closedAt,inverseCopy:{sourceEntryPlan:{environmentPersistenceScore:persistence,environmentTransitionPressure:.2,environmentProfitExpansion:expansion},
      fills:[{sourceGross:kind==='REAL'?4:-4,sourceFee:.1,sourceFunding:0}]}};
}
test('a high hour then a drop pauses new entries for six hours and does not follow',()=>{
  const trades:ConfirmationRealityTrade[]=[];
  for(let i=0;i<8;i++)trades.push(trade(10+i,i%5===0?'REAL':'FAKE',.58,'NORMAL'));
  for(let i=0;i<6;i++)trades.push(trade(18, 'FAKE',.74,'HIGH'));
  for(let i=0;i<8;i++)trades.push(trade(22, 'REAL',.58,'NORMAL'));
  const view=confirmationRealityView(trades,23*H);
  assert.equal(view.ordersAffected,false);
  assert.equal(view.regime,'PAUSE');
  assert.equal(view.entryHalted,true);
  assert.equal(view.certainty.seen,true);
  assert.match(view.sentence,/先停 6 小时/);
  assert.equal(bookRegime(trades,22*H+6*H).mode,'FADE');
});
test('ordinary fake confirmations keep fading',()=>{
  const trades=Array.from({length:12},(_,i)=>trade(10+i,i===3?'REAL':'FAKE',.58,'NORMAL'));
  const view=confirmationRealityView(trades,30*H);
  assert.equal(view.state,'FAKE_MAJORITY');
  assert.equal(view.regime,'FADE');
  assert.match(view.sentence,/反着做/);
});
test('high persistence without a later drop does not pause',()=>{
  const trades=[...Array.from({length:8},(_,i)=>trade(10+i,'FAKE',.58,'NORMAL')),
    ...Array.from({length:6},()=>trade(20,'FAKE',.74,'HIGH'))];
  const view=confirmationRealityView(trades,21*H);
  assert.equal(view.state,'CERTAINTY');
  assert.equal(view.regime,'FADE');
  assert.match(view.sentence,/还没掉下来/);
});
test('after the pause, shadow wins follow for two hours and a loss streak without a new rise goes back to fading',()=>{
  const trades:ConfirmationRealityTrade[]=[];
  for(let i=0;i<12;i++){
    const row=trade(18,'REAL',.74,'HIGH');
    row.exitReason='SHADOW_SOURCE_EXIT';
    trades.push(row);
  }
  for(let i=0;i<4;i++)trades.push(trade(22,'REAL',.5,'NORMAL'));
  assert.equal(bookRegime(trades,23*H).mode,'PAUSE');
  assert.equal(bookRegime(trades,22*H+6*H).mode,'FOLLOW');
  assert.equal(bookRegime(trades,22*H+8*H).mode,'FADE');
  for(let i=0;i<12;i++)trades.push(trade(40+i,'REAL',.55,'NORMAL'));
  assert.equal(bookRegime(trades,60*H).mode,'FADE');
});
