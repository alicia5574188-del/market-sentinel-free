import test from "node:test";
import assert from "node:assert/strict";
import {ADAPTIVE_ENGINE_VERSION,advanceForward,forwardSummary,initialForward,normalizeForward,resetForwardAccountPreservingLearning,
  type Candle,type Contract,type Opportunity,type Quote} from "../lib/forward-relations.ts";
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

test("position count is not capped at ten; risk and margin remain the limiting authorities",()=>{
  const now=nowAt(39),paths=sliced(39);let s=initialForward(now-60_000);
  s.lastCandleAt=now;s.opportunities=symbols.map((symbol,i)=>({id:`manual-${symbol}`,symbol,side:i%2?"SHORT":"LONG",mode:"RELATION",premium:false,reserve:true,
    score:70,eligible:true,completedAt:now-1000,expiresAt:now+60_000,price:full[symbol]![39]!.close,stopPrice:full[symbol]![39]!.close*(i%2?1.003:.997),
    targetPrice:full[symbol]![39]!.close*(i%2?.994:1.006),stopRate:.003,targetRate:.006,directionStrength:60,pathEfficiency:60,momentumPersistence:60,
    positionScore:70,spaceScore:70,executionScore:90,grossRemainingSpaceRate:.006,netRemainingSpaceRate:.0041,pullbackRiskRate:.003,edgeRatio:1.36,
    expectedHoldMinutes:60,marketFit:70,regionId:null,regionQuality:null,reason:"risk-limited fixture",relationRuleId:`r-${symbol}`,relationStatus:"ACTIVE",relationHorizon:60,
    relationHealth:.25,riskScale:.25} satisfies Opportunity));
  for(let i=0;i<4;i++)s=advanceForward({state:s,now:now+i*1000,paths,quotes:quotesAt(39,now+i*1000),contracts,entrySymbols:symbols,allowDataCycle:false}).state;
  assert.equal(s.positions.length,12,"legacy ten-seat cap must not stop otherwise risk-valid positions");
  const equity=forwardSummary(s,quotesAt(39,now+4000),now+4000).equity;
  assert.ok(s.positions.reduce((n,t)=>n+t.plannedRisk,0)<=equity*.10+1e-6);
  assert.ok(s.positions.reduce((n,t)=>n+t.margin,0)<=equity*.75+1e-6);
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
  const learned=learnThrough(39),now=nowAt(39);let s=initialForward(now-60_000);s.relationEngine=learned;
  s.sampleMemory["RELATION:MIXED:LONG"]={count:4,emaNetRate:.003,emaMfeRate:.008,emaMaeRate:.002,updatedAt:now};
  s.balance=812.34;s.resolved=9;s.wins=4;s.turnover=5432;
  const n=resetForwardAccountPreservingLearning(s,now+1000);
  assert.equal(n.balance,1000);assert.equal(n.initialEquity,1000);assert.equal(n.resolved,0);assert.equal(n.wins,0);assert.equal(n.turnover,0);
  assert.equal(n.positions.length,0);assert.equal(n.history.length,0);
  assert.equal(n.relationEngine.samples.length,learned.samples.length);assert.equal(n.relationEngine.rules.length,learned.rules.length);
  assert.equal(n.relationEngine.observations,learned.observations);assert.equal(n.relationEngine.measured,learned.measured);
  assert.deepEqual(n.relationEngine.rules,learned.rules);assert.deepEqual(n.relationEngine.pending,learned.pending);
  assert.deepEqual(n.sampleMemory,s.sampleMemory);
  assert.match(n.latestReason,/保留/);
});

test("summary exposes relation lifecycle and the no-forced-reversal boundary",()=>{
  const s=initialForward(1000),view=forwardSummary(s,{},2000);
  assert.equal(view.engineVersion,FORWARD_RELATION_V2_VERSION);assert.equal(view.targetPositions,null);assert.equal(view.positionLimit,null);
  assert.equal(view.executionBboCapacity,30);assert.equal(view.minuteConfirmationCapacity,11);
  assert.match(view.boundaries.grammar,/15\/60\/180/);assert.match(view.boundaries.sampleMeaning,/旧方向失效不会自动生成反向订单/);
  assert.equal(view.relationEngine.version,FORWARD_RELATION_V2_VERSION);
});
