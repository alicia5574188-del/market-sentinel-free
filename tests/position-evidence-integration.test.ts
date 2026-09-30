import test from "node:test";
import assert from "node:assert/strict";
import {evaluatePositionIntelligence} from "../lib/position-intelligence-engine.ts";
import {capturePositionBaseline,POSITION_EVIDENCE_CONTRACT} from "../lib/position-evidence-contract.ts";
import {fillForwardPortfolio,initialForward,advanceForward,type Opportunity} from "../lib/forward-relations.ts";
import {prepareForwardWrite,readForwardStore} from "../lib/forward-store.ts";
import type {MarketSymbolState,CandleLike} from "../lib/market-intelligence-engine.ts";
import type {SymbolLiquidityMap} from "../lib/market-intelligence-liquidity.ts";

const B=1790784000000,OPEN=B-21_055,FIRST=B+8188,SECOND=B+10276;
const healthy:MarketSymbolState={symbol:"TEST_USDT",watchScore:85,regime:"TRANSITION",stage:"READY",clusterId:"corr:TEST",
  correlation:.6,beta:1,volatility:.004,dataConfidence:96,actualMove:.01,expectedMove:.001,residual:.009,residualZ:1.4,
  residualPersistence:1,relativeStrength:.8,longScore:86,shortScore:20,pathLong:.82,pathShort:.18,roomLong:.03,roomShort:.002,
  sourceCount:4,venueAgreement:1,venuePressure:.8,reasons:[],signalSide:"LONG",signalSince:B-600_000,signalBars:2,signalLastBar:B-300_000};
const broken:MarketSymbolState={...healthy,residual:-.010,residualZ:-1.4,relativeStrength:.2,longScore:20,shortScore:86,
  pathLong:.18,pathShort:.82,roomLong:.002,roomShort:.03,venuePressure:-.8,signalSide:"SHORT"};
function minutes(end:number,step=-.001):CandleLike[]{return Array.from({length:10},(_,i)=>{
  const open=100*(1+step)**i,close=open*(1+step);return{time:(end-(10-i)*60_000)/1000,
    open,close,high:Math.max(open,close),low:Math.min(open,close),volume:100};});}
const badQuote={sourceCount:4,disagreementRate:.0002,bookImbalance:-.4,bidLiquidityChange:-.2,askLiquidityChange:.18,liquiditySourceCount:3};
const goodQuote={sourceCount:4,disagreementRate:.0002,bookImbalance:.4,bidLiquidityChange:.2,askLiquidityChange:-.18,liquiditySourceCount:3};
const base={now:FIRST,openedAt:OPEN,side:"LONG" as const,signedRate:-.0032,peakFavorableRate:0,ageMin:(FIRST-OPEN)/60_000,
  firstProfit:false,expectedHoldMinutes:91,stopRate:.025,entryScore:99,entryResidual:.009,entryRelativeStrength:.8,
  entryRemainingSpaceRate:.09,state:broken,quote:{...badQuote,observedAt:FIRST-100},minutePath:minutes(B),
  marketStateAgeMs:1000,entryResponseValidated:true,entryBaseline:capturePositionBaseline("LONG",healthy,OPEN)};
const rejection={ready:true,departure:{state:"REJECTED",side:"DOWN",confidence:.8},accumulation:.5} as SymbolLiquidityMap;

test("recorded rollover clocks cannot value-exit a new position even with several adverse assessments",()=>{
  // Synthetic market inputs isolate the recorded ENA clock failure; no historical PnL replay is claimed.
  const input={...base,liquidity:rejection,entryTradePlan:"LIQUIDITY_REJECTION" as const,currentPrice:100,entryOrigin:{lower:90,upper:101}};
  const first=evaluatePositionIntelligence(input);
  assert.equal(first.decision,"REVIEW");assert.equal(first.reviewBars,1);assert.ok(first.supportFamilies.includes("LIQUIDITY"));
  const second=evaluatePositionIntelligence({...input,now:SECOND,state:{...broken,signalLastBar:B},quote:{...badQuote,observedAt:SECOND-100},previous:first});
  assert.equal(second.reviewBars,1);assert.notEqual(second.decision,"EXIT");assert.equal(second.reviewSince,FIRST);
  const confirmed=evaluatePositionIntelligence({...input,now:B+300_100,state:{...broken,signalLastBar:B+300_000},
    quote:{...badQuote,observedAt:B+300_000},previous:second});
  assert.equal(confirmed.reviewBars,2);assert.equal(confirmed.decision,"EXIT");
  assert.notEqual(confirmed.exitBasis,"ENTRY_PRICE_FALSIFIED");
});

