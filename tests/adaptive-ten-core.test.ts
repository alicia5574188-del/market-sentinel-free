import test from "node:test";
import assert from "node:assert/strict";
import {ADAPTIVE_ENGINE_VERSION,advanceForward,closeForwardForReset,fillForwardPortfolio,forwardSummary,initialForward,normalizeForward,resetForwardAccountPreservingLearning,
  type Candle,type Contract,type Opportunity,type Quote} from "../lib/forward-relations.ts";
import {FORWARD_STORAGE,prepareForwardReset} from "../lib/forward-store.ts";
import {FORWARD_RELATION_V2_VERSION,advanceRelationEngine,initialRelationEngine,normalizeRelationEngine,relationCandidates,type RelationRule} from "../lib/forward-relation-v2.ts";
import {recordFamilyFailure,relationFamilyId} from "../lib/forward-family-experiment.ts";

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
const seedManualRules=(state:ReturnType<typeof initialForward>,ops:Opportunity[],now:number)=>{
  const grouped=new Map<string,Opportunity[]>();
  for(const o of ops){if(!o.relationRuleId)continue;const rows=grouped.get(o.relationRuleId)??[];rows.push(o);grouped.set(o.relationRuleId,rows);}
  state.relationEngine.rules=[...grouped.entries()].map(([id,rows])=>{const o=rows[0]!,idx=Math.max(0,symbols.indexOf(o.symbol)),
    feature=idx%8,op=idx<8?"GE":"LE",health=o.relationHealth??.9;
    return{id,signature:id,scope:o.reserve?"RECENT":"BASE",horizon:o.relationHorizon??60,side:o.side,
      conditions:[{feature,op,threshold:0}],longNet:.01,recentNet:.008,standardError:.001,samples:40,longGroups:6,recentGroups:3,
      health,status:o.relationStatus??"ACTIVE",livePathScore:.78,environmentFit:.82,stopRate:o.stopRate,targetRate:o.targetRate,
      exitProfile:{version:"sample-exit-plan-v1" as const,bestHoldMinutes:60 as const,feedbackDeadlineMinutes:15,maxHoldMinutes:60,
      normalAdverseRate:.008,targetRate:.012,protectionActivationRate:.004,retentionRate:.78,samples:40,groups:6,
      path:{15:{expectedRate:.003,adverseRate:.004,remainingEdgeRate:.007},30:{expectedRate:.006,adverseRate:.005,remainingEdgeRate:.004},
        45:{expectedRate:.009,adverseRate:.006,remainingEdgeRate:.002},60:{expectedRate:.011,adverseRate:.008,remainingEdgeRate:0}}},updatedAt:now,lastQualifiedAt:now-60_000,symbols:rows.map(x=>x.symbol),reason:"manual relation fixture"} satisfies RelationRule;});
};

const manualOpportunity=(symbol:string,index:number,options:{reserve?:boolean;premium?:boolean;ruleId?:string;score?:number;health?:number}={}):Opportunity=>{
  const price=full[symbol]![39]!.close,side=index%2?"SHORT":"LONG",stopRate=.015,targetRate=.03;
  return{id:`manual-${symbol}-${options.ruleId??index}`,symbol,side,mode:options.premium?"BREAKOUT":"RELATION",premium:options.premium??false,
    reserve:options.reserve??false,score:options.score??90,eligible:true,completedAt:nowAt(39)-1000,expiresAt:nowAt(39)+60*60_000,price,
    stopPrice:price*(side==="LONG"?1-stopRate:1+stopRate),targetPrice:price*(side==="LONG"?1+targetRate:1-targetRate),stopRate,targetRate,
    directionStrength:90,pathEfficiency:85,momentumPersistence:85,positionScore:85,spaceScore:90,executionScore:90,grossRemainingSpaceRate:targetRate,
    netRemainingSpaceRate:targetRate-.0019,pullbackRiskRate:stopRate,edgeRatio:1.8,expectedHoldMinutes:60,marketFit:85,regionId:null,regionQuality:null,
    reason:"portfolio-control fixture",relationRuleId:options.ruleId??`r-${symbol}`,relationStatus:"ACTIVE",relationHorizon:60,
    relationHealth:options.health??.9,riskScale:options.health??.9};
};

function learnThrough(last:number){let e=initialRelationEngine(nowAt(24)-1);for(let i=24;i<=last;i++)
  e=advanceRelationEngine({state:e,paths:sliced(i),now:nowAt(i)});return e;}

