import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {RESEARCH_PLAN_VERSION as RPV,researchPlanContext} from '../lib/research-plan.ts';
import {WINNER_POLICY_VERSION as WPV,advanceWinnerManagement,selectWinnerOpportunity,type WinnerPlan} from '../lib/winner-policy.ts';
import {initialMarketHypothesisResearch,type MarketHypothesis,type MarketHypothesisResearchState} from '../lib/market-intelligence-hypothesis-research.ts';
import {initialForward,applyOpportunityResearch,fillForwardPortfolio,manageWinnerTrade,type Trade,type Opportunity,type Quote} from '../lib/forward-relations.ts';
import type {MarketSymbolState,CandleLike} from '../lib/market-intelligence-engine.ts';
import {captureTradeReviews,initialReviewJournal,appendReviewEvents} from '../lib/review-trace.ts';
import {buildReviewSnapshot,checkpointCoverage,mergeReviewArchive,reviewVersionDiagnostics} from '../lib/research-snapshot.ts';
import {prepareForwardWrite,readForwardStore,prepareForwardProtectionWrite} from '../lib/forward-store.ts';

const T=1790816400000,B=300_000;
const healthy:MarketSymbolState={symbol:'TEST_USDT',watchScore:90,regime:'DIVERGENT',stage:'READY',clusterId:'corr:TEST',correlation:.5,beta:1,volatility:.004,dataConfidence:96,actualMove:.025,expectedMove:.003,residual:.022,residualZ:1.8,residualPersistence:1,relativeStrength:.8,longScore:90,shortScore:10,pathLong:.9,pathShort:.1,roomLong:.05,roomShort:.001,sourceCount:4,venueAgreement:1,venuePressure:.7,reasons:[],signalSide:'LONG',signalSince:T-3*B,signalBars:3,signalLastBar:T};
function hypotheses(now=T,patch:Partial<MarketHypothesis>={}):MarketHypothesisResearchState{
  return{...initialMarketHypothesisResearch(now),active:[{id:'warning',key:'PULLBACK_AHEAD:SHORT',kind:'PULLBACK_AHEAD',direction:'SHORT',
    confidence:.8,startedAt:now-3*B,updatedAt:now,expiresAt:now+3*B,confirmedAt:now-B,observations:4,targetHits:3,targetHitStreak:3,
    invalidationHitStreak:0,lastTargetAt:now,status:'CONFIRMED',horizonMinutes:[5,15,30],families:['BREADTH','FLOW'],
    evidenceTypes:[],thesis:'synthetic warning',expectedNext:[],invalidation:'synthetic recovery',...patch}]};
}
const context=(now=T,state=healthy,research=hypotheses(now))=>researchPlanContext({now,state,score:state.watchScore,side:'LONG',research});
const quote=(price:number,now=T):Quote=>({bestBid:price,bestAsk:price,observedAt:now,fresh:true,entryReady:true,sourceCount:4,
  bookImbalance:.4,bidLiquidityChange:.2,askLiquidityChange:-.2,liquiditySourceCount:3,disagreementRate:0});
const row=(at:number,open:number,close:number,low=Math.min(open,close)-.1,high=Math.max(open,close)+.1):CandleLike=>({time:at/1000,open,close,low,high,volume:100});
const plan=():WinnerPlan=>({version:WPV,researchVersion:RPV,intent:'TREND',source:'RELATIVE_CORE',eventAt:T-B,initialStop:99,
  origin:null,target:null,targetArea:null,riskGroup:'corr:TEST:LONG:TREND'});
const args={side:'LONG' as const,price:104,entryPrice:100,openedAt:T,now:T+3*B,plan:plan(),rows:[] as CandleLike[],cost:.0019,
  remainingFraction:1,concernFamilies:[] as string[],supportFamilies:['PATH','STRUCTURE'],positionExit:false,trendEligible:true};
