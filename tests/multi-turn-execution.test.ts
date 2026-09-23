import test from "node:test";
import assert from "node:assert/strict";
import { advanceForward, BAR_MS, forwardEquity, forwardSummary, forwardWatchSymbols, initialForward, initialMultiTurnForward,
  multiTurnEntryLeverage, MULTI_TURN_TARGET_LEVERAGE, type Candle, type Contract, type Quote } from "../lib/forward-relations.ts";
import { MULTI_TURN_VERSION, TURN_TIMEFRAMES, evaluateMultiTurn, initialMultiTurn } from "../lib/multi-turn-engine.ts";
import { REGION_LIFECYCLE_VERSION, type RegionEntrySignal, type RegionLifecycleState } from "../lib/region-lifecycle.ts";
import { ANCHOR_FLOW_VERSION, type AnchorFlowEntrySignal } from "../lib/anchor-flow.ts";
import { FORWARD_PROTECTION_STORAGE, FORWARD_STORAGE, prepareForwardReset, prepareForwardWrite, readForwardStore } from "../lib/forward-store.ts";

const BASE=Date.parse("2026-09-21T00:00:00Z");
const meta:Contract={quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1};
const quote=(mid:number,at:number):Quote=>({bestBid:mid*.9999,bestAsk:mid*1.0001,observedAt:at,fresh:true,entryReady:true});

const regionPath=():Candle[]=>{
  const rows:Candle[]=[],start=BASE/1000;let prev=100;
  for(let i=0;i<36;i++){
    const close=100*(1+.0032*Math.sin(i*Math.PI/2));
    rows.push({time:start+i*300,open:prev,high:Math.max(prev,close)*1.0018,low:Math.min(prev,close)*.9982,close,volume:1000+i});prev=close;
  }
  return rows;
};

const lifecycle=(symbol:string,now:number,status:RegionLifecycleState["status"]="ACCEPTED_UP"):RegionLifecycleState=>({
  version:REGION_LIFECYCLE_VERSION,symbol,initializedAt:now-60_000,observedAt:now,lastProcessedAt:now,
  zone:{id:`rg-${symbol}`,symbol,startAt:now-3_600_000,endAt:now-600_000,confirmedAt:now-600_000,bars:24,
    lower:99,upper:101,center:100,width:2,widthRate:.02,touchesUpper:5,touchesLower:5,crossings:8},
  status,probeStartedAt:null,probeExtreme:null,acceptedAt:now-300_000,detachedAt:null,upperConsumedAt:null,lowerConsumedAt:null,
  reason:"fixture",
});
type TestSignal=RegionEntrySignal&Partial<AnchorFlowEntrySignal>;
const signal=(symbol:string,now:number,overrides:Partial<TestSignal>={}):TestSignal=>{
  const row:TestSignal={
    version:REGION_LIFECYCLE_VERSION,id:`rs-${symbol}-${now}`,symbol,kind:"MIGRATION",side:"LONG",boundary:"UPPER",
    completedAt:now-1_000,expiresAt:now+9*60_000,signalPrice:101.2,stopPrice:100.6,targetPrice:null,
    regionId:`rg-${symbol}`,regionConfirmedAt:now-600_000,regionLower:99,regionUpper:101,regionCenter:100,regionWidth:2,regionWidthRate:.02,
    reason:"fixture AnchorFlow restart",entryModel:"ANCHOR_FLOW",contextTimeframe:"15m",directionFrameAt:now-60_000,trendFrameAt:now-60_000,
    retestAt:now-300_000,restartLevel:101.1,pullbackExtreme:100.7,anchorExpectedMoveRate:.025,...overrides,
  };
  if(row.kind==="REJECTION"){
    delete row.entryModel;delete row.contextTimeframe;delete row.directionFrameAt;delete row.trendFrameAt;
    delete row.retestAt;delete row.restartLevel;delete row.pullbackExtreme;delete row.anchorExpectedMoveRate;
  }
  return row;
};
const seeded=(symbols:string[],now:number)=>{
  const s=initialMultiTurnForward(now-60_000);
  s.lastCycleAt=now;s.lastQuoteCycleAt=0;s.regionLifecycles={};s.regionSignals=[];
  for(const symbol of symbols){s.regionLifecycles[symbol]=lifecycle(symbol,now);s.regionSignals.push(signal(symbol,now));}
  return s;
};

