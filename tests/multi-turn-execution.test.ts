import test from "node:test";
import assert from "node:assert/strict";
import { advanceForward, forwardEquity, forwardWatchSymbols, initialForward, initialMultiTurnForward, multiTurnEntryLeverage, MULTI_TURN_TARGET_LEVERAGE, turnModeledCost, type Candle, type Contract, type Quote } from "../lib/forward-relations.ts";
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

test("an observed winner exits at its protected profit floor without waiting for a full turn",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000,quotes={BTC_USDT:q(p,now)};
  let s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},quotes,contracts:{BTC_USDT:meta}}).state;
  assert.ok(s.positions.length);
  const t=s.positions[0],riskRate=t.plannedRisk/t.notional;
  t.favorable=riskRate*3.2;
  const frame=s.turnEngine!.frames.BTC_USDT![t.turn!.timeframe]!;
  frame.direction=t.side;frame.rawDirection=t.side;frame.phase="FLOW";frame.lastTurnAt=null;frame.justTurned=false;
  s.lastCycleAt=now;
  const ret=riskRate*.5,px=t.entryPrice*(t.side==="LONG"?1+ret:1-ret),later=now+1000;
  s=advanceForward({state:s,now:later,paths:{BTC_USDT:p},
    quotes:{BTC_USDT:{bestBid:px*.99999,bestAsk:px*1.00001,observedAt:later,fresh:true,entryReady:true}},contracts:{BTC_USDT:meta}}).state;
  assert.equal(s.positions.length,0);
  assert.equal(s.history[0].exitAudit?.trigger,"PROFIT_GIVEBACK");
  assert.ok(s.history[0].netPnl!>0);
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


test("only the current scan universe can create or occupy new Multi-Turn entry slots",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000;
  const paths={BTC_USDT:p,OLD_USDT:p},quotes={BTC_USDT:q(p,now),OLD_USDT:q(p,now)};
  const contracts={BTC_USDT:meta,OLD_USDT:meta};
  const s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths,quotes,contracts,
    entrySymbols:["BTC_USDT"]}).state;
  assert.ok(s.turnEngine?.frames.BTC_USDT);
  assert.equal(s.turnEngine?.frames.OLD_USDT,undefined,
    "a retired scan symbol cannot be rebuilt from a stale retained path");
  assert.ok(s.positions.every(position=>position.symbol==="BTC_USDT"));

  s.turnEngine!.frames.OLD_USDT=structuredClone(s.turnEngine!.frames.BTC_USDT);
  const watched=forwardWatchSymbols(s,now,["BTC_USDT"]);
  assert.equal(watched.includes("OLD_USDT"),false,
    "an old frame cannot steal realtime entry capacity after leaving the active scan universe");
});


test("Multi-Turn entries use the exact 20x-or-lower safe leverage and derive margin from notional",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000,quote=q(p,now);
  const result=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},
    quotes:{BTC_USDT:quote},contracts:{BTC_USDT:meta}}).state;
  assert.ok(result.positions.length);
  const t=result.positions[0],mid=(quote.bestBid+quote.bestAsk)/2,spread=(quote.bestAsk-quote.bestBid)/mid;
  const expected=multiTurnEntryLeverage(t.rule.stopRate,meta.maintenanceRate,turnModeledCost(t.turn!.timeframe,spread),meta.leverageMax);
  assert.equal(t.leverage,expected);
  assert.ok(t.leverage<=MULTI_TURN_TARGET_LEVERAGE);
  assert.ok(Math.abs(t.margin-t.notional/t.leverage)<1e-9);
});

test("20x is a target, never an excuse to place the structural stop inside unsafe margin",()=>{
  assert.equal(multiTurnEntryLeverage(.02,.005,.0022,50),20);
  const wide=multiTurnEntryLeverage(.08,.005,.0022,50);
  assert.ok(wide<20);
  assert.ok(1/wide>.08+.005+.0022);
  assert.equal(multiTurnEntryLeverage(.02,.005,.0022,10),10);
});

