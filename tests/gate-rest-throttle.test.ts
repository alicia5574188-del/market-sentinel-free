import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {GateRestThrottle,GATE_REST_THROTTLE} from "../lib/gate-rest-throttle.ts";

test("threshold: a quiet symbol gets its first REST read at once, then not again before the base interval", ()=>{
  const t=new GateRestThrottle();const t0=1_000_000;
  assert.equal(t.allow("A",t0,false),true);
  for(let ms=2000;ms<GATE_REST_THROTTLE.baseMs;ms+=2000)assert.equal(t.allow("A",t0+ms,false),false,`${ms}ms`);
  assert.equal(t.allow("A",t0+GATE_REST_THROTTLE.baseMs,false),true);
});
test("backoff: doubles while the websocket stays silent, capped, reset when a websocket book is seen", ()=>{
  const t=new GateRestThrottle({baseMs:8000,capMs:60000,ratePerSec:100,burst:100});let now=0;const gaps:number[]=[];
  t.allow("Q",now,false);
  for(let i=0;i<6;i++){const next=t.nextAt("Q")!;gaps.push(next-now);now=next;assert.equal(t.allow("Q",now,false),true);}
  assert.deepEqual(gaps,[8000,16000,32000,60000,60000,60000]);
  t.wsSeen("Q");assert.equal(t.nextAt("Q"),null);assert.equal(t.allow("Q",now+1,false),true,"after WS resumes, first fallback is immediate again");
});
test("budget: global token bucket caps non-critical REST across many symbols", ()=>{
  const t=new GateRestThrottle();let sent=0;
  for(let loop=0;loop<300;loop++)for(let k=0;k<30;k++)if(t.allow(`S${k}`,loop*2000,false))sent++;   // 600s, 30 quiet symbols
  const rate=sent/600;assert.ok(rate<=GATE_REST_THROTTLE.ratePerSec+GATE_REST_THROTTLE.burst/600+1e-9,`rate ${rate}`);
  assert.ok(t.status().budgetSkips>0);
});
test("open-position / pending-fill exemption: critical symbols are never throttled, even with an empty budget", ()=>{
  const t=new GateRestThrottle({baseMs:8000,capMs:60000,ratePerSec:.01,burst:1});
  for(let loop=0;loop<100;loop++)assert.equal(t.allow("POS",loop*2000,true),true);
  assert.equal(t.allow("OTHER",200_001,false),false,"critical traffic drains the shared budget first");
  assert.equal(t.status().criticalAllowed,100);
});
test("worker wiring: only the REST fallback is gated; websocket path, urgent set and the live order path are untouched", ()=>{
  const src=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  const f=src.slice(src.indexOf("private async processAdaptiveBooks("),src.indexOf("protected prepareLiveEquityWrite("));
  assert.match(f,/const urgent=new Set\(\[\.\.\.this\.currentAuthorityProtectionSymbols\(\),\.\.\.this\.forwardUrgentSymbols\(now\)\]\)/);
  assert.match(f,/critical=\(symbol:string\)=>fastLiving\.all\|\|urgent\.has\(symbol\)\|\|fastLiving\.symbols\.includes\(symbol\)/);
  assert.match(f,/if\(streamBook\(symbol\)\)\{this\.gateRestThrottle\.wsSeen\(symbol\);return true;\}/);
  assert.match(f,/this\.gateRestThrottle\.allow\(symbol,now,critical\(symbol\)\)/);
  const prot=src.slice(src.indexOf("private currentAuthorityProtectionSymbols() {"),src.indexOf("private forwardUrgentSymbols("));
  for(const k of ["live.positions","live.entries","forwardState?.positions"])assert.ok(prot.includes(k),k);
  const eng=readFileSync(new URL("../lib/living/engine.ts",import.meta.url),"utf8");
  assert.match(eng,/restCritical\(now:number\)\{[^}]*all:acting&&!!this\.fast\.episode/);
  assert.match(src,/gateRestThrottle: this\.gateRestThrottle\.status\(\)/);
});