function fixture(){const s=initialForward(T-B);s.extremumRegime.symbols.TEST_USDT=healthy;s.extremumRegime.updatedAt=T;
  const p=plan(),o={id:'test-integrated',symbol:'TEST_USDT',side:'LONG',mode:'RELATIVE',premium:true,score:90,eligible:true,
    completedAt:T,expiresAt:T+B,price:100,stopPrice:99,targetPrice:105,stopRate:.01,targetRate:.05,directionStrength:90,pathEfficiency:90,
    momentumPersistence:100,positionScore:80,spaceScore:90,executionScore:100,grossRemainingSpaceRate:.05,netRemainingSpaceRate:.0481,
    pullbackRiskRate:.01,edgeRatio:4.81,expectedHoldMinutes:180,marketFit:80,regionId:null,regionQuality:null,reason:'synthetic fixture',
    strategyVersion:'market-intelligence-v1',winnerPlan:p,tradePlan:'WINNER_TREND',liquidityInvalidationPrice:99,clusterId:healthy.clusterId,thesisId:'test-integrated'} as Opportunity;
  s.opportunities=[o];const before=structuredClone(s);
  assert.equal(fillForwardPortfolio(s,{TEST_USDT:quote(100)},{TEST_USDT:{quantoMultiplier:.01,leverageMax:10,maintenanceRate:.005,minContracts:1}},T,1000,false),1);
  captureTradeReviews(before,s,T,'build-new','fp-new',{TEST_USDT:quote(100)});return {s,t:s.positions[0]!,before};
}

