import test from "node:test";
import assert from "node:assert/strict";
import { advanceForward, BAR_MS, forwardSummary, forwardWatchSymbols, initialForward, initialMultiTurnForward,
  multiTurnEntryLeverage, type Candle, type Contract, type Quote } from "../lib/forward-relations.ts";
import { MULTI_TURN_VERSION, TURN_TIMEFRAMES, evaluateMultiTurn, initialMultiTurn } from "../lib/multi-turn-engine.ts";
import { REGION_LIFECYCLE_VERSION, type RegionEntrySignal, type RegionLifecycleState } from "../lib/region-lifecycle.ts";
import { ANCHOR_FLOW_VERSION, type AnchorFlowState } from "../lib/anchor-flow.ts";
import { REGION_LAUNCH_VERSION } from "../lib/region-launch.ts";
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

const lifecycle=(symbol:string,now:number):RegionLifecycleState=>({
  version:REGION_LIFECYCLE_VERSION,symbol,initializedAt:now-60_000,observedAt:now,lastProcessedAt:now,
  zone:{id:`rg-${symbol}`,symbol,startAt:now-3_600_000,endAt:now-600_000,confirmedAt:now-600_000,bars:24,
    lower:99,upper:101,center:100,width:2,widthRate:.02,touchesUpper:5,touchesLower:5,crossings:8},
  status:"IN_REGION",probeStartedAt:null,probeExtreme:null,acceptedAt:null,detachedAt:null,
  upperConsumedAt:null,lowerConsumedAt:null,reason:"fixture",
});

const retiredAnchor=(symbol:string,now:number):AnchorFlowState=>({
  version:ANCHOR_FLOW_VERSION,symbol,regionId:`rg-${symbol}`,side:"LONG",boundary:"UPPER",phase:"READY",
  createdAt:now-10*60_000,expiresAt:now+50*60_000,lastProcessedAt:now-1_000,breakoutCompletedAt:now-10*60_000,
  regionConfirmedAt:now-600_000,regionLower:99,regionUpper:101,regionCenter:100,regionWidth:2,regionWidthRate:.02,
  excursionExtreme:102,retestAt:now-300_000,pullbackExtreme:100.7,restartLevel:101.1,readyAt:now-1_000,reacceptBars:0,
  retryCount:0,confirmationExtreme:101.05,firedAt:now-1_000,consumedAt:null,failedAt:null,reason:"retired fixture",
});

const retiredAnchorSignal=(symbol:string,now:number):RegionEntrySignal&{entryModel:"ANCHOR_FLOW"}=>({
  version:REGION_LIFECYCLE_VERSION,id:`af-${symbol}-retired`,symbol,kind:"MIGRATION",side:"LONG",boundary:"UPPER",
  completedAt:now-1_000,expiresAt:now+600_000,signalPrice:101.2,stopPrice:100.6,targetPrice:null,
  regionId:`rg-${symbol}`,regionConfirmedAt:now-600_000,regionLower:99,regionUpper:101,regionCenter:100,
  regionWidth:2,regionWidthRate:.02,reason:"retired AnchorFlow fixture",entryModel:"ANCHOR_FLOW",
});

test("retired AnchorFlow and REJECTION events cannot create new positions",()=>{
  const now=BASE+5*60*60_000,s=initialMultiTurnForward(now-60_000);
  s.lastCycleAt=now;s.lastQuoteCycleAt=0;s.regionLifecycles={BTC_USDT:lifecycle("BTC_USDT",now)};
  s.anchorFlows={BTC_USDT:retiredAnchor("BTC_USDT",now)};
  s.regionSignals=[retiredAnchorSignal("BTC_USDT",now),{
    version:REGION_LIFECYCLE_VERSION,id:"reject-retired",symbol:"BTC_USDT",kind:"REJECTION",side:"SHORT",boundary:"UPPER",
    completedAt:now-1_000,expiresAt:now+600_000,signalPrice:100.6,stopPrice:101.1,targetPrice:100,
    regionId:"rg-BTC_USDT",regionConfirmedAt:now-600_000,regionLower:99,regionUpper:101,regionCenter:100,
    regionWidth:2,regionWidthRate:.02,reason:"retired rejection fixture",
  }];
  const next=advanceForward({state:s,now,paths:{},quotes:{BTC_USDT:quote(101.2,now)},contracts:{BTC_USDT:meta},
    entrySymbols:["BTC_USDT"],allowDataCycle:false}).state;
  assert.equal(next.positions.length,0);
  assert.equal(next.regionSignals?.length,0);
  assert.deepEqual(next.anchorFlows,s.anchorFlows,"retired state may remain readable until the next completed data cycle, but it has no order authority");
});

