/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic Worker/Member protected-method resource tests */
import test from "node:test";
import assert from "node:assert/strict";
import {register} from "node:module";
import {Memory} from "./member-fixtures.ts";
import {initialForward} from "../lib/forward-relations.ts";
import {resourceDay} from "../lib/resource-day.ts";
import {liveExitTag} from "../lib/gate-live.ts";
register("./worker-test-loader.mjs",import.meta.url);
const {MarketStream,MemberExecutor}=await import("../worker/index-clean.ts");
const T=Date.parse("2026-09-20T12:00:00Z");
async function clock(fn:(set:(at:number)=>void)=>Promise<void>){
 const original=Date.now,network=globalThis.fetch;let at=T;Date.now=()=>at;
 globalThis.fetch=async()=>{throw new Error("real network forbidden in write reservation test");};
 try{await fn(value=>{at=value;});}finally{Date.now=original;globalThis.fetch=network;}
}
async function harness(member=false){
 const db=new Memory(),tasks:Promise<unknown>[]=[];let ready=Promise.resolve();
 if(member)await db.put("member-execution:v1:identity",{id:`m_${"a".repeat(32)}`,label:"synthetic",createdAt:T-3_600_000});
 const ctx={storage:db,blockConcurrencyWhile(fn:()=>Promise<void>){ready=fn();},waitUntil(p:Promise<unknown>){tasks.push(p);}};
 const env={OWNER_ACCESS_TOKEN:"synthetic-not-live"};
 const w:any=member?new MemberExecutor(ctx as never,env as never):new MarketStream(ctx as never,env as never,true);
 await ready;w.forwardState=initialForward(T-3_600_000);w.turnoverAccountUser="synthetic";
 w.liveClient={credentials:{environment:"testnet",apiKey:"synthetic"},async confirmedFills(){return [];}};
 return {w,db,tasks};
}
function holdPut(db:Memory){
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;}),put=db.put.bind(db);
 db.put=async(...args:Parameters<Memory["put"]>)=>{entered();await gate;await put(...args);};
 return {started,release};
}
test("reservation synchronously includes all pending rows and settles once",()=>clock(async()=>{
 const {w}=await harness();w.runtime.nonAlarmWrites=7998;
 const a=w.reserveNonAlarmWrites(1),b=w.reserveNonAlarmWrites(1);assert.ok(a&&b);
 assert.equal(w.nonAlarmPendingWrites,2);assert.equal(w.reserveNonAlarmWrites(1),null);
 a.finish(true);a.finish(false);a.finish(true);assert.equal(w.runtime.nonAlarmWrites,7999);assert.equal(w.nonAlarmPendingWrites,1);
 b.finish(false);assert.equal(w.runtime.nonAlarmWrites,7999);assert.equal(w.nonAlarmPendingWrites,0);
 const retry=w.reserveNonAlarmWrites(1);assert.ok(retry);retry.finish(true);assert.equal(w.runtime.nonAlarmWrites,8000);
}));
test("headroom, malformed counts and isolated missing day never become free capacity",()=>clock(async()=>{
 const {w}=await harness();w.runtime.nonAlarmWrites=7936;delete w.runtime.utcDay;
 assert.equal(w.reserveNonAlarmWrites(1,64),null);assert.equal(w.runtime.nonAlarmWrites,7936);
 assert.equal(w.runtime.utcDay,resourceDay(T));
 assert.throws(()=>w.reserveNonAlarmWrites(-1));assert.throws(()=>w.reserveNonAlarmWrites(1,.5));
 w.runtime.nonAlarmWrites=NaN;assert.equal(w.reserveNonAlarmWrites(1),null);
}));
test("UTC rollover retains old-day pending reservations until completion and cannot roll backwards",()=>clock(async set=>{
 set(Date.parse("2026-09-20T23:59:59Z"));const {w}=await harness();w.runtime.nonAlarmWrites=7999;
 const old=w.reserveNonAlarmWrites(1);assert.ok(old);
 set(Date.parse("2026-09-21T00:00:01Z"));assert.equal(w.reserveNonAlarmWrites(8000),null);
 assert.equal(w.runtime.nonAlarmWrites,0);assert.equal(w.nonAlarmPendingWrites,1);
 const today=w.reserveNonAlarmWrites(7999);assert.ok(today);
 old.finish(true);assert.equal(w.runtime.nonAlarmWrites,1);assert.equal(w.nonAlarmPendingWrites,7999);
 today.finish(true);assert.equal(w.runtime.nonAlarmWrites,8000);assert.equal(w.nonAlarmPendingWrites,0);
 w.resetDailyCounters(T);assert.equal(w.runtime.utcDay,"2026-09-21");assert.equal(w.runtime.nonAlarmWrites,8000);
}));
test("actual primary checkpoint reserves before await and rejects concurrent oversubscription",()=>clock(async()=>{
 const {w,db}=await harness();w.runtime.nonAlarmWrites=7999;const hold=holdPut(db);
 const first=w.saveCheckpoint(T,true);await hold.started;
 assert.equal(w.nonAlarmPendingWrites,1);await assert.rejects(()=>w.saveCheckpoint(T,true),/reserve reached/);
 await w.saveCheckpoint(T,false);assert.equal(db.writes,0);
 hold.release();await first;assert.equal(w.nonAlarmPendingWrites,0);assert.equal(w.runtime.nonAlarmWrites,8000);
 assert.equal((await db.get<any>("checkpoint")).nonAlarmWrites,8000);
}));
test("checkpoint failure releases its reservation without deleting the pending financial journal",()=>clock(async()=>{
 const {w,db}=await harness();w.runtime.nonAlarmWrites=7998;w.liveJournal.set("synthetic-binding",{id:"same"});
 db.fail=true;await assert.rejects(()=>w.saveCheckpoint(T,true),/storage failure/);
 assert.equal(w.nonAlarmPendingWrites,0);assert.equal(w.runtime.nonAlarmWrites,7998);assert.equal(w.liveJournal.size,1);
 db.fail=false;await w.saveCheckpoint(T,true);assert.equal(w.runtime.nonAlarmWrites,8000);assert.equal(w.liveJournal.size,0);
}));
test("primary checkpoint and turnover share the reservation before either transaction completes",()=>clock(async()=>{
 const {w,db}=await harness();w.runtime.nonAlarmWrites=7743;const hold=holdPut(db);
 const first=w.saveCheckpoint(T,true);await hold.started;
 await assert.rejects(()=>w.syncTurnover(T),/交易保护优先/);
 assert.equal(w.nonAlarmPendingWrites,1);assert.equal(w.turnoverState.total,0);
 hold.release();await first;assert.equal(w.runtime.nonAlarmWrites,7744);assert.equal(w.nonAlarmPendingWrites,0);
}));
test("actual member checkpoint and inherited turnover share the same isolated reservation",()=>clock(async()=>{
 const {w,db}=await harness(true);w.runtime.nonAlarmWrites=7743;const hold=holdPut(db);
 const first=w.saveCheckpoint(T,true);await hold.started;assert.equal(w.nonAlarmPendingWrites,1);
 await assert.rejects(()=>w.syncTurnover(T),/交易保护优先/);
 const other=await harness(true);assert.equal(other.w.nonAlarmPendingWrites,0);assert.equal(other.w.runtime.nonAlarmWrites,0);
 hold.release();await first;assert.equal(w.runtime.nonAlarmWrites,7744);assert.equal(w.nonAlarmPendingWrites,0);
}));
test("member failed financial checkpoint releases budget and retains original identity and journal",()=>clock(async()=>{
 const {w,db}=await harness(true),identity=structuredClone(w.identity);w.runtime.nonAlarmWrites=7998;
 w.liveJournal.set("member-binding",{id:"same"});db.fail=true;
 await assert.rejects(()=>w.saveCheckpoint(T,true),/storage failure/);
 assert.equal(w.nonAlarmPendingWrites,0);assert.equal(w.runtime.nonAlarmWrites,7998);
 assert.deepEqual(w.identity,identity);assert.equal(w.liveJournal.size,1);
 db.fail=false;await w.saveCheckpoint(T,true);assert.equal(w.runtime.nonAlarmWrites,8000);
}));
test("full forward financial commit holds its reservation across storage await",()=>clock(async()=>{
 const {w,db}=await harness(),hold=holdPut(db);
 const first=w.advanceForwardNow(T);await hold.started;
 const pending=w.nonAlarmPendingWrites;assert.ok(pending>0);
 assert.equal(w.runtime.nonAlarmWrites,0);assert.equal(w.forwardState.storage.persistedAt,0);
 hold.release();await first;assert.equal(w.forwardError,null);assert.equal(w.runtime.nonAlarmWrites,pending);
 assert.equal(w.nonAlarmPendingWrites,0);assert.equal(w.forwardState.storage.persistedAt,T);
}));
test("actual settlement cache write reserves against concurrent turnover without changing closed PnL",()=>clock(async()=>{
 const {w,db,tasks}=await harness();w.runtime.nonAlarmWrites=7743;
 const opened=T-620_000,closed=T-15_000,id="source-settlement";
 w.liveHistory=[{id,symbol:"BTC_USDT",side:"LONG",status:"CLOSED",entryAt:opened+10_000,exitAt:closed+5000,
   entryPrice:100,exchangeSize:.1,parity:{sourceId:id,copiedAt:opened,roundedContracts:.1}}];
 w.liveClient.positionCloseHistory=async()=>[{contract:"BTC_USDT",side:"long",time:closed/1000,first_open_time:opened/1000,
   pnl:"-.07",text:liveExitTag(id),max_size:".1",accum_size:".1",long_price:"100",short_price:"103"}];
 const hold=holdPut(db);await w.privateLiveHistory();await hold.started;
 assert.equal(w.nonAlarmPendingWrites,1);await assert.rejects(()=>w.syncTurnover(T),/交易保护优先/);
 hold.release();await Promise.all(tasks);assert.equal(w.runtime.nonAlarmWrites,7744);assert.equal(w.nonAlarmPendingWrites,0);
 assert.equal((await w.privateLiveHistory()).history[0].realizedPnl,-.07);
}));
