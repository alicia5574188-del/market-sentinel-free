import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {entryGate,entryGateNote} from "../lib/entry-gate.ts";
import {gateFields} from "../lib/order-journal.ts";
import {LOG_REQUIRED,LOG_REQUIRED_WHEN_CLOSED} from "../lib/log-complete.ts";
import type {Trade} from "../lib/forward-relations.ts";

test("TREND long opens when BTC 1h is up at least 0.5%",()=>{
  assert.deepEqual(entryGate({stage:"TREND",side:"LONG",btc1hPct:0.6,factor30mPct:0.3}),{action:"OPEN",side:"LONG",rule:"btc_follow"});
  assert.deepEqual(entryGate({stage:"TREND",side:"LONG",btc1hPct:0.5,factor30mPct:null}),{action:"OPEN",side:"LONG",rule:"btc_follow"});
});
test("TREND long is blocked when BTC 1h is only +0.3% and the market is not washed out",()=>{
  assert.deepEqual(entryGate({stage:"TREND",side:"LONG",btc1hPct:0.3,factor30mPct:-0.5}),{action:"BLOCK",rule:"btc_follow_block"});
});
test("short side mirrors the BTC follow rule in TREND and SHOCK",()=>{
  assert.deepEqual(entryGate({stage:"SHOCK",side:"SHORT",btc1hPct:-0.7,factor30mPct:-2}),{action:"OPEN",side:"SHORT",rule:"btc_follow"});
  assert.deepEqual(entryGate({stage:"TREND",side:"SHORT",btc1hPct:-0.45,factor30mPct:-0.8}),{action:"BLOCK",rule:"btc_follow_block"});
  assert.deepEqual(entryGate({stage:"SHOCK",side:"LONG",btc1hPct:0.49,factor30mPct:1}),{action:"BLOCK",rule:"btc_follow_block"});
});
test("SHOCK short with BTC -0.2% and factor -2% is blocked, never flipped",()=>{
  assert.deepEqual(entryGate({stage:"SHOCK",side:"SHORT",btc1hPct:-0.2,factor30mPct:-2}),{action:"BLOCK",rule:"btc_follow_block"});
});
test("TREND short with BTC -0.25% and factor -2.0% is flipped to a long",()=>{
  const input={stage:"TREND",side:"SHORT" as const,btc1hPct:-0.25,factor30mPct:-2.0};
  const d=entryGate(input);
  assert.deepEqual(d,{action:"FLIP",side:"LONG",rule:"washout_flip"});
  assert.deepEqual(entryGateNote(input,d),{version:"entry-gate-v1",rule:"washout_flip",signalSide:"SHORT",side:"LONG",btc1hPct:-0.25,factor30mPct:-2,coinBgPct:null});
});
test("washout edges: factor exactly -1.4 counts, |BTC| 0.4 does not, native long is allowed",()=>{
  assert.equal(entryGate({stage:"TREND",side:"SHORT",btc1hPct:0.1,factor30mPct:-1.4}).action,"FLIP");
  assert.equal(entryGate({stage:"TREND",side:"SHORT",btc1hPct:-0.4,factor30mPct:-3}).action,"BLOCK");
  assert.equal(entryGate({stage:"TREND",side:"SHORT",btc1hPct:0.2,factor30mPct:-1.39}).action,"BLOCK");
  assert.equal(entryGate({stage:"TREND",side:"SHORT",btc1hPct:-0.2,factor30mPct:null}).action,"BLOCK");
  assert.deepEqual(entryGate({stage:"TREND",side:"LONG",btc1hPct:-0.3,factor30mPct:-1.8}),{action:"OPEN",side:"LONG",rule:"washout_long"});
});
test("unknown BTC 1h blocks TREND and SHOCK entries",()=>{
  for(const stage of ["TREND","SHOCK"])for(const side of ["LONG","SHORT"] as const)for(const btc of [null,undefined,Number.NaN])
    assert.deepEqual(entryGate({stage,side,btc1hPct:btc,factor30mPct:-3}),{action:"BLOCK",rule:"btc_missing_block"});
});
test("TRANSITION, ROTATION and other stages are untouched",()=>{
  for(const stage of ["TRANSITION","ROTATION","RANGE",null,undefined])for(const side of ["LONG","SHORT"] as const){
    assert.deepEqual(entryGate({stage,side,btc1hPct:-0.1,factor30mPct:-3}),{action:"PASS"});
    assert.deepEqual(entryGate({stage,side,btc1hPct:null,factor30mPct:null}),{action:"PASS"});
    assert.equal(entryGateNote({stage,side,btc1hPct:null,factor30mPct:null},{action:"PASS"}),null);
  }
});
test("gate tag reaches the run log without becoming a required field",()=>{
  const t={entryContext:{entryGate:{version:"entry-gate-v1",rule:"washout_flip",signalSide:"SHORT",side:"LONG",btc1hPct:-0.25,factor30mPct:-2}}} as unknown as Trade;
  assert.deepEqual(gateFields(t),{entry_gate:"washout_flip",gate_signal_side:"SHORT",gate_btc_1h_pct:-0.25,gate_coin_bg_pct:null});
  assert.deepEqual(gateFields({} as Trade),{entry_gate:null,gate_signal_side:null,gate_btc_1h_pct:null,gate_coin_bg_pct:null});
  for(const key of ["entry_gate","gate_signal_side","gate_btc_1h_pct","gate_coin_bg_pct"]){
    assert.ok(!(LOG_REQUIRED as readonly string[]).includes(key));
    assert.ok(!(LOG_REQUIRED_WHEN_CLOSED as readonly string[]).includes(key));
  }
});
test("the old gate no longer decides TREND/SHOCK (replaced by S1, tests/s1-rule.test.ts); the same logged BTC 1h feeds S1",()=>{
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  const advance=core.slice(core.indexOf("function advanceEntryResponses"),core.indexOf("export function fillForwardPortfolio"));
  assert.doesNotMatch(advance,/entryGate\(gateInput\)/,"S1 replaces the gate's direction decisions; it is not stacked on top");
  assert.match(advance,/s1Decision\(\{stage,signalSide:o\.side,btc1hPct\}\)/);
  const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  assert.match(worker,/btc1hPct:this\.gateBtc1h\(now\)/);
  assert.match(worker,/btcChange\(\{now,btcBars5m:this\.strategyCandles\.BTC_USDT\?\?null,btcMids:this\.btcMidRing,btcHourly:this\.regimeHourly\.BTC_USDT\?\?null\},1\)/);
});

