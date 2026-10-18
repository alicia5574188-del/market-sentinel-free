import test from "node:test";
import assert from "node:assert/strict";
import { initialForward, normalizeForward, resetForwardAccountPreservingLearning, type ForwardState, type Trade, type Quote } from "../lib/forward-relations.ts";
import { prepareForwardWrite, readForwardStore, hotProjectionForMeasure, FORWARD_PAIRED_ACCOUNT_MAX_BYTES } from "../lib/forward-store.ts";
import { emptyStrategyAccount } from "../lib/strategy-slot.ts";
import { emptyReviewLogCursor, prepareReviewLogWrite, readReviewLog, restoreReviewLog, reviewLogOffload,
  unopenedRowKey, UNOPENED_HOT_WINDOW_MS, REVIEW_TALLY_KEY } from "../lib/review-log-store.ts";
import { accountLogBook } from "../lib/run-log.ts";
import { backfillSignalTally } from "../lib/signal-repeat.ts";

const T=1_792_300_000_000;
const filler=(i:number,n:number)=>Array.from({length:n},(_,k)=>((i*7919+k*104729)%1000003).toString(36)).join("");
function unopened(i:number,openedAt:number,status:"OPEN"|"CLOSED"="CLOSED"):Trade{
  return {id:`un-${i}`,symbol:`S${i%40}_USDT`,side:i%2?"SHORT":"LONG",openedAt,closedAt:status==="CLOSED"?openedAt+30*60_000:null,status,
    entryPrice:100,exitPrice:status==="CLOSED"?100.5:null,quantity:1,contracts:1,quantoMultiplier:1,notional:100,leverage:6,margin:16.7,
    plannedRisk:1,stopPrice:98,armPrice:101,favorable:.01,adverse:.004,lastPrice:100.5,lastQuoteAt:openedAt,entryFee:.07,exitFee:.07,
    fundingAllowance:0,grossPnl:.5,netPnl:.36,exitReason:status==="CLOSED"?"PLAN_INVALIDATED":null,relationFailureBars:0,lastRelationBar:openedAt,
    execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,unopened:true,
    rule:{id:"mi",signature:"mi",parentId:null,version:1,createdAt:openedAt,expiresAt:openedAt+1,status:"EXPERIMENTAL",conditions:[],side:"LONG",
      horizon:60,stopRate:.02,armRate:.01,givebackRate:.005,exitMode:"REACTION_DECAY",samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:0,
      priorResponse:null,recentResponse:null,standardError:0,reason:filler(i,1500),mutation:"CREATE",grammar:"mi",liveEligible:false},
    entryContext:{version:"adaptive-ten-entry-v1",capturedAt:openedAt,timeframe:"5m",side:i%2?"SHORT":"LONG",mode:"RELATIVE",reason:filler(i+1,1000),
      entryScore:80,directionStrength:70,spaceScore:60,positionScore:60,executionScore:90,remainingSpaceRate:.02,pullbackRiskRate:.01,edgeRatio:2,
      expectedHoldMinutes:240,marketFit:70,regionId:null,environment:"TRANSITION",
      stageNote:{liveStage:"TRANSITION",priorStage:"TREND",stageAgeMin:10,minutesSinceShock:null,shockPush:0,syncDrop:null}},
    signalRepeat:{n:1,gapMin:null,nSymbol:1,prevSide:null,prevGapMin:null,prevNetPct:null,prevMfePct:null},entrySpreadBps:5} as unknown as Trade;
}
class MemoryStorage{
  map=new Map<string,unknown>();
  async get<V>(key:string){return structuredClone(this.map.get(key)) as V|undefined;}
  async put(entries:Record<string,unknown>){for(const[k,v]of Object.entries(entries))this.map.set(k,structuredClone(v));}
  async delete(keys:string[]){let n=0;for(const k of keys)if(this.map.delete(k))n++;return n;}
}
/** A paired (4 MiB budget) account carrying `rows` closed not-opened rows, oldest beyond the hot window. */
function fixture(rows:number){
  const base=emptyStrategyAccount(initialForward(T-48*3600_000),T-47*3600_000);
  base.storage={persistedAt:T-1,error:null};
  base.unopenedTrades=[unopened(9999,T-10*60_000,"OPEN"),...Array.from({length:rows},(_,i)=>unopened(i,T-60_000-i*5*60_000))];
  base.signalTally=backfillSignalTally(base.unopenedTrades.map(t=>({id:t.id,symbol:t.symbol,side:t.side,openedAt:t.openedAt,status:t.status,netPct:.36,mfePct:1,maePct:.4}))).tally;
  base.signalTallyMeta={backfilled:true,from:T-48*3600_000};
  base.stageChronicle={...base.stageChronicle!,changes:Array.from({length:40},(_,i)=>({at:T-40*600_000+i*600_000,stage:i%2?"TREND":"TRANSITION",prior:i%2?"TRANSITION":"TREND",trendSide:"SHORT",
    snap:{sync:.6,breadth:.5,expansion:.4,aligned_flow:.1,pressure:.3,persistence:.5,btc:67000,eth:2600,factor:1.23}}))} as ForwardState["stageChronicle"];
  return normalizeForward(base,T);
}
const quotes:Record<string,Quote>={};

