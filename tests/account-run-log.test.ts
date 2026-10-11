import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, PAPER_COST, type Quote, type Trade} from '../lib/forward-relations.ts';
import {accountLogBook, buildRunLogExport} from '../lib/run-log.ts';

const now=1_791_758_000_000;
function quote(bid:number,ask:number):Quote{
  return {bestBid:bid,bestAsk:ask,observedAt:now,fresh:true,sourceCount:2,disagreementRate:0};
}
test('the run log records the market-intelligence account, not an empty experiment funnel',()=>{
  const state=initialForward(now-60_000);
  const entry=100,px=(101+101.02)/2,fee=entry*PAPER_COST.feeRate;
  state.balance=state.initialEquity-fee;
  state.positions.push({id:'mi-1',symbol:'ETH_USDT',side:'LONG',openedAt:now-30_000,closedAt:null,status:'OPEN',
    entryPrice:entry,exitPrice:null,quantity:1,contracts:1,quantoMultiplier:1,notional:entry,leverage:5,margin:20,
    plannedRisk:1,stopPrice:98,armPrice:103,favorable:0,adverse:0,lastPrice:px,lastQuoteAt:now,entryFee:fee,exitFee:0,
    fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,
    execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false} as Trade);
  state.opportunities.push({id:'o1',symbol:'ETH_USDT',eligible:true,expiresAt:now+60_000,score:1} as typeof state.opportunities[number]);
  const packed=accountLogBook(state,{ETH_USDT:quote(101,101.02)},now);
  const file=buildRunLogExport({events:[],funnel:packed.funnel,health:{healthySources:3},gate:{connected:true,freshBooks:1},
    exportedAt:now,liveEnabled:false,positions:packed.positions,fills:packed.fills,curve:packed.curve,
    equity:packed.equity,initial:packed.initial,closedNet:packed.closedNet,priorAdjustment:0,places:[]});
  assert.equal(file.positions.length,1);
  assert.equal(file.positions[0]?.symbol,'ETH_USDT');
  assert.equal(file.funnel.filled,1);
  assert.equal(file.funnel.signals,1);
  assert.ok(Math.abs(file.invariants.identity_error??99)<0.05,`identity ${file.invariants.identity_error}`);
  assert.notEqual(file.howToRead.includes('实验漏斗'),false);
});
