import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { advanceForward, initialForward, initialMultiTurnForward, type ForwardState, type Quote, type Trade } from "../lib/forward-relations.ts";
import { newExitControl, TIMELY_PROTECTION_POLICY } from "../lib/forward-protection.ts";
import { buildForwardProtectionCheckpoint, forwardProtectionChanged, restoreForwardProtectionCheckpoint } from "../lib/forward-protection-checkpoint.ts";
import { FORWARD_PROTECTION_STORAGE, FORWARD_STORAGE, prepareForwardProtectionWrite,
  prepareForwardWrite, readForwardStore } from "../lib/forward-store.ts";
import { nextProtectionWriteBudget, PROTECTION_WRITE_CAP, type ProtectionWriteBudget } from "../lib/forward-write-budget.ts";
import { MULTI_TURN_PROFIT_PROTECTION_VERSION } from "../lib/multi-turn-profit-protection.ts";
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
  queue:Promise<unknown>=Promise.resolve();
  async get<V>(key:string){return structuredClone(this.data.get(key)) as V|undefined;}
  async put(entries:Record<string,unknown>){
    if(this.fail)throw new Error("injected storage failure");
    this.writes.push(Object.keys(entries));
    for(const[k,v]of Object.entries(entries))this.data.set(k,structuredClone(v));
  }
  async transaction<V>(fn:(db:Memory)=>Promise<V>){
    const job=this.queue.then(async()=>{
      const old=structuredClone(this.data);try{return await fn(this);}catch(error){this.data=old;throw error;}
    });
    this.queue=job.catch(()=>{});return job;
  }
}
async function base(){
  const state=step(account(),100_000,102).state;
  state.storage={persistedAt:T+100_000,error:null};
  const store=new Memory(),full=await prepareForwardWrite(null,state,T+100_000);await store.put(full.entries);
  store.writes=[];return{state,store};
}
type Harness={forwardState:ForwardState;forwardError:string|null;forwardBusy:boolean;forwardLastAttemptAt:number;
  forwardProtectionBudget:ProtectionWriteBudget|null;
  forwardCompression:unknown;runtime:{nonAlarmWrites:number;live:{entries:Record<string,never>;positions:Record<string,never>}};
  ctx:{storage:Memory};strategyCandles:Record<string,never>;mirrorClosures:Map<string,Trade>;
  regimeQuotes(now:number):Record<string,Quote>;regimeContracts():Record<string,never>;advanceForwardNow(now:number):Promise<void>};