test('forming, weakened, stale, future and expired hypotheses cannot change valid entry behavior',()=>{
  for(const patch of [{status:'FORMING' as const,confirmedAt:null},{status:'WEAKENING' as const},{updatedAt:T-16*60000},{updatedAt:T+1},{expiresAt:T-1}]){
    const c=context(T,healthy,hypotheses(T,patch));assert.notEqual(c.level,'CAUTION');assert.equal(c.entryAction,'NORMAL');assert.equal(c.riskScale,1);
  }
});
test('a stable market warning reduces new risk but preserves the independent winner lane',()=>{
  const c=context();assert.equal(c.level,'CAUTION');assert.equal(c.entryAction,'SMALLER_RISK');assert.equal(c.riskScale,.85);
  const dependent=context(T,{...healthy,watchScore:78,residualZ:.4});assert.equal(dependent.entryAction,'CONFIRM_MORE');assert.equal(dependent.riskScale,.70);
});
test('research updates the pending plan advice without rewriting side, geometry or event identity',()=>{
  const {s}=fixture(),o=s.opportunities[0]!,p=structuredClone(o.winnerPlan!);s.hypothesisResearch=hypotheses();
  applyOpportunityResearch(s,o,T);assert.equal(o.winnerPlan!.entryResearch?.entryAction,'SMALLER_RISK');assert.equal(o.extendedConfirmation,false);
  assert.equal(o.winnerPlan!.initialStop,p.initialStop);assert.equal(o.winnerPlan!.eventAt,p.eventAt);assert.deepEqual(o.winnerPlan!.origin,p.origin);
  s.hypothesisResearch=initialMarketHypothesisResearch(T+1000);applyOpportunityResearch(s,o,T+1000);assert.equal(o.environmentRiskScale,1);
});
test('original relative core proposal is preserved exactly, not tuned on winning examples',()=>{
  const code=readFileSync(new URL('../lib/winner-policy.ts',import.meta.url),'utf8'),core=code.slice(code.indexOf('export function trendCore'),code.indexOf('/** New-entry geometry'));
  assert.equal(createHash('sha256').update(core).digest('hex'),'8df8569614f4063571e7bf0a3b9f59965fb748281b7f4831e102f15bef29f4d5');
  for(const price of [100,110])assert.equal(selectWinnerOpportunity({state:healthy,price,rows:[],now:T,majorScore:0,shortScore:0}).eligible,true);
});
test('market-only warnings leave healthy trend actions and protection unchanged on identical price paths',()=>{
  for(const price of [100,103,107,106.6,110]){
    const clear=advanceWinnerManagement({...args,price,researchContext:context(args.now,healthy,initialMarketHypothesisResearch(args.now))});
    const warning=advanceWinnerManagement({...args,price,researchContext:context(args.now)});
    assert.equal(warning.action,clear.action);assert.equal(warning.state.protectedStop,clear.state.protectedStop);
  }
});
test('three price-derived concern labels are one group, not three independent exit votes',()=>{
  const c=context(args.now),result=advanceWinnerManagement({...args,researchContext:c,positionExit:true,concernFamilies:['RELATIVE','PATH','STRUCTURE'],trendEligible:false});
  assert.equal(result.action,'HOLD');assert.deepEqual(result.state.research?.evidenceGroups,['PRICE']);assert.equal(result.state.research?.allowExit,false);
});
test('a slow starter is not rejected by time or market concern alone',()=>{
  for(const age of [20_000,30*60000,3*3600000]){
    const x=advanceWinnerManagement({...args,now:T+age,price:99.9,researchContext:context(T+age),concernFamilies:['RELATIVE'],positionExit:true});
    assert.equal(x.action,'HOLD');assert.equal(x.state.protectedStop,99);
  }
});
test('post-entry break and failed recovery can exit; incomplete, stale and pre-entry bars cannot',()=>{
  const rows=[row(T,100,100,99.8,100.2),row(T+B,99.8,99.3,99.2,99.9),row(T+2*B,99.3,99.2,99.1,99.5)];
  const input={...args,price:99.2,rows,positionExit:true,concernFamilies:['PATH','STRUCTURE'],researchContext:context(args.now)};
  assert.equal(advanceWinnerManagement(input).reason,'WINNER_THESIS_EXIT');
  for(const p of [{now:T+2*B+2000},{openedAt:T+1},{now:T+10*B},{rows:[rows[0]!,rows[2]!]}])assert.equal(advanceWinnerManagement({...input,...p}).action,'HOLD');
  assert.equal(advanceWinnerManagement({...input,price:100}).action,'HOLD','recovered current price cannot be exited on old broken closes');
});
test('real rapid price failure plus fresh independent book evidence and hard stops still exit promptly',()=>{
  const now=T+20_000,q={...quote(99.5,now),bookImbalance:-.4,bidLiquidityChange:-.3,askLiquidityChange:.3};
  const input={...args,now,price:99.5,researchContext:context(now),positionExit:true,exitBasis:'ENTRY_PRICE_FALSIFIED',quote:q,concernFamilies:['STRUCTURE','FLOW']};
  assert.equal(advanceWinnerManagement(input).action,'EXIT');
  assert.equal(advanceWinnerManagement({...input,quote:{...q,observedAt:T-1}}).action,'HOLD');
  assert.equal(advanceWinnerManagement({...input,price:98.9,positionExit:false}).reason,'WINNER_STRUCTURE_EXIT');
});
test('stable warning plus actual local deterioration protects only after a causally later complete candle',()=>{
  const rows=[row(T,105,105,104.9,105.2),row(T+B,105,104.3,104.2,105.1),row(T+2*B,104.3,103.9,103.8,104.5)],p={...plan(),initialStop:98};
  const seed=advanceWinnerManagement({...args,plan:p,price:105.2,now:T+1});
  const input={...args,price:103.9,plan:p,now:T+3*B+100,rows,previous:seed.state,researchContext:context(T+3*B+100),concernFamilies:['RELATIVE','PATH'],trendEligible:false};
  const first=advanceWinnerManagement(input);assert.equal(first.action,'HOLD');assert.equal(first.state.research?.protect,true);
  const tick=advanceWinnerManagement({...input,previous:first.state,now:input.now+2000});assert.equal(tick.action,'HOLD');assert.equal(tick.state.obstacleBars,0);
  const later=advanceWinnerManagement({...input,previous:tick.state,now:T+4*B+100,rows:[...rows,row(T+3*B,103.9,103.8,103.7,104.1)],price:103.8,researchContext:context(T+4*B+100)});
  assert.equal(later.action,'REDUCE');assert.ok(later.fraction>=.15&&later.fraction<=.65);
});
test('actual trade management records proposed versus applied action and preserves money on HOLD',()=>{
  const {s,t}=fixture();s.hypothesisResearch=hypotheses(T+2000);const balance=s.balance,contracts=t.contracts;
  const exited=manageWinnerTrade(s,t,quote(101,T+2000),T+2000,{},{});
  assert.equal(exited,false);assert.equal(t.winnerManagement?.research?.context.level,'CAUTION');
  assert.equal(t.winnerManagement?.appliedAction,'HOLD');assert.equal(s.balance,balance);assert.equal(t.contracts,contracts);
});
test('important research/protection events and version identity survive quote chatter and paged restart',async()=>{
  const {s,t}=fixture();let prior=structuredClone(s);
  for(let i=1;i<=40;i++){
    const now=T+i*2000;s.hypothesisResearch=i%2?hypotheses(now):initialMarketHypothesisResearch(now);
    manageWinnerTrade(s,t,quote(101,now),now,{},{});captureTradeReviews(prior,s,now,i<20?'build-new':'build-patch','fp-new',{TEST_USDT:quote(101,now)});prior=structuredClone(s);
  }
  assert.ok(t.review!.milestones?.firstMarketCaution);assert.equal(t.review!.entryBuildSha,'build-new');assert.equal(t.review!.policySpans?.length,2);
  assert.ok(new TextEncoder().encode(JSON.stringify(t.review)).length<=6144);
  const time=T+80000;s.storage.persistedAt=time;const write=await prepareForwardWrite(null,s,time,{compact:true}),db=new Map(Object.entries(write.entries));
  const restored=await readForwardStore({get:async<T>(k:string)=>structuredClone(db.get(k)) as T|undefined},time+1);
  assert.equal(restored.balance,s.balance);assert.equal(restored.positions[0]!.entryContext?.winnerPlan?.entryResearch?.version,RPV);
  assert.deepEqual(restored.positions[0]!.winnerManagement,JSON.parse(JSON.stringify(t.winnerManagement)));
  const checkpoint=prepareForwardProtectionWrite(s);assert.ok(new TextEncoder().encode(JSON.stringify(checkpoint)).length<112*1024);
});
test('snapshot isolates current entries, old entries, mixed management and unknown records',()=>{
  const {s,t}=fixture(),closed={...structuredClone(t),status:'CLOSED',closedAt:T+1000,netPnl:5,grossPnl:5.2,exitFee:.1} as Trade;
  closed.review!.exitBuildSha='build-new';closed.review!.exitStrategyFingerprint='fp-new';
  const old=structuredClone(closed);old.id='old';old.review!.entryStrategyFingerprint='fp-old';old.review!.entryBuildSha='old-build';
  const unknown=structuredClone(closed);unknown.id='unknown';delete unknown.review;
  const snap=buildReviewSnapshot({view:{startedAt:s.startedAt,resolved:3,positions:[],history:[closed,old,unknown]},exportedAt:T+2000,buildSha:'build-new',strategyFingerprint:'fp-new'});
  const d=snap.versionDiagnostics as ReturnType<typeof reviewVersionDiagnostics>;
  assert.equal(d.currentEntry.entries,1);assert.equal(d.olderEntry.entries,1);assert.equal(d.unknownEntry.entries,1);assert.equal(d.changedStrategyWhileOpen.entries,1);
  assert.equal(d.integratedEvidence.complete,false);assert.ok(snap.issues.some(i=>i.code==='INTEGRATED_PLAN_EVIDENCE_MISSING'));
});
test('richer archived causal receipt wins without changing settlement and without inventing entry identity',()=>{
  const {t,s}=fixture(),closed={...t,status:'CLOSED',closedAt:T+1000,netPnl:1} as Trade;
  const snap=buildReviewSnapshot({view:{startedAt:s.startedAt,resolved:1,positions:[],history:[{...closed,review:{...closed.review,fromEntry:false,entryBuildSha:null,entryStrategyFingerprint:null}}]},exportedAt:T+2000,buildSha:'b',strategyFingerprint:'f'});
  mergeReviewArchive(snap,{accountStartedAt:s.startedAt,asOf:T+2000,trades:[closed],recordsRead:1,nextCursor:null,exhausted:true});
  assert.equal(snap.trades[0]!.netPnl,1);assert.equal(snap.trades[0]!.review?.entryBuildSha,'build-new');
});
test('45 minute coverage is real and future checkpoint observations cannot be counted',()=>{
  const at=T+45*60000,cp={minutes:45,targetAt:at,observedAt:at,marketAt:at,price:100};
  assert.equal(checkpointCoverage({startedAt:T,checkpoints:[cp]},at)['45'],'VALID');
  assert.notEqual(checkpointCoverage({startedAt:T,checkpoints:[cp]},T)['45'],'VALID');
  assert.equal(checkpointCoverage({startedAt:T,checkpoints:[]},at)['45'],'DUE_NOT_OBSERVED');
});
test('observed-only candidate churn does not first evict authorized execution evidence',()=>{
  const j=initialReviewJournal(T,T);appendReviewEvents(j,[{at:T,id:'important',symbol:'TEST_USDT',stage:'AUTHORIZED',reason:'original',buildSha:'b',planVersion:RPV}],T);
  for(let i=0;i<100;i++)appendReviewEvents(j,[{at:T+i+1,id:'watch-'+i,symbol:'X_USDT',stage:'CANDIDATE_OBSERVED',reason:'watch'}],T+i+1);
  assert.ok(j.candidates.some(r=>r.id==='important'));assert.ok(j.droppedCandidates>0);
});

