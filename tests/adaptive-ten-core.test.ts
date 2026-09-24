import test from "node:test";
import assert from "node:assert/strict";
import {ADAPTIVE_ENGINE_VERSION,advanceForward,closeForwardForReset,fillForwardPortfolio,forwardSummary,initialForward,normalizeForward,resetForwardAccountPreservingLearning,
  type Candle,type Contract,type Opportunity,type Quote} from "../lib/forward-relations.ts";
import {FORWARD_STORAGE,prepareForwardReset} from "../lib/forward-store.ts";
import {FORWARD_RELATION_V2_VERSION,advanceRelationEngine,initialRelationEngine,relationCandidates} from "../lib/forward-relation-v2.ts";

const START=Date.parse("2026-09-24T00:00:00Z")/1000;
const symbols=Array.from({length:12},(_,i)=>`S${i}_USDT`);
const contract:Contract={quantoMultiplier:.001,leverageMax:10,maintenanceRate:.005,minContracts:1};
function makePath(index:number,bars=80,flipAt=40):Candle[]{const out:Candle[]=[];let prev=100+index;
  for(let i=0;i<bars;i++){const step=i<flipAt?.002:-.006,close=prev*(1+step);out.push({time:START+i*300,open:prev,close,
    high:Math.max(prev,close)*1.0002,low:Math.min(prev,close)*.9998,volume:1000+i});prev=close;}return out;}
const full=Object.fromEntries(symbols.map((s,i)=>[s,makePath(i)])) as Record<string,Candle[]>;
const sliced=(last:number)=>Object.fromEntries(symbols.map(s=>[s,full[s]!.slice(0,last+1)])) as Record<string,Candle[]>;
const nowAt=(last:number)=>(full[symbols[0]]![last]!.time+300)*1000+1000;
const quotesAt=(last:number,now=nowAt(last))=>Object.fromEntries(symbols.map(s=>{const p=full[s]![last]!.close;
  return[s,{bestBid:p*.9999,bestAsk:p*1.0001,observedAt:now,fresh:true,entryReady:true} satisfies Quote];})) as Record<string,Quote>;
const contracts=Object.fromEntries(symbols.map(s=>[s,contract]));
const manualOpportunity=(symbol:string,index:number,options:{reserve?:boolean;premium?:boolean;ruleId?:string;score?:number;health?:number;
  familyKey?:string;edgeRatio?:number;netRate?:number;livePathScore?:number;status?:"ACTIVE"|"PRESSURED"|"DEGRADED"|"RECOVERING"}={}):Opportunity=>{
  const price=full[symbol]![39]!.close,side=index%2?"SHORT":"LONG",stopRate=.015,targetRate=.03,ruleId=options.ruleId??`r-${symbol}`,
    netRate=options.netRate??targetRate-.0019;
  return{id:`manual-${symbol}-${ruleId}`,symbol,side,mode:options.premium?"BREAKOUT":"RELATION",premium:options.premium??false,
    reserve:options.reserve??false,score:options.score??90,eligible:true,completedAt:nowAt(39)-1000,expiresAt:nowAt(39)+60*60_000,price,
    stopPrice:price*(side==="LONG"?1-stopRate:1+stopRate),targetPrice:price*(side==="LONG"?1+targetRate:1-targetRate),stopRate,targetRate,
    directionStrength:90,pathEfficiency:85,momentumPersistence:85,positionScore:85,spaceScore:90,executionScore:90,grossRemainingSpaceRate:targetRate,
    netRemainingSpaceRate:netRate,pullbackRiskRate:stopRate,edgeRatio:options.edgeRatio??1.8,expectedHoldMinutes:60,marketFit:85,regionId:null,regionQuality:null,
    reason:"portfolio-control fixture",relationRuleId:ruleId,relationStatus:options.status??"ACTIVE",relationHorizon:60,
    relationHealth:options.health??.9,riskScale:options.health??.9,relationFamilyKey:options.familyKey??`family-${ruleId}`,
    relationEvidenceAt:nowAt(39)-60_000,relationLivePathScore:options.livePathScore??.8};
};

function learnThrough(last:number){let e=initialRelationEngine(nowAt(24)-1);for(let i=24;i<=last;i++)
  e=advanceRelationEngine({state:e,paths:sliced(i),now:nowAt(i)});return e;}

