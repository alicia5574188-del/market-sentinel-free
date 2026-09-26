import test from "node:test";
import assert from "node:assert/strict";
import {fillForwardPortfolio,forwardEquity,initialForward,type Candle,type Contract,type Opportunity,type Quote} from "../lib/forward-relations.ts";
import {PREDICTIVE_PATH_VERSION} from "../lib/predictive-path-types.ts";
import {buildProportionalMirror,forwardMirrorSources,liveEntryDriftGuard,mirrorSourceFresh} from "../lib/live-parity.ts";
import {sourceAfterEnable,startLiveSession} from "../lib/live-session.ts";

const START=Date.parse("2026-09-24T00:00:00Z")/1000;
const makePath=(step=.0016,bars=60):Candle[]=>{const out:Candle[]=[];let p=100;
  for(let i=0;i<bars;i++){const c=p*(1+step);out.push({time:START+i*300,open:p,close:c,
    high:Math.max(p,c)*1.0006,low:Math.min(p,c)*.9994,volume:1000+i});p=c;}return out;};
const q=(p:number,now:number):Quote=>({bestBid:p*.9999,bestAsk:p*1.0001,observedAt:now,fresh:true,entryReady:true,
  sourceCount:4,disagreementRate:.0002,sourceBreadth:1,directionalAgreement:1,medianShortMove:.0006});
const contract:Contract={quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,minContracts:1,
  enableDecimal:false,orderSizeMin:"1",orderSizeMax:"1000000"};
function source(){
  const path=makePath(),now=(path.at(-1)!.time+300)*1000+1000,price=path.at(-1)!.close,s=initialForward(now-60_000),
    forecast={version:PREDICTIVE_PATH_VERSION,symbol:"BTC_USDT",at:now,lastBarTime:now-1000,
      upProbability:{m15:.61,m30:.66,m60:.70,m120:.72},expectedReturn:{m15:.004,m30:.007,m60:.016,m120:.023},
      long:{mfe60:.027,mae60:.006,targetBeforeRisk60:.68,entryRegret10:.001,netEv60:.011},
      short:{mfe60:.006,mae60:.027,targetBeforeRisk60:.25,entryRegret10:.004,netEv60:-.012},
      crossVenue:{sourceCount:4,agreement:.9,breadth:.8,disagreementRate:.0003},
      evidence:{price:.7,technical:.6,derivatives:.4,liquidation:.2,multiVenue:.7,context:.5,persistence:.8,uncertainty:.8},
      rawSide:"LONG" as const,stableSide:"LONG" as const,directionProbability:.70,entryQuality:.82,enterNow:true,waitReason:null,confidence:.78},
    opportunity:Opportunity={id:"fixture-predictive",symbol:"BTC_USDT",side:"LONG",mode:"PREDICTIVE",premium:true,reserve:false,
      score:78,eligible:true,completedAt:now-1000,expiresAt:now+60_000,price,stopPrice:price*.992,targetPrice:price*1.02,
      stopRate:.008,targetRate:.02,directionStrength:70,pathEfficiency:.7,momentumPersistence:72,positionScore:82,spaceScore:80,
      executionScore:90,grossRemainingSpaceRate:.016,netRemainingSpaceRate:.0141,pullbackRiskRate:.008,edgeRatio:1.76,
      expectedHoldMinutes:60,marketFit:78,regionId:null,regionQuality:null,reason:"Causal Predictive Path LIVE同源测试事件",
      strategyVersion:PREDICTIVE_PATH_VERSION,sourceCount:4,disagreementRate:.0003,predictiveForecast:forecast};
  s.opportunities=[opportunity];s.lastCandleAt=now;
  fillForwardPortfolio(s,{BTC_USDT:q(price,now)},{BTC_USDT:contract},now,1000,false);
  assert.equal(s.positions.length,1,JSON.stringify(s.entryDiagnostics));return{s,trade:s.positions[0]!,now,price};
}

