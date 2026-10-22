import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {visibleInterval,pageHidden} from "../lib/visible-poll.ts";

function fakeDocument(){
  const handlers=new Set<()=>void>();
  const doc={hidden:false,addEventListener:(_:string,fn:()=>void)=>handlers.add(fn),removeEventListener:(_:string,fn:()=>void)=>handlers.delete(fn),
    set(hidden:boolean){doc.hidden=hidden;for(const fn of handlers)fn();},handlers};
  return doc;
}

test("a hidden tab makes no periodic reads and catches up once when shown",(t)=>{
  t.mock.timers.enable({apis:["setInterval"]});
  const doc=fakeDocument();(globalThis as {document?:unknown}).document=doc;
  try{
    let reads=0;const stop=visibleInterval(()=>reads++,10_000);
    t.mock.timers.tick(10_000);assert.equal(reads,1);
    doc.set(true);assert.equal(pageHidden(),true);
    t.mock.timers.tick(60_000);assert.equal(reads,1,"no read while hidden");
    doc.set(false);assert.equal(reads,2,"immediate read on return");
    t.mock.timers.tick(9_999);assert.equal(reads,2,"interval restarts from the catch-up read");
    t.mock.timers.tick(1);assert.equal(reads,3);
    // A brief hide with no skipped tick does not cause an extra read.
    doc.set(true);doc.set(false);assert.equal(reads,3);
    stop();assert.equal(doc.handlers.size,0);
    t.mock.timers.tick(30_000);assert.equal(reads,3);
  }finally{delete (globalThis as {document?:unknown}).document;}
});

test("without a document (server render) the interval simply runs",(t)=>{
  t.mock.timers.enable({apis:["setInterval"]});
  let reads=0;const stop=visibleInterval(()=>reads++,1_000);
  t.mock.timers.tick(3_000);assert.equal(reads,3);stop();
});

test("live history and the run-log panel use the hidden-tab pause",()=>{
  const live=readFileSync(new URL("../app/live-console.tsx",import.meta.url),"utf8");
  assert.match(live,/visibleInterval\(\(\)=>void load\(\),10000\)/);
  assert.doesNotMatch(live,/setInterval\(\(\)=>void load\(\),10000\)/);
  const panel=readFileSync(new URL("../lib/panel-cache.ts",import.meta.url),"utf8");
  assert.match(panel,/every\?visibleInterval\(tick,every\):null/);
  const runLog=readFileSync(new URL("../app/run-log-status.tsx",import.meta.url),"utf8");
  assert.match(runLog,/every:60_000/);
});
