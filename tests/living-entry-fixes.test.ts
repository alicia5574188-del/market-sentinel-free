/** 10-21 low-frequency diagnosis fixes: catalog contract params, squeeze/flush stop pad, stop cooldown, follow edge, 4bp spread. */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {planIntent,extremePad,followAtEdge,EXTREME_PAD,type CoinIntent} from "../lib/living/intent.ts";
import {stopCooldown,STOP_COOLDOWN_MS} from "../lib/living/engine.ts";
import {STEPS} from "../lib/living/config.ts";
import {LAYER_LABEL} from "../lib/living/runlog.ts";

const bar=(t:number,h:number,l:number)=>({time:t,open:(h+l)/2,high:h,low:l,close:(h+l)/2});
const rows5=Array.from({length:30},(_,i)=>bar(i*300,101,100));        // 5-min range 1.0 (≈1%)
const rows1=Array.from({length:60},(_,i)=>bar(i*60,100.5,99.5));
const ci=(atr5:number)=>({symbol:"T_USDT",at:0,capital:"SQUEEZE_UP",emotion:"EXHAUSTION",crowd:null,actor:"SHORT",strength:.6,action:null,why:"",
  f:{atr5,last:100,rangePos:.9,rangeHi:101,rangeLo:99}} as unknown as CoinIntent);

test("squeeze-fade / flush-rebound invalidation: extreme ± max(0.4·ATR5, 1.2 × mean 5-min range)", ()=>{
  assert.equal(EXTREME_PAD.range,1.2);
  assert.ok(Math.abs(extremePad(.5,rows5)-1.2)<1e-9,"range term wins: 1.2 × 1.0");
  assert.ok(Math.abs(extremePad(5,rows5)-2)<1e-9,"ATR term wins: 0.4 × 5");
  const sq=planIntent("squeeze-fade","SHORT",ci(.5),rows5,rows1)!;assert.ok(Math.abs(sq.inv-(100.5+1.2))<1e-9);
  const fl=planIntent("flush-rebound","LONG",ci(.5),rows5,rows1)!;assert.ok(Math.abs(fl.inv-(99.5-1.2))<1e-9);
  const cf=planIntent("crowd-fade","SHORT",ci(.5),rows5,rows1)!;assert.ok(Math.abs(cf.inv-(100.5+.2))<1e-9,"other playbooks unchanged");
  const src=readFileSync(new URL("../lib/living/engine.ts",import.meta.url),"utf8");
  assert.match(src,/stopCheck\(\{side:a\.side,price:mid,stop:plan\.inv,min:STEPS\.stopMin,max:STEPS\.stopMax/,"2% cap still checked (skip if beyond)");
  assert.equal(STEPS.stopMax,.02);
});
test("stop cooldown: 60 min after LIVING_STOP on the same coin + playbook; other playbooks/coins/exits not blocked", ()=>{
  const now=10*3_600_000,h=(o:object)=>({id:"x",symbol:"NEAR_USDT",side:"SHORT" as const,netPnl:-7,plannedRisk:8,notional:300,closedAt:now-10*60_000,
    exitReason:"LIVING_STOP",openedAt:now-11*60_000,entryContext:{living:{v:"living-v2",k:"N",pb:"squeeze-fade"}},...o}) as never;
  assert.match(stopCooldown([h({})],"NEAR_USDT","squeeze-fade",now)!,/止损后冷却：50 分钟/);
  assert.equal(stopCooldown([h({})],"NEAR_USDT","follow",now),null);
  assert.equal(stopCooldown([h({})],"TIA_USDT","squeeze-fade",now),null);
  assert.equal(stopCooldown([h({exitReason:"LIVING_DYN_LOCK"})],"NEAR_USDT","squeeze-fade",now),null);
  assert.equal(stopCooldown([h({closedAt:now-STOP_COOLDOWN_MS})],"NEAR_USDT","squeeze-fade",now),null,"expires at 60 min");
  assert.match(stopCooldown([h({entryContext:{living:{k:"F",pb:"x"}}})],"NEAR_USDT","follow",now)!,/冷却/,"fast trades count as follow");
  const src=readFileSync(new URL("../lib/living/engine.ts",import.meta.url),"utf8");
  assert.match(src,/stopCooldown\(ctx\.forward\.history,s,a\.pb,now\)/,"from persisted forward history → survives restart");
  assert.match(LAYER_LABEL.COOLDOWN,/冷却/);
});
test("follow edge: LONG skips at rangePos ≥ 0.90, SHORT at ≤ 0.10; logged as FOLLOW_EDGE", ()=>{
  assert.equal(followAtEdge("LONG",.9),true);assert.equal(followAtEdge("LONG",.89),false);
  assert.equal(followAtEdge("SHORT",.1),true);assert.equal(followAtEdge("SHORT",.11),false);
  assert.equal(followAtEdge("LONG",null),false);
  const src=readFileSync(new URL("../lib/living/engine.ts",import.meta.url),"utf8");
  assert.match(src,/a\.pb==="follow"&&followAtEdge\(a\.side,c\.ci\.f\.rangePos\)/);assert.match(src,/"FOLLOW_EDGE"/);
  assert.match(LAYER_LABEL.FOLLOW_EDGE,/区间/);
});
test("spread limit 4bp in the living hard filter and selection labels", ()=>{
  assert.equal(STEPS.selectSpread,.0004);
  const eng=readFileSync(new URL("../lib/living/engine.ts",import.meta.url),"utf8"),sel=readFileSync(new URL("../lib/living/select.ts",import.meta.url),"utf8");
  assert.doesNotMatch(eng,/bp>6bp/);assert.doesNotMatch(sel,/bp"\}>6bp/);
});
test("living contracts come from the in-memory catalog for basket coins outside the Gate-resident set (no request)", ()=>{
  const src=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  const f=src.slice(src.indexOf("private regimeContracts("),src.indexOf("private livingContractSymbols()"));
  assert.match(f,/this\.contractCatalog\.get\(symbol\)/);assert.match(f,/maintenanceRate: row\.maintenanceRate, leverageMax: row\.leverageMax/);
  assert.doesNotMatch(f,/fetch|await/);
  assert.match(src,/const contracts=this\.regimeContracts\(this\.livingContractSymbols\(\)\)/);
  assert.match(src,/contracts:this\.regimeContracts\(this\.livingContractSymbols\(\)\)/);
});
