import test from "node:test";
import assert from "node:assert/strict";
import {beijingDayStart,recentRate,runLogCapacity} from "../lib/run-log-capacity.ts";

const H=3_600_000,NOW=Date.UTC(2026,9,19,4,0,0);
const every=(n:number,stepMs:number,end=NOW)=>Array.from({length:n},(_,i)=>end-i*stepMs);
const near=(a:number|null|undefined,b:number,tol=.03)=>assert.ok(a!=null&&Math.abs(a-b)<=Math.abs(b)*tol+1e-9,`${a} ≈ ${b}`);
const nearT=(a:number|null|undefined,b:number,tolMs=2*H)=>assert.ok(a!=null&&Math.abs(a-b)<=tolMs,`${a} ≈ ${b} (Δ ${a==null?"null":((a-b)/H).toFixed(2)} h)`);

test("rate: records per hour over the last 24 h, younger books use what they have",()=>{
  near(recentRate(every(48,30*60_000),NOW),2);                      // ~24 h span, 2/h
  assert.equal(recentRate(every(200,30*60_000),NOW),49/24);          // only the last 24 h count
  assert.equal(recentRate(every(7,30*60_000),NOW),7/3);              // 3 h span
  assert.equal(recentRate([NOW-5*60_000,NOW],NOW),2);                 // < 1 h: at least 1 h window
  assert.equal(recentRate([],NOW),null);
  assert.equal(recentRate([NOW-48*H,NOW-40*H],NOW),0);               // nothing recent
});

test("no export yet: deadline is when the stored count reaches the cap",()=>{
  const r=runLogCapacity({now:NOW,lastExport:null,counts:[{key:"records",label:"订单记录",cap:1200,times:every(1000,30*60_000)}]});
  assert.equal(r.primary!.stored,1000);assert.equal(r.primary!.usedPct,83.3);
  near(r.primary!.ratePerHour,2);
  nearT(r.deadline,NOW+100*H,4*H);near(r.hoursLeft,100);
  near(r.safeAt!-NOW,(r.deadline!-NOW)*.8,.001);
  assert.equal(r.lastExportAt,null);assert.equal(r.overdue,false);
});

test("after an export: only rows written since then count toward the cap",()=>{
  const exportAt=NOW-10*H;
  const r=runLogCapacity({now:NOW,lastExport:{at:exportAt,rows:900},counts:[{key:"records",label:"订单记录",cap:1200,times:every(1200,30*60_000)}]});
  assert.equal(r.primary!.stored,1200);
  assert.equal(r.primary!.sinceBase,20);
  assert.equal(r.primary!.pendingPct,1.7);
  nearT(r.deadline,NOW+(1180/2)*H,20*H);
  assert.equal(r.lastExportRows,900);assert.equal(r.overdue,false);
});

test("short deadlines keep a 12 h minimum margin; rate 0 gives no deadline",()=>{
  const r=runLogCapacity({now:NOW,lastExport:null,counts:[{key:"records",label:"订单记录",cap:1200,times:every(1180,30*60_000)}]});
  nearT(r.deadline,NOW+10*H,H);assert.equal(r.safeAt,NOW,"12 h margin clamps to now");
  const idle=runLogCapacity({now:NOW,lastExport:{at:NOW-H,rows:1},counts:[{key:"records",label:"订单记录",cap:1200,times:[NOW-90*H]}]});
  assert.equal(idle.deadline,null);assert.equal(idle.safeAt,null);assert.equal(idle.hoursLeft,null);
  const empty=runLogCapacity({now:NOW,lastExport:null,counts:[{key:"records",label:"订单记录",cap:1200,times:[]}]});
  assert.equal(empty.deadline,null);assert.equal(empty.primary!.usedPct,0);
});

test("overdue: full book with no export, or more rows since the export than the cap",()=>{
  const full=runLogCapacity({now:NOW,lastExport:null,counts:[{key:"records",label:"订单记录",cap:1200,times:every(1200,30*60_000)}]});
  assert.equal(full.overdue,true);assert.equal(full.deadline,NOW);
  const lost=runLogCapacity({now:NOW,lastExport:{at:NOW-900*H,rows:5},counts:[{key:"records",label:"订单记录",cap:10,times:every(11,H)}]});
  assert.equal(lost.overdue,true);
});

test("the binding class is the one that fills first; the primary stays the record book",()=>{
  const r=runLogCapacity({now:NOW,lastExport:{at:NOW-H,rows:10},
    counts:[{key:"records",label:"订单记录",cap:1200,times:every(24,H)},{key:"stages",label:"阶段",cap:30,times:every(24,H)}]});
  assert.equal(r.primary!.key,"records");assert.equal(r.binding!.key,"stages");
  nearT(r.deadline,NOW+29*H,2*H);
});

test("equity minutes: the export carries the last 8 Beijing days, so the export day must stay inside them",()=>{
  const exportAt=Date.UTC(2026,9,18,20,0,0); // 10-19 04:00 Beijing
  assert.equal(beijingDayStart(exportAt),Date.UTC(2026,9,18,16,0,0));
  const r=runLogCapacity({now:NOW,lastExport:{at:exportAt,rows:1},counts:[],windows:[{key:"equity",label:"每分钟权益",days:8,since:0}]});
  assert.equal(r.deadline,Date.UTC(2026,9,18,16,0,0)+8*24*H);
  assert.equal(r.binding!.key,"equity");
  const late=runLogCapacity({now:NOW,lastExport:{at:NOW-9*24*H,rows:1},counts:[],windows:[{key:"equity",label:"每分钟权益",days:8,since:0}]});
  assert.equal(late.overdue,true);assert.equal(late.deadline,NOW);
});

test("hot account bytes are reported, never treated as an eviction deadline",()=>{
  const r=runLogCapacity({now:NOW,lastExport:null,counts:[],hot:{rawBytes:1_048_576,budgetBytes:4*1_048_576}});
  assert.deepEqual(r.hot,{rawBytes:1_048_576,budgetBytes:4_194_304,usedPct:25});
  assert.equal(r.deadline,null);
  assert.equal(runLogCapacity({now:NOW,lastExport:null,counts:[],hot:null}).hot,null);
});

test("the export mark is one tiny key written only on a served export, and the status route only reads",async()=>{
  const {readFileSync}=await import("node:fs");
  const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  assert.match(worker,/return jsonStreamResponse\(body,\{[\s\S]*?onDone:\(\)=>this\.noteRunLogExport\(exportedAt,markRows\)\}\);/);
  assert.doesNotMatch(worker,/await this\.noteRunLogExport\(exportedAt,[^\n]*\);\n\s*return json\(body\);/);
  assert.match(worker,/this\.reserveNonAlarmWrites\(1,512,"runlog-export"\);if\(!reservation\)return;\n\s*try\{await this\.ctx\.storage\.put\(RUN_LOG_EXPORT_KEY,\{at,rows\}/);
  const status=worker.slice(worker.indexOf("private async runLogStatus"),worker.indexOf("private async ensureOrderJournal"));
  assert.doesNotMatch(status,/storage\.put|storage\.delete|fetch\(|reserveNonAlarmWrites/);
});