test("a completed data cycle clears retired entry state while keeping region location",()=>{
  const p=regionPath(),now=(p.at(-1)!.time+300)*1000+1,s=initialMultiTurnForward(now-1_000);
  s.anchorFlows={BTC_USDT:retiredAnchor("BTC_USDT",now)};
  s.regionSignals=[retiredAnchorSignal("BTC_USDT",now)];
  const next=advanceForward({state:s,now,paths:{BTC_USDT:p},quotes:{BTC_USDT:quote(p.at(-1)!.close,now)},
    contracts:{BTC_USDT:meta},entrySymbols:["BTC_USDT"]}).state;
  assert.equal(next.positions.length,0);
  assert.equal(Object.keys(next.anchorFlows??{}).length,0);
  assert.equal(next.regionSignals?.length,0);
  assert.ok(next.regionLifecycles?.BTC_USDT?.zone);
});

test("wall-clock time cannot consume a new data slot before a genuinely new completed 5m candle exists",()=>{
  const p=regionPath(),now=(p.at(-1)!.time+300)*1000+1;
  let s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},
    quotes:{BTC_USDT:quote(p.at(-1)!.close,now)},contracts:{BTC_USDT:meta},entrySymbols:["BTC_USDT"]}).state;
  const firstCycle=s.lastCycleAt,later=now+BAR_MS+90_000;
  s=advanceForward({state:s,now:later,paths:{BTC_USDT:p},quotes:{BTC_USDT:quote(p.at(-1)!.close,later)},contracts:{BTC_USDT:meta},
    entrySymbols:["BTC_USDT"]}).state;
  assert.equal(s.lastCycleAt,firstCycle);
  const last=p.at(-1)!,fresh=[...p,{time:last.time+300,open:last.close,high:last.close*1.002,low:last.close*.999,
    close:last.close*1.001,volume:last.volume+1}];
  const at=later+10_000;
  s=advanceForward({state:s,now:at,paths:{BTC_USDT:fresh},quotes:{BTC_USDT:quote(fresh.at(-1)!.close,at)},
    contracts:{BTC_USDT:meta},entrySymbols:["BTC_USDT"]}).state;
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

test("retired AnchorFlow state cannot occupy a scarce realtime watch slot",()=>{
  const now=BASE+11*60*60_000,s=initialMultiTurnForward(now-60_000);
  s.regionLifecycles={BTC_USDT:lifecycle("BTC_USDT",now)};
  s.anchorFlows={OLD_USDT:retiredAnchor("OLD_USDT",now)};
  const watched=forwardWatchSymbols(s,now,["BTC_USDT","OLD_USDT"]);
  assert.ok(watched.includes("BTC_USDT"));
  assert.equal(watched.includes("OLD_USDT"),false);
});

test("only active scan symbols and open positions can occupy scarce realtime watch slots",()=>{
  const now=BASE+11*60*60_000,s=initialMultiTurnForward(now-60_000);
  s.regionLifecycles={BTC_USDT:lifecycle("BTC_USDT",now),OLD_USDT:lifecycle("OLD_USDT",now)};
  const watched=forwardWatchSymbols(s,now,["BTC_USDT"]);
  assert.equal(watched.includes("BTC_USDT"),true);
  assert.equal(watched.includes("OLD_USDT"),false);
});

test("runtime summary exposes RegionLaunch as the sole current execution grammar",()=>{
  const now=BASE+12*60*60_000,s=initialMultiTurnForward(now-60_000);
  s.regionLifecycles={BTC_USDT:lifecycle("BTC_USDT",now)};
  s.anchorFlows={BTC_USDT:retiredAnchor("BTC_USDT",now)};
  s.regionSignals=[retiredAnchorSignal("BTC_USDT",now)];
  const summary=forwardSummary(s,{BTC_USDT:quote(101.2,now)},now);
  assert.equal(summary.grammar,REGION_LAUNCH_VERSION);
  assert.equal(summary.regionLaunchVersion,REGION_LAUNCH_VERSION);
  assert.equal(summary.regionVersion,REGION_LIFECYCLE_VERSION);
  assert.equal(summary.anchorFlows.length,0);assert.equal(summary.regionSignals.length,0);
  assert.match(summary.boundaries.grammar,/单一执行通道|完整边界/);
});

test("old Forward account and a fresh RegionLaunch PAPER head still commit atomically with the old archive retained",async()=>{
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
  assert.equal(restored.regionLaunchVersion,REGION_LAUNCH_VERSION);
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