test("Forward Relation 2.0 learns only from matured market responses and produces causal long relations",()=>{
  const e=learnThrough(39);
  assert.equal(e.version,FORWARD_RELATION_V2_VERSION);
  assert.ok(e.measured>=48,"five 15m groups across the market should have matured");
  assert.ok(e.rules.length>0,"mature cost-positive responses should produce relations");
  assert.ok(e.rules.some(r=>r.side==="LONG"&&r.status==="ACTIVE"));
  assert.ok(e.rules.some(r=>r.side==="LONG"&&r.scope==="BASE"),"mature BASE authority must survive alongside faster RECENT probes");
  assert.ok(relationCandidates(e).some(c=>c.side==="LONG"&&!c.reserve),"a healthy BASE relation should retain normal-risk authority");
  assert.equal(e.rules.some(r=>r.side==="SHORT"),false,"the opposite side must not be fabricated while only long responses matured");
  assert.ok(relationCandidates(e).length>0);
});

test("ongoing 5m response path can degrade an old relation before its 15m final label matures",()=>{
  const before=learnThrough(39);
  assert.ok(before.rules.some(r=>r.side==="LONG"&&r.status==="ACTIVE"));
  const after=advanceRelationEngine({state:before,paths:sliced(40),now:nowAt(40)});
  assert.ok(after.rules.some(r=>r.side==="LONG"&&(r.status==="PRESSURED"||r.status==="DEGRADED")));
  assert.equal(after.rules.some(r=>r.side==="SHORT"),false,"old long deterioration alone must never create a short relation");
  assert.ok(after.diagnostics.liveAnomalies>0);
});

test("opposite direction earns authority only after its own completed recent response groups agree",()=>{
  let e=learnThrough(39);
  e=advanceRelationEngine({state:e,paths:sliced(40),now:nowAt(40)});
  assert.equal(e.rules.some(r=>r.side==="SHORT"),false);
  for(let i=41;i<=51;i++)e=advanceRelationEngine({state:e,paths:sliced(i),now:nowAt(i)});
  const shorts=e.rules.filter(r=>r.side==="SHORT");
  assert.ok(shorts.length>0,"three completed negative 15m groups should be able to create an independent short relation");
  assert.ok(shorts.some(r=>r.scope==="RECENT"),"fast migration must still be based on matured recent samples");
  const rapid=relationCandidates(e).filter(c=>c.side==="SHORT");
  assert.ok(rapid.length>0&&rapid.every(c=>c.reserve),"recent reversal evidence may probe freed risk but cannot immediately take full rotation authority");
});

test("PAPER uses learned relations for entries instead of the retired 5m FLOW gate",()=>{
  const learned=learnThrough(39),now=nowAt(39),paths=sliced(39),quotes=quotesAt(39,now);
  let s=initialForward(now-60_000);s.relationEngine=learned;
  s=advanceForward({state:s,now,paths,quotes,contracts,entrySymbols:symbols}).state;
  assert.ok(s.positions.length>0);
  assert.ok(s.opportunities.some(o=>o.mode==="RELATION"&&o.eligible));
  assert.ok(s.positions.every(t=>t.entryContext?.mode==="RELATION"||t.entryContext?.regionId));
  assert.ok(s.positions.some(t=>t.entryContext?.relationRuleId));
});

test("fast quote loop cannot open a premium region trade before any Forward Relation samples exist",()=>{
  const symbol="S0_USDT",rows:Array<Candle>=[],base=START;
  for(let i=0;i<24;i++){const open=100+(i%2?.01:-.01),close=100+(i%2?-.01:.01);
    rows.push({time:base+i*300,open,close,high:100.05,low:99.95,volume:1000+i});}
  rows.push({time:base+24*300,open:100,close:102,high:102.2,low:99.9,volume:2000});
  const candleAt=(rows.at(-1)!.time+300)*1000,now=candleAt+1000,price=rows.at(-1)!.close;
  let state=initialForward(now-60_000);state.lastCandleAt=candleAt;
  state.regions[symbol]={id:"fixture-region",symbol,confirmedAt:candleAt-300_000,lower:99.8,upper:100.2,center:100,widthRate:.004,bars:10,quality:80,state:"ABOVE",lastSeenAt:now};
  assert.equal(state.relationEngine.samples.length,0);assert.equal(state.relationEngine.rules.length,0);
  state=advanceForward({state,now,paths:{[symbol]:rows},quotes:{[symbol]:{bestBid:price*.9999,bestAsk:price*1.0001,observedAt:now,fresh:true,entryReady:true}},contracts:{[symbol]:contract},entrySymbols:[symbol],allowDataCycle:false}).state;
  assert.equal(state.positions.length,0,"premium region execution must never bypass empty relation authority");
  assert.equal(state.opportunities.some(o=>o.premium&&o.eligible),false);
});