test("only a completed AnchorFlow restart owns trend entry authority and preserves retest invalidation",()=>{
  const now=BASE+6*60*60_000,s=seeded(["BTC_USDT"],now);
  const state=advanceForward({state:s,now,paths:{},quotes:{BTC_USDT:quote(101.2,now)},contracts:{BTC_USDT:meta},
    entrySymbols:["BTC_USDT"],allowDataCycle:false}).state;
  assert.equal(state.positions.length,1);
  const t=state.positions[0]!;
  assert.equal(t.entryContext?.version,"anchor-flow-entry-v1");
  assert.equal(t.entryContext?.regionKind,"MIGRATION");
  assert.equal(t.turn?.timeframe,"15m");
  assert.equal(t.stopPrice,100.6);
  assert.equal(t.rule.authority,"MULTI_TURN");
  assert.equal(t.rule.grammar,ANCHOR_FLOW_VERSION);
  assert.ok(t.leverage>=6&&t.leverage<=MULTI_TURN_TARGET_LEVERAGE);
  assert.ok(Math.abs(t.margin-t.notional/t.leverage)<1e-9);
  assert.ok(t.notional<=600.01);
  const exact=(t.entryPrice-t.stopPrice)/t.entryPrice;
  assert.ok(Math.abs(t.rule.stopRate-exact)<1e-12);
  assert.equal(state.entryOpportunities?.length??0,0);
});

test("cold reconstruction can restore an old region but cannot backfill an already happened entry",()=>{
  const p=regionPath(),zNow=(p.at(-1)!.time+300)*1000+1;
  const rows=[...p];let prev=rows.at(-1)!.close;
  for(const close of[101.0,101.4,101.7]){
    const i=rows.length;rows.push({time:prev?rows.at(-1)!.time+300:p.at(-1)!.time+300,open:prev,high:Math.max(prev,close)*1.001,
      low:Math.min(prev,close)*.999,close,volume:2000+i});prev=close;
  }
  const now=(rows.at(-1)!.time+300)*1000+1;
  const state=advanceForward({state:initialMultiTurnForward(zNow-1000),now,paths:{BTC_USDT:rows},
    quotes:{BTC_USDT:quote(rows.at(-1)!.close,now)},contracts:{BTC_USDT:meta},entrySymbols:["BTC_USDT"]}).state;
  assert.ok(state.regionLifecycles?.BTC_USDT?.zone);
  assert.equal(state.positions.length,0);
  assert.equal(state.regionSignals?.length??0,0,"restored historical boundary events are state only, never catch-up orders");
});

test("a rejection trade can close at region center immediately without a minimum holding-age embargo",()=>{
  const now=BASE+7*60*60_000,s=seeded(["ETH_USDT"],now);
  s.regionSignals=[signal("ETH_USDT",now,{kind:"REJECTION",side:"SHORT",boundary:"UPPER",signalPrice:100.65,stopPrice:101.5,targetPrice:100,
    reason:"fixture rejection"})];
  s.regionLifecycles!.ETH_USDT=lifecycle("ETH_USDT",now,"IN_REGION");
  let state=advanceForward({state:s,now,paths:{},quotes:{ETH_USDT:quote(100.6,now)},contracts:{ETH_USDT:meta},
    entrySymbols:["ETH_USDT"],allowDataCycle:false}).state;
  assert.equal(state.positions.length,1);
  const later=now+1_000;
  state=advanceForward({state,now:later,paths:{},quotes:{ETH_USDT:quote(99.95,later)},contracts:{ETH_USDT:meta},
    entrySymbols:["ETH_USDT"],allowDataCycle:false}).state;
  assert.equal(state.positions.length,0);
  assert.equal(state.history[0]?.exitAudit?.trigger,"MULTI_TURN");
  assert.match(state.history[0]?.exitReason??"",/区域中心/);
});

test("profitable AnchorFlow trade uses the proven monotonic Multi-Turn profit floor",()=>{
  const now=BASE+8*60*60_000,s=seeded(["SOL_USDT"],now);
  let state=advanceForward({state:s,now,paths:{},quotes:{SOL_USDT:quote(101.2,now)},contracts:{SOL_USDT:meta},
    entrySymbols:["SOL_USDT"],allowDataCycle:false}).state;
  assert.equal(state.positions.length,1);
  state.positions[0]!.favorable=.08;
  const later=now+1_000,mid=state.positions[0]!.entryPrice*1.01;
  state=advanceForward({state,now:later,paths:{},quotes:{SOL_USDT:quote(mid,later)},contracts:{SOL_USDT:meta},
    entrySymbols:["SOL_USDT"],allowDataCycle:false}).state;
  assert.equal(state.positions.length,0);
  assert.equal(state.history[0]?.exitAudit?.trigger,"PROFIT_GIVEBACK");
  assert.match(state.history[0]?.exitReason??"",/利润.*保护/);
});