test("without an offload the hot JSON is byte-identical to the pre-change projection (default path unchanged)",()=>{
  const s=fixture(30),a=hotProjectionForMeasure(s,T),b=hotProjectionForMeasure(s,T,{stageDurable:false,tallyDurable:false,coldUnopenedIds:new Set()});
  assert.equal(a.raw.length,b.raw.length);assert.deepEqual(a.account,b.account);
});

test("an account above 4 MiB because of old not-opened rows saves once the rows are durable in their own keys",async()=>{
  const s=fixture(520),storage=new MemoryStorage();
  await assert.rejects(prepareForwardWrite(s,s,T,{compact:true}),/超过已声明账户预算.*最大字段：unopenedTrades=/);
  let cursor=emptyReviewLogCursor();
  for(let i=0;i<20;i++){
    const plan=prepareReviewLogWrite(s,T,cursor);if(!plan.writes)break;
    await storage.put(plan.entries);await storage.delete(plan.deletes);cursor=plan.cursor;
  }
  const offload=reviewLogOffload(s,cursor);
  assert.ok(offload.stageDurable&&offload.tallyDurable);
  const write=await prepareForwardWrite(s,s,T,{compact:true,offload});
  assert.equal(write.compression.accountBudgetBytes,FORWARD_PAIRED_ACCOUNT_MAX_BYTES);
  assert.ok(write.compression.rawBytes<3*1024*1024,`hot ${write.compression.rawBytes}`);
  // Financial fields, open rows and in-window rows are untouched.
  const hot=hotProjectionForMeasure(s,T,offload).account as ForwardState;
  assert.equal(hot.balance,s.balance);assert.deepEqual(hot.positions,s.positions);assert.deepEqual(hot.inverseTrial,hotProjectionForMeasure(s,T).account.inverseTrial);
  assert.ok(hot.unopenedTrades!.some(t=>t.status==="OPEN"));
  assert.ok(hot.unopenedTrades!.filter(t=>t.status==="CLOSED").every(t=>t.openedAt>=T-UNOPENED_HOT_WINDOW_MS));
  assert.equal(hot.signalTally,undefined);assert.equal(hot.stageChronicle!.changes.length,1);
  assert.equal(hot.stageChronicle!.stage,s.stageChronicle!.stage);assert.equal(hot.stageChronicle!.stageSince,s.stageChronicle!.stageSince);
  // In-memory account still carries everything.
  assert.equal(s.unopenedTrades!.length,521);
});

