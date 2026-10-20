/** Living engine: modes, fallback, storage caps / write budget, and the wired paper-enabled / compute-only paths on the fixture. */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {LivingEngine,LIVING_WRITES_PER_DAY,LIVING_KEYS} from "../lib/living/engine.ts";
import {defaultLivingConfig,LIVING_MAX_VALUE_BYTES,LIVING_KEY_PREFIX,effectiveLiving,withFallback} from "../lib/living/config.ts";
import {bytesOf} from "../lib/living/util.ts";
import {orderRecord} from "../lib/order-journal.ts";
import {runLiving} from "./living/living-sim.ts";
import {bj,sha,fixtureContracts} from "./living/fixture.ts";

const now0=bj("10-19 06:00");
const engineWith=(mode:"off"|"compute-only"|"paper-enabled")=>{const e=new LivingEngine(now0);e.restore(new Map([[LIVING_KEYS.config,{...defaultLivingConfig(now0),mode}]]),now0);return e;};
const emptyCtx=(now:number)=>({now,forward:{positions:[],history:[],opportunities:[]},quotes:{},contracts:{},funding:{},candles:{}});

test("defaults: paper-enabled with all 7 items on; off runs nothing; compute-only never returns a directive",()=>{
  const d=defaultLivingConfig(0);assert.equal(d.mode,"paper-enabled");assert.ok(Object.values(d.items).every(Boolean));
  const off=engineWith("off");off.onHub([{symbol:"A",mid:1,at:now0}],now0,()=>true);
  assert.equal(off.tape.symbols().length,0);assert.equal(off.plan(emptyCtx(now0)),undefined);
  const co=engineWith("compute-only");assert.equal(co.plan(emptyCtx(now0)),undefined);
  const pe=engineWith("paper-enabled");const dir=pe.plan(emptyCtx(now0));
  assert.ok(dir);assert.equal(dir!.legacyGate,"note");assert.deepEqual(dir!.orders,[]);
});
test("fallback: stale quotes or a module error → compute-only for one hour, then back",()=>{
  const e=engineWith("paper-enabled");
  e.onHub(Array.from({length:50},(_,i)=>({symbol:`S${i}`,mid:1,at:now0,volume24hUsd:1e8,sources:3})),now0,()=>true);
  assert.equal(e.plan(emptyCtx(now0+200_000)),undefined,"quotes 200s old");
  assert.match(e.config.fallback!.reason,/秒没更新/);
  assert.equal(effectiveLiving(e.config,now0+30*60_000).acting,false);
  assert.equal(effectiveLiving(e.config,now0+200_000+61*60_000).acting,true);
  const bad=engineWith("paper-enabled");
  const ctx={...emptyCtx(now0),forward:null as never};
  assert.equal(bad.plan(ctx),undefined);assert.match(bad.config.fallback!.reason,/研究层出错/);
  assert.equal(withFallback(bad.config,now0+1000,"again"),bad.config,"no stacking while active");
});
test("storage: every own value ≤ 96KB, own prefix only, 5m bars paged in 6 keys, log rolls into pages, daily write budget",()=>{
  const e=engineWith("compute-only");
  const syms=Array.from({length:90},(_,i)=>`COIN${i}_USDT`);
  // 27 hours of 30s points → full 26h of 5m bars for 90 symbols
  for(let t=now0-27*3_600_000;t<now0;t+=30_000)e.tape.feed(syms.map((s,i)=>({symbol:s,mid:100+i+Math.sin(t/1e6+i)*3,at:t})),t);
  for(let i=0;i<8000;i++)e.note(now0+i,"RECORD_ONLY",{sym:syms[i%90]!,reason:`测试原因 ${i} ${"很长的说明".repeat(4)}`});
  for(let i=0;i<1800;i++)e.probes.series.push([now0+i,"P1",.001,2,30]);
  for(let i=0;i<200;i++)e.episodes.push({id:`fe-${i}`,side:"LONG",alertAt:i,alertKind:"z60",confirmAt:i,endAt:i,end:"EXHAUST",peakZ:4,extreme:.01,maxRetrace:.1,bucket:2,
    after:{"1":[.001,.001,.001],"5":[.001,.001,.001],"15":[.001,.001,.001],"30":[.001,.001,.001],"60":[.001,.001,.001],"120":[.001,.001,.001]},
    leaders:["A_USDT","B_USDT","C_USDT","D_USDT","E_USDT","F_USDT"],leadersAfter30:.001,follow30Net:.001,entries:1,protections:1});
  for(const k of Object.values(LIVING_KEYS))if(k!==LIVING_KEYS.logIndex)(e as unknown as {dirty:Set<string>}).dirty.add(k);
  const w=e.writes(now0,true),keys=Object.keys(w);
  assert.ok(keys.length>=10);
  for(const [k,v] of Object.entries(w)){assert.ok(k.startsWith(LIVING_KEY_PREFIX),k);assert.ok(bytesOf(v)<=LIVING_MAX_VALUE_BYTES,`${k} ${bytesOf(v)}`);}
  assert.equal(keys.filter(k=>k.includes("bars5m:")).length,6);
  assert.ok(keys.filter(k=>/log:\d+$/.test(k)).length>=2,"log rolled into several pages");
  e.committed(keys,now0);
  // restore from what was written: bars come back for warm-up
  const back=new LivingEngine(now0);back.restore(new Map(Object.entries(w)),now0);
  assert.ok(back.tape.m5.size>=80);
  // a day of steady activity stays within the own budget
  let n=0;for(let t=now0;t<now0+86_400_000;t+=2_000){e.note(t,"X");(e as unknown as {dirty:Set<string>}).dirty.add(LIVING_KEYS.fast);(e as unknown as {dirty:Set<string>}).dirty.add(LIVING_KEYS.probes);
    const ws=Object.keys(e.writes(t));if(ws.length){e.committed(ws,t);n+=ws.length;}}
  assert.ok(n<=LIVING_WRITES_PER_DAY+400,`writes ${n}`);
});
test("paper-enabled on 10-19 06:00: fast follow opens a paper trade with its living note and run-log fields; MMR > 2% coins are only recorded",()=>{
  const r=runLiving({from:bj("10-19 05:56"),to:bj("10-19 06:12"),stepMs:4000,mode:"paper-enabled"});
  const all=[...r.state.positions,...r.state.history],lv=all.filter(t=>t.entryContext?.living);
  assert.ok(lv.length>=1,"a living trade");
  const t=lv[0]!;assert.equal(t.entryContext!.living!.k,"F");assert.equal(t.side,"LONG");assert.ok(t.openedAt>=bj("10-19 06:00:12")&&t.openedAt<=bj("10-19 06:02"));
  const ct=fixtureContracts();for(const x of lv)assert.ok(ct[x.symbol]!.maintenanceRate<=.02);
  const rec=orderRecord(t) as Record<string,unknown>;assert.equal(rec.living_kind,"fast");assert.equal(rec.rule_epoch,"living-v1");assert.equal(rec.living_episode,t.entryContext!.living!.ep);
  assert.ok(r.engine.log.some(row=>row.k==="RECORD_ONLY"&&/维持保证金率/.test(String(row.reason))));
  assert.ok(r.engine.config.epochStartedAt!=null);
  // the run-log row of a trade without a note is unchanged (no living_* keys)
  const plain=r.state.unopenedTrades?.[0]??r.state.history.find(x=>!x.entryContext?.living);
  if(plain)assert.ok(!Object.keys(orderRecord(plain)).some(k=>k.startsWith("living_")||k==="rule_epoch"));
});
test("compute-only with the engine running reproduces a38882f4 (golden W1 prefix, digests every 10 ticks)",()=>{
  const golden=JSON.parse(readFileSync(new URL("./fixtures/living/golden-a38882f4.json",import.meta.url),"utf8"));
  const w=golden.windows[0],from=bj(w.from),digests:string[]=[];let i=0;
  const r=runLiving({from,to:from+250*w.stepMs,stepMs:w.stepMs,mode:"compute-only",onTick:(s)=>{if(i++%10===0)digests.push(sha(s).slice(0,16));}});
  assert.equal(digests.length,25);digests.forEach((d,k)=>assert.equal(d,w.digests[k],`digest ${k}`));
  assert.ok(r.engine.log.length>0,"the engine did run");
});