test("AnchorFlow structural defense is the retest invalidation and is never widened",()=>{
  const now=BASE+9*60*60_000,s=seeded(["AAVE_USDT"],now);
  let state=advanceForward({state:s,now,paths:{},quotes:{AAVE_USDT:quote(101.2,now)},contracts:{AAVE_USDT:meta},
    entrySymbols:["AAVE_USDT"],allowDataCycle:false}).state;
  assert.equal(state.positions.length,1);
  const initialStop=state.positions[0]!.stopPrice,hitAt=now+1_000;
  state=advanceForward({state,now:hitAt,paths:{},quotes:{AAVE_USDT:quote(initialStop*.999,hitAt)},contracts:{AAVE_USDT:meta},
    entrySymbols:["AAVE_USDT"],allowDataCycle:false}).state;
  assert.equal(state.positions.length,0);
  assert.equal(state.history[0]?.stopPrice,initialStop);
  assert.equal(state.history[0]?.exitAudit?.trigger,"HARD_STOP");
});

test("AnchorFlow entries obey the rebuilt portfolio, directional, trade-risk and notional caps",()=>{
  const now=BASE+10*60*60_000,symbols=Array.from({length:12},(_,i)=>`S${i}_USDT`),s=seeded(symbols,now);
  const quotes=Object.fromEntries(symbols.map(x=>[x,quote(101.2,now)])),contracts=Object.fromEntries(symbols.map(x=>[x,meta]));
  const state=advanceForward({state:s,now,paths:{},quotes,contracts,entrySymbols:symbols,allowDataCycle:false}).state;
  const eq=forwardEquity(state,quotes,now).equity,total=state.positions.reduce((n,t)=>n+t.plannedRisk,0);
  assert.ok(total<=eq*.04+1e-8);
  assert.ok(state.positions.filter(t=>t.side==="LONG").reduce((n,t)=>n+t.plannedRisk,0)<=eq*.03+1e-8);
  assert.ok(state.positions.every(t=>t.plannedRisk<=eq*.008+1e-8));
  assert.ok(state.positions.every(t=>t.notional<=600.01));
  assert.ok(state.positions.every(t=>t.turn?.timeframe==="15m"));
});

test("wall-clock time cannot consume a new data slot before a genuinely new completed 5m candle exists",()=>{
  const p=regionPath(),now=(p.at(-1)!.time+300)*1000+1;
  let s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},
    quotes:{BTC_USDT:quote(p.at(-1)!.close,now)},contracts:{BTC_USDT:meta},entrySymbols:["BTC_USDT"]}).state;
  const firstCycle=s.lastCycleAt,later=now+BAR_MS+90_000;
  s=advanceForward({state:s,now:later,paths:{BTC_USDT:p},quotes:{BTC_USDT:quote(p.at(-1)!.close,later)},contracts:{BTC_USDT:meta},
    entrySymbols:["BTC_USDT"]}).state;
  assert.equal(s.lastCycleAt,firstCycle);
  const last=p.at(-1)!,fresh=[...p,{time:last.time+300,open:last.close,high:last.close*1.002,low:last.close*.999,close:last.close*1.001,volume:last.volume+1}];
  const at=later+10_000;
  s=advanceForward({state:s,now:at,paths:{BTC_USDT:fresh},quotes:{BTC_USDT:quote(fresh.at(-1)!.close,at)},contracts:{BTC_USDT:meta},
    entrySymbols:["BTC_USDT"]}).state;
  assert.equal(s.lastCycleAt,at);
});

