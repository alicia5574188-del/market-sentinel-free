import assert from "node:assert/strict";
import test from "node:test";
import {normalizeSignalTally, quoteSpreadBps, rememberSignalRepeat} from "../lib/signal-repeat.ts";
import {normalizeLiveFills, rememberLiveFill} from "../lib/live-fill-note.ts";

test("the same coin and side counts forward, and a different side starts again",()=>{
  const first=rememberSignalRepeat({},"WLD_USDT","LONG",0);
  assert.equal(first.repeat.n,1);
  assert.equal(first.repeat.gapMin,null);
  const second=rememberSignalRepeat(first.tally,"WLD_USDT","LONG",30*60_000);
  assert.equal(second.repeat.n,2);
  assert.equal(second.repeat.gapMin,30);
  const other=rememberSignalRepeat(second.tally,"WLD_USDT","SHORT",40*60_000);
  assert.equal(other.repeat.n,1);
  assert.equal(other.repeat.gapMin,null);
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