function harness(state:ForwardState,store:Memory,price=104){
  // Exercise the ACTUAL protected Worker method without constructing unrelated
  // host services or making Gate/D1/network requests.
  const h=Object.create(MarketStream.prototype) as Harness;
  Object.assign(h,{forwardState:structuredClone(state),forwardError:null,forwardBusy:false,forwardLastAttemptAt:0,
    forwardCompression:null,forwardProtectionBudget:null,ctx:{storage:store},strategyCandles:{},mirrorClosures:new Map(),
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
test("dynamic Multi-Turn profit floor survives a compact restart overlay without loosening",()=>{
  const base=account();base.storage={persistedAt:T+1,error:null};base.lastQuoteCycleAt=T+1000;
  base.positions[0].rule.authority="MULTI_TURN";
  const next=structuredClone(base);next.lastQuoteCycleAt=T+2000;
  next.positions[0].favorable=.08;
  next.positions[0].profitProtection={
    version:MULTI_TURN_PROFIT_PROTECTION_VERSION,reachedR:4,lockedR:2.5,floorRate:.05,retentionRate:.625,
    activationRate:.012,checkpointBand:10,mode:"WEAKENING",peakR:4,updatedAt:T+2000,
  };
  const checkpoint=buildForwardProtectionCheckpoint(next);
  const restored=restoreForwardProtectionCheckpoint(base,checkpoint);
  assert.deepEqual(restored.positions[0].profitProtection,next.positions[0].profitProtection);
  assert.equal(restored.positions[0].favorable,.08);
});

test("release-344 Worker does not create a later profit-floor checkpoint",async()=>{
  const start=Date.parse("2026-09-21T00:00:00Z");
  const rows=Array.from({length:360},(_,i)=>{
    const close=100*Math.exp(i*.0008),open=close/1.0008;
    return{time:start/1000+i*300,open,high:close*1.001,low:open*.999,close,volume:1000+i};
  });
  const now=(rows.at(-1)!.time+300)*1000+1000,mid=rows.at(-1)!.close;
  const state=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:rows},
    quotes:{BTC_USDT:{bestBid:mid*.9999,bestAsk:mid*1.0001,observedAt:now,fresh:true,entryReady:true}},
    contracts:{BTC_USDT:{quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1}}}).state;
  assert.equal(state.positions.length,1);
  const trade=state.positions[0],frame=state.turnEngine!.frames.BTC_USDT[trade.turn!.timeframe]!;
  frame.continuationScore=.55;frame.triggerProbability=.20;frame.direction=trade.side;frame.rawDirection=trade.side;
  frame.phase="FLOW";frame.lastTurnAt=null;state.lastCycleAt=now;
  const px=trade.entryPrice*(trade.side==="LONG"?1.035:.965),at=now+10_000;
  const next=advanceForward({state,now:at,paths:{},
    quotes:{BTC_USDT:{bestBid:px*.99999,bestAsk:px*1.00001,observedAt:at,fresh:true,entryReady:true}},contracts:{}});

  assert.equal(next.state.positions.length,1);
  assert.equal(next.state.positions[0].profitProtection,undefined);
  assert.equal(next.state.positions[0].profitProtectionMigration,undefined);
  assert.equal(next.state.history.some(x=>x.exitAudit?.trigger==="PROFIT_GIVEBACK"),false,
    "release-344 has no independent Multi-Turn profit-giveback exit");
});