test("critical quote management can mark equity without consuming stale strategy data",()=>{
  const p=regionPath(),now=(p.at(-1)!.time+300)*1000+1;
  const s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},
    quotes:{BTC_USDT:quote(p.at(-1)!.close,now)},contracts:{BTC_USDT:meta},entrySymbols:["BTC_USDT"]}).state;
  const cycle=s.lastCycleAt,mark=s.daily.at(-1)!.lastAt,later=now+BAR_MS+150_000;
  const next=advanceForward({state:s,now:later,paths:{BTC_USDT:p},quotes:{BTC_USDT:quote(p.at(-1)!.close,later)},
    contracts:{BTC_USDT:meta},entrySymbols:["BTC_USDT"],allowDataCycle:false});
  assert.equal(next.state.lastCycleAt,cycle);assert.ok(next.state.daily.at(-1)!.lastAt>mark);
});

test("only active scan symbols and open positions can occupy scarce realtime watch slots",()=>{
  const now=BASE+11*60*60_000,s=seeded(["BTC_USDT","OLD_USDT"],now);
  const watched=forwardWatchSymbols(s,now,["BTC_USDT"]);
  assert.equal(watched.includes("BTC_USDT"),true);
  assert.equal(watched.includes("OLD_USDT"),false);
});

test("runtime summary exposes AnchorFlow as execution authority while retaining region location state",()=>{
  const now=BASE+12*60*60_000,s=seeded(["BTC_USDT"],now);
  const summary=forwardSummary(s,{BTC_USDT:quote(101.2,now)},now);
  assert.equal(summary.grammar,ANCHOR_FLOW_VERSION);
  assert.equal(summary.executionVersion,ANCHOR_FLOW_VERSION);
  assert.equal(summary.regionVersion,REGION_LIFECYCLE_VERSION);
  assert.ok(summary.regionLifecycles.length>=1);
  assert.equal(summary.entryOpportunities.length,0);
  assert.match(summary.boundaries.grammar,/AnchorFlow/);
});

test("old Forward account and a fresh AnchorFlow PAPER head still commit atomically with the old archive retained",async()=>{
  class Memory{data=new Map<string,unknown>();async get<T>(k:string){return structuredClone(this.data.get(k)) as T|undefined;}
    async put(v:Record<string,unknown>){for(const[k,x]of Object.entries(v))this.data.set(k,structuredClone(x));}}
  const db=new Memory(),old=initialForward(BASE);old.balance=895;old.peakEquity=1020;old.maxDrawdown=.2;old.storage={persistedAt:BASE,error:null};
  const seededWrite=await prepareForwardWrite(null,old,BASE,{compact:true});await db.put(seededWrite.entries);
  const closed=structuredClone(old);closed.positions=[];closed.balance=895;
  const fresh=initialMultiTurnForward(BASE+1000);
  const reset=await prepareForwardReset(old,closed,fresh,BASE+2000);await db.put(reset.entries);
  const restored=await readForwardStore(db,BASE+3000);
  assert.equal(restored.strategyAuthorityVersion,MULTI_TURN_VERSION);
  assert.equal(restored.regionVersion,REGION_LIFECYCLE_VERSION);
  assert.equal(restored.executionVersion,ANCHOR_FLOW_VERSION);
  assert.equal(restored.initialEquity,1000);assert.equal(restored.balance,1000);
  assert.ok([...db.data.keys()].some(k=>k.startsWith(`${FORWARD_STORAGE}archive:`)));
  assert.ok(db.data.has(FORWARD_PROTECTION_STORAGE));
});

test("turn diagnostics may remain causal research data but cannot create new orders",()=>{
  const p=regionPath(),now=(p.at(-1)!.time+300)*1000+1;
  const e=evaluateMultiTurn({state:initialMultiTurn(),paths:{BTC_USDT:p},now});
  assert.ok(TURN_TIMEFRAMES.every(tf=>e.calibration[tf].count===0));
  const state=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},
    quotes:{BTC_USDT:quote(p.at(-1)!.close,now)},contracts:{BTC_USDT:meta},entrySymbols:["BTC_USDT"]}).state;
  assert.equal(state.positions.length,0,"turn diagnostics alone have no entry authority");
});

test("6-12x isolated leverage tiers remain below liquidation pressure and respect exchange limits",()=>{
  assert.equal(multiTurnEntryLeverage(.01,.005,.0022,50),12);
  assert.equal(multiTurnEntryLeverage(.02,.005,.0022,50),10);
  const wide=multiTurnEntryLeverage(.05,.005,.0022,50);
  assert.equal(wide,6);assert.ok(1/wide>.05+.005+.0022);
  assert.equal(multiTurnEntryLeverage(.02,.005,.0022,8),8);
  assert.equal(multiTurnEntryLeverage(.02,.005,.0022,5),0);
});