test("ordinary 5m relation inventory cannot keep opening on the fast quote loop",()=>{
  const now=nowAt(39),paths=sliced(39),symbol=symbols[0]!,s=initialForward(now-60_000);
  s.lastCandleAt=now;s.opportunities=[manualOpportunity(symbol,0,{premium:false})];
  const next=advanceForward({state:s,now,paths,quotes:quotesAt(39,now),contracts,entrySymbols:symbols,allowDataCycle:false}).state;
  assert.equal(next.positions.length,0);
});

test("one 5m deployment window cannot spray more than 2.5% portfolio risk budget",()=>{
  const now=nowAt(39),s=initialForward(now-60_000);s.lastCandleAt=now;
  s.opportunities=symbols.map((symbol,i)=>manualOpportunity(symbol,i,{premium:true}));
  fillForwardPortfolio(s,quotesAt(39,now),contracts,now,1000,false);
  const charge=s.positions.reduce((n,t)=>n+(t.entryContext?.portfolioRiskCharge??t.plannedRisk),0);
  assert.ok(charge<=25.01,`cycle charge ${charge}`);assert.ok(s.positions.length<=4);
});

test("one reserve relation family can hold only one real probe even when several rule ids and symbols match",()=>{
  const now=nowAt(39),s=initialForward(now-60_000);s.lastCandleAt=now;
  s.opportunities=[
    manualOpportunity(symbols[0]!,0,{reserve:true,ruleId:"family-a-r1",familyKey:"family-a"}),
    manualOpportunity(symbols[1]!,1,{reserve:true,ruleId:"family-a-r2",familyKey:"family-a"}),
    manualOpportunity(symbols[2]!,2,{reserve:true,ruleId:"family-b-r1",familyKey:"family-b"}),
  ];
  fillForwardPortfolio(s,quotesAt(39,now),contracts,now,1000,false);
  assert.equal(s.positions.filter(t=>t.entryContext?.relationFamilyKey==="family-a").length,1);
  assert.equal(s.positions.filter(t=>t.entryContext?.relationFamilyKey==="family-b").length,1);
  assert.equal(s.positions.length,2);
});

test("structure stop without positive feedback locks the whole probe family across symbol and rule-id changes",()=>{
  const now=nowAt(39),paths=sliced(39),s=initialForward(now-60_000),familyKey="family-stop";
  s.lastCandleAt=now;s.opportunities=[manualOpportunity(symbols[0]!,0,{reserve:true,premium:false,ruleId:"stop-r1",familyKey})];
  fillForwardPortfolio(s,quotesAt(39,now),contracts,now,1000,false);assert.equal(s.positions.length,1);
  const trade=s.positions[0]!,stopNow=now+10_000,stopQuote=quotesAt(39,stopNow);
  if(trade.side==="LONG"){const bid=trade.stopPrice*.999;stopQuote[trade.symbol]={bestBid:bid,bestAsk:bid*1.0001,observedAt:stopNow,fresh:true,entryReady:true};}
  else{const ask=trade.stopPrice*1.001;stopQuote[trade.symbol]={bestBid:ask*.9999,bestAsk:ask,observedAt:stopNow,fresh:true,entryReady:true};}
  const stopped=advanceForward({state:s,now:stopNow,paths,quotes:stopQuote,contracts,entrySymbols:symbols,allowDataCycle:false}).state;
  assert.ok(stopped.history.some(t=>t.id===trade.id&&t.exitReason==="STRUCTURE_STOP"));
  assert.equal(stopped.familyProbeGuards[familyKey]?.reason,"STRUCTURE_STOP_NO_FEEDBACK");

  stopped.lastCandleAt=stopNow+300_000;
  stopped.opportunities=[manualOpportunity(symbols[2]!,2,{reserve:true,ruleId:"stop-r2",familyKey})];
  fillForwardPortfolio(stopped,quotesAt(39,stopNow+301_000),contracts,stopNow+301_000,1000,false);
  assert.equal(stopped.positions.some(t=>t.entryContext?.relationFamilyKey===familyKey),false);
});