test("a washout flip opens through the normal path as a LONG with the stop mirrored below entry",async()=>{
  const {buildMarketIntelligence,initialMarketIntelligenceState,MARKET_INTELLIGENCE_VERSION}=await import("../lib/market-intelligence-engine.ts");
  const {initialForward,openIntelligenceTradeForTest}=await import("../lib/forward-relations.ts");
  const T=2_000_000_000_000;
  const candles=(start:number,step:number,vol=.002)=>{const out=[] as Array<{time:number;open:number;high:number;low:number;close:number;volume:number}>;let px=start;
    for(let i=0;i<72;i++){const move=step+Math.sin(i/5)*vol*.15,open=px,close=px*(1+move);out.push({time:(T-(72-i)*300_000)/1000,open,close,
      high:Math.max(open,close)*(1+vol*.25),low:Math.min(open,close)*(1-vol*.25),volume:1000+i});px=close;}return out;};
  const q=(px:number,move=-.0003)=>({bestBid:px*.99995,bestAsk:px*1.00005,observedAt:T,fresh:true,entryReady:true,sourceCount:4,
    disagreementRate:.00008,sourceBreadth:move>0?.75:-.75,directionalAgreement:.9,medianShortMove:move});
  const paths={BTC_USDT:candles(100,-.0010),ETH_USDT:candles(100,-.0013),SOL_USDT:candles(100,-.0009)};
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,q(v.at(-1)!.close)]));
  const built=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-300_000),now:T});
  const base=built.opportunities[0]!,quote=quotes[base.symbol]!;
  const opportunity={...base,side:"SHORT" as const,winnerPlan:undefined,eligible:true,tradePlan:"LIQUIDITY_MIGRATION" as const,environmentForceRetest:false,
    strategyVersion:MARKET_INTELLIGENCE_VERSION,thesisId:"washout-flip",thesisSince:T-300_000,
    netRemainingSpaceRate:.04,grossRemainingSpaceRate:.045,edgeRatio:4,targetRate:.04,
    liquidityInvalidationPrice:quote.bestBid*1.01,liquidityInvalidationRate:.01,rapidLiquidityAuthorization:true};
  const state=initialForward(T-600_000);state.extremumRegime=built.state;
  const contract={quantoMultiplier:.001,leverageMax:10,maintenanceRate:.005,minContracts:1};
  const input={stage:"TREND",side:"SHORT" as const,btc1hPct:-0.25,factor30mPct:-2};
  const note=entryGateNote(input,entryGate(input));
  const error=openIntelligenceTradeForTest(state,opportunity as never,quote as never,contract as never,T,1000,undefined,undefined,undefined,null,null,false,note);
  assert.equal(error,null);
  const t=state.positions[0]!;
  assert.equal(t.side,"LONG");
  assert.equal(t.entryPrice,quote.bestAsk);
  assert.ok(t.stopPrice<t.entryPrice,"long stop sits below entry");
  assert.ok(Math.abs((t.entryPrice-t.stopPrice)/t.entryPrice-t.rule.stopRate)<1e-9,"same stop width, other side");
  assert.equal(t.liquidityLifecycle?.invalidationPrice,null,"short-side invalidation above price is not kept for a long");
  assert.equal(t.entryContext?.entryGate?.rule,"washout_flip");
  assert.equal(t.entryContext?.entryGate?.signalSide,"SHORT");
  assert.equal(state.lastSide[opportunity.symbol],"LONG");
});

