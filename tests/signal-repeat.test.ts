import assert from "node:assert/strict";
import test from "node:test";
import {backfillSignalTally, earliestTallyAt, normalizeSignalTally, noteSignalOutcome, quoteSpreadBps, rememberSignalRepeat} from "../lib/signal-repeat.ts";
import {applyConfirmedFillCosts, normalizeLiveFills, rememberLiveFill} from "../lib/live-fill-note.ts";
import {collectEquityMinutes, summarizeEquity, mergeEquityMinutes, sampleEquity} from "../lib/equity-minutes.ts";
import {advanceStageChronicle, attachStageSnap, equalWeightPriceIndex, equalWeightReturnPct, fillStageForward, initialStageChronicle} from "../lib/stage-chronicle.ts";
import {readFileSync} from "node:fs";

test("the same coin and side counts forward, and a different side starts again",()=>{
  const first=rememberSignalRepeat({},"WLD_USDT","LONG",0);
  assert.equal(first.repeat.n,1);
  assert.equal(first.repeat.gapMin,null);
  const second=rememberSignalRepeat(first.tally,"WLD_USDT","LONG",30*60_000);
  assert.equal(second.repeat.n,2);
  assert.equal(second.repeat.gapMin,30);
  const other=rememberSignalRepeat(second.tally,"WLD_USDT","SHORT",40*60_000,"b");
  assert.equal(other.repeat.n,1);
  assert.equal(other.repeat.nSymbol,3);
  assert.equal(other.repeat.prevSide,"LONG");
  assert.equal(other.repeat.prevGapMin,10);
  const closed=noteSignalOutcome(other.tally,{id:"b",symbol:"WLD_USDT",netPct:-1.2,mfePct:0.4,maePct:1.5});
  const next=rememberSignalRepeat(closed,"WLD_USDT","LONG",50*60_000,"c");
  assert.equal(next.repeat.prevNetPct,-1.2);
  assert.equal(quoteSpreadBps(100,100.2),19.98);
  assert.equal(normalizeSignalTally({bad:{n:0,at:1},ok:{n:3,at:5}}).ok?.n,3);
});

test("a live fill note keeps the exchange price and drops a broken row",()=>{
  const row={sourceId:"p1",symbol:"WLD_USDT",side:"LONG" as const,paperPrice:1,exchangePrice:1.01,bid:1,ask:1.002,spreadBps:20,at:10};
  const kept=rememberLiveFill([{...row,sourceId:"old"}],row);
  assert.equal(kept.at(-1)?.exchangePrice,1.01);
  const again=rememberLiveFill(kept,{...row,exchangePrice:1.02});
  assert.equal(again.length,2);
  assert.equal(again.filter(item=>item.sourceId==="p1").length,1);
  assert.equal(normalizeLiveFills([{sourceId:"x",side:"LONG",symbol:"A",exchangePrice:0,at:1}]).length,0);
});
test("a stage snapshot is filled thirty minutes later and equity drawdown uses the minute marks",()=>{
  let row=advanceStageChronicle(initialStageChronicle(0),"TREND",0.7,true,1_000,"SHORT");
  row=attachStageSnap(row,{sync:0.7,breadth:0.4,expansion:0.5,aligned_flow:-0.2,pressure:0.3,persistence:0.6,btc:100,eth:10,factor:1},1_000);
  const early=fillStageForward(row,101,10,1,1_000+20*60_000);
  assert.equal(early.changes.at(-1)?.fwd?.m30,undefined);
  const later=fillStageForward(row,103,9,1.02,1_000+30*60_000);
  assert.equal(later.changes.at(-1)?.fwd?.m30?.btc_pct,3);
  const mark=sampleEquity({now:120_000,balance:1004,initial:1000,liveEquity:null,symbols:["ETH_USDT"],
    positions:[{side:"LONG",entryPrice:100,quantity:1,notional:100,margin:20,lastPrice:101}],
    quotes:{ETH_USDT:{bestBid:101,bestAsk:101.1}}});
  assert.equal(mark.ts,120_000);
  assert.equal(mark.unrealized,1);
  const stats=summarizeEquity(mergeEquityMinutes([{...mark,ts:60_000,equity:1000}],[{...mark,equity:990}]));
  assert.equal(stats.max_drawdown_u,10);
  const filled=backfillSignalTally([{id:"a",symbol:"WLD_USDT",side:"LONG",openedAt:10,status:"CLOSED",netPct:2,mfePct:4,maePct:1}]);
  assert.equal(filled.tally["WLD_USDT|LONG"]?.n,1);
  assert.equal(earliestTallyAt(filled.tally),10);
  const many=Array.from({length:1600},(_,i)=>({...mark,ts:i*60_000,equity:1000-i}));
  assert.equal(collectEquityMinutes([many]).length,1600);
  assert.equal(mergeEquityMinutes([],many).length,1500);
  const mids=[1,2,4,8,16,32,64,128];
  const index=equalWeightPriceIndex(mids);
  assert.ok(index!=null&&Math.abs(index-Math.pow(2,3.5))<1e-9);
  assert.equal(equalWeightPriceIndex([1,2,3]),null);
  assert.equal(equalWeightReturnPct(Array.from({length:8},()=>0.01)),1);
  const noted=applyConfirmedFillCosts([{sourceId:"p",symbol:"WLD_USDT",side:"LONG",leg:"ENTRY",paperPrice:1,exchangePrice:1.01,
    bid:1,ask:1.002,spreadBps:20,at:10_000,fee:null,role:null}],
    [{contract:"WLD_USDT",price:1.01,fee:"0.02",role:"taker",create_time:10,trade_value:"100",close_size:0},
      {contract:"WLD_USDT",price:9,fee:"5",role:"maker",create_time:10,trade_value:"100",close_size:0}]);
  assert.equal(noted[0]?.fee,0.02);
  assert.equal(noted[0]?.fee_rate,0.0002);
  assert.equal(noted[0]?.role,"taker");
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  const open=core.slice(core.indexOf("function openIntelligenceTrade"),core.indexOf("export function extremeResidualConfirmationProfile"));
  assert.equal([...open.matchAll(/rememberSignalRepeat\(s\.signalTally,o\.symbol,side,now,t\.id\)/g)].length,2);
  assert.equal([...open.matchAll(/rememberSignalRepeat\(s\.signalTally,o\.symbol,side,now\)/g)].length,0);
  assert.match(core,/factor:equalWeightPriceIndex\(mids\)/);
});