test("probe relationships share one 1.5% portfolio pool instead of fragmenting into dozens of positions",()=>{
  const now=nowAt(39),s=initialForward(now-60_000);s.lastCandleAt=now;
  s.opportunities=symbols.map((symbol,i)=>manualOpportunity(symbol,i,{premium:true,reserve:true,health:.25,score:70}));
  fillForwardPortfolio(s,quotesAt(39,now),contracts,now,1000,false);
  const charge=s.positions.reduce((n,t)=>n+(t.entryContext?.portfolioRiskCharge??t.plannedRisk),0);
  assert.ok(charge<=15.01);assert.ok(s.positions.length<=2,"weak probe deployment is also paced to at most two per 5m cycle");
});

test("one learned relation cannot consume more than 2.5% portfolio budget across correlated symbols",()=>{
  const now=nowAt(39),s=initialForward(now-60_000);s.lastCandleAt=now;
  s.opportunities=symbols.map((symbol,i)=>manualOpportunity(symbol,i,{premium:true,ruleId:"shared-market-factor"}));
  fillForwardPortfolio(s,quotesAt(39,now),contracts,now,1000,false);
  const charge=s.positions.reduce((n,t)=>n+(t.entryContext?.portfolioRiskCharge??t.plannedRisk),0);
  assert.ok(charge<=25.01);assert.ok(s.positions.length<=4);
});

test("there is no fixed ten-position cap; strong independent relations can grow beyond ten only across multiple 5m budgets",()=>{
  const base=nowAt(39),s=initialForward(base-60_000);
  for(let cycle=0;cycle<5&&s.positions.length<=10;cycle++){
    const at=base+cycle*300_000;s.lastCandleAt=at;
    s.opportunities=symbols.filter(symbol=>!s.positions.some(t=>t.symbol===symbol))
      .map(symbol=>manualOpportunity(symbol,symbols.indexOf(symbol),{premium:true,score:92,health:.95}));
    fillForwardPortfolio(s,quotesAt(39,at+1000),contracts,at+1000,1000,false);
  }
  assert.ok(s.positions.length>10,"risk-shaped portfolio may exceed ten when independent high-quality relations justify it");
  const charge=s.positions.reduce((n,t)=>n+(t.entryContext?.portfolioRiskCharge??t.plannedRisk),0),equity=forwardSummary(s,quotesAt(39,base+1_500_000),base+1_500_000).equity;
  assert.ok(charge<=equity*.10+1e-6);
  assert.ok(s.positions.reduce((n,t)=>n+t.margin,0)<=equity*.75+1e-6);
});

test("manual reset preparation remains bounded with twenty-two legacy open positions",async()=>{
  const now=nowAt(39),symbol=symbols[0]!,previous=initialForward(now-60_000);previous.lastCandleAt=now;
  previous.opportunities=[manualOpportunity(symbol,0,{premium:true})];
  fillForwardPortfolio(previous,quotesAt(39,now),contracts,now,1000,false);
  assert.equal(previous.positions.length,1);const baseTrade=previous.positions[0]!;
  previous.positions=Array.from({length:22},(_,i)=>({...structuredClone(baseTrade),id:`legacy-${i}`,symbol:`LEG${i}_USDT`}));
  previous.storage={persistedAt:now-1000,error:null};
  const closed=closeForwardForReset(previous,{},now+1000),next=resetForwardAccountPreservingLearning(previous,now+1000),
    prepared=await prepareForwardReset(previous,closed,next,now+1000);
  assert.equal(Object.keys(prepared.archiveEntries).length,22);
  assert.ok(prepared.accountEntries[`${FORWARD_STORAGE}head`]);
  assert.equal(prepared.state.positions.length,0);assert.equal(prepared.state.balance,1000);
});

test("a holding exits early when its own relation is degraded and it has no positive feedback",()=>{
  const learned=learnThrough(39),now=nowAt(39),paths=sliced(39);
  let s=initialForward(now-60_000);s.relationEngine=learned;
  s=advanceForward({state:s,now,paths,quotes:quotesAt(39,now),contracts,entrySymbols:symbols}).state;
  assert.ok(s.positions.length>0);
  const held=s.positions[0]!,ruleId=held.entryContext?.relationRuleId;assert.ok(ruleId);
  const rule=s.relationEngine.rules.find(r=>r.id===ruleId);assert.ok(rule);
  rule!.status="DEGRADED";rule!.health=.2;rule!.livePathScore=.2;
  held.openedAt=now-6*60_000;held.firstProfitAt=null;held.favorable=0;
  const later=now+1000,next=advanceForward({state:s,now:later,paths,quotes:quotesAt(39,later),contracts,entrySymbols:symbols,allowDataCycle:false}).state;
  assert.ok(next.history.some(t=>t.id===held.id&&t.exitReason==="RELATION_DEGRADED"));
  assert.equal(next.opportunities.some(o=>o.side==="SHORT"&&o.mode==="RELATION"),false,"degradation is defense, not a forced reversal");
});

