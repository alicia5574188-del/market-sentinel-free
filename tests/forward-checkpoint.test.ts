import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { advanceForward, initialForward, type ForwardState, type Quote, type Trade } from "../lib/forward-relations.ts";
import { newExitControl, TIMELY_PROTECTION_POLICY } from "../lib/forward-protection.ts";
import { buildForwardProtectionCheckpoint, forwardProtectionChanged } from "../lib/forward-protection-checkpoint.ts";
import { FORWARD_PROTECTION_STORAGE, FORWARD_STORAGE, prepareForwardProtectionWrite,
  prepareForwardWrite, readForwardStore } from "../lib/forward-store.ts";
register("./worker-test-loader.mjs",import.meta.url);
const { MarketStream }=await import("../worker/index-clean.ts");
const T=1_790_100_000_000;

function account():ForwardState{
  const s=initialForward(T-3_600_000);
  const p:Trade={id:"checkpoint-fixture",symbol:"BTC_USDT",side:"LONG",openedAt:T,closedAt:null,status:"OPEN",
    entryPrice:100,exitPrice:null,quantity:2,contracts:2000,quantoMultiplier:.001,notional:200,
    leverage:2,margin:100,plannedRisk:4.44,stopPrice:98,armPrice:101.5,favorable:0,adverse:0,
    lastPrice:100,lastQuoteAt:T,entryFee:.14,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,
    exitReason:null,relationFailureBars:0,lastRelationBar:T,execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,
    exitControl:newExitControl(),rule:{id:"fixture-rule",signature:"fixture",parentId:null,version:1,createdAt:T-1000,
      expiresAt:T+3_600_000,status:"EXPERIMENTAL",conditions:[],side:"LONG",horizon:60,stopRate:.02,
      armRate:.015,givebackRate:.007,exitMode:"REACTION_DECAY",samples:20,trainGroups:3,checkGroups:2,
      estimatedNetRate:.01,priorResponse:.02,recentResponse:.02,standardError:.003,reason:"Synthetic, not market evidence",
      mutation:"CREATE",grammar:"fixture",liveEligible:false}};
  s.positions=[p];s.balance=1000;s.lastCycleAt=T+90_000;s.lastFitAt=T+90_000;
  s.exitPolicyUpgrade={policy:TIMELY_PROTECTION_POLICY,at:T-1,equity:1000,balance:1000,resolved:0,inheritedPositionIds:[]};
  return s;
}
function quote(now:number,price:number):Record<string,Quote>{
  return {BTC_USDT:{bestBid:price,bestAsk:price+.01,observedAt:now,fresh:true}};
}
function step(state:ForwardState,offset:number,price:number){
  return advanceForward({state,now:T+offset,paths:{},contracts:{},quotes:quote(T+offset,price)});
}
class Memory {
  data=new Map<string,unknown>();writes:string[][]=[];fail=false;
  async get<V>(key:string){return structuredClone(this.data.get(key)) as V|undefined;}
  async put(entries:Record<string,unknown>){
    if(this.fail)throw new Error("injected storage failure");
    this.writes.push(Object.keys(entries));
    for(const[k,v]of Object.entries(entries))this.data.set(k,structuredClone(v));
  }
  async transaction<V>(fn:(db:Memory)=>Promise<V>){
    const old=structuredClone(this.data);try{return await fn(this);}catch(error){this.data=old;throw error;}
  }
}
async function base(){
  const state=step(account(),100_000,102).state;
  state.storage={persistedAt:T+100_000,error:null};
  const store=new Memory(),full=await prepareForwardWrite(null,state,T+100_000);await store.put(full.entries);
  store.writes=[];return{state,store};
}
type Harness={forwardState:ForwardState;forwardError:string|null;forwardBusy:boolean;forwardLastAttemptAt:number;
  forwardCompression:unknown;runtime:{nonAlarmWrites:number;live:{entries:Record<string,never>;positions:Record<string,never>}};
  ctx:{storage:Memory};strategyCandles:Record<string,never>;mirrorClosures:Map<string,Trade>;
  regimeQuotes(now:number):Record<string,Quote>;regimeContracts():Record<string,never>;advanceForwardNow(now:number):Promise<void>};
function harness(state:ForwardState,store:Memory,price=104){
  // Exercise the ACTUAL protected Worker method without constructing unrelated
  // host services or making Gate/D1/network requests.
  const h=Object.create(MarketStream.prototype) as Harness;
  Object.assign(h,{forwardState:structuredClone(state),forwardError:null,forwardBusy:false,forwardLastAttemptAt:0,
    forwardCompression:null,ctx:{storage:store},strategyCandles:{},mirrorClosures:new Map(),
    runtime:{nonAlarmWrites:0,live:{entries:{},positions:{}}},
    regimeQuotes:(now:number)=>quote(now,price),regimeContracts:()=>({})});
  return h;
}

