import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Quote, type Trade} from '../lib/forward-relations.ts';
import {emptyTradePathBook, exportTradePaths, observeTradePaths, searchHolding, type TradePath} from '../lib/trade-path.ts';

const now=1_791_770_000_000;
function quote(bid:number,ask:number,at=now):Quote{
  return {bestBid:bid,bestAsk:ask,observedAt:at,fresh:true,sourceCount:2,disagreementRate:0};
}
function open(id:string,side:'LONG'|'SHORT',entry:number):Trade{
  return {id,symbol:'ETH_USDT',side,openedAt:now,closedAt:null,status:'OPEN',entryPrice:entry,exitPrice:null,
    quantity:10,contracts:10,quantoMultiplier:1,notional:entry*10,leverage:5,margin:entry*2,plannedRisk:1,
    stopPrice:entry,armPrice:entry,favorable:0,adverse:0,lastPrice:entry,lastQuoteAt:now,entryFee:entry*10*0.0007,
    exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,
    execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false} as Trade;
}
test('each order keeps the hold path and the hour after exit',()=>{
  const state=initialForward(now);
  const book=emptyTradePathBook(state.startedAt);
  state.positions.push(open('a','LONG',100));
  assert.equal(observeTradePaths(book,state,{ETH_USDT:quote(100,100.1,now)},{},now),true);
  assert.equal(observeTradePaths(book,state,{ETH_USDT:quote(99.5,99.6,now+20_000)},{},now+20_000),true);
  assert.equal(book.trades[0]?.hold.length,1);
  assert.deepEqual(book.trades[0]?.hold[0],[0,99.5,100]);
  assert.equal(observeTradePaths(book,state,{ETH_USDT:quote(101,101.1,now+60_000)},{},now+60_000),true);
  assert.equal(book.trades[0]?.hold.length,2);
  const t=state.positions.pop()!;
  t.status='CLOSED';t.exitPrice=101;t.closedAt=now+60_000;t.netPnl=1;state.history.unshift(t);
  observeTradePaths(book,state,{ETH_USDT:quote(102,102.2,now+120_000)},{},now+120_000);
  assert.equal(book.trades[0]?.after[0]?.[0],1);
  const exported=exportTradePaths(book);
  assert.equal(exported[0]?.bestHoldMin,1);
  assert.equal(exported[0]?.direction,'进场后走出过成本');
});
test('a profitable holding rule is reported, and a book that never pays says the entry is wrong',()=>{
  const book=emptyTradePathBook(now);
  const winner:TradePath={id:'w',symbol:'ETH_USDT',side:'LONG',entry:100,qty:10,notional:1000,entryFee:0.7,openedAt:now,
    exit:100,exitAt:now+20*60_000,net:0,hold:[[0,100,100],[10,100,102]],after:[[5,103,103]]};
  const loser:TradePath={id:'l',symbol:'SOL_USDT',side:'LONG',entry:100,qty:10,notional:1000,entryFee:0.7,openedAt:now,
    exit:99,exitAt:now+5*60_000,net:-10,hold:[[0,100,100],[1,99,99.2]],after:[]};
  book.trades=[winner,loser];
  const found=searchHolding(book);
  assert.equal(found.profitable,true);
  assert.ok(found.best&&found.best.net>0);
  const dead=emptyTradePathBook(now);
  dead.trades=[{...loser,hold:[[0,100,100],[30,99,99.1]],after:[[10,98,98]]}];
  const none=searchHolding(dead);
  assert.equal(none.profitable,false);
  assert.match(none.verdict,/入场/);
});
test('an early exit still leaves the later path available for another exit rule',()=>{
  const book=emptyTradePathBook(now);
  book.trades=[{id:'e',symbol:'ETH_USDT',side:'LONG',entry:100,qty:10,notional:1000,entryFee:0.7,openedAt:now,
    exit:99.4,exitAt:now+5*60_000,net:-6,hold:[[0,100,100.3],[5,99.4,99.6]],after:[[10,101.6,102]]}];
  const found=searchHolding(book);
  assert.equal(found.profitable,true);
  assert.equal(found.afterMinutes,180);
});
test('a quote older than ten seconds and a saved last price still leave the hold path',()=>{
  const state=initialForward(now);
  const book=emptyTradePathBook(state.startedAt);
  const t=open('a','LONG',100);t.lastPrice=101;t.lastQuoteAt=now-30_000;
  state.positions.push(t);
  assert.equal(observeTradePaths(book,state,{ETH_USDT:quote(101.2,101.3,now-30_000)},{},now),true);
  assert.equal(book.trades[0]?.hold.length,1);
  assert.equal(book.trades[0]?.hold[0]?.[1],101.2);
});
test('a one-point exit is rebuilt from the five-minute bars and a real path is left alone',()=>{
  const state=initialForward(now-20*60_000);
  const book=emptyTradePathBook(state.startedAt);
  const t=open('a','LONG',100);t.openedAt=now-20*60_000;t.status='CLOSED';t.closedAt=now;t.exitPrice=101;t.netPnl=1;
  state.history.unshift(t);
  const bars=[{time:(now-20*60_000)/1000,high:100.4,low:99.6},{time:(now-10*60_000)/1000,high:103,low:100.8}];
  observeTradePaths(book,state,{},{},now,{ETH_USDT:bars});
  assert.ok((book.trades[0]?.hold.length??0)>=2);
  assert.equal(book.trades[0]?.hold[0]?.[1],99.6);
  book.trades[0]!.hold.push([30,104,105]);
  observeTradePaths(book,state,{},{},now,{ETH_USDT:bars});
  assert.equal(book.trades[0]?.hold.at(-1)?.[0],30);
});