test('short-side causal structure failure is symmetric and cannot be replaced by a general market warning',()=>{
  const rows=[row(T,100,100,99.8,100.2),row(T+B,100.2,100.7,100.1,100.8),row(T+2*B,100.7,100.8,100.5,100.9)],p={...plan(),initialStop:101};
  const x=advanceWinnerManagement({...args,side:'SHORT',price:100.8,rows,plan:p,positionExit:true,concernFamilies:['PATH','STRUCTURE'],researchContext:context(args.now)});
  assert.equal(x.reason,'WINNER_THESIS_EXIT');assert.equal(x.state.research?.referencePrice,100.2);
  const normal=advanceWinnerManagement({...args,side:'SHORT',price:97,plan:p,researchContext:context(args.now)});assert.equal(normal.action,'HOLD');
});
test('tiny net profits are not fragmented merely because a stable market warning exists',()=>{
  const x=advanceWinnerManagement({...args,price:100.3,plan:{...plan(),target:100.35},researchContext:context(args.now),
    concernFamilies:['PATH','RELATIVE'],rows:[row(T,100.7,100.6),row(T+B,100.6,100.4),row(T+2*B,100.4,100.3)]});
  assert.equal(x.action,'HOLD');
});
test('diagnostic fingerprint includes the winner, research and money modules whose changes matter',()=>{
  const config=readFileSync(new URL('../vite.config.ts',import.meta.url),'utf8');
  for(const p of ['lib/winner-policy.ts','lib/research-plan.ts','lib/winner-risk.ts','lib/market-intelligence-hypothesis-research.ts','lib/trade-realization.ts'])assert.ok(config.includes(p));
});