test("guarded and deferred adaptive-profit migration state survives compact restart",()=>{
  for(const state of["GUARDED","DEFERRED"] as const){
    const base=account();base.storage={persistedAt:T+1,error:null};base.lastQuoteCycleAt=T+1000;
    base.positions[0].rule.authority="MULTI_TURN";
    const next=structuredClone(base);next.lastQuoteCycleAt=T+2000;next.positions[0].favorable=.06;
    next.positions[0].profitProtectionMigration={
      version:MULTI_TURN_PROFIT_PROTECTION_VERSION,state,updatedAt:T+2000,baselineFavorable:.06,
    };
    if(state==="GUARDED")next.positions[0].profitProtection={
      version:MULTI_TURN_PROFIT_PROTECTION_VERSION,reachedR:3,lockedR:1.2,floorRate:.024,retentionRate:.4,
      activationRate:.012,checkpointBand:4,mode:"NORMAL",peakR:3,updatedAt:T+2000,
    };
    const checkpoint=buildForwardProtectionCheckpoint(next);
    const restored=restoreForwardProtectionCheckpoint(base,checkpoint);
    assert.deepEqual(restored.positions[0].profitProtectionMigration,next.positions[0].profitProtectionMigration);
    assert.deepEqual(restored.positions[0].profitProtection,next.positions[0].profitProtection);
  }
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
  const{state}=await base();state.peakEquity=1100;state.maxDrawdown=.1;
  const audit=step(state,110_000,101.9);
  assert.equal(audit.changed,false);assert.equal(audit.protectionChanged,false);
  const below=account();below.peakEquity=1100;below.maxDrawdown=.1;
  const n=step(below,110_000,100.5).state;
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
  assert.equal(h.forwardError,null);assert.equal(h.runtime.nonAlarmWrites,0);
  assert.equal(h.forwardProtectionBudget?.writes,1);
  assert.equal((await store.get<{writeBudget:ProtectionWriteBudget}>(FORWARD_PROTECTION_STORAGE))?.writeBudget.writes,1);
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
test("actual Worker critical peaks cannot consume the unchanged financial cap or exit reserve",async()=>{
  const{state,store}=await base(),h=harness(state,store);h.runtime.nonAlarmWrites=7936;
  await h.advanceForwardNow(T+110_000);
  assert.equal(h.forwardError,null);assert.equal(h.runtime.nonAlarmWrites,7936);
  assert.deepEqual(store.writes,[[FORWARD_PROTECTION_STORAGE]]);
  h.runtime.nonAlarmWrites=8000;h.regimeQuotes=now=>quote(now,105);
  await h.advanceForwardNow(T+120_000);
  assert.equal(h.forwardError,null);assert.equal(h.runtime.nonAlarmWrites,8000);
  assert.equal(h.forwardProtectionBudget?.writes,2);
});
test("resource stress: a durable peak preserves the final headroom for a subsequent close",async t=>{
  const{state,store}=await base(),peak=step(state,110_000,104).state;
  const closure=step(peak,120_000,103).state;closure.storage={persistedAt:T+120_000,error:null};
  const closeWrite=await prepareForwardWrite(peak,closure,T+120_000,{compact:true});
  const h=harness(state,store);h.runtime.nonAlarmWrites=8000-64-closeWrite.writes;
  // Without the intervening peak, this many full-close records exactly fits.
  assert.equal(h.runtime.nonAlarmWrites+closeWrite.writes+64,8000);
  await h.advanceForwardNow(T+110_000);assert.equal(h.forwardError,null);
  assert.equal(h.forwardState.positions.length,1);assert.equal(store.writes.length,1);
  h.regimeQuotes=now=>quote(now,103);await h.advanceForwardNow(T+120_000);
  assert.equal(h.forwardError,null);
  assert.equal(h.forwardState.positions.length,0);assert.equal(h.forwardState.history.length,1);
  assert.equal(h.runtime.nonAlarmWrites,7936);
  assert.equal(store.writes.length,2);
  const restored=await readForwardStore(store,T+125_000);
  assert.equal(restored.history[0].netPnl,h.forwardState.history[0].netPnl);
  const metrics={scenario:"forward-protection-write-budget",criticalCheckpointNoLongerStarvesExit:true,
    dailyCap:8000,reserve:64,observedBaselineWrites:7773,observedRemainingUsable:8000-64-7773,
    callbackCadenceMs:10_000,callbacksPerDay:86_400_000/10_000,
    fullCyclesPerDay:86_400_000/300_000,
    worstAdditionalCheckpointWrites:86_400_000/10_000-86_400_000/300_000,
    closeWrites:closeWrite.writes,peakWrites:1,protectionCap:PROTECTION_WRITE_CAP};
  assert.equal(metrics.worstAdditionalCheckpointWrites,8352);
  assert.ok(metrics.worstAdditionalCheckpointWrites>metrics.dailyCap-metrics.reserve);
  t.diagnostic(JSON.stringify(metrics));
});
test("restart preserves lane counter and does not delay the next eligible ten-second slot",async()=>{
  const{state,store}=await base(),h=harness(state,store);
  await h.advanceForwardNow(T+110_000);
  const restarted=harness(await readForwardStore(store,T+115_000),store,105);
  await restarted.advanceForwardNow(T+115_000);
  assert.equal(store.writes.length,1);
  await restarted.advanceForwardNow(T+120_000);
  assert.equal(restarted.forwardError,null);assert.equal(store.writes.length,2);
  assert.equal(restarted.forwardProtectionBudget?.writes,2);
});
test("a financial full commit leaves the protection counter durable across generation change",async()=>{
  const{state,store}=await base(),h=harness(state,store);
  await h.advanceForwardNow(T+110_000);
  const next=structuredClone(h.forwardState);next.revision++;next.storage.persistedAt=T+115_000;
  await store.put((await prepareForwardWrite(h.forwardState,next,T+115_000,{compact:true})).entries);
  const restored=await readForwardStore(store,T+116_000);
  assert.equal(restored.revision,next.revision);
  const restarted=harness(restored,store,105);await restarted.advanceForwardNow(T+120_000);
  assert.equal(restarted.forwardError,null);assert.equal(restarted.forwardProtectionBudget?.writes,2);
});
test("a full financial exit bypasses exhausted or corrupt protection-only resource metadata",async()=>{
  for(const corrupt of [false,true]){
    const{state,store}=await base(),peak=step(state,110_000,104).state;
    const write=prepareForwardProtectionWrite(peak);
    const writeBudget={...nextProtectionWriteBudget(null,T+110_000),writes:corrupt?-1:PROTECTION_WRITE_CAP};
    await store.put({[FORWARD_PROTECTION_STORAGE]:{...write.entries[FORWARD_PROTECTION_STORAGE],writeBudget}});
    const h=harness(await readForwardStore(store,T+115_000),store,103);
    await h.advanceForwardNow(T+120_000);
    assert.equal(h.forwardError,null);assert.equal(h.forwardState.positions.length,0);
    assert.equal(h.forwardState.history[0].exitAudit!.trigger,"PROFIT_GIVEBACK");
  }
});
test("exhausted, corrupt and failed critical commits retain both financial and protection authority",async()=>{
  for(const mode of ["full","corrupt","failed"]){
    const{state,store}=await base(),peak=step(state,110_000,104).state;
    const write=prepareForwardProtectionWrite(peak);
    const writeBudget={...nextProtectionWriteBudget(null,T+110_000),writes:mode==="full"?PROTECTION_WRITE_CAP:mode==="corrupt"?-1:3};
    await store.put({[FORWARD_PROTECTION_STORAGE]:{...write.entries[FORWARD_PROTECTION_STORAGE],writeBudget}});
    const h=harness(await readForwardStore(store,T+115_000),store,105),old=structuredClone(h.forwardState);
    const saved=structuredClone(store.data);store.fail=mode==="failed";
    await h.advanceForwardNow(T+120_000);
    assert.ok(h.forwardError);assert.deepEqual(h.forwardState,old);assert.deepEqual(store.data,saved);
    assert.equal(h.runtime.nonAlarmWrites,0);
  }
});
test("serialized competing critical transactions cannot reset the durable counter or double-commit a slot",async()=>{
  const{state,store}=await base(),a=harness(state,store,104),b=harness(state,store,105);
  await Promise.all([a.advanceForwardNow(T+110_000),b.advanceForwardNow(T+110_000)]);
  assert.equal(store.writes.length,1);
  assert.equal([a,b].filter(x=>x.forwardError===null).length,1);
  assert.equal((await store.get<{writeBudget:ProtectionWriteBudget}>(FORWARD_PROTECTION_STORAGE))?.writeBudget.writes,1);
});
test("actual Worker does not write on ordinary noncritical quote updates",async()=>{
  const{state,store}=await base();state.peakEquity=1100;state.maxDrawdown=.1;
  const h=harness(state,store,101.9);
  await h.advanceForwardNow(T+110_000);
  assert.equal(h.forwardError,null);assert.equal(store.writes.length,0);assert.equal(h.runtime.nonAlarmWrites,0);
});
test("checkpoint preparation refuses an unsaved base and never drops oversize protection",()=>{
  assert.throws(()=>prepareForwardProtectionWrite(account()),/整包账户尚未持久化/);
  const s=account();s.storage.persistedAt=T;
  s.positions=Array.from({length:2000},(_,i)=>({...s.positions[0],id:`oversize-${i}`}));
  assert.throws(()=>prepareForwardProtectionWrite(s),/单值预算/);
});