test("Forward Path Relation 3.0 learns from root paths without double-counting checkpoints",()=>{
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
  assert.ok(rapid.length>0&&rapid.some(c=>c.reserve),"recent reversal evidence must create at least one bounded probe; independently validated BASE evidence may coexist");
});

test("a restart can seed closed root paths immediately instead of waiting a fresh hour",()=>{
  const now=nowAt(50),e=advanceRelationEngine({state:initialRelationEngine(now-1000),paths:sliced(50),now});
  assert.ok(e.samples.length>=24,"closed 5m history should seed root paths immediately; trading authority still requires independent validation");
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

test("pure relation trades keep sample MAE for path invalidation but a wider hard safety stop for account risk",()=>{
  const learned=learnThrough(39),now=nowAt(39);let state=initialForward(now-60_000);state.relationEngine=learned;
  state=advanceForward({state,now,paths:sliced(39),quotes:quotesAt(39,now),contracts,entrySymbols:symbols}).state;
  const trade=state.positions.find(t=>t.entryContext?.mode==="RELATION"&&t.exitPlan);assert.ok(trade);
  assert.equal(trade!.entryContext!.pullbackRiskRate,trade!.exitPlan!.normalAdverseRate);
  assert.ok(trade!.rule.stopRate>trade!.exitPlan!.normalAdverseRate,
    "hard stop must sit outside the learned normal adverse path instead of reusing sample MAE as liquidation");
  assert.ok(trade!.plannedRisk>=trade!.notional*trade!.rule.stopRate,
    "position sizing must charge the wider hard stop, not the smaller sample invalidation allowance");
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

test("fast quote normalization preserves current v3 frames and evidence diagnostics",()=>{
  const learned=learnThrough(39),now=nowAt(39),frameCount=Object.keys(learned.frames).length,sampleCount=learned.samples.length,ruleCount=learned.rules.length;
  assert.ok(frameCount>0&&sampleCount>0&&ruleCount>0);
  let state=initialForward(now-60_000);state.relationEngine=learned;state.lastCandleAt=now;
  state=advanceForward({state,now:now+1000,paths:sliced(39),quotes:quotesAt(39,now+1000),contracts,entrySymbols:symbols,allowDataCycle:false}).state;
  assert.equal(Object.keys(state.relationEngine.frames).length,frameCount,"fast quote loop must not erase relation frames");
  assert.equal(state.relationEngine.samples.length,sampleCount,"fast quote loop must not erase matured samples");
  assert.equal(state.relationEngine.rules.length,ruleCount,"fast quote loop must not erase learned rules");
  assert.equal(state.relationEngine.diagnostics.matureSamples,sampleCount,"display diagnostics must be derived from actual samples");
  assert.equal(state.relationEngine.diagnostics.rules,ruleCount);
});

test("ordinary 5m relation inventory cannot keep opening on the fast quote loop",()=>{
  const now=nowAt(39),paths=sliced(39),symbol=symbols[0]!,s=initialForward(now-60_000);
  s.lastCandleAt=now;s.opportunities=[manualOpportunity(symbol,0,{premium:false})];
  const next=advanceForward({state:s,now,paths,quotes:quotesAt(39,now),contracts,entrySymbols:symbols,allowDataCycle:false}).state;
  assert.equal(next.positions.length,0);
});

test("one 5m deployment window cannot spray more than 2.5% portfolio risk budget",()=>{
  const now=nowAt(39),s=initialForward(now-60_000);s.lastCandleAt=now;
  s.opportunities=symbols.map((symbol,i)=>manualOpportunity(symbol,i,{premium:true}));seedManualRules(s,s.opportunities,now);
  fillForwardPortfolio(s,quotesAt(39,now),contracts,now,1000,false);
  const charge=s.positions.reduce((n,t)=>n+(t.entryContext?.portfolioRiskCharge??t.plannedRisk),0);
  assert.ok(charge<=25.01,`cycle charge ${charge}`);assert.ok(s.positions.length<=4);
});

test("probe relationships share one 1.5% portfolio pool instead of fragmenting into dozens of positions",()=>{
  const now=nowAt(39),s=initialForward(now-60_000);s.lastCandleAt=now;
  s.opportunities=symbols.map((symbol,i)=>manualOpportunity(symbol,i,{premium:true,reserve:true,health:.25,score:70}));seedManualRules(s,s.opportunities,now);
  s.relationEngine.rules.forEach(r=>{r.status="DEGRADED";r.health=.25;r.livePathScore=.70;r.environmentFit=.80;});
  fillForwardPortfolio(s,quotesAt(39,now),contracts,now,1000,false);
  const charge=s.positions.reduce((n,t)=>n+(t.entryContext?.portfolioRiskCharge??t.plannedRisk),0);
  assert.ok(charge<=15.01);assert.ok(s.positions.length<=2,"reserve experiments are paced to at most two per 5m cycle");
});

test("different rule ids from one causal family can open only one reserve experiment",()=>{
  const now=nowAt(39),s=initialForward(now-60_000);s.lastCandleAt=now;
  const a=manualOpportunity(symbols[0]!,0,{premium:true,reserve:true,ruleId:"family-a",health:.25,score:72}),
    b=manualOpportunity(symbols[2]!,2,{premium:true,reserve:true,ruleId:"family-b",health:.25,score:71});
  s.opportunities=[a,b];seedManualRules(s,s.opportunities,now);
  for(const [i,r] of s.relationEngine.rules.entries()){
    r.scope="RECENT";r.status="DEGRADED";r.health=.25;r.livePathScore=.70;r.environmentFit=.80;
    r.conditions=[{feature:2,op:"LE",threshold:i===0?-.17:-.31}];
  }
  fillForwardPortfolio(s,quotesAt(39,now),contracts,now,1000,false);
  assert.equal(s.positions.length,1);
  assert.ok(Object.keys(s.entryDiagnostics.reasons).some(reason=>/已有一笔探测仓/.test(reason)));
});

test("one learned relation cannot consume more than 2.5% portfolio budget across correlated symbols",()=>{
  const now=nowAt(39),s=initialForward(now-60_000);s.lastCandleAt=now;
  s.opportunities=symbols.map((symbol,i)=>manualOpportunity(symbol,i,{premium:true,ruleId:"shared-market-factor"}));seedManualRules(s,s.opportunities,now);
  fillForwardPortfolio(s,quotesAt(39,now),contracts,now,1000,false);
  const charge=s.positions.reduce((n,t)=>n+(t.entryContext?.portfolioRiskCharge??t.plannedRisk),0);
  assert.ok(charge<=25.01);assert.ok(s.positions.length<=4);
});

test("there is no fixed ten-position cap; strong independent relations can grow beyond ten only across multiple 5m budgets",()=>{
  const base=nowAt(39),s=initialForward(base-60_000);
  for(let cycle=0;cycle<5&&s.positions.length<=10;cycle++){
    const at=base+cycle*300_000;s.lastCandleAt=at;
    s.opportunities=symbols.filter(symbol=>!s.positions.some(t=>t.symbol===symbol))
      .map(symbol=>manualOpportunity(symbol,symbols.indexOf(symbol),{premium:true,score:92,health:.95}));seedManualRules(s,s.opportunities,at+1000);
    fillForwardPortfolio(s,quotesAt(39,at+1000),contracts,at+1000,1000,false);
  }
  assert.ok(s.positions.length>10,"risk-shaped portfolio may exceed ten when independent high-quality relations justify it");
  const charge=s.positions.reduce((n,t)=>n+(t.entryContext?.portfolioRiskCharge??t.plannedRisk),0),equity=forwardSummary(s,quotesAt(39,base+1_500_000),base+1_500_000).equity;
  assert.ok(charge<=equity*.10+1e-6);
  assert.ok(s.positions.reduce((n,t)=>n+t.margin,0)<=equity*.75+1e-6);
});

test("manual reset preparation remains bounded with twenty-two legacy open positions",async()=>{
  const now=nowAt(39),symbol=symbols[0]!,previous=initialForward(now-60_000);previous.lastCandleAt=now;
  previous.opportunities=[manualOpportunity(symbol,0,{premium:true})];seedManualRules(previous,previous.opportunities,now);
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

test("new PAPER trades freeze the sample exit plan and use its feedback deadline",()=>{
  const now=nowAt(39),symbol=symbols[0]!,state=initialForward(now-60_000);state.lastCandleAt=now;
  const o=manualOpportunity(symbol,0,{premium:true});state.opportunities=[o];seedManualRules(state,state.opportunities,now);
  const learned=state.relationEngine.rules[0]!.exitProfile;learned.bestHoldMinutes=30;learned.feedbackDeadlineMinutes=5;learned.maxHoldMinutes=45;
  fillForwardPortfolio(state,quotesAt(39,now),contracts,now,1000,false);
  assert.equal(state.positions.length,1);assert.deepEqual(state.positions[0]!.exitPlan,learned);
  const later=now+6*60_000,entry=state.positions[0]!.entryPrice,q:Quote={bestBid:entry*.9999,bestAsk:entry*1.0001,observedAt:later,fresh:true,entryReady:true};
  const next=advanceForward({state,now:later,paths:sliced(39),quotes:{[symbol]:q},contracts:{[symbol]:contract},entrySymbols:[symbol],allowDataCycle:false}).state;
  assert.ok(next.history.some(t=>t.symbol===symbol&&t.exitReason==="NO_POSITIVE_FEEDBACK"));
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
  assert.ok(Object.keys(next.familyExperiment.guards).length>0,"no-feedback degraded exit must lock the relation family");
  assert.equal(next.opportunities.some(o=>o.side==="SHORT"&&o.mode==="RELATION"),false,"degradation is defense, not a forced reversal");
});

test("an existing recent relation is revalidated on its own evidence before threshold-grid drift can degrade it",()=>{
  const positive=Object.fromEntries(symbols.map((symbol,i)=>[symbol,makePath(i,90,999)])) as Record<string,Candle[]>,
    slice=(last:number)=>Object.fromEntries(symbols.map(symbol=>[symbol,positive[symbol]!.slice(0,last+1)])) as Record<string,Candle[]>,
    at=(last:number)=>(positive[symbols[0]]![last]!.time+300)*1000+1000;
  let engine=initialRelationEngine(at(24)-1);for(let i=24;i<=50;i++)engine=advanceRelationEngine({state:engine,paths:slice(i),now:at(i)});
  const template=engine.rules.find(r=>r.scope==="RECENT"&&r.side==="LONG");assert.ok(template);
  const old={...structuredClone(template!),id:"legacy-grid-rule",signature:"old-grid-signature",
    conditions:[{feature:0,op:"GE" as const,threshold:-8},{feature:1,op:"GE" as const,threshold:-8}],
    horizon:15 as const,scope:"RECENT" as const,side:"LONG" as const,lastQualifiedAt:at(50)-60_000,status:"ACTIVE" as const,health:.70};
  engine.rules=[old];
  engine=advanceRelationEngine({state:engine,paths:slice(51),now:at(51)});
  const retained=engine.rules.find(r=>r.scope==="RECENT"&&r.conditions.length===2&&r.conditions.every(c=>c.threshold===-8));
  assert.ok(retained,"an old condition family outside the current RECENT search grid should be explicitly revalidated");
  assert.notEqual(retained!.status,"DEGRADED","positive current evidence must not be degraded solely because quantile thresholds moved");
  assert.doesNotMatch(retained!.reason,/未通过|旧关系未再/);
});

test("risk scaling never becomes a global trading pause merely because a relation is pressured",()=>{
  const learned=learnThrough(39),pressured=advanceRelationEngine({state:learned,paths:sliced(40),now:nowAt(40)});
  const candidates=relationCandidates(pressured).filter(c=>c.side==="LONG");
  assert.ok(candidates.length>0,"degraded/pressured relations retain bounded probe participation");
  assert.ok(candidates.every(c=>c.health>=.15));
  assert.ok(candidates.some(c=>c.reserve));
});

test("real Forward Relation 2.0 horizon records migrate into v3 root samples",()=>{
  const now=nowAt(39),at=now-30*60_000,x=[.4,.3,.2,.7,.1,.6,.2,.1],env={breadth:.6,dispersion:.3,expansion:.2};
  const legacy={version:"forward-relation-v2",startedAt:now-3*60*60_000,updatedAt:now-1000,observations:99,measured:66,invalidated:2,
    frames:{},pending:{},lastBars:{},rules:[],diagnostics:{},samples:[
      {symbol:"BTC_USDT",at,horizon:15,response:.004,up:.006,down:.0015,x,env,cp:{5:.001,10:.002,15:.004}},
      {symbol:"BTC_USDT",at,horizon:60,response:.011,up:.014,down:.002,x,env,cp:{5:.001,10:.002,15:.004,30:.008,60:.011}},
      {symbol:"ETH_USDT",at,horizon:15,response:.003,up:.005,down:.001,x,env,cp:{5:.001,10:.002,15:.003}},
      {symbol:"ETH_USDT",at,horizon:180,response:.02,up:.025,down:.005,x,env,cp:{5:.001,10:.002,15:.003,30:.006,60:.01,180:.02}},
    ]};
  const migrated=normalizeRelationEngine(legacy,now);
  assert.equal(migrated.samples.length,2,"same-symbol 15m/60m legacy rows must merge into one root; 180m still contributes shared <=60m checkpoints");
  assert.equal(migrated.samples.find(r=>r.symbol==="BTC_USDT")?.cp[60],.011);
  assert.equal(migrated.samples.find(r=>r.symbol==="ETH_USDT")?.cp[60],.01);
  assert.equal(migrated.measured,66,"historical measured counter must remain intact");
  assert.equal(migrated.diagnostics.matureSamples,2,"diagnostics must reflect migrated evidence instead of resetting to zero");
  assert.equal(migrated.diagnostics.effectiveGroups,1);
});

test("strategy migration preserves account identity, financial history and causal samples instead of cold-resetting learning",()=>{
  const learned=learnThrough(39),s=initialForward(1000);s.startedAt=123;s.balance=876.54;s.initialEquity=1000;s.resolved=7;s.turnover=4321;
  s.relationEngine=structuredClone(learned);(s.relationEngine as unknown as {version:string}).version="forward-relation-v2";
  s.engineVersion="legacy";s.strategyAuthorityVersion="legacy";s.executionVersion="legacy";s.storage={persistedAt:999,error:null};
  const n=normalizeForward(s,5000);
  assert.equal(n.startedAt,123);assert.equal(n.balance,876.54);assert.equal(n.resolved,7);assert.equal(n.turnover,4321);
  assert.equal(n.storage.persistedAt,999);assert.equal(n.engineVersion,ADAPTIVE_ENGINE_VERSION);
  assert.equal(n.strategyAuthorityVersion,FORWARD_RELATION_V2_VERSION);assert.equal(n.executionVersion,FORWARD_RELATION_V2_VERSION);
  assert.ok(n.relationEngine.samples.length>0);assert.ok(n.relationEngine.measured>=learned.measured);
});


test("manual PAPER reset preserves causal learning while resetting the financial account",()=>{
  const learned=learnThrough(39),now=nowAt(39),s=initialForward(now-60_000);s.relationEngine=learned;
  const guardRule=learned.rules[0]!,familyId=relationFamilyId(guardRule);
  recordFamilyFailure({state:s.familyExperiment,familyId,sourceRuleId:guardRule.id,evidenceAt:guardRule.lastQualifiedAt,
    health:guardRule.health,livePathScore:guardRule.livePathScore,now,reason:"NO_POSITIVE_FEEDBACK",symbol:"S0_USDT"});
  s.balance=812.34;s.resolved=9;s.wins=4;s.turnover=5432;
  const n=resetForwardAccountPreservingLearning(s,now+1000);
  assert.equal(n.balance,1000);assert.equal(n.initialEquity,1000);assert.equal(n.resolved,0);assert.equal(n.wins,0);assert.equal(n.turnover,0);
  assert.equal(n.positions.length,0);assert.equal(n.history.length,0);
  assert.equal(n.relationEngine.samples.length,learned.samples.length);assert.equal(n.relationEngine.rules.length,learned.rules.length);
  assert.equal(n.relationEngine.observations,learned.observations);assert.equal(n.relationEngine.measured,learned.measured);
  assert.deepEqual(n.relationEngine.rules,learned.rules);assert.deepEqual(n.relationEngine.pending,learned.pending);
  assert.deepEqual(n.familyExperiment,s.familyExperiment);
  assert.match(n.latestReason,/保留/);
});

test("summary exposes relation lifecycle and the no-forced-reversal boundary",()=>{
  const s=initialForward(1000),view=forwardSummary(s,{},2000);
  assert.equal(view.engineVersion,FORWARD_RELATION_V2_VERSION);assert.equal(view.targetPositions,null);assert.equal(view.positionLimit,null);
  assert.equal(view.executionBboCapacity,30);assert.equal(view.minuteConfirmationCapacity,11);
  assert.match(view.boundaries.grammar,/15\/30\/45\/60/);assert.equal(view.boundaries.historyBackfill,true);assert.match(view.boundaries.sampleMeaning,/旧方向失效不会自动生成反向订单/);
  assert.equal(view.relationEngine.version,FORWARD_RELATION_V2_VERSION);
});