test("time-space hold value can exit an old position before the legacy maximum lifetime",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000,quotes={BTC_USDT:q(p,now)};
  let s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},quotes,contracts:{BTC_USDT:meta}}).state;
  assert.ok(s.positions.length);
  const t=s.positions[0],tf="1h" as const;
  t.turn={version:MULTI_TURN_VERSION,timeframe:tf,signalAt:now-60_000,entryTurnProbability:.1,entryContinuation:.8,entryDirectionConfidence:.8};
  t.rule.authority="MULTI_TURN";t.rule.turnTimeframe=tf;t.rule.horizon=TURN_CONFIG[tf].maxHoldMinutes;
  t.openedAt=now-8*60*60_000;
  const frame=s.turnEngine!.frames.BTC_USDT![tf]!;
  frame.direction=t.side;frame.rawDirection=t.side;frame.phase="WATCH";frame.directionConfidence=.35;
  frame.continuationScore=.25;frame.triggerProbability=.65;frame.expectedMoveRate=.012;frame.atrRate=.012;
  frame.propagationPressure=.55;frame.evidence.structure=.70;frame.evidence.changePoint=.60;frame.evidence.cusum=.60;
  frame.completedAt=now;frame.lastTurnAt=null;s.lastCycleAt=now;
  const mid=t.entryPrice*(t.side==="LONG"?1.012:.988),later=now+1000;
  s=advanceForward({state:s,now:later,paths:{BTC_USDT:p},
    quotes:{BTC_USDT:{bestBid:mid*.9999,bestAsk:mid*1.0001,observedAt:later,fresh:true,entryReady:true}},contracts:{BTC_USDT:meta}}).state;
  assert.equal(s.positions.length,0);
  assert.equal(s.history[0].exitAudit?.trigger,"HOLD_VALUE");
  assert.match(s.history[0].exitReason??"",/时间—空间持仓价值退出/);
});


test("stale owning-frame data cannot leave a four-hour no-progress holding occupying risk indefinitely",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000;
  let s=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},
    quotes:{BTC_USDT:q(p,now)},contracts:{BTC_USDT:meta}}).state;
  assert.ok(s.positions.length);
  const t=s.positions[0];
  t.turn={version:MULTI_TURN_VERSION,timeframe:"4h",signalAt:now-25*60*60_000,
    entryTurnProbability:.1,entryContinuation:.7,entryDirectionConfidence:.7};
  t.rule.authority="MULTI_TURN";t.rule.turnTimeframe="4h";t.rule.horizon=TURN_CONFIG["4h"].maxHoldMinutes;
  t.openedAt=now-25*60*60_000;t.favorable=.003;
  if(t.entryContext){t.entryContext.timeframe="4h";t.entryContext.expectedMoveRate=.08;t.entryContext.bestHoldMinutes=1440;}
  delete s.turnEngine!.frames.BTC_USDT?.["4h"];
  s.lastCycleAt=now;
  const ret=-.006,px=t.entryPrice*(t.side==="LONG"?1+ret:1-ret),later=now+1000;
  s=advanceForward({state:s,now:later,paths:{},
    quotes:{BTC_USDT:{bestBid:px*.99999,bestAsk:px*1.00001,observedAt:later,fresh:true,entryReady:true}},contracts:{}}).state;
  assert.equal(s.positions.length,0);
  assert.equal(s.history[0].exitAudit?.trigger,"HOLD_VALUE");
  assert.match(s.history[0].exitReason??"",/释放长期无进展仓位/);
});

test("new Multi-Turn trades persist the exact entry context used for later research review",()=>{
  const p=candles(),now=(p.at(-1)!.time+300)*1000+1000;
  const state=advanceForward({state:initialMultiTurnForward(now-1000),now,paths:{BTC_USDT:p},
    quotes:{BTC_USDT:q(p,now)},contracts:{BTC_USDT:meta}}).state;
  assert.ok(state.positions.length);
  const trade=state.positions[0],ctx=trade.entryContext;
  assert.ok(ctx);
  assert.equal(ctx.version,"multi-turn-entry-context-v1");
  assert.equal(ctx.capturedAt,trade.openedAt);
  assert.equal(ctx.timeframe,trade.turn!.timeframe);
  assert.equal(ctx.side,trade.side);
  assert.equal(ctx.signalAt,trade.turn!.signalAt);
  assert.equal(ctx.directionConfidence,trade.turn!.entryDirectionConfidence);
  assert.equal(ctx.continuationScore,trade.turn!.entryContinuation);
  assert.ok(ctx.expectedMoveRate>0);
  assert.ok(ctx.modeledCostRate>0);
  assert.ok(ctx.stopRate>0);
  assert.ok(ctx.bestHoldMinutes>0&&ctx.strongExtensionMinutes>=ctx.bestHoldMinutes&&ctx.hardExtensionMinutes>=ctx.strongExtensionMinutes);
  assert.ok(ctx.timeframeStates.length>=4);
  assert.ok(ctx.timeframeStates.some(row=>row.timeframe===ctx.timeframe));
  const restored=structuredClone(state);
  assert.deepEqual(restored.positions[0].entryContext,ctx);
});