test("restart: hot head + cold logs restore the same export rows, stage timeline and tally",async()=>{
  const s=fixture(300),storage=new MemoryStorage();let cursor=emptyReviewLogCursor();
  for(let i=0;i<20;i++){const plan=prepareReviewLogWrite(s,T,cursor);if(!plan.writes)break;await storage.put(plan.entries);await storage.delete(plan.deletes);cursor=plan.cursor;}
  const write=await prepareForwardWrite(s,s,T,{compact:true,offload:reviewLogOffload(s,cursor)});
  await storage.put(write.entries);
  const loaded=await readForwardStore(storage,T+1000);
  assert.ok(loaded.unopenedTrades!.length<s.unopenedTrades!.length);
  const log=await readReviewLog(storage,loaded.startedAt);
  restoreReviewLog(loaded,log);
  const before=accountLogBook(s,quotes,T),after=accountLogBook(loaded,quotes,T);
  assert.deepEqual(after.notOpened.map(r=>r.id),before.notOpened.map(r=>r.id));
  assert.deepEqual(after.notOpened,before.notOpened);
  assert.deepEqual(after.stageTimeline,before.stageTimeline);
  assert.deepEqual(loaded.signalTally,s.signalTally);assert.deepEqual(loaded.signalTallyMeta,s.signalTallyMeta);
});

test("rows inside the trade-path window and open rows are never written cold",()=>{
  const s=fixture(200),plan=prepareReviewLogWrite(s,T,emptyReviewLogCursor());
  const cold=Object.keys(plan.entries).filter(k=>k.includes(":t:"));
  for(const key of cold){const id=key.split(":t:")[1]!,t=s.unopenedTrades!.find(x=>x.id===id)!;
    assert.equal(t.status,"CLOSED");assert.ok(t.openedAt<T-UNOPENED_HOT_WINDOW_MS);}
  assert.ok(cold.length<=48,"bounded rows per write");
});

test("a failed log write offloads nothing: the hot JSON keeps every row it would otherwise lose",()=>{
  const s=fixture(80),offload=reviewLogOffload(s,emptyReviewLogCursor());
  assert.equal(offload.stageDurable,false);assert.equal(offload.tallyDurable,false);assert.equal(offload.coldUnopenedIds.size,0);
  const hot=hotProjectionForMeasure(s,T,offload).account as ForwardState;
  assert.equal(hot.unopenedTrades!.length,s.unopenedTrades!.length);assert.deepEqual(hot.signalTally,s.signalTally);
});

test("a changed tally is no longer durable until rewritten, so it goes back into the hot JSON",async()=>{
  const s=fixture(10);let cursor=emptyReviewLogCursor();const storage=new MemoryStorage();
  const plan=prepareReviewLogWrite(s,T,cursor);await storage.put(plan.entries);cursor=plan.cursor;
  assert.equal(reviewLogOffload(s,cursor).tallyDurable,true);
  s.signalTally!["NEW_USDT"]={n:1,at:T};
  assert.equal(reviewLogOffload(s,cursor).tallyDurable,false);
  assert.ok(storage.map.has(REVIEW_TALLY_KEY));
});

test("account reset keeps the counter and never deletes the old account's cold rows",async()=>{
  const s=fixture(200),storage=new MemoryStorage();let cursor=emptyReviewLogCursor();
  for(let i=0;i<10;i++){const plan=prepareReviewLogWrite(s,T,cursor);if(!plan.writes)break;await storage.put(plan.entries);await storage.delete(plan.deletes);cursor=plan.cursor;}
  const oldKeys=[...storage.map.keys()].filter(k=>k.includes(`:${s.startedAt}:`));assert.ok(oldKeys.length>0);
  const next=resetForwardAccountPreservingLearning(s,T+5000);
  assert.deepEqual(next.signalTally,s.signalTally);
  const plan=prepareReviewLogWrite(next,T+5000,cursor);
  assert.equal(plan.deletes.length,0);
  await storage.put(plan.entries);
  for(const key of oldKeys)assert.ok(storage.map.has(key),key);
  assert.ok(!Object.keys(plan.entries).some(k=>k.includes(`:${s.startedAt}:`)));
});

test("cold rows keep the existing 800 closed-row retention",()=>{
  const s=fixture(10);
  const cursor={...emptyReviewLogCursor(),startedAt:s.startedAt,coldIds:Array.from({length:800},(_,i)=>`old-${i}`)};
  s.unopenedTrades!.push(unopened(77777,T-30*3600_000));
  const plan=prepareReviewLogWrite(s,T,cursor);
  assert.equal(plan.cursor.coldIds.length,800);
  assert.ok(plan.deletes.every(k=>k.startsWith("log:review:v1:unopened:")));
  assert.ok(plan.entries[unopenedRowKey(s.startedAt,"un-77777")]);
});
