import test from "node:test";
import assert from "node:assert/strict";
import { advanceForward, forwardEquity, initialForward, initialMultiTurnForward, type Candle, type Contract, type Quote } from "../lib/forward-relations.ts";
import { MULTI_TURN_VERSION, TURN_CONFIG, TURN_TIMEFRAMES, evaluateMultiTurn, initialMultiTurn } from "../lib/multi-turn-engine.ts";
import { FORWARD_PROTECTION_STORAGE, FORWARD_STORAGE, prepareForwardReset, prepareForwardWrite, readForwardStore } from "../lib/forward-store.ts";

const BASE=Date.parse("2026-09-21T00:00:00Z");
const candles=(count=360,slope=.0008):Candle[]=>Array.from({length:count},(_,i)=>{
  const close=100*Math.exp(i*slope),open=close/(1+slope);
  return{time:BASE/1000+i*300,open,high:Math.max(open,close)*1.001,low:Math.min(open,close)*.999,close,volume:1000+i};
});
const q=(rows:Candle[],at:number):Quote=>{const mid=rows.at(-1)!.close;return{bestBid:mid*.9999,bestAsk:mid*1.0001,observedAt:at,fresh:true,entryReady:true};};
const meta:Contract={quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1};

test("Multi-Turn opens at most one executable leg per symbol while every timeframe keeps an independent state",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000,s=initialMultiTurnForward(now-1000);
  const result=advanceForward({state:s,now,paths:{BTC_USDT:p},quotes:{BTC_USDT:q(p,now)},contracts:{BTC_USDT:meta}}).state;
  assert.equal(result.strategyAuthorityVersion,MULTI_TURN_VERSION);
  assert.ok(Object.keys(result.turnEngine!.frames.BTC_USDT??{}).length>=4);
  assert.ok(result.positions.length<=1);
  if(result.positions.length){assert.equal(result.positions[0].rule.authority,"MULTI_TURN");assert.ok(result.positions[0].turn);}
});

test("timeframe sleeves, directional cap and portfolio cap remain authoritative with many simultaneous markets",()=>{
  const paths:Record<string,Candle[]>={},quotes:Record<string,Quote>={},contracts:Record<string,Contract>={};
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000;
  for(let i=0;i<12;i++){const symbol=`S${i}_USDT`;paths[symbol]=p;quotes[symbol]=q(p,now);contracts[symbol]=meta;}
  const s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths,quotes,contracts}).state;
  const eq=forwardEquity(s,quotes,now).equity,total=s.positions.reduce((n,t)=>n+t.plannedRisk,0);
  assert.ok(total<=eq*.10+1e-8);
  for(const side of["LONG","SHORT"] as const)assert.ok(s.positions.filter(t=>t.side===side).reduce((n,t)=>n+t.plannedRisk,0)<=eq*.065+1e-8);
  for(const tf of TURN_TIMEFRAMES)assert.ok(s.positions.filter(t=>t.turn?.timeframe===tf).reduce((n,t)=>n+t.plannedRisk,0)<=eq*TURN_CONFIG[tf].riskCap+1e-8);
  assert.ok(s.positions.every(t=>t.plannedRisk<=eq*.015+1e-8));
});

test("a confirmed 5m turn cannot close a 1h-owned position",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000,quotes={BTC_USDT:q(p,now)};
  let s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},quotes,contracts:{BTC_USDT:meta}}).state;
  assert.ok(s.positions.length);
  const t=s.positions[0];t.turn={version:MULTI_TURN_VERSION,timeframe:"1h",signalAt:now-60_000,entryTurnProbability:.1,entryContinuation:.8,entryDirectionConfidence:.8};
  t.rule.authority="MULTI_TURN";t.rule.turnTimeframe="1h";t.rule.horizon=TURN_CONFIG["1h"].maxHoldMinutes;
  const h=s.turnEngine!.frames.BTC_USDT!["1h"]!,m5=s.turnEngine!.frames.BTC_USDT!["5m"]!;
  h.direction=t.side;h.phase="FLOW";h.lastTurnAt=null;
  m5.direction=t.side==="LONG"?"SHORT":"LONG";m5.phase="CONFIRMED";m5.lastTurnAt=now+1;m5.justTurned=true;
  s.lastCycleAt=now;
  const later=now+1000,qq={BTC_USDT:{...quotes.BTC_USDT,observedAt:later}};
  s=advanceForward({state:s,now:later,paths:{BTC_USDT:p},quotes:qq,contracts:{BTC_USDT:meta}}).state;
  assert.equal(s.positions.length,1);
});