test("full-risk rotation atomically replaces one clearly weak holding and cannot churn again inside the cooldown",()=>{
  const p=candles(),seedAt=(p.at(-1)!.time+300)*1000+1000;
  const seeded=advanceForward({state:initialMultiTurnForward(seedAt-1000),now:seedAt,paths:{BTC_USDT:p},
    quotes:{BTC_USDT:q(p,seedAt)},contracts:{BTC_USDT:meta}}).state;
  assert.ok(seeded.positions.length);
  const baseTrade=seeded.positions[0],baseFrame=seeded.turnEngine!.frames.BTC_USDT![baseTrade.turn!.timeframe]!;
  const s=structuredClone(seeded),symbols=["W0_USDT","W1_USDT","W2_USDT","W3_USDT","W4_USDT"];
  const timeframes=["5m","15m","30m","4h","1h"] as const;
  s.positions=symbols.map((symbol,i)=>{
    const t=structuredClone(baseTrade),tf=timeframes[i];
    t.id=`rotation-${i}`;t.symbol=symbol;t.side="LONG";t.openedAt=seedAt-(i===0?11:5)*60_000;
    t.entryPrice=100;t.lastPrice=100;t.quantity=1;t.contracts=1000;t.quantoMultiplier=.001;t.notional=100;
    t.leverage=20;t.margin=5;t.plannedRisk=12.9;t.stopPrice=98;t.armPrice=103;t.entryFee=.07;
    t.exitFee=0;t.fundingAllowance=0;t.grossPnl=null;t.netPnl=null;t.exitReason=null;t.favorable=0;t.adverse=0;
    t.lastQuoteAt=seedAt;t.rule={...t.rule,id:`rotation-rule-${i}`,side:"LONG",authority:"MULTI_TURN",turnTimeframe:tf,
      horizon:TURN_CONFIG[tf].maxHoldMinutes,stopRate:.02};
    t.turn={version:MULTI_TURN_VERSION,timeframe:tf,signalAt:seedAt-60_000,
      entryTurnProbability:.1,entryContinuation:.8,entryDirectionConfidence:.8};
    delete t.holdValue;return t;
  });
  s.rules=s.positions.map(t=>structuredClone(t.rule));s.balance=1000-s.positions.reduce((n,t)=>n+t.entryFee,0);
  s.peakEquity=1000;s.turnLastEntryBars={};s.turnSymbolExitAt={};s.turnRotationBlockedUntil={};
  s.rotationState={version:"multi-turn-selective-risk-rotation-v1",lastAt:0,count:0,lastFrom:null,lastTo:null};
  s.turnEngine!.frames={};
  const strong=(symbol:string,tf:(typeof timeframes)[number]|"1h")=>({...structuredClone(baseFrame),symbol,timeframe:tf,
    observedAt:seedAt,completedAt:seedAt,ready:true,direction:"LONG" as const,rawDirection:"LONG" as const,
    directionConfidence:.92,continuationScore:.84,turnProbability:.08,triggerProbability:.10,phase:"FLOW" as const,
    candidateSide:"NEUTRAL" as const,candidateBars:0,justTurned:false,lastTurnAt:null,signalAgeBars:1,
    atrRate:.005,expectedMoveRate:.04,stopRate:.012,price:100,propagationPressure:.06,
    evidence:{structure:.06,momentum:.06,acceleration:.06,cusum:.06,changePoint:.06,failedExtension:.03,
      volatility:.2,volume:.2,breadth:.08,propagation:.06},reason:"strong rotation fixture"});
  for(let i=0;i<symbols.length;i++)s.turnEngine!.frames[symbols[i]]={[timeframes[i]]:strong(symbols[i],timeframes[i])};
  const weak=s.turnEngine!.frames.W0_USDT!["5m"]!;
  // Weak enough for selective replacement while still inside the short 5m
  // no-progress window; rotation remains independently testable.
  weak.directionConfidence=.48;weak.continuationScore=.38;weak.turnProbability=.60;weak.triggerProbability=.60;weak.phase="WATCH";
  weak.atrRate=.012;weak.expectedMoveRate=.012;weak.propagationPressure=.55;
  weak.evidence={structure:.70,momentum:.55,acceleration:.45,cusum:.60,changePoint:.58,failedExtension:.40,
    volatility:.4,volume:.3,breadth:.5,propagation:.55};
  s.turnEngine!.frames.NEW_USDT={["1h"]:strong("NEW_USDT","1h")};
  s.turnEngine!.updatedAt=seedAt;s.lastCycleAt=seedAt;

  const later=seedAt+1000,quotes:Record<string,Quote>={},contracts:Record<string,Contract>={};
  for(const symbol of [...symbols,"NEW_USDT"]){quotes[symbol]={bestBid:99.99,bestAsk:100.01,observedAt:later,fresh:true,entryReady:true};contracts[symbol]=meta;}
  const first=advanceForward({state:s,now:later,paths:{},quotes,contracts,entrySymbols:[...symbols,"NEW_USDT"]}).state;
  assert.equal(first.rotationState?.count,1);
  assert.equal(first.rotationState?.lastFrom,"W0_USDT");
  assert.equal(first.rotationState?.lastTo,"NEW_USDT");
  assert.equal(first.positions.some(t=>t.symbol==="W0_USDT"),false);
  assert.equal(first.positions.some(t=>t.symbol==="NEW_USDT"&&t.openedAt===later),true);
  assert.equal(first.history[0].exitAudit?.trigger,"ROTATION");
  assert.match(first.history[0].exitReason??"",/择优换仓/);
  assert.ok((first.turnRotationBlockedUntil?.W0_USDT??0)>later);

  // Refill the synthetic risk budget, weaken a second holding, and present two
  // strong candidates inside 60 minutes. Neither a second rotation nor an
  // immediate re-entry of W0 is allowed.
  const secondAt=later+30*60_000;
  for(const t of first.positions)t.plannedRisk=12.9;
  const w1=first.positions.find(t=>t.symbol==="W1_USDT")!;w1.openedAt=secondAt-31*60_000;
  const w1Frame=first.turnEngine!.frames.W1_USDT!["15m"]!;
  w1Frame.directionConfidence=.48;w1Frame.continuationScore=.38;w1Frame.turnProbability=.60;w1Frame.triggerProbability=.60;w1Frame.phase="WATCH";
  w1Frame.atrRate=.012;w1Frame.expectedMoveRate=.012;w1Frame.propagationPressure=.55;w1Frame.completedAt=secondAt-1000;
  w1Frame.evidence={structure:.70,momentum:.55,acceleration:.45,cusum:.60,changePoint:.58,failedExtension:.40,
    volatility:.4,volume:.3,breadth:.5,propagation:.55};
  first.turnEngine!.frames.W0_USDT={["5m"]:{...strong("W0_USDT","5m"),completedAt:secondAt-1000,observedAt:secondAt}};
  first.turnEngine!.frames.NEW2_USDT={["1h"]:{...strong("NEW2_USDT","1h"),completedAt:secondAt-1000,observedAt:secondAt}};
  first.turnEngine!.updatedAt=secondAt;first.lastCycleAt=secondAt;
  quotes.W0_USDT={bestBid:99.99,bestAsk:100.01,observedAt:secondAt,fresh:true,entryReady:true};
  quotes.NEW2_USDT={bestBid:99.99,bestAsk:100.01,observedAt:secondAt,fresh:true,entryReady:true};
  contracts.W0_USDT=meta;contracts.NEW2_USDT=meta;
  for(const symbol of Object.keys(quotes))quotes[symbol]={...quotes[symbol],observedAt:secondAt};
  const second=advanceForward({state:first,now:secondAt,paths:{},quotes,contracts,
    entrySymbols:[...symbols,"NEW_USDT","NEW2_USDT"]}).state;
  assert.equal(second.rotationState?.count,1);
  assert.equal(second.positions.some(t=>t.symbol==="W0_USDT"),false,"rotated-out symbol stays in its re-entry cooldown");
  assert.equal(second.positions.some(t=>t.symbol==="NEW2_USDT"),false,"account-level 60-minute cooldown prevents rotation churn");
});