test("pumped short: a short Rule 1 would block opens when the coin's own background is up >= 5%",()=>{
  const g=(stage:string,side:"LONG"|"SHORT",btc:number|null,bg:number|null,factor:number|null=0)=>entryGate({stage,side,btc1hPct:btc,factor30mPct:factor,coinBgPct:bg});
  assert.deepEqual(g("TREND","SHORT",0.7,9.3),{action:"OPEN",side:"SHORT",rule:"pumped_short"});
  assert.deepEqual(g("SHOCK","SHORT",0.7,12.7),{action:"OPEN",side:"SHORT",rule:"pumped_short"});
  assert.deepEqual(g("TREND","SHORT",0.8,2.0),{action:"BLOCK",rule:"btc_follow_block"});
  assert.deepEqual(g("TREND","SHORT",0.1,5),{action:"OPEN",side:"SHORT",rule:"pumped_short"});
  assert.deepEqual(g("TREND","SHORT",0.1,4.99),{action:"BLOCK",rule:"btc_follow_block"});
  assert.deepEqual(g("TREND","SHORT",0.7,null),{action:"BLOCK",rule:"btc_follow_block"});
  assert.deepEqual(g("SHOCK","SHORT",0.7,Number.NaN),{action:"BLOCK",rule:"btc_follow_block"});
  assert.deepEqual(g("TREND","LONG",0.3,10),{action:"BLOCK",rule:"btc_follow_block"});
  assert.deepEqual(g("SHOCK","SHORT",null,10),{action:"BLOCK",rule:"btc_missing_block"});
  assert.deepEqual(g("TREND","SHORT",null,10),{action:"BLOCK",rule:"btc_missing_block"});
  // BTC already follows -> plain btc_follow; washout still wins first in TREND; other stages untouched
  assert.deepEqual(g("TREND","SHORT",-0.6,10),{action:"OPEN",side:"SHORT",rule:"btc_follow"});
  assert.deepEqual(g("TREND","SHORT",-0.2,10,-2),{action:"FLIP",side:"LONG",rule:"washout_flip"});
  assert.deepEqual(g("TRANSITION","SHORT",0.7,10),{action:"PASS"});
  const input={stage:"TREND",side:"SHORT" as const,btc1hPct:0.7,factor30mPct:0,coinBgPct:9.3};
  assert.equal(entryGateNote(input,entryGate(input))?.coinBgPct,9.3);
});