test("risk scaling never becomes a global trading pause merely because a relation is pressured",()=>{
  const learned=learnThrough(39),pressured=advanceRelationEngine({state:learned,paths:sliced(40),now:nowAt(40)});
  const candidates=relationCandidates(pressured).filter(c=>c.side==="LONG");
  assert.ok(candidates.length>0,"degraded/pressured relations retain bounded probe participation");
  assert.ok(candidates.every(c=>c.health>=.15));
  assert.ok(candidates.some(c=>c.reserve));
});

test("strategy migration preserves account identity and financial history while starting a fresh causal relation learner",()=>{
  const s=initialForward(1000);s.startedAt=123;s.balance=876.54;s.initialEquity=1000;s.resolved=7;s.turnover=4321;
  s.engineVersion="legacy";s.strategyAuthorityVersion="legacy";s.executionVersion="legacy";s.storage={persistedAt:999,error:null};
  const n=normalizeForward(s,5000);
  assert.equal(n.startedAt,123);assert.equal(n.balance,876.54);assert.equal(n.resolved,7);assert.equal(n.turnover,4321);
  assert.equal(n.storage.persistedAt,999);assert.equal(n.engineVersion,ADAPTIVE_ENGINE_VERSION);
  assert.equal(n.strategyAuthorityVersion,FORWARD_RELATION_V2_VERSION);assert.equal(n.executionVersion,FORWARD_RELATION_V2_VERSION);
  assert.equal(n.relationEngine.startedAt,5000);assert.equal(n.relationEngine.measured,0);
});


test("manual PAPER reset preserves causal learning while resetting the financial account",()=>{
  const learned=learnThrough(39),now=nowAt(39),s=initialForward(now-60_000);s.relationEngine=learned;
  s.sampleMemory["RELATION:MIXED:LONG"]={count:4,emaNetRate:.003,emaMfeRate:.008,emaMaeRate:.002,updatedAt:now};
  s.familyProbeGuards["ff-test"]={familyKey:"ff-test",blockedAt:now-1000,blockedEvidenceAt:now-5000,blockedHealth:.25,blockedLivePathScore:.3,reason:"NO_POSITIVE_FEEDBACK",symbol:"S0_USDT",failures:1,lastRuleId:"r-test"};
  s.balance=812.34;s.resolved=9;s.wins=4;s.turnover=5432;
  const n=resetForwardAccountPreservingLearning(s,now+1000);
  assert.equal(n.balance,1000);assert.equal(n.initialEquity,1000);assert.equal(n.resolved,0);assert.equal(n.wins,0);assert.equal(n.turnover,0);
  assert.equal(n.positions.length,0);assert.equal(n.history.length,0);
  assert.equal(n.relationEngine.samples.length,learned.samples.length);assert.equal(n.relationEngine.rules.length,learned.rules.length);
  assert.equal(n.relationEngine.observations,learned.observations);assert.equal(n.relationEngine.measured,learned.measured);
  assert.deepEqual(n.relationEngine.rules,learned.rules);assert.deepEqual(n.relationEngine.pending,learned.pending);
  assert.deepEqual(n.sampleMemory,s.sampleMemory);
  assert.deepEqual(n.familyProbeGuards,s.familyProbeGuards);
  assert.match(n.latestReason,/保留/);
});

test("summary exposes relation lifecycle and the no-forced-reversal boundary",()=>{
  const s=initialForward(1000),view=forwardSummary(s,{},2000);
  assert.equal(view.engineVersion,FORWARD_RELATION_V2_VERSION);assert.equal(view.targetPositions,null);assert.equal(view.positionLimit,null);
  assert.equal(view.executionBboCapacity,30);assert.equal(view.minuteConfirmationCapacity,11);
  assert.match(view.boundaries.grammar,/15\/60\/180/);assert.match(view.boundaries.sampleMeaning,/旧方向失效不会自动生成反向订单/);
  assert.equal(view.relationEngine.version,FORWARD_RELATION_V2_VERSION);
  assert.equal(view.familyProbe.version,"forward-family-probe-v1");assert.equal(view.familyProbe.maxNewPer5m,2);
});
