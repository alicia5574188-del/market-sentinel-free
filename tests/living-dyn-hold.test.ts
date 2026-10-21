/** Dynamic holding rules (hold-dyn) + L1 market intent as a sizing layer (2026-10-21). */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dynHold,volUnit,DYN,type DynState} from "../lib/living/hold-dyn.ts";
import {marketSizing,MARKET_SIZING,type MarketIntent} from "../lib/living/intent.ts";
import {LAYER_LABEL} from "../lib/living/runlog.ts";
import {livingWhy,livingDetail} from "../lib/living-trade-view.ts";

const M=60_000;
const st=():DynState=>({revN:0,lastMin:0});
const L=(o:Partial<Parameters<typeof dynHold>[0]>={})=>({side:"LONG" as const,entry:100,price:100,peak:0,trough:0,ageMin:10,holdMin:60,a:.002,h:null,now:10*M,...o});

test("volatility unit a = max(0.15%, 3 × mean |1-min change| over 15 min)", ()=>{
  assert.equal(volUnit([100,100,100]),null,"too few closes");
  assert.equal(volUnit(Array(16).fill(100)),DYN.aFloor,"flat → floor 0.15%");
  const xs=[100];for(let i=0;i<15;i++)xs.push(xs[i]!*(i%2?1.002:0.998));
  assert.ok(Math.abs(volUnit(xs)!-.006)<1e-4,"3 × 0.2% = 0.6%");
  assert.ok(Math.abs(volUnit([1,1,1,1,...xs])!-.006)<1e-4,"only the last 15 changes count");
});
test("profit protection: starts at max(0.6%, 2a), giveback max(0.5×peak, 1.5a), 0.35× from a 2% peak", ()=>{
  assert.equal(dynHold(L({peak:.005,price:100.1}),st()).protecting,false,"peak 0.5% < 0.6%");
  assert.equal(dynHold(L({peak:.006,price:100.4,a:.004}),st()).protecting,false,"peak 0.6% < 2a=0.8%");
  const v=dynHold(L({peak:.012,price:100.6}),st());assert.equal(v.act,"EXIT");assert.equal(v.code,"LIVING_DYN_LOCK");assert.match(v.why,/动态锁利/);
  assert.equal(dynHold(L({peak:.012,price:100.61}),st()).act,"HOLD","above peak−0.6%");
  assert.ok(Math.abs(dynHold(L({peak:.03,price:102.5}),st()).giveback!-.0105)<1e-9,"2%+ peak: 35%");
  assert.ok(Math.abs(dynHold(L({peak:.008,price:100.7,a:.004}),st()).giveback!-.006)<1e-9,"1.5a floor");
});
test("STRONG widens giveback ×1.3, FADING tightens to max(a, 0.5×current profit)", ()=>{
  assert.ok(Math.abs(dynHold(L({peak:.012,price:100.9,h:.4}),st()).giveback!-.0078)<1e-9);
  assert.equal(dynHold(L({peak:.012,price:100.55,h:.4}),st()).act,"HOLD","STRONG holds through 0.65% giveback");
  const f=dynHold(L({peak:.012,price:100.9,h:-.3}),st());assert.ok(Math.abs(f.giveback!-.0045)<1e-9);
  assert.equal(dynHold(L({peak:.012,price:100.7,h:-.3}),st()).act,"EXIT","FADING exits at 0.5% giveback");
});
test("hold time: 1.5× planned → exit, extended up to 3× while ≥70% of a ≥1.5% peak", ()=>{
  assert.equal(dynHold(L({ageMin:89}),st()).act,"HOLD");
  assert.equal(dynHold(L({ageMin:90,price:100.2}),st()).code,"LIVING_THESIS_TIMEOUT");
  const e=dynHold(L({ageMin:120,peak:.02,price:101.5}),st());assert.equal(e.act,"HOLD");assert.equal(e.extended,true);assert.equal(e.code,"LIVING_DYN_EXTEND");
  assert.equal(dynHold(L({ageMin:120,peak:.014,price:101.3}),st()).code,"LIVING_THESIS_TIMEOUT","peak < 1.5%");
  assert.equal(dynHold(L({ageMin:180,peak:.02,price:101.8}),st()).code,"LIVING_DYN_EXTEND_END");
  assert.equal(dynHold(L({ageMin:500,holdMin:0}),st()).act,"HOLD","no plan → no time rule");
});
test("loss: REVERSED two minutes running exits; no pure time cut; repair at 0 / trough÷2", ()=>{
  const s=st();
  assert.equal(dynHold(L({price:99.5,h:-.6,now:10*M}),s).act,"HOLD","one minute is not enough");
  assert.equal(dynHold(L({price:99.5,h:-.6,now:10*M+20_000}),s).act,"HOLD","same minute counted once");
  const r=dynHold(L({price:99.5,h:-.6,now:11*M}),s);assert.equal(r.code,"LIVING_DYN_REVERSED");assert.match(r.why,/资金反转离场/);
  const s2=st();dynHold(L({h:-.6,now:10*M}),s2);assert.equal(dynHold(L({h:0,now:11*M,price:99}),s2).act,"HOLD","reset by a healthy minute");
  assert.equal(dynHold(L({trough:.004,price:100}),st()).act,"HOLD","trough −0.4%: no repair");
  assert.equal(dynHold(L({trough:.007,price:99.95}),st()).act,"HOLD","not back to 0 yet");
  assert.equal(dynHold(L({trough:.007,price:100}),st()).code,"LIVING_DYN_LOSS_REPAIR");
  assert.equal(dynHold(L({trough:.014,price:99.3}),st()).code,"LIVING_DYN_LOSS_REPAIR","deep trough: half back");
  assert.equal(dynHold(L({trough:.014,price:99.2}),st()).act,"HOLD");
  assert.equal(dynHold(L({trough:.007,price:100,h:.35}),st()).act,"HOLD","STRONG keeps the loser");
  assert.equal(dynHold(L({trough:.007,peak:.008,price:100.6}),st()).act,"HOLD","protection already started → repair off");
  assert.equal(dynHold(L({side:"SHORT",entry:100,trough:.007,price:100}),st()).code,"LIVING_DYN_LOSS_REPAIR","short mirrors");
  assert.equal(dynHold(L({price:99,ageMin:1000,holdMin:0}),st()).act,"HOLD","a loser with no plan is held to the stop");
});
test("engine wires the dynamic rules after the brain exits; holdCheck's fixed timeout is off", ()=>{
  const src=readFileSync(new URL("../lib/living/engine.ts",import.meta.url),"utf8");
  const h=src.slice(src.indexOf("private intentHolds("),src.indexOf("private normalOrder("));
  assert.match(h,/holdMin:0,cost:STEPS\.cost,stopDist\}\)/);assert.match(h,/dynHold\(/);assert.match(h,/volUnit\(this\.tape\.closed1\(/);
  for(const k of ["LIVING_DYN_LOCK","LIVING_DYN_REVERSED","LIVING_DYN_LOSS_REPAIR","LIVING_DYN_EXTEND_END"]){
    assert.match(readFileSync(new URL("../app/order-card.tsx",import.meta.url),"utf8"),new RegExp(k));
    assert.match(readFileSync(new URL("../lib/brain-view.ts",import.meta.url),"utf8"),new RegExp(k));
  }
});
const mk=(state:string,side:"LONG"|"SHORT"|null=null,allowed:string[]=[])=>({at:0,state,side,confidence:.6,sentence:"",allowed} as unknown as MarketIntent);
test("L1 sizing: MIXED → 0.5× for follow/squeeze-fade/crowd-fade; absorb-revert blocked; CALM follow blocked", ()=>{
  assert.equal(MARKET_SIZING.mixed,.5);
  for(const pb of ["follow","squeeze-fade","crowd-fade"] as const){const r=marketSizing(mk("MIXED"),pb,"LONG");assert.equal(r.ok,true);assert.equal(r.mult,.5);assert.equal(r.sized,true);assert.match(r.why,/市场方向不清，半仓/);}
  assert.equal(marketSizing(mk("MIXED"),"absorb-revert","LONG").ok,false);
  assert.equal(marketSizing(mk("CALM"),"follow","LONG").ok,false);
  assert.match(LAYER_LABEL.L1_SIZED,/半仓/);
});
test("L1 sizing in the engine: L1_SIZED is logged, risk × multiplier, note lm, card shows half size", ()=>{
  const src=readFileSync(new URL("../lib/living/engine.ts",import.meta.url),"utf8");
  assert.match(src,/logCount\(now,"L1_SIZED",l1\.why\)/);assert.match(src,/evidence:ev\.factor\*mod\*lm/);assert.match(src,/\.\.\.\(lm<1\?\{lm\}:\{\}\)/);
  const t={side:"LONG" as const,entryPrice:100,stopPrice:99,liquidationPrice:91,plannedRisk:1.6,leverage:10,notional:300,expectedHoldMinutes:60,
    entryContext:{living:{v:"living-v2",k:"N",pb:"follow",ev:"medium",mult:1.5,sc:.5,rk:1,inv:99,hold:60,why:"市场方向不清，半仓（0.5×）·x",in:"DEMAND/CONVICTION",mk:"MIXED",lm:.5}}};
  assert.match(livingWhy(t,"顺着真资金"),/市场方向不清，半仓（0\.5×）/);
  const d=livingDetail(t,"顺着真资金").join("\n");
  assert.match(d,/按 0\.5× 仓位放行/);assert.match(d,/市场方向不清 0\.5/);assert.match(d,/动态锁利/);assert.match(d,/反弹减亏离场/);assert.match(d,/延长持有/);
});
