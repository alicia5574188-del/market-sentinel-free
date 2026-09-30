import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initialForward,advanceForward,type Trade,type Quote,type Opportunity} from '../lib/forward-relations.ts';
import {buildReviewSnapshot,mergeReviewArchive,checkpointCoverage,readReviewArchivePage,collectReviewSnapshot} from '../lib/research-snapshot.ts';
import {captureTradeReviews,initialReviewJournal,appendReviewEvents,recordDiscoveryReview,REVIEW_JOURNAL_BYTES} from '../lib/review-trace.ts';
import {advanceCounterfactualResearch,initialCounterfactualResearch,counterfactualResearchWrites} from '../lib/market-intelligence-research.ts';
import {advanceShadowResearch,initialShadowResearch,type TradeShadowResearch} from '../lib/market-intelligence-shadow-research.ts';
import {prepareForwardWrite} from '../lib/forward-store.ts';
const T=1790760000000;
const trade=(id='one',patch:Partial<Trade>={}):Trade=>({id,symbol:'AAA_USDT',side:'LONG',status:'CLOSED',openedAt:T+1000,closedAt:T+20000,
  entryPrice:100,exitPrice:101,quantity:1,contracts:1,quantoMultiplier:1,notional:100,margin:10,leverage:10,plannedRisk:2,stopPrice:98,
  favorable:.04,adverse:.01,lastPrice:101,lastQuoteAt:T+20000,entryFee:.07,exitFee:.0707,fundingAllowance:0,grossPnl:1,netPnl:.8593,
  exitReason:'POSITION_VALUE_EXIT',rule:{id:'r',signature:'r',reason:'fixture',conditions:[]},execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
  ...patch} as Trade);
const view=(trades:Trade[],resolved:number)=>({startedAt:T,updatedAt:T+30000,policyVersion:'fixture',initialEquity:1000,balance:992,equity:993,
  netPnl:-7,floating:1,fees:4,grossPnl:-4,resolved,positions:trades.filter(t=>t.status==='OPEN'),history:trades.filter(t=>t.status==='CLOSED'),opportunities:[]});
const snapshot=(trades:Trade[],resolved=trades.length)=>buildReviewSnapshot({view:view(trades,resolved),exportedAt:T+60000,buildSha:'build',strategyFingerprint:'policy'});
const quote=(p:number,at:number):Quote=>({bestBid:p,bestAsk:p+.01,observedAt:at,fresh:true,entryReady:true});

