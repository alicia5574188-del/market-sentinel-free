import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Trade} from '../lib/forward-relations.ts';
import {emptyOrderJournal, observeOrderJournal} from '../lib/order-journal.ts';
import {accountLogBook} from '../lib/run-log.ts';

const now=1_791_900_000_000;
function closed(id:string,reason='EXPECTANCY_EXIT'):Trade{
  return {id,symbol:'ETH_USDT',side:'LONG',openedAt:now-120_000,closedAt:now-60_000,status:'CLOSED',
    entryPrice:100,exitPrice:101,quantity:1,contracts:1,quantoMultiplier:1,notional:100,leverage:5,margin:20,
    plannedRisk:1,stopPrice:98,armPrice:103,favorable:0.01,adverse:0,lastPrice:101,lastQuoteAt:now,entryFee:0.07,exitFee:0.07,
    fundingAllowance:0,grossPnl:1,netPnl:0.86,exitReason:reason,relationFailureBars:0,lastRelationBar:now,
    execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
    entryContext:{environment:'TRANSITION',marketEvolutionPhase:'TRANSITIONAL',marketExpectancy:0.006} as Trade['entryContext'],
    exitRegime:{stage:'SHOCK',phase:'EXPANDING'}} as Trade;
}

test('closed orders stay in the journal after the hot history drops them',()=>{
  const state=initialForward(now);
  state.environmentContext={...state.environmentContext,environment:'SHOCK',phase:'EXPANDING'};
  const kept=closed('keep'),dropped=closed('drop');
  state.history=[kept];
  const journal=emptyOrderJournal(state.startedAt);
  assert.equal(observeOrderJournal(journal,state.history,state.startedAt),true);
  state.history=[dropped];
  observeOrderJournal(journal,state.history,state.startedAt);
  state.history=[];
  const packed=accountLogBook(state,{},now,journal);
  assert.deepEqual(packed.positions.map(row=>row.id),['drop','keep']);
  const row=packed.positions[0]!;
  assert.equal(row.market_stage,'TRANSITION');
  assert.equal(row.entry_phase,'TRANSITIONAL');
  assert.equal(row.exit_stage,'SHOCK');
  assert.equal(row.exit_phase,'EXPANDING');
  assert.equal(row.exit_trigger,'EXPECTANCY_EXIT');
  assert.equal(packed.funnel.closed,2);
});

test('reset closes and inverse copies are not archived',()=>{
  const state=initialForward(now);
  const journal=emptyOrderJournal(state.startedAt);
  observeOrderJournal(journal,[closed('reset','ACCOUNT_RESET'),{...closed('inv'),inverseCopy:{}} as Trade],state.startedAt);
  assert.equal(journal.rows.length,0);
});
