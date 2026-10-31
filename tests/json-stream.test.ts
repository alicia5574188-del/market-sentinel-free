import test from "node:test";
import assert from "node:assert/strict";
import {jsonPieces,jsonStreamResponse} from "../lib/json-stream.ts";
import {buildLivingRunLog} from "../lib/living/runlog-export.ts";

const sample={a:1,b:"中文\"引号\n",c:[],d:[1],e:[1,"x",null,undefined,{u:undefined,v:[undefined,2]}],f:{g:[3,4]},h:undefined,i:()=>1,j:null,k:true,"键":[{z:1},{z:2}]};

test("pieces are exactly what JSON.stringify would write",()=>{
  for(const v of [sample,{},{a:[]},{a:[1,2,3]},[1,2],"s",null,5])assert.equal([...jsonPieces(v)].join(""),JSON.stringify(v));
});

const NOW=1_790_000_000_000;
function bigRunLog(n:{positions:number;cases:number;buckets:number}){
  const pad=(i:number)=>"x".repeat(200)+i;
  const positions=Array.from({length:n.positions},(_,i)=>({id:"t"+i,symbol:"S_USDT",side:"LONG",opened_at:NOW-i*6e5,living_story:"中文故事"+pad(i)}));
  const cases=Array.from({length:n.cases},(_,i)=>({id:"c"+i,at:NOW-i*3e5,stages:["a"],path:Array.from({length:360},(_,k)=>k),text:"中文"+pad(i)}));
  const buckets=Array.from({length:n.buckets},(_,i)=>({id:"b"+i,at:NOW-i*6e5,end:NOW-i*6e5+6e5,minutes:10,gate:{OPEN:10},market:{CALM:10},fast:{},funnel:{reads:5},reasons:{"no_idea:x":5},open:0,watches:0,opened:[],events:[],pool:Array.from({length:25},(_,k)=>({t:"GATE",at:NOW,why:"y".repeat(90)+k}))}));
  return buildLivingRunLog({exportedAt:NOW,liveEnabled:false,buildSha:"x",hours:72,since:null,status:{dynamic:{events:[]}},buckets:buckets as never,cases:cases as never,
    account:{equity:1000,initial:1000,invariants:{},book_audit:{},equity_curve:[],equity_minutes:[],drawdown:{},curve_since:null,drawdown_since:null,account_resets:[],account_epoch:1,account_reset_pending:null,liveFills:[],equity_gaps:[],equity_filled_min:0} as never,
    positions:positions as never,fills:[],paths:[],archive:{}});
}

test("a production-sized run-log streams in small chunks and equals the one-shot JSON (the one-shot string is what blew the isolate memory)",async()=>{
  const file=bigRunLog({positions:640,cases:770,buckets:432});
  const whole=JSON.stringify(file);
  assert.ok(whole.length>2_000_000,`fixture should be big, got ${whole.length}`);
  assert.ok(/[^\x00-\xff]/.test(whole),"two-byte text: this is why one string costs 2 bytes per char");
  const sizes:number[]=[];let done=0;
  const res=jsonStreamResponse(file,{headers:{"X-Export-Meta":"{}"},onDone:()=>{done++;}});
  assert.equal(res.headers.get("x-export-meta"),"{}");
  const reader=res.body!.getReader();const parts:Uint8Array[]=[];
  for(;;){assert.equal(done,0,"mark only after the last chunk");const r=await reader.read();if(r.done)break;sizes.push(r.value.length);parts.push(r.value);}
  assert.equal(done,1);
  assert.equal(Buffer.concat(parts).toString("utf8"),whole);
  // no single chunk is anywhere near the whole body; the biggest is a few hundred KB
  assert.ok(Math.max(...sizes)<1_000_000,`largest chunk ${Math.max(...sizes)}`);
  assert.ok(sizes.length>10);
});

test("a cancelled or failing stream does not move the export mark",async()=>{
  let done=0;
  const cancelled=jsonStreamResponse({a:Array.from({length:50_000},(_,i)=>({i,t:"x".repeat(50)}))},{onDone:()=>{done++;}});
  const r=cancelled.body!.getReader();await r.read();await r.cancel();
  const bad={a:[1,{toJSON(){throw new Error("boom")}}]};
  const failing=jsonStreamResponse(bad,{onDone:()=>{done++;}});
  await assert.rejects(async()=>{const rd=failing.body!.getReader();for(;;){const x=await rd.read();if(x.done)break;}});
  assert.equal(done,0);
});

test("the old run-log export is retired: kind=log answers 410 and points to the merged NTS download; the 系统 page has no old export button",async()=>{
  const {readFileSync}=await import("node:fs");
  const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  const route=worker.slice(worker.indexOf('if (path === "/forward-export"'),worker.indexOf('if(url.searchParams.get("page")==="archive")'));
  assert.match(route,/kind"\)==="log"\)return json\(\{error:"旧运行日志导出已停用[^}]*use:"\/api\/nts\/log"\},410\)/);
  assert.doesNotMatch(route,/buildLivingRunLog/);
  const page=readFileSync(new URL("../app/forward-dashboard.tsx",import.meta.url),"utf8");
  assert.doesNotMatch(page,/kind=log/);
  assert.doesNotMatch(page,/导出运行日志/);
  assert.doesNotMatch(page,/RunLogStatus/);
  const panel=readFileSync(new URL("../app/nts-panel.tsx",import.meta.url),"utf8");
  assert.match(panel,/\/api\/nts\/log"/);
  assert.match(panel,/\/api\/nts\/log-backup"/);
});