test("fill baseline and later position scores use one scale, not entry quality",()=>{
  const baseline=capturePositionBaseline("LONG",healthy,OPEN)!;
  const first=evaluatePositionIntelligence({...base,state:healthy,entryScore:1,quote:goodQuote,minutePath:minutes(B,.001),entryBaseline:baseline});
  const second=evaluatePositionIntelligence({...base,state:healthy,now:SECOND,entryScore:99,quote:goodQuote,minutePath:minutes(B,.001),
    entryBaseline:undefined,previous:JSON.parse(JSON.stringify(first))});
  assert.equal(first.advantageChange,0);assert.equal(second.advantageChange,0);assert.deepEqual(second.baseline,baseline);
  assert.equal(first.holdValueScore,second.holdValueScore);
});

test("legacy positions get explicitly recovered baselines without invented entry scores or retroactive fast exits",()=>{
  const old=evaluatePositionIntelligence({...base,entryBaseline:undefined,previous:undefined,signedRate:-.006});
  assert.equal(old.baseline?.source,"RECOVERED");assert.equal(old.baseline?.at,FIRST);assert.equal(old.advantageChange,0);
  assert.notEqual(old.exitBasis,"ENTRY_PRICE_FALSIFIED");
});

test("pre-entry minute history alone cannot masquerade as post-entry immediate falsification",()=>{
  const oldData=evaluatePositionIntelligence({...base,signedRate:-.02,quote:{...badQuote,observedAt:OPEN-1}});
  assert.notEqual(oldData.decision,"EXIT");
  const fresh=evaluatePositionIntelligence({...base,signedRate:-.02,quote:{...badQuote,observedAt:FIRST-1}});
  assert.equal(fresh.decision,"EXIT");assert.equal(fresh.exitBasis,"ENTRY_PRICE_FALSIFIED");assert.equal(fresh.reviewBars,1);
});

test("neutral flicker retains review without granting stale concerns current exit authority",()=>{
  const first=evaluatePositionIntelligence(base);
  const neutral={...healthy,longScore:50,shortScore:50,residual:0,residualZ:0,relativeStrength:.5,pathLong:.5,pathShort:.5,venuePressure:0};
  const quiet={sourceCount:4,disagreementRate:.0002,bookImbalance:0,bidLiquidityChange:0,askLiquidityChange:0,liquiditySourceCount:3};
  const second=evaluatePositionIntelligence({...base,now:SECOND,state:neutral,quote:quiet,minutePath:minutes(B,0),previous:first});
  assert.equal(second.concernFamilies.length,0);assert.equal(second.reviewCandidate,false);assert.equal(second.decision,"REVIEW");
  assert.equal(second.reviewSince,FIRST);assert.equal(second.exitBasis,null);assert.equal(second.reviewBars,1);
  const resumed=evaluatePositionIntelligence({...base,now:SECOND+2000,previous:second});
  assert.equal(resumed.reviewSince,FIRST);assert.equal(resumed.reviewBars,1);
});

test("healthy slow starters and proven trend winners have no minimum-age or time-only exit",()=>{
  for(const ageMin of [.2,30,120])for(const peak of [0,.08]){
    const r=evaluatePositionIntelligence({...base,now:B+ageMin*60_000,openedAt:B-60_000,ageMin,signedRate:peak? .055:-.0005,
      firstProfit:peak>0,peakFavorableRate:peak,state:healthy,quote:goodQuote,minutePath:minutes(B,.001)});
    assert.equal(r.decision,"HOLD");assert.equal(r.exitBasis,null);
  }
});

function opportunity():Opportunity{return{id:"fixture",symbol:"TEST_USDT",side:"LONG",mode:"CONTINUATION",premium:false,score:85,
  eligible:true,completedAt:B,expiresAt:B+600_000,price:100,stopPrice:99,targetPrice:103,stopRate:.01,targetRate:.03,
  directionStrength:80,pathEfficiency:80,momentumPersistence:80,positionScore:80,spaceScore:80,executionScore:90,
  grossRemainingSpaceRate:.03,netRemainingSpaceRate:.0281,pullbackRiskRate:.01,edgeRatio:2.81,expectedHoldMinutes:180,marketFit:80,
  regionId:null,regionQuality:null,reason:"synthetic integration fixture",strategyVersion:"market-intelligence-v1",clusterId:"corr:TEST",
  thesisId:"fixture",residual:.009,relativeStrength:.8,sourceCount:4,dataConfidence:96,confirmationStage:"READY"};}