test("LIVE sees the exact persisted PAPER trade rather than rebuilding a strategy decision",()=>{
  const {s,trade}=source(),equity=forwardEquity(s,{BTC_USDT:q(trade.lastPrice,trade.lastQuoteAt)},trade.lastQuoteAt).equity;
  const rows=forwardMirrorSources(s,equity);
  assert.equal(rows.BTC_USDT.id,trade.id);
  assert.deepEqual(rows.BTC_USDT.forwardSource,trade);
  assert.equal(rows.BTC_USDT.activeStopPrice,trade.stopPrice);
  assert.equal(rows.BTC_USDT.notional,trade.notional);
  assert.deepEqual(rows.BTC_USDT.forwardSource?.exitPlan,trade.exitPlan);
  assert.equal(rows.BTC_USDT.forwardSource?.side,trade.side);assert.equal(rows.BTC_USDT.forwardSource?.stopPrice,trade.stopPrice);
  assert.equal(rows.BTC_USDT.forwardSource?.entryContext?.strategyVersion,PREDICTIVE_PATH_VERSION);
  assert.equal(rows.BTC_USDT.forwardSource?.entryContext?.mode,"PREDICTIVE");
});

test("owner enable fences old PAPER positions and admits only new events",()=>{
  const {s,trade,now}=source();
  const late=startLiveSession(now+1000,s);
  assert.equal(sourceAfterEnable(trade,late,s.startedAt),false);
  const before=initialForward(now-10_000),early=startLiveSession(now-5000,before);
  assert.notEqual(before.startedAt,s.startedAt);
  assert.equal(sourceAfterEnable(trade,early,s.startedAt),false,"different PAPER generation must not be mixed");
  const sameGeneration=startLiveSession(trade.openedAt-1,{startedAt:s.startedAt,positions:[]});
  assert.equal(sourceAfterEnable(trade,sameGeneration,s.startedAt),true);
});

test("proportional LIVE sizing preserves source leverage and does not enlarge a small account",()=>{
  const {s,trade,now}=source(),sourceEquity=forwardEquity(s,{BTC_USDT:q(trade.lastPrice,now)},now).equity;
  const result=buildProportionalMirror({source:trade,sourceEquity,equity:sourceEquity*.1,available:sourceEquity*.1,
    entryPrice:trade.entryPrice,quantoMultiplier:trade.quantoMultiplier,leverageMax:20,maintenanceRate:.005,
    openRisk:0,sameDirectionRisk:0,openMargin:0,openNotional:0,now:trade.openedAt+1000,policy:s.policyVersion,
    sizeRules:{enableDecimal:false,orderSizeMin:"1",orderSizeMax:"1000000"},mirrorRatio:.1,sourceRiskAuthority:true,
    quoteObservedAt:trade.lastQuoteAt});
  assert.equal(result.intent.leverage,trade.leverage);
  assert.ok(result.intent.notional<=trade.notional*.1+trade.entryPrice*trade.quantoMultiplier);
  assert.equal(result.binding.receipt.sourceId,trade.id);
  assert.equal(result.binding.receipt.ratio,.1);
  assert.equal(result.binding.receipt.sourceExitPlanVersion,undefined);
  assert.equal(result.binding.receipt.sourceBestHoldMinutes,undefined);
  assert.equal(result.binding.receipt.sourceMaxHoldMinutes,undefined);
});

test("stale events are never replayed into LIVE and adverse chase is bounded",()=>{
  const {trade}=source();
  assert.equal(mirrorSourceFresh(trade,trade.id,trade.openedAt+1000),true);
  assert.equal(mirrorSourceFresh(trade,trade.id,trade.openedAt+(trade.exitPlan?.maxHoldMinutes??trade.rule.horizon)*60_000),false);
  const favorable=trade.side==="LONG"?trade.entryPrice*.999:trade.entryPrice*1.001;
  assert.equal(liveEntryDriftGuard(trade,favorable).adverse,0);
  const bad=trade.side==="LONG"?trade.entryPrice*1.02:trade.entryPrice*.98;
  const guard=liveEntryDriftGuard(trade,bad);assert.ok(guard.adverse>guard.allowed);
});