test("compact checkpoint restores the same next giveback decision across restart",async()=>{
  const{state,store}=await base(),peak=step(state,110_000,104);
  assert.equal(peak.changed,false);assert.equal(peak.protectionChanged,true);
  const prepared=prepareForwardProtectionWrite(peak.state);assert.equal(prepared.writes,1);
  assert.deepEqual(Object.keys(prepared.entries),[FORWARD_PROTECTION_STORAGE]);
  await store.put(prepared.entries);const restored=await readForwardStore(store,T+115_000);
  const continuous=step(peak.state,120_000,103).state,restarted=step(restored,120_000,103).state;
  assert.equal(continuous.positions.length,0);assert.equal(restarted.positions.length,0);
  assert.equal(restarted.history[0].exitAudit!.trigger,"PROFIT_GIVEBACK");
  assert.equal(restarted.history[0].netPnl,continuous.history[0].netPnl);
  assert.equal(restored.storage.persistedAt,state.storage.persistedAt);
  for(const field of ["balance","fees","turnover","history","rules","samples","events","revision"] as const)
    assert.deepEqual(restored[field],state[field]);
});
test("legacy full records remain readable when no protection overlay exists",async()=>{
  const{state,store}=await base();assert.deepEqual(await readForwardStore(store,T+110_000),state);
});
test("a newer full commit makes an old overlay inert without a delete or extra key",async()=>{
  const{state,store}=await base(),peak=step(state,110_000,104).state;
  await store.put(prepareForwardProtectionWrite(peak).entries);
  const newer=step(peak,120_000,103).state;newer.storage={persistedAt:T+120_000,error:null};
  const write=await prepareForwardWrite(state,newer,T+120_000);await store.put(write.entries);
  assert.equal(Object.keys(write.entries).some(k=>k===FORWARD_PROTECTION_STORAGE),false);
  assert.deepEqual(await readForwardStore(store,T+130_000),newer);
});
test("account reset, revision and full-generation mismatch never restore another overlay",async()=>{
  for(const changed of ["startedAt","baseRevision","basePersistedAt"] as const){
    const{state,store}=await base(),checkpoint=buildForwardProtectionCheckpoint(step(state,110_000,104).state);
    checkpoint[changed]--;await store.put({[FORWARD_PROTECTION_STORAGE]:checkpoint});
    assert.deepEqual(await readForwardStore(store,T+120_000),state);
  }
});
test("obsolete generation remains inert even if its payload is corrupt",async()=>{
  const{state,store}=await base(),checkpoint=buildForwardProtectionCheckpoint(step(state,110_000,104).state);
  const stale={...checkpoint,basePersistedAt:checkpoint.basePersistedAt-1,positions:null,version:"obsolete"};
  await store.put({[FORWARD_PROTECTION_STORAGE]:stale});
  assert.deepEqual(await readForwardStore(store,T+120_000),state);
});
test("matching corrupt overlay fails closed without changing stored financial history",async()=>{
  const{state,store}=await base(),original=structuredClone(store.data);
  const valid=buildForwardProtectionCheckpoint(step(state,110_000,104).state);
  const corruptions=[{...valid,positions:[]},{...valid,positions:[{...valid.positions[0],favorable:NaN}]},
    {...valid,positions:[{...valid.positions[0],openedAt:T-1}]},{...valid,version:"unknown"},
    {...valid,positions:[{...valid.positions[0],relationFailureBars:-1}]}];
  for(const value of corruptions){
    await store.put({[FORWARD_PROTECTION_STORAGE]:value});
    await assert.rejects(()=>readForwardStore(store,T+120_000),/保护检查点异常/);
    for(const[k,v]of original)assert.deepEqual(store.data.get(k),v);
  }
});
test("overlay storage read errors do not silently fall back to forgotten protection",async()=>{
  const{store}=await base();
  await assert.rejects(()=>readForwardStore({async get<V>(key:string){
    if(key===FORWARD_PROTECTION_STORAGE)throw new Error("overlay read failed");return store.get<V>(key);
  }},T+120_000),/overlay read failed/);
});
test("ordinary quote/audit movements alone request no compact persistence",async()=>{
  const{state}=await base(),audit=step(state,110_000,101.9);
  assert.equal(audit.changed,false);assert.equal(audit.protectionChanged,false);
  const below=account(),n=step(below,110_000,100.5).state;
  assert.equal(forwardProtectionChanged(below,n),false);
});
test("only actual completed-bar confirmation changes request protection persistence",async()=>{
  const{state}=await base(),n=structuredClone(state);n.positions[0].relationFailureBars=1;
  n.positions[0].lastRelationBar=T+105_000;n.lastQuoteCycleAt=T+110_000;
  assert.equal(forwardProtectionChanged(state,n),true);
  assert.equal(forwardProtectionChanged(n,structuredClone(n)),false);
});
test("actual Worker writes exactly one compact key and publishes only after commit",async()=>{
  const{state,store}=await base(),h=harness(state,store);const original=structuredClone(h.forwardState);
  const put=store.put.bind(store);store.put=async entries=>{
    assert.deepEqual(h.forwardState,original);await put(entries);
  };
  await h.advanceForwardNow(T+110_000);
  assert.equal(h.forwardError,null);assert.equal(h.runtime.nonAlarmWrites,1);
  assert.deepEqual(store.writes,[[FORWARD_PROTECTION_STORAGE]]);
  assert.ok(h.forwardState.positions[0].favorable>state.positions[0].favorable);
  assert.equal(h.forwardState.storage.persistedAt,state.storage.persistedAt);
  assert.equal(h.forwardCompression,null);
  assert.equal(store.writes.flat().some(k=>k===`${FORWARD_STORAGE}head`||k.includes("archive:")),false);
});
test("actual Worker failed checkpoint write retains authority and records a visible error",async()=>{
  const{state,store}=await base(),h=harness(state,store),old=structuredClone(h.forwardState);store.fail=true;
  await h.advanceForwardNow(T+110_000);
  assert.deepEqual(h.forwardState,old);assert.match(h.forwardError!,/injected storage failure/);
  assert.equal(h.runtime.nonAlarmWrites,0);assert.equal(h.forwardBusy,false);
  assert.equal(store.data.has(FORWARD_PROTECTION_STORAGE),false);
});
test("actual Worker obeys unchanged 8000 cap and 64-write reserve, including critical peaks",async()=>{
  const{state,store}=await base(),h=harness(state,store);h.runtime.nonAlarmWrites=7936;
  await h.advanceForwardNow(T+110_000);
  assert.match(h.forwardError!,/保护写入预算不足/);assert.deepEqual(h.forwardState,state);
  assert.equal(h.runtime.nonAlarmWrites,7936);assert.equal(store.writes.length,0);
  h.runtime.nonAlarmWrites=7935;await h.advanceForwardNow(T+120_000);
  assert.equal(h.forwardError,null);assert.equal(h.runtime.nonAlarmWrites,7936);
  assert.deepEqual(store.writes,[[FORWARD_PROTECTION_STORAGE]]);
  // This arithmetic is a LIMITATION, not a capacity claim: all 10s callbacks
  // becoming new peaks would exceed the whole cap before other account work.
  assert.ok(86_400_000/10_000>8000);
});
test("resource stress: a durable peak can consume the final headroom needed by a subsequent close",async t=>{
  const{state,store}=await base(),peak=step(state,110_000,104).state;
  const closure=step(peak,120_000,103).state;closure.storage={persistedAt:T+120_000,error:null};
  const closeWrite=await prepareForwardWrite(peak,closure,T+120_000);
  const h=harness(state,store);h.runtime.nonAlarmWrites=8000-64-closeWrite.writes;
  // Without the intervening peak, this many full-close records exactly fits.
  assert.equal(h.runtime.nonAlarmWrites+closeWrite.writes+64,8000);
  await h.advanceForwardNow(T+110_000);assert.equal(h.forwardError,null);
  assert.equal(h.forwardState.positions.length,1);assert.equal(store.writes.length,1);
  h.regimeQuotes=now=>quote(now,103);await h.advanceForwardNow(T+120_000);
  assert.match(h.forwardError!,/前向写入预算不足/);
  assert.equal(h.forwardState.positions.length,1);assert.equal(h.forwardState.history.length,0);
  assert.equal(store.writes.length,1); // No uncommitted close or archive is published.
  const metrics={scenario:"forward-protection-write-budget",releaseReady:false,
    dailyCap:8000,reserve:64,observedBaselineWrites:7773,observedRemainingUsable:8000-64-7773,
    callbackCadenceMs:10_000,callbacksPerDay:86_400_000/10_000,
    fullCyclesPerDay:86_400_000/300_000,
    worstAdditionalCheckpointWrites:86_400_000/10_000-86_400_000/300_000,
    closeWrites:closeWrite.writes,peakWrites:1,failedClosePreservesAuthority:true};
  assert.equal(metrics.worstAdditionalCheckpointWrites,8352);
  assert.ok(metrics.worstAdditionalCheckpointWrites>metrics.dailyCap-metrics.reserve);
  t.diagnostic(JSON.stringify(metrics));
});
test("actual Worker does not write on ordinary noncritical quote updates",async()=>{
  const{state,store}=await base(),h=harness(state,store,101.9);
  await h.advanceForwardNow(T+110_000);
  assert.equal(h.forwardError,null);assert.equal(store.writes.length,0);assert.equal(h.runtime.nonAlarmWrites,0);
});
test("checkpoint preparation refuses an unsaved base and never drops oversize protection",()=>{
  assert.throws(()=>prepareForwardProtectionWrite(account()),/整包账户尚未持久化/);
  const s=account();s.storage.persistedAt=T;
  s.positions=Array.from({length:2000},(_,i)=>({...s.positions[0],id:`oversize-${i}`}));
  assert.throws(()=>prepareForwardProtectionWrite(s),/单值预算/);
});
