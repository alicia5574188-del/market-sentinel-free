/** A held coin's Gate quote gap only shows (health DEGRADED / "持仓报价延迟") after it has lasted 20 s; short gaps stay LIVE. */
import test from "node:test";
import assert from "node:assert/strict";
import {protectedQuoteDelay,PROTECTED_QUOTE_GRACE_MS,runtimeStatusLabel,runtimeNotice} from "../lib/runtime-health.ts";

test("held-coin quote gap: debounced 20 s, resets when the quote is back",()=>{
  const t=1_800_000_000_000;
  assert.deepEqual(protectedQuoteDelay(null,0,t),{since:null,delayed:false});
  let d=protectedQuoteDelay(null,1,t);assert.deepEqual(d,{since:t,delayed:false},"gap starts → not reported yet");
  d=protectedQuoteDelay(d.since,1,t+PROTECTED_QUOTE_GRACE_MS-1);assert.equal(d.delayed,false,"19.999 s → still quiet");
  d=protectedQuoteDelay(d.since,2,t+PROTECTED_QUOTE_GRACE_MS);assert.deepEqual(d,{since:t,delayed:true},"20 s → reported");
  d=protectedQuoteDelay(d.since,0,t+PROTECTED_QUOTE_GRACE_MS+1);assert.deepEqual(d,{since:null,delayed:false},"quote back → cleared");
  assert.equal(protectedQuoteDelay(t+5_000,1,t).since,t,"a since in the future (clock call order) restarts at now");
  assert.equal(PROTECTED_QUOTE_GRACE_MS,20_000);
});

test("label: a reported gap reads 持仓报价延迟 (it never froze other coins), not 新仓冻结",()=>{
  const now=Date.now(),rt={state:"DEGRADED",authorityReady:true,lastSuccessAt:now,realtimeReadiness:{capacity:30,actionableMarkets:20,protectedMarketsReady:false},
    lastError:"持仓报价延迟：MASK_USDT 的Gate报价已断 21 秒（超过 20 秒才提示）"};
  const label=runtimeStatusLabel(rt,true,false,now);
  assert.equal(label,"后台运行中 · 持仓报价延迟");assert.doesNotMatch(label,/冻结/);
  assert.match(runtimeNotice(rt,now)!,/其它币照常开新仓/);
  assert.equal(runtimeStatusLabel({...rt,state:"LIVE",lastError:null,realtimeReadiness:{capacity:30,actionableMarkets:20,protectedMarketsReady:true}},true,false,now),"后台运行中");
});