test('account aggregate is not confused with the included trade window; records are unique',()=>{
  const a=trade(),s=snapshot([a],160);assert.equal(s.coverage.missingClosed,159);assert.equal(s.coverage.complete,false);
  assert.equal((s.summary.includedClosedPerformance as {netPnl:number}).netPnl,.8593);assert.equal(s.account.netPnl,-7);
  mergeReviewArchive(s,{accountStartedAt:T,asOf:T+60000,trades:[a,a,trade('two')],recordsRead:12,nextCursor:'next',exhausted:false});
  assert.equal(s.trades.length,2);assert.equal(s.coverage.missingClosed,158);assert.equal(s.account.netPnl,-7);
});
test('archive preserves rich exit evidence lost in hot compaction and detects conflicting settlements',()=>{
  const a=trade(),s=snapshot([a]);const pi={decision:'EXIT'} as Trade['positionIntelligence'];
  mergeReviewArchive(s,{accountStartedAt:T,asOf:T+60000,trades:[{...a,positionIntelligence:pi}],recordsRead:1,nextCursor:null,exhausted:true});
  assert.deepEqual(s.trades[0].positionIntelligence,pi);
  mergeReviewArchive(s,{accountStartedAt:T,asOf:T+60000,trades:[{...a,netPnl:9}],recordsRead:1,nextCursor:null,exhausted:true});
  assert.deepEqual(s.coverage.conflictingTradeIds,['one']);assert.equal(s.trades[0].netPnl,.8593);assert.equal(s.coverage.complete,false);
});
test('old shadow positions are isolated; FULL path label cannot override unavailable checkpoints',()=>{
  const s=buildReviewSnapshot({view:view([trade()],1),exportedAt:T+60000,buildSha:null,strategyFingerprint:null,
    shadow:{trades:[{tradeId:'old',openedAt:T-10000,status:'OPEN'}],marketGeometry:[{at:T,label:'MIXED'}]},
    counterfactual:{postExit:[{openedAt:T+1000,startedAt:T,pathCoverage:'FULL',checkpoints:[],unavailableCheckpoints:[5]}]}});
  assert.equal((s.research.tradeQuality as unknown[]).length,0);assert.equal((s.research.priorAccount as {excludedOpenRecords:number}).excludedOpenRecords,1);
  assert.equal((s.market.geometry as unknown[]).length,1);
  const c=checkpointCoverage({startedAt:T,pathCoverage:'FULL',unavailableCheckpoints:[5]},T+16*60000);
  assert.equal(c['5'],'UNAVAILABLE');assert.equal(c['15'],'DUE_NOT_OBSERVED');assert.equal(c['60'],'PENDING');
});
test('read-only archive paging validates range and excludes other epochs, future records and obsolete OPEN copies',async()=>{
  let reads=0;const storage={list:async<TValue>(options:unknown)=>{assert.ok(options);reads++;
    return new Map([['key',{startedAt:T,trades:[trade(),trade('future',{closedAt:T+90000}),trade('open',{status:'OPEN',closedAt:null})]}]]) as Map<string,TValue>;}};
  const p=await readReviewArchivePage(storage,T,T+60000,null);assert.equal(reads,1);assert.equal(p.trades.length,1);assert.equal(p.exhausted,true);
  await assert.rejects(()=>readReviewArchivePage(storage,T,T+60000,'other-key'),/INVALID_REVIEW_CURSOR/);assert.equal(reads,1);
});
test('one-click collector assembles archive pages and does not mix resets',async()=>{
  const s=snapshot([trade()],2);let calls=0;
  const result=await collectReviewSnapshot((async (url:unknown)=>{calls++;
    return Response.json(String(url).includes('?')?{accountStartedAt:T,asOf:T+60000,trades:[trade('two')],recordsRead:1,nextCursor:null,exhausted:true}:s);
  }) as typeof fetch);
  assert.equal(calls,2);assert.equal(result.coverage.complete,true);assert.equal(result.trades.length,2);
  assert.throws(()=>mergeReviewArchive(s,{accountStartedAt:T+1,asOf:T+60000,trades:[],recordsRead:0,nextCursor:null,exhausted:true}),/CHANGED/);
});
test('owner OFF is not counted as a copy failure and exports have no strategy side effects',()=>{
  const input={...view([trade()],1),liveMirror:{rows:[{status:'OWNER_OFF'}],eligibleMissingCount:0}};
  const before=structuredClone(input),s=buildReviewSnapshot({view:input,exportedAt:T+60000,buildSha:null,strategyFingerprint:null});
  assert.equal(s.summary.liveAssessment,'OWNER_OFF_NOT_A_COPY_FAILURE');assert.deepEqual(input,before);
  const worker=readFileSync(new URL('../worker/index-clean.ts',import.meta.url),'utf8');
  const route=worker.slice(worker.indexOf('if (path === "/forward-export"'),worker.indexOf('if (path === "/forward-equity"'));
  assert.doesNotMatch(route,/await this\.ensureAlarm|ensureAdaptiveAccount|advanceCounterfactualResearchNow|advanceShadowResearchNow|storage\.put|createEntry/);
});
test('review capture changes only metadata and does not invent legacy entry version or peak time',()=>{
  const old=initialForward(T);old.positions=[trade('a',{status:'OPEN',closedAt:null,netPnl:null,exitPrice:null})];
  const next=structuredClone(old),before=structuredClone(next);
  captureTradeReviews(old,next,T+60000,'build2','policy2',{AAA_USDT:quote(101,T+60000)});
  const review=next.positions[0].review!;assert.equal(review.entryBuildSha,null);assert.equal(review.fromEntry,false);assert.equal(review.peakGrossAt,null);
  delete next.positions[0].review;assert.deepEqual(next,before);
});
test('new trades and terminal exits preserve build identity, real trigger evidence and bounded timelines',()=>{
  const old=initialForward(T),next=structuredClone(old);next.positions=[trade('a',{openedAt:T+60000,status:'OPEN',closedAt:null,netPnl:null,exitPrice:null})];
  captureTradeReviews(old,next,T+60000,'build1','policy1',{AAA_USDT:quote(101,T+60000)});
  assert.equal(next.positions[0].review!.entryBuildSha,'build1');
  const end=structuredClone(next),t=end.positions[0];t.status='CLOSED';t.closedAt=T+120000;t.netPnl=.8;t.exitAudit={trigger:'FIXTURE_PRICE_STOP',at:T+120000,evidence:{authority:'PRICE_STOP',stopPrice:101}};
  end.positions=[];end.history=[t];captureTradeReviews(next,end,T+120000,'build2','policy2',{AAA_USDT:quote(101,T+120000)});
  assert.equal(t.review!.terminal!.evidence!.evidence!.authority,'PRICE_STOP');assert.equal(t.review!.entryBuildSha,'build1');assert.equal(t.review!.exitBuildSha,'build2');
  assert.ok(JSON.stringify(t.review).length<3072);
});
test('diagnostic observer exceptions cannot alter the Forward decision or money',()=>{
  const s=initialForward(T),input={state:s,now:T+10000,paths:{},quotes:{},contracts:{}};
  const base=advanceForward(input),observed=advanceForward({...input,reviewTrace(){throw new Error('logger failure');}});
  assert.deepEqual(base,observed);
});
test('journal coalesces repeated waits and stays below its own byte budget',()=>{
  const j=initialReviewJournal(T,T);
  for(let i=0;i<600;i++)appendReviewEvents(j,[{at:T+i,id:'candidate-'+i,symbol:'X_USDT',stage:'WAIT_RETEST',reason:'waiting '+i}],T+i);
  for(let i=0;i<200;i++)recordDiscoveryReview(j,{at:T+i*300000,sourceAt:T,catalogCount:1000,radarInputCount:900,eligibleCount:600,selected:[],sampledOutside:[]});
  assert.ok(new TextEncoder().encode(JSON.stringify(j)).length<REVIEW_JOURNAL_BYTES);assert.ok(j.droppedCandidates>0);assert.ok(j.droppedDiscovery>0);
  appendReviewEvents(j,[{at:T+999999,id:'candidate-599',symbol:'X_USDT',stage:'WAIT_RETEST',reason:'waiting 999'}],T+999999);
  assert.equal(j.candidates.at(-1)!.events.length,1);
});
test('research retirement affects trade records only, never market geometry or current positions',()=>{
  const s=initialForward(T),old=initialShadowResearch(T);old.trades=[{tradeId:'old',openedAt:T-1000,status:'OPEN',updatedAt:T-1} as TradeShadowResearch];
  const next=advanceShadowResearch({state:old,forward:s,now:T+1000,quotes:{},paths:{}});
  assert.equal(next.state.trades.length,0);assert.equal(next.state.retiredTrades![0].status,'PRIOR_ACCOUNT_UNVERIFIED');assert.equal(s.positions.length,0);
});
test('candidate admission reserves checkpoint capacity rather than evicting incomplete paths',()=>{
  const s=initialForward(T);s.opportunities=Array.from({length:80},(_,i)=>({id:'o'+i,thesisId:'o'+i,symbol:'X_USDT',side:'LONG',
    strategyVersion:'market-intelligence-v1',expiresAt:T+600000,score:80,sourceCount:3,dataConfidence:90,price:100,
    mode:'CONTINUATION',stopRate:.02,reason:'fixture',confirmationStage:'READY',eligible:true,edgeRatio:2} as Opportunity));
  const first=advanceCounterfactualResearch({state:initialCounterfactualResearch(T),forward:s,now:T,quotes:{},paths:{},observeCandidates:true});
  const ids=first.state.rejected.map(r=>r.id);assert.ok(first.state.sampling!.notAdmittedAttempts>0);assert.ok(ids.length>0);
  const second=advanceCounterfactualResearch({state:first.state,forward:s,now:T+60000,quotes:{},paths:{},observeCandidates:true});
  assert.ok(ids.every(id=>second.state.rejected.some(r=>r.id===id)));assert.equal(second.state.sampling!.evictedBeforeComplete,0);
  for(const value of Object.values(counterfactualResearchWrites(second.state)))assert.ok(new TextEncoder().encode(JSON.stringify(value)).length<100*1024);
});
test('trade review is archived without duplicating it in financial account positions',async()=>{
  const previous=initialForward(T);previous.storage.persistedAt=T;const next=structuredClone(previous),t=trade();next.history=[t];next.resolved=1;next.revision=previous.revision+1;
  next.events=[{id:'a'+T+'-'+next.revision,at:T+20000,kind:'EXIT',subject:t.id,reason:'fixture'}];
  captureTradeReviews(previous,next,T+20000,'b','p',{AAA_USDT:quote(101,T+20000)});
  const result=await prepareForwardWrite(previous,next,T+20000,{compact:true});
  const packet=Object.entries(result.entries).find(([k])=>k.includes('archive:'))![1] as {trades:Trade[];reviews:unknown[]};
  assert.ok(packet.reviews.length);assert.equal(packet.trades[0].review,undefined);
});