test("a materially profitable Multi-Turn position cannot normally give back through zero",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000,quotes={BTC_USDT:q(p,now)};
  let s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},quotes,contracts:{BTC_USDT:meta}}).state;
  assert.ok(s.positions.length);
  const t=s.positions[0];
  t.favorable=.08;
  const mid=t.entryPrice*(t.side==="LONG"?1.04:.96),later=now+1000;
  const protectedQuote={bestBid:mid*.9999,bestAsk:mid*1.0001,observedAt:later,fresh:true,entryReady:true};
  const frame=s.turnEngine!.frames.BTC_USDT![t.turn!.timeframe]!;
  frame.direction=t.side;frame.phase="FLOW";frame.lastTurnAt=null;frame.justTurned=false;
  s.lastCycleAt=now;
  s=advanceForward({state:s,now:later,paths:{BTC_USDT:p},quotes:{BTC_USDT:protectedQuote},contracts:{BTC_USDT:meta}}).state;
  assert.equal(s.positions.length,0);
  assert.match(s.history[0].exitReason??"",/利润保护/);
  assert.equal(s.history[0].exitAudit?.trigger,"PROFIT_GIVEBACK");
  assert.ok((s.history[0].netPnl??0)>0);
});

test("the owning timeframe confirmed turn exits its own position without waiting for a fixed horizon",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000,quotes={BTC_USDT:q(p,now)};
  let s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},quotes,contracts:{BTC_USDT:meta}}).state;
  assert.ok(s.positions.length);
  const t=s.positions[0],tf="1h" as const;
  t.turn={version:MULTI_TURN_VERSION,timeframe:tf,signalAt:now-60_000,entryTurnProbability:.1,entryContinuation:.8,entryDirectionConfidence:.8};
  t.rule.authority="MULTI_TURN";t.rule.turnTimeframe=tf;t.rule.horizon=TURN_CONFIG[tf].maxHoldMinutes;
  const frame=s.turnEngine!.frames.BTC_USDT![tf]!;
  frame.direction=t.side==="LONG"?"SHORT":"LONG";frame.phase="CONFIRMED";frame.lastTurnAt=now+1;frame.justTurned=true;
  s.lastCycleAt=now;
  const later=now+1000,qq={BTC_USDT:{...quotes.BTC_USDT,observedAt:later}};
  s=advanceForward({state:s,now:later,paths:{BTC_USDT:p},quotes:qq,contracts:{BTC_USDT:meta}}).state;
  assert.equal(s.positions.length,0);assert.ok(s.history[0].exitReason?.includes("1h已确认转向"));
  assert.equal(s.history[0].exitAudit?.trigger,"MULTI_TURN");
});

test("old Forward account and new 1000U Multi-Turn head are committed atomically with the old final archive retained",async()=>{
  class Memory{data=new Map<string,unknown>();async get<T>(k:string){return structuredClone(this.data.get(k)) as T|undefined;}
    async put(v:Record<string,unknown>){for(const[k,x]of Object.entries(v))this.data.set(k,structuredClone(x));}}
  const db=new Memory(),old=initialForward(BASE);old.balance=895;old.peakEquity=1020;old.maxDrawdown=.2;old.storage={persistedAt:BASE,error:null};
  const seeded=await prepareForwardWrite(null,old,BASE,{compact:true});await db.put(seeded.entries);
  const closed=structuredClone(old);closed.positions=[];closed.balance=895;
  const fresh=initialMultiTurnForward(BASE+1000);
  const reset=await prepareForwardReset(old,closed,fresh,BASE+2000);await db.put(reset.entries);
  const restored=await readForwardStore(db,BASE+3000);
  assert.equal(restored.strategyAuthorityVersion,MULTI_TURN_VERSION);assert.equal(restored.initialEquity,1000);assert.equal(restored.balance,1000);
  assert.equal(restored.positions.length,0);assert.equal(restored.history.length,0);assert.ok(restored.turnEngine);
  assert.ok([...db.data.keys()].some(k=>k.startsWith(`${FORWARD_STORAGE}archive:`)));
  assert.ok(db.data.has(FORWARD_PROTECTION_STORAGE));
});

test("turn probability calibration is causal and never imports future labels into a fresh account",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000;
  const e=evaluateMultiTurn({state:initialMultiTurn(),paths:{BTC_USDT:p},now});
  assert.ok(e.pending.length>0);assert.ok(TURN_TIMEFRAMES.every(tf=>e.calibration[tf].count===0));
});