test('ten fully annotated holdings keep protection checkpoints within the existing single-value budget',()=>{
  const {s,t}=fixture();s.storage.persistedAt=T;
  const h=hypotheses(T+4*B);h.active=[0,1,2].map(i=>({...h.active[0]!,id:'fh-market-hypothesis-'+i,kind:i===0?'PULLBACK_AHEAD':i===1?'REVERSAL_AHEAD':'EXPANSION_AHEAD'}));
  s.hypothesisResearch=h;manageWinnerTrade(s,t,quote(104,T+4*B),T+4*B,{},{});
  captureTradeReviews(structuredClone(s),s,T+4*B,'a'.repeat(40),'b'.repeat(64),{TEST_USDT:quote(104,T+4*B)});
  const r=t.review!,point=r.timeline.at(-1)!;
  r.milestones={firstMarketCaution:point,firstLocalReview:point,firstProtection:point,reductions:[point,point]};
  r.policySpans=[0,1,2,3].map(i=>({at:T+i,buildSha:('a'+i).repeat(20),strategyFingerprint:('b'+i).repeat(32)}));
  r.timeline=Array.from({length:6},(_,i)=>({...point,at:T+i}));
  s.positions=Array.from({length:10},(_,i)=>({...structuredClone(t),id:'annotated-'+i,symbol:'COIN'+i+'_USDT'}));
  const write=prepareForwardProtectionWrite(s),bytes=new TextEncoder().encode(JSON.stringify(write)).length;
  assert.ok(bytes<112*1024,`checkpoint bytes ${bytes}`);
});