function account(){const s=initialForward(B-600_000);s.extremumRegime.symbols.TEST_USDT={...healthy,signalLastBar:B};
  s.extremumRegime.updatedAt=B;s.opportunities=[opportunity()];s.lastCandleAt=B;return s;}
const execQuote={bestBid:99.99,bestAsk:100,observedAt:B,fresh:true,entryReady:true,...goodQuote};
const contract={quantoMultiplier:.01,leverageMax:10,maintenanceRate:.005};

test("actual financial entry freezes the comparable baseline before committing money",()=>{
  const s=account();const count=fillForwardPortfolio(s,{TEST_USDT:execQuote},{TEST_USDT:contract},B,1000,false);
  assert.equal(count,1);const t=s.positions[0]!;assert.equal(t.positionIntelligence?.baseline?.source,"ENTRY");
  assert.equal(t.positionIntelligence?.baseline?.at,t.openedAt);assert.equal(t.positionIntelligence?.advantageChange,0);
  assert.equal(t.positionIntelligence?.baseline?.version,POSITION_EVIDENCE_CONTRACT);
});

test("the shared assessor identifies converged entry contradictions without relying on time or quality-score deltas",()=>{
  const r=evaluatePositionIntelligence({...base,now:OPEN,openedAt:OPEN,ageMin:0,signedRate:-.0001,
    entryBaseline:capturePositionBaseline("LONG",broken,OPEN),quote:{...badQuote,observedAt:OPEN},minutePath:minutes(OPEN)});
  assert.equal(r.advantageChange,0);assert.equal(r.entryConflict,true);assert.notEqual(r.decision,"EXIT");
});

test("missing independent path evidence does not manufacture an entry veto",()=>{
  const s=account();s.extremumRegime.symbols.TEST_USDT={...broken,signalLastBar:B};
  s.opportunities[0]={...opportunity(),netRemainingSpaceRate:.015,pullbackRiskRate:.006,edgeRatio:2.5};
  const before={balance:s.balance,fees:s.fees,turnover:s.turnover,consumed:structuredClone(s.consumedTheses)};
  // With no minute path, structure/relative alone do not fabricate independent confirmation.
  const result=fillForwardPortfolio(s,{TEST_USDT:{...execQuote,...badQuote}},{TEST_USDT:contract},B,1000,false);
  assert.equal(result,1,"absence of independent price/flow confirmation must not add a blanket veto");
  assert.equal(s.positions.length,1);assert.equal(s.positions[0]!.positionIntelligence?.entryConflict,false);
  assert.ok(s.balance<=before.balance);
});

test("saved baseline and causal review memory survive the real paged store reader",async()=>{
  const s=account();fillForwardPortfolio(s,{TEST_USDT:execQuote},{TEST_USDT:contract},B,1000,false);
  const t=s.positions[0]!;
  t.positionIntelligence=evaluatePositionIntelligence({...base,openedAt:t.openedAt,now:B+30_000,ageMin:.5,
    entryBaseline:t.positionIntelligence!.baseline,quote:{...badQuote,observedAt:B+29999}});
  s.storage.persistedAt=B+30_000;
  const write=await prepareForwardWrite(null,s,B+30_000,{compact:true});
  const data=new Map(Object.entries(write.entries));
  const saved=await readForwardStore({get:async<T>(key:string)=>structuredClone(data.get(key)) as T|undefined},B+31_000);
  assert.equal(saved.startedAt,s.startedAt);assert.equal(saved.balance,s.balance);
  assert.deepEqual(saved.positions[0]!.positionIntelligence?.baseline,t.positionIntelligence.baseline);
  assert.deepEqual(saved.positions[0]!.positionIntelligence?.reviewMemory,t.positionIntelligence.reviewMemory);
});

test("hard price stops still exit immediately even when causal review count is insufficient",()=>{
  const s=account();fillForwardPortfolio(s,{TEST_USDT:execQuote},{TEST_USDT:contract},B,1000,false);
  const stop=s.positions[0]!.stopPrice;
  const now=B+1000,quotes={TEST_USDT:{...execQuote,bestBid:stop*.99,bestAsk:stop*.9901,observedAt:now}};
  const r=advanceForward({state:s,now,paths:{},quotes,contracts:{TEST_USDT:contract},allowDataCycle:false});
  assert.equal(r.state.positions.length,0);assert.equal(r.state.history[0]!.exitReason,"STRUCTURE_STOP");
});