test("pumped short: the gate's background value is the one the run log writes as coin_background_pct",async()=>{
  const {buildMarketIntelligence,initialMarketIntelligenceState,MARKET_INTELLIGENCE_VERSION}=await import("../lib/market-intelligence-engine.ts");
  const {initialForward,openIntelligenceTradeForTest}=await import("../lib/forward-relations.ts");
  const {readCoinPath}=await import("../lib/coin-path.ts");
  const {orderRecord}=await import("../lib/order-journal.ts");
  const T=2_000_000_000_000;
  const candles=(start:number,step:number,vol=.002)=>{const out=[] as Array<{time:number;open:number;high:number;low:number;close:number;volume:number}>;let px=start;
    for(let i=0;i<120;i++){const move=step+Math.sin(i/5)*vol*.15,open=px,close=px*(1+move);out.push({time:(T-(120-i)*300_000)/1000,open,close,
      high:Math.max(open,close)*(1+vol*.25),low:Math.min(open,close)*(1-vol*.25),volume:1000+i});px=close;}return out;};
  const q=(px:number)=>({bestBid:px*.99995,bestAsk:px*1.00005,observedAt:T,fresh:true,entryReady:true,sourceCount:4,
    disagreementRate:.00008,sourceBreadth:-.75,directionalAgreement:.9,medianShortMove:-.0003});
  const paths={BTC_USDT:candles(100,.0012),ETH_USDT:candles(100,.0015),SOL_USDT:candles(100,.0011)};
  const quotes=Object.fromEntries(Object.entries(paths).map(([s,v])=>[s,q(v.at(-1)!.close)]));
  const built=buildMarketIntelligence({paths,quotes,previous:initialMarketIntelligenceState(T-300_000),now:T});
  const base=built.opportunities[0]!,quote=quotes[base.symbol]!;
  const coinPath=readCoinPath({bars:paths[base.symbol as keyof typeof paths],now:T});
  assert.ok(typeof coinPath.backgroundPct==="number"&&coinPath.backgroundPct>=5,`fixture background ${coinPath.backgroundPct}`);
  const opportunity={...base,side:"SHORT" as const,coinPath,winnerPlan:undefined,eligible:true,tradePlan:"LIQUIDITY_MIGRATION" as const,environmentForceRetest:false,
    strategyVersion:MARKET_INTELLIGENCE_VERSION,thesisId:"pumped-short",thesisSince:T-300_000,
    netRemainingSpaceRate:.04,grossRemainingSpaceRate:.045,edgeRatio:4,targetRate:.04,
    liquidityInvalidationPrice:quote.bestBid*1.01,liquidityInvalidationRate:.01,rapidLiquidityAuthorization:true};
  const input={stage:"TREND",side:"SHORT" as const,btc1hPct:0.7,factor30mPct:0.5,coinBgPct:opportunity.coinPath?.backgroundPct??null};
  const decision=entryGate(input);assert.equal(decision.action,"OPEN");
  const state=initialForward(T-600_000);state.extremumRegime=built.state;
  const error=openIntelligenceTradeForTest(state,opportunity as never,quote as never,{quantoMultiplier:.001,leverageMax:10,maintenanceRate:.005,minContracts:1} as never,
    T,1000,undefined,undefined,undefined,null,null,false,entryGateNote(input,decision));
  assert.equal(error,null);
  const row=orderRecord(state.positions[0]!);
  assert.equal(row.side,"SHORT");
  assert.equal(row.entry_gate,"pumped_short");
  assert.equal(row.gate_coin_bg_pct,row.coin_background_pct);
  assert.equal(row.gate_coin_bg_pct,coinPath.backgroundPct);
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  assert.match(core,/coinPath:o\.coinPath\}/);
});