test('complete settlement counts still load missing archived exit assessments',async()=>{
  const a=trade(),s=snapshot([a],1);let calls=0;
  assert.equal(s.coverage.complete,true);assert.equal(s.summary.positionAssessmentMissing,1);
  const pi={decision:'EXIT'} as Trade['positionIntelligence'];
  const result=await collectReviewSnapshot((async (url:unknown)=>{calls++;
    return Response.json(String(url).includes('?')?{accountStartedAt:T,asOf:T+60000,
      trades:[{...a,positionIntelligence:pi}],recordsRead:1,nextCursor:'unused',exhausted:false}:s);
  }) as typeof fetch);
  assert.equal(calls,2);assert.equal(result.trades.length,1);assert.equal(result.coverage.complete,true);
  assert.deepEqual(result.trades[0].positionIntelligence,pi);assert.equal(result.summary.positionAssessmentMissing,0);
  assert.equal(result.coverage.exportLimitReached,false);
});
test('missing historical evidence stays unknown when the bounded archive is exhausted',async()=>{
  const s=snapshot([trade()],1);let calls=0;
  const result=await collectReviewSnapshot((async (url:unknown)=>{calls++;
    return Response.json(String(url).includes('?')?{accountStartedAt:T,asOf:T+60000,
      trades:[],recordsRead:0,nextCursor:null,exhausted:true}:s);
  }) as typeof fetch);
  assert.equal(calls,2);assert.equal(result.coverage.complete,true);
  assert.equal(result.summary.positionAssessmentMissing,1);assert.equal(result.summary.exitTraceMissing,1);
  assert.equal(result.coverage.archiveExhausted,true);assert.equal(result.coverage.exportLimitReached,false);
});
test('optional review growth cannot shorten existing hot history or market-memory retention',async()=>{
  const plain=initialForward(T);plain.storage.persistedAt=T;plain.latestReason='x'.repeat(600*1024);
  plain.history=Array.from({length:40},(_,i)=>trade('bounded-'+i));plain.resolved=40;
  const enriched=structuredClone(plain);
  captureTradeReviews(initialForward(T),enriched,T+60000,'b','p',{AAA_USDT:quote(101,T+60000)});
  const baseline=await prepareForwardWrite(null,plain,T+60000,{compact:true});
  const withReview=await prepareForwardWrite(null,enriched,T+60000,{compact:true});
  assert.equal(baseline.compression.hotHistory,40);
  assert.equal(withReview.compression.droppedHotReview,true);
  for(const key of ['hotHistory','fullHistory','hotEvents','narrativeHistory','evidence','rawBytes'] as const)
    assert.equal(withReview.compression[key],baseline.compression[key],key);
  assert.equal(enriched.history.length,40);assert.ok(enriched.history[0].review);
});
