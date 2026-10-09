import {RESEARCH_PLAN_VERSION} from './research-plan.ts';
import type {Trade} from './forward-relations.ts';
import type {ReviewJournal, TradeReview} from './review-trace.ts';
import {LIVE_REVIEW_VERSION,compareLiveReview,type LiveReview} from './live-review.ts';
import {inverseLossResearchView} from './inverse-loss-research.ts';
import {inverseSoftLossReview,type InverseSourceMark} from './inverse-soft-loss-review.ts';
import {confirmationRealityView} from './confirmation-reality.ts';

export const REVIEW_SNAPSHOT_VERSION='market-intelligence-review-v2';
const ARCHIVE_PREFIX='forward-relations:v1:archive:';
export const REVIEW_ARCHIVE_PAGE_ROWS=48,REVIEW_MAX_BYTES=12*1024*1024;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const arr=<T>(v:unknown):T[]=>Array.isArray(v)?v:[];
type ObjectRow=Record<string,unknown>;
const obj=(v:unknown):ObjectRow=>v&&typeof v==='object'&&!Array.isArray(v)?v as ObjectRow:{};
const sum=(rows:Trade[],key:keyof Trade)=>rows.reduce((n,t)=>n+(finite(t[key])?t[key] as number:0),0);
const timestamp=(v:unknown)=>finite(v)?new Date(v).toISOString():null;
const beijing=(at:number)=>new Date(at+8*3600_000).toISOString().replace('Z','+08:00');
export type ArchivePage={accountStartedAt:number;asOf:number;trades:Trade[];recordsRead:number;nextCursor:string|null;exhausted:boolean;conflictingTradeIds?:string[]};
type ArchiveReader={list<T>(options:{prefix:string;start:string;end:string;reverse:boolean;limit:number}):Promise<Map<string,T>>};
/** Bounded, strictly read-only page. No remote market data and no account mutation. */
export async function readReviewArchivePage(storage:ArchiveReader,accountStartedAt:number,asOf:number,cursor:string|null):Promise<ArchivePage>{
  if(!Number.isSafeInteger(accountStartedAt)||accountStartedAt<=0||!Number.isSafeInteger(asOf)||asOf<accountStartedAt)throw new Error('INVALID_REVIEW_RANGE');
  const start=ARCHIVE_PREFIX+String(accountStartedAt).padStart(16,'0');
  const end=ARCHIVE_PREFIX+String(asOf+1).padStart(16,'0');
  if(cursor&&(!/^forward-relations:v1:archive:\d{16}:(?:\d+|reset:\d+)$/.test(cursor)||cursor<start||cursor>=end))throw new Error('INVALID_REVIEW_CURSOR');
  const rows=await storage.list<{startedAt?:number;trades?:Trade[];reviews?:{tradeId:string;review:TradeReview}[]}>({prefix:ARCHIVE_PREFIX,start,end:cursor??end,reverse:true,limit:REVIEW_ARCHIVE_PAGE_ROWS});
  const trades:Trade[]=[];
  for(const packet of rows.values()){
    if(packet.startedAt!==accountStartedAt)continue;
    const reviews=new Map((packet.reviews??[]).map(r=>[r.tradeId,r.review]));
    for(const t of packet.trades??[]){
      if(t?.id&&t.status==='CLOSED'&&t.openedAt>=accountStartedAt&&t.openedAt<=asOf&&(t.closedAt===null||t.closedAt<=asOf))
        trades.push(reviews.has(t.id)?{...t,review:reviews.get(t.id)}:t);
    }
  }
  const conflictingTradeIds:string[]=[];
  return{accountStartedAt,asOf,trades:mergeTradeRows([],trades,conflictingTradeIds),conflictingTradeIds,recordsRead:rows.size,
    nextCursor:rows.size===REVIEW_ARCHIVE_PAGE_ROWS?[...rows.keys()].at(-1)!:null,exhausted:rows.size<REVIEW_ARCHIVE_PAGE_ROWS};
}
export type ReviewSnapshot={
  liveReview?:LiveReview|null;
  inverseExperiment?:ObjectRow|null;
  version:typeof REVIEW_SNAPSHOT_VERSION;
  versionDiagnostics?:ObjectRow;
  meta:{exportedAt:number;exportedAtBeijing:string;buildSha:string|null;strategyFingerprint:string|null;policyVersion:unknown;
    accountStartedAt:number;accountStartedAtBeijing:string;sourceUpdatedAt:unknown;marketUpdatedAt:unknown;readOnly:true;
    diagnosticVersion?:'research-plan-audit-v1';fingerprintScope?:string};
  summary:ObjectRow;coverage:{expectedClosed:number;includedClosed:number;openCount:number;missingClosed:number;complete:boolean;
    archiveRecordsRead:number;archivePagesRead:number;archiveExhausted:boolean;archiveNextCursor:string|null;
    exportLimitReached:boolean;archiveError:string|null;conflictingTradeIds:string[]};
  account:ObjectRow;trades:Trade[];opportunities:unknown[];market:ObjectRow;research:ObjectRow;runtime:ObjectRow;
  decisionJournal:ReviewJournal|null;issues:{code:string;classification:
    'CONFIRMED_DATA_ISSUE'|'CONFIRMED_LOGIC_MISMATCH'|'CONFIRMED_DIAGNOSTIC_ISSUE'|'CONFIRMED_PORTFOLIO_STATE'|'REVIEW_LEAD'|'INSUFFICIENT_EVIDENCE';
    count:number;tradeIds?:string[]}[];
};
function preferReview(a:TradeReview|undefined,b:TradeReview|undefined){
  const quality=(r:TradeReview|undefined)=>!r?0:Number(r.fromEntry)*4+Number(!!r.entryStrategyFingerprint)*4
    +Number(!!r.terminal)*4+Number(!!r.diagnosticVersion)*2+(r.milestones?.reductions.length??0);
  return quality(b)>quality(a)?b:a;
}
export function tradePlanVersion(t:Trade){return t.inverseCopy?.version??t.entryContext?.winnerPlan?.researchVersion??t.entryContext?.winnerPlan?.version
  ??t.entryContext?.strategyVersion??'UNKNOWN_LEGACY';}

function mergeTradeRows(current:Trade[],incoming:Trade[],conflicts:string[]){
  const byId=new Map(current.map(t=>[t.id,t]));
  for(const t of incoming){
    const old=byId.get(t.id);if(!old){byId.set(t.id,t);continue;}
    if(old.status==='CLOSED'&&t.status==='CLOSED'&&(old.closedAt!==t.closedAt||old.netPnl!==t.netPnl||old.exitPrice!==t.exitPrice)){
      if(!conflicts.includes(t.id))conflicts.push(t.id);continue;
    }
    if(old.status==='CLOSED'&&t.status!=='CLOSED')continue;
    if(t.status==='CLOSED'&&old.status!=='CLOSED'){byId.set(t.id,{...old,...t});continue;}
    const newer=(old.lastQuoteAt??0)>=(t.lastQuoteAt??0)?old:t,older=newer===old?t:old;
    byId.set(t.id,{...older,...newer,review:preferReview(newer.review,older.review),positionIntelligence:newer.positionIntelligence??older.positionIntelligence,
      ...(newer.inverseCopy?{inverseCopy:{...newer.inverseCopy,lossResearch:newer.inverseCopy.lossResearch??older.inverseCopy?.lossResearch,
        lossResearchHotOmitted:newer.inverseCopy.lossResearch||older.inverseCopy?.lossResearch?undefined:newer.inverseCopy.lossResearchHotOmitted}}:{})});
  }
  return[...byId.values()].sort((a,b)=>b.openedAt-a.openedAt||a.id.localeCompare(b.id));
}
function performance(rows:Trade[]){
  const priced=rows.filter(t=>finite(t.netPnl)),winners=priced.filter(t=>t.netPnl!>0),losers=priced.filter(t=>t.netPnl!<0);
  const net=sum(priced,'netPnl'),best=[...priced].sort((a,b)=>b.netPnl!-a.netPnl!).slice(0,3);
  return{closedCount:rows.length,pricedCount:priced.length,wins:winners.length,losses:losers.length,netPnl:net,
    grossPnl:sum(rows,'grossPnl'),fees:sum(rows,'entryFee')+sum(rows,'exitFee'),fundingAllowance:sum(rows,'fundingAllowance'),
    winRate:priced.length?winners.length/priced.length:null,profitFactor:losers.length?sum(winners,'netPnl')/-sum(losers,'netPnl'):null,
    topWinnerIds:best.filter(t=>t.netPnl!>0).map(t=>t.id),netWithoutLargestWinner:net-Math.max(0,best[0]?.netPnl??0),
    firstOpenedAt:rows.length?Math.min(...rows.map(t=>t.openedAt)):null,lastClosedAt:rows.length?Math.max(...rows.map(t=>t.closedAt??0)):null};
}
function researchPerformance(rows:Trade[]){
  const priced=rows.filter(t=>finite(t.netPnl));
  const peaks=rows.map(t=>(finite(t.favorable)?t.favorable:0)*(finite(t.notional)?t.notional:0));
  return {closedCount:rows.length,grossPnl:sum(rows,'grossPnl'),fees:sum(rows,'entryFee')+sum(rows,'exitFee'),
    netPnl:sum(priced,'netPnl'),bestFavorableU:peaks.length?Math.max(...peaks):0};
}
function researchGrouped(rows:Trade[],key:(t:Trade)=>string){
  const groups=new Map<string,Trade[]>();
  for(const row of rows){const name=key(row);groups.set(name,[...(groups.get(name)??[]),row]);}
  return Object.fromEntries([...groups].map(([name,list])=>[name,researchPerformance(list)]));
}
const researchKind=(t:Trade)=>t.entryContext?.mode==='CONTINUATION'?'领头':t.entryContext?.mode==='RELATIVE'?'掉队':t.entryContext?.mode==='REVERSAL'?'失败针':'未标思路';
const researchTone=(t:Trade)=>t.entryContext?.clusterId==='TOGETHER_UP'?'一起涨':t.entryContext?.clusterId==='TOGETHER_DOWN'?'一起跌':t.entryContext?.clusterId==='SPLIT'?'各走各的':'未标整盘';
const researchAge=(t:Trade)=>t.entryContext?.researchMoveAge==='STARTED'?'刚开始':t.entryContext?.researchMoveAge==='ONGOING'?'还在走':t.entryContext?.researchMoveAge==='DONE'?'已经走远':t.entryContext?.researchMoveAge==='QUIET'?'安静':'未标走到哪';
const researchCrowd=(t:Trade)=>t.entryContext?.researchCrowd==='LONG'?'费率挤多':t.entryContext?.researchCrowd==='SHORT'?'费率挤空':t.entryContext?.researchCrowd==='NONE'?'费率没有':'未标费率';
const researchExit=(t:Trade)=>({BRAIN_WRONG_EXIT:'想错了',BRAIN_GIVEBACK_EXIT:'利润吐回',BRAIN_STALE_EXIT:'时间到了',BRAIN_MARKET_EXIT:'整盘散了'} as Record<string,string>)[t.exitReason??'']??t.exitReason??'未标出场';
function passSummary(rows:ObjectRow[]){
  const later=rows.filter(row=>finite(row.laterMove));
  return {skipped:rows.length,laterKnown:later.length,pendingLater:rows.length-later.length,
    laterWithIdea:later.filter(row=>Number(row.laterMove)>0).length,
    laterAgainstIdea:later.filter(row=>Number(row.laterMove)<=0).length};
}
function grouped(rows:Trade[],key:(t:Trade)=>string){
  const groups=new Map<string,Trade[]>();for(const row of rows){const k=key(row);groups.set(k,[...(groups.get(k)??[]),row]);}
  return Object.fromEntries([...groups].map(([k,r])=>[k,performance(r)]));
}
function researchSummary(closed:Trade[],passes:ObjectRow[]){
  const brain=closed.filter(t=>t.entryContext?.strategyVersion==='brain-v1');
  if(!brain.length&&!passes.length)return {};
  return {byResearchIdea:researchGrouped(brain,researchKind),byResearchTone:researchGrouped(brain,researchTone),
    byResearchAge:researchGrouped(brain,researchAge),byResearchCrowd:researchGrouped(brain,researchCrowd),
    byResearchExit:researchGrouped(brain,researchExit),researchPasses:passSummary(passes)};
}
export function checkpointCoverage(row:ObjectRow,at:number){
  const start=Number(row.startedAt),checkpoints=arr<ObjectRow>(row.checkpoints),unavailable=arr<number>(row.unavailableCheckpoints);
  return Object.fromEntries([5,15,30,45,60].map(m=>{
    const target=start+m*60_000,cp=checkpoints.find(x=>x.minutes===m);
    const valid=cp&&finite(cp.marketAt)&&finite(cp.price)&&cp.price>0&&finite(cp.targetAt)&&Math.abs(cp.targetAt-target)<=1000
      &&cp.marketAt>=start&&cp.marketAt<=at&&cp.marketAt<=target+90_000&&cp.marketAt>=target-6*60_000
      &&(!finite(cp.observedAt)||cp.observedAt<=at);
    return[m,valid?'VALID':unavailable.includes(m)?'UNAVAILABLE':at<target?'PENDING':'DUE_NOT_OBSERVED'];
  }));
}
export function buildReviewSnapshot(input:{view:ObjectRow;buildSha:string|null;strategyFingerprint:string|null;exportedAt:number;
  marketData?:unknown;counterfactual?:unknown;shadow?:unknown;inverseSources?:InverseSourceMark[];runtime?:ObjectRow;journal?:ReviewJournal|null}):ReviewSnapshot{
  const v=input.view,startedAt=Number(v.startedAt),rawShadow=obj(input.shadow),rawCounter=obj(input.counterfactual);
  const currentShadow=arr<ObjectRow>(rawShadow.trades).filter(t=>Number(t.openedAt)>=startedAt);
  const olderShadow=arr<ObjectRow>(rawShadow.trades).filter(t=>Number(t.openedAt)<startedAt);
  const post=arr<ObjectRow>(rawCounter.postExit).filter(t=>Number(t.openedAt)>=startedAt);
  const rejected=arr<ObjectRow>(rawCounter.rejectedOpportunities).filter(t=>Number(t.observedAt)>=startedAt);
  const pick=(keys:string[])=>Object.fromEntries(keys.map(k=>[k,v[k]??null]));
  const trades=mergeTradeRows(arr<Trade>(v.positions),arr<Trade>(v.history),[]);
  const snapshot:ReviewSnapshot={version:REVIEW_SNAPSHOT_VERSION,inverseExperiment:obj(v.shadowInverse).version?obj(v.shadowInverse):null,
    meta:{exportedAt:input.exportedAt,exportedAtBeijing:beijing(input.exportedAt),buildSha:input.buildSha,strategyFingerprint:input.strategyFingerprint,
      policyVersion:v.policyVersion??null,accountStartedAt:startedAt,accountStartedAtBeijing:beijing(startedAt),sourceUpdatedAt:v.updatedAt??null,
      marketUpdatedAt:obj(v.marketIntelligence).updatedAt??null,readOnly:true,
      diagnosticVersion:'research-plan-audit-v1',fingerprintScope:'core+winner+research+risk+realization'},summary:{},
    coverage:{expectedClosed:Number(v.resolved)||0,includedClosed:0,openCount:arr(v.positions).length,missingClosed:0,complete:false,
      archiveRecordsRead:0,archivePagesRead:0,archiveExhausted:false,archiveNextCursor:null,exportLimitReached:false,archiveError:null,conflictingTradeIds:[]},
    account:pick(['initialEquity','balance','equity','floating','netPnl','grossPnl','fees','fundingAllowance','maxDrawdown','turnover','resolved','wins','daily','cost','storage','stalePositions']),
    trades,opportunities:arr(v.opportunities),
    market:{intelligence:v.marketIntelligence??null,environmentRouter:v.environmentRouter??null,hypothesisResearch:v.hypothesisResearch??null,
      marketPulse:v.marketPulse??null,geometry:rawShadow.marketGeometry??[],geometrySummary:rawShadow.summary?obj(rawShadow.summary).rollingGeometry:null},
    research:{inverseSourceMarks:input.inverseSources??[],shadowUpdatedAt:rawShadow.updatedAt??null,counterfactualUpdatedAt:rawCounter.updatedAt??null,
      decisionAccount:v.shadowInverse?'FROZEN_SHADOW_SOURCE':'PAPER',sourceToInverse:trades.filter(t=>t.inverseCopy).map(t=>({sourceId:t.inverseCopy!.sourceId,inverseId:t.id})),
      tradeQuality:currentShadow,retiredTrades:arr(rawShadow.retiredTrades),priorAccount:{excludedShadowCount:olderShadow.length+arr(rawShadow.retiredTrades).length,excludedShadowTradeIds:olderShadow.map(t=>t.tradeId),
        excludedOpenRecords:olderShadow.filter(t=>t.status==='OPEN').length,status:'ISOLATED_NOT_ASSUMED_CLOSED'},
      postExit:post.map(r=>({...r,checkpointCoverage:checkpointCoverage(r,input.exportedAt)})),
      passes:arr(v.researchPasses),
      rejectedOpportunities:rejected.map(r=>({...r,checkpointCoverage:checkpointCoverage(r,input.exportedAt),
        blockerScope:r.blockerScope??'LEGACY_AGGREGATE_NOT_CANDIDATE_CAUSE'})),
      sampling:rawCounter.sampling??null,
      notes:{peakProfit:'Observed or modeled, not achievable profit entitlement.',postExit:'Later prices cannot be used as entry-time knowledge.',
        discovery:'Bounded observed samples, not a full-market replay.',timeUnit:'Unix milliseconds; *_Rate is decimal, not percent.'}},
    runtime:{...input.runtime,marketData:input.marketData??null,liveMirror:v.liveMirror??null,entryValidation:v.entryValidation??null,
      entryDiagnostics:v.entryDiagnostics??null,events:arr(v.events)},decisionJournal:input.journal??null,issues:[]};
  return finalizeReviewSnapshot(snapshot);
}
export function reviewVersionDiagnostics(s:ReviewSnapshot){
  const known=(t:Trade)=>!!t.review?.entryStrategyFingerprint;
  const current=(t:Trade)=>known(t)&&!!s.meta.strategyFingerprint&&t.review!.entryStrategyFingerprint===s.meta.strategyFingerprint;
  const cohort=(rows:Trade[])=>({entries:rows.length,open:rows.filter(t=>t.status==='OPEN').length,
    closed:performance(rows.filter(t=>t.status==='CLOSED')),tradeIds:rows.map(t=>t.id)});
  const integrated=s.trades.filter(t=>tradePlanVersion(t)===RESEARCH_PLAN_VERSION);
  const missing=integrated.filter(t=>!t.review?.fromEntry||!t.review.entryBuildSha||!t.entryContext?.winnerPlan?.entryResearch
    ||(t.status==='CLOSED'&&(!t.review.terminal||!t.winnerManagement?.appliedAction)));
  const spans=s.trades.filter(t=>t.status==='CLOSED'&&t.review?.entryStrategyFingerprint&&t.review.exitStrategyFingerprint
    &&(t.review.entryStrategyFingerprint!==t.review.exitStrategyFingerprint||new Set(t.review.policySpans?.map(p=>p.strategyFingerprint)).size>1));
  const journal=s.decisionJournal,records=journal?.candidates??[];
  return{version:'research-plan-audit-v1',comparisonAvailable:!!s.meta.strategyFingerprint,exportBuild:s.meta.buildSha,exportStrategy:s.meta.strategyFingerprint,
    currentEntry:cohort(s.trades.filter(current)),olderEntry:cohort(s.trades.filter(t=>known(t)&&!current(t))),
    unknownEntry:cohort(s.trades.filter(t=>!known(t))),
    closedUnderCurrentStrategy:cohort(s.trades.filter(t=>t.status==='CLOSED'&&!!s.meta.strategyFingerprint&&t.review?.exitStrategyFingerprint===s.meta.strategyFingerprint)),
    changedStrategyWhileOpen:cohort(spans),byEntryPlanVersion:grouped(s.trades.filter(t=>t.status==='CLOSED'),tradePlanVersion),
    integratedEvidence:{tracked:integrated.length,missing:missing.length,missingTradeIds:missing.map(t=>t.id),
      complete:missing.length===0&&integrated.length>0,meaning:'Entry receipts and decisive exits, not every tick or proof of profit.'},
    decisionRows:integrated.map(t=>({tradeId:t.id,planId:t.entryContext?.thesisId??null,planVersion:tradePlanVersion(t),
      entryBuild:t.review?.entryBuildSha??null,exitBuild:t.review?.exitBuildSha??null,
      entryAction:t.entryContext?.winnerPlan?.entryResearch?.entryAction??null,
      entryRiskScale:t.entryContext?.winnerPlan?.entryResearch?.riskScale??null,
      requestedAction:t.winnerManagement?.requestedAction??null,appliedAction:t.status==='CLOSED'?'EXIT':t.winnerManagement?.appliedAction??null,
      reductionResult:t.winnerManagement?.reductionResult??null,researchLevel:t.winnerManagement?.research?.level??null,
      reason:t.exitReason??t.winnerManagement?.actionReason??null,
      realizedParts:t.realization?.sequence??0,parentNetPnl:t.netPnl,peakObservedNet:t.review?.peakNetPnl??null,
      evidencePresent:!missing.includes(t)})),
    retainedCandidateCoverage:{records:records.length,firstAt:records.length?Math.min(...records.map(r=>r.firstObservedAt)):null,
      lastAt:records.length?Math.max(...records.map(r=>r.lastObservedAt)):null,
      droppedCandidates:journal?.droppedCandidates??null,droppedEvents:journal?.droppedEvents??null,
      scope:'BOUNDED_OBSERVED_WINDOW_NOT_ALL_MARKET_OPPORTUNITIES'},
    limits:['Historical peaks are observed marks, not guaranteed achievable fills.',
      'A current export build is not the entry build of all contained orders.',
      'Missing causal records are unknown, not proof of a correct decision.']};
}

export function finalizeReviewSnapshot(s:ReviewSnapshot):ReviewSnapshot{
  const closed=s.trades.filter(t=>t.status==='CLOSED'&&t.openedAt>=s.meta.accountStartedAt),open=s.trades.filter(t=>t.status==='OPEN');
  s.research.inverseLossExit=inverseLossResearchView(s.trades);
  s.research.inverseSoftLossExit=inverseSoftLossReview(s.trades,Array.isArray(s.research.inverseSourceMarks)?s.research.inverseSourceMarks as InverseSourceMark[]:[],s.meta.exportedAt);
  s.research.confirmationReality=confirmationRealityView(s.trades,s.meta.exportedAt);
  s.coverage.includedClosed=closed.length;s.coverage.missingClosed=Math.max(0,s.coverage.expectedClosed-closed.length);
  s.coverage.complete=s.coverage.missingClosed===0&&closed.length===s.coverage.expectedClosed&&s.coverage.conflictingTradeIds.length===0;
  const traceMissing=closed.filter(t=>!t.review?.terminal&&!t.inverseCopy?.sourceClosedAt),
    piMissing=closed.filter(t=>!t.inverseCopy&&!t.positionIntelligence&&!t.review?.terminal?.assessments.length);
  const profitLeads=closed.filter(t=>t.favorable*t.notional>Math.max(2,(t.entryFee+t.exitFee)*4)
    &&(t.netPnl??0)<t.favorable*t.notional*.4).sort((a,b)=>b.favorable*b.notional-a.favorable*a.notional).slice(0,5),
    lowExecutionEdge=closed.filter(t=>Number(t.entryContext?.edgeRatio)<1.25).sort((a,b)=>(a.netPnl??0)-(b.netPnl??0)).slice(0,8);
  const rejected=arr<ObjectRow>(s.research.rejectedOpportunities),sampling=obj(s.research.sampling),
    postExit=arr<ObjectRow>(s.research.postExit),liquidityRebounds=postExit.filter(r=>r.exitReason==='LIQUIDITY_HYPOTHESIS_INVALIDATED'
      &&arr<ObjectRow>(r.checkpoints).some(p=>[5,15,30].includes(Number(p.minutes))&&Number(p.netAfterCostRate)>.002)).slice(0,8),
    maturity=Object.fromEntries([5,15,30,45,60].map(m=>{
    const statuses=rejected.map(r=>obj(r.checkpointCoverage)[m]);return[m,{tracked:statuses.length,
      valid:statuses.filter(v=>v==='VALID').length,pending:statuses.filter(v=>v==='PENDING').length,
      unavailable:statuses.filter(v=>v==='UNAVAILABLE').length,dueNotObserved:statuses.filter(v=>v==='DUE_NOT_OBSERVED').length}];}));
  const mirror=obj(s.runtime.liveMirror),rows=arr<ObjectRow>(mirror.rows),ownerOff=rows.length>0&&rows.every(r=>r.status==='OWNER_OFF');
  s.summary={accountCumulative:{equity:s.account.equity,netEquityChange:s.account.netPnl,realizedGross:s.account.grossPnl,
      fees:s.account.fees,fundingAllowance:s.account.fundingAllowance,floating:s.account.floating,closedCount:s.coverage.expectedClosed},
    includedClosedPerformance:performance(closed),byEntryPlan:grouped(closed,t=>t.entryContext?.tradePlan??'LEGACY_UNCLASSIFIED'),
    byEntryEnvironment:grouped(closed,t=>t.entryContext?.environment??'UNKNOWN'),byExit:grouped(closed,t=>t.exitReason??'UNKNOWN'),
    byEntryStrategyFingerprint:grouped(closed,t=>t.review?.entryStrategyFingerprint??'UNKNOWN_LEGACY'),
    byEntryBuild:grouped(closed,t=>t.review?.entryBuildSha??'UNKNOWN_LEGACY'),
    byExitBuild:grouped(closed,t=>t.review?.exitBuildSha??'UNKNOWN_LEGACY'),
    ...researchSummary(closed,arr<ObjectRow>(s.research.passes)),
    activeCount:open.length,exitTraceMissing:traceMissing.length,positionAssessmentMissing:piMissing.length,
    inverseLossArchiveMissing:closed.filter(t=>t.inverseCopy?.lossResearchHotOmitted&&!t.inverseCopy.lossResearch).length,
    counterfactualMaturity:maturity,liveAssessment:ownerOff?'OWNER_OFF_NOT_A_COPY_FAILURE':(s.runtime.liveAssessment??'SEE_SCOPED_LIVE_EVIDENCE'),
    observedOrderWindow:{from:timestamp(closed.length?Math.min(...closed.map(t=>t.openedAt)):null),to:timestamp(closed.length?Math.max(...closed.map(t=>t.closedAt??0)):null)}};
  s.versionDiagnostics=reviewVersionDiagnostics(s);
  if(s.liveReview){
    const comparison=compareLiveReview(s.liveReview,s.trades,s.coverage.complete,s.meta.accountStartedAt),
      enabledAt=s.liveReview.context.sessionAt,curve=arr<ObjectRow>(s.inverseExperiment?.curve),
      prior=curve.filter(p=>finite(p.at)&&p.at<=enabledAt&&finite(p.inverse)).sort((a,b)=>Number(b.at)-Number(a.at))[0],
      observed=prior&&enabledAt-Number(prior.at)<=120_000?prior:null;
    s.summary.liveComparison={...comparison,paperAccountWindow:{enabledAt,
      baselineAt:observed?.at??null,baselineEquity:observed?.inverse??null,currentEquity:s.account.equity,
      observedEquityChange:observed&&finite(s.account.equity)?s.account.equity-Number(observed.inverse):null,
      scope:'NEAREST_RETAINED_PRE_ENABLE_MARK_WITHIN_2M; INCLUDES_PRE_ENABLE_HOLDINGS; NOT_EXACT_ENABLE_EQUITY'}};
  }
  if(s.inverseExperiment){
    const paired=s.trades.filter(t=>t.inverseCopy),sourceId=(t:Trade)=>t.inverseCopy!.sourceId;
    s.inverseExperiment={...s.inverseExperiment,accountingScope:'FROZEN_SHADOW_AND_PASSIVE_INVERSE_PAPER',
      actualLiveDiagnostics:s.liveReview?'liveReview':null,pairs:paired.map(t=>({tradeId:t.id,sourceId:sourceId(t),sourceBuild:t.inverseCopy!.sourceBuild,
      openedAt:t.openedAt,closedAt:t.closedAt,side:t.side,sourceSide:t.inverseCopy!.sourceSide,status:t.status,
      sourceEntry:t.inverseCopy!.sourceEntryPrice,entry:t.entryPrice,exit:t.exitPrice,remainingContracts:t.status==='OPEN'?t.contracts:0,
      sourceRemainingContracts:t.inverseCopy!.sourceRemainingContracts,sourceReason:t.inverseCopy!.sourceExitReason,
      netPnl:t.netPnl,fills:t.inverseCopy!.fills,sourceEntryPlan:t.inverseCopy!.sourceEntryPlan,sourceExitAudit:t.inverseCopy!.sourceExitAudit})),
      coverage:{expected:Number(s.inverseExperiment.pairedOpened),included:paired.length,
        complete:paired.length===Number(s.inverseExperiment.pairedOpened)},
      costs:'Each ledger pays its own fees once. Spread drag is attribution, not an extra debit. Funding is an adverse allowance, not actual exchange funding.'};
  }
  s.issues=[];
  if(Number(s.summary.inverseLossArchiveMissing)>0)s.issues.push({code:'INVERSE_LOSS_RESEARCH_REQUIRES_ARCHIVE',classification:'INSUFFICIENT_EVIDENCE',count:Number(s.summary.inverseLossArchiveMissing)});
  if(s.liveReview&&(s.liveReview.coverage.error||s.liveReview.coverage.limitReached))s.issues.push({
    code:'LIVE_REVIEW_HISTORY_INCOMPLETE',classification:'INSUFFICIENT_EVIDENCE',count:1});
  if(s.runtime.liveReviewError)s.issues.push({code:'LIVE_REVIEW_UNAVAILABLE',classification:'INSUFFICIENT_EVIDENCE',count:1});
  const evidence=obj(s.versionDiagnostics.integratedEvidence);
  if(Number(evidence.missing)>0)s.issues.push({code:'INTEGRATED_PLAN_EVIDENCE_MISSING',classification:'INSUFFICIENT_EVIDENCE',
    count:Number(evidence.missing),tradeIds:arr<string>(evidence.missingTradeIds)});
  if((s.decisionJournal?.droppedCandidates??0)>0)s.issues.push({code:'CANDIDATE_HISTORY_IS_BOUNDED',classification:'INSUFFICIENT_EVIDENCE',
    count:s.decisionJournal!.droppedCandidates});
  if(!s.coverage.complete)s.issues.push({code:'TRADE_HISTORY_INCOMPLETE_OR_CONFLICTING',classification:'CONFIRMED_DATA_ISSUE',count:s.coverage.missingClosed+s.coverage.conflictingTradeIds.length});
  if(traceMissing.length)s.issues.push({code:'CAUSAL_EXIT_TRACE_MISSING',classification:'INSUFFICIENT_EVIDENCE',count:traceMissing.length});
  if(profitLeads.length)s.issues.push({code:'PROFIT_GIVEBACK_REVIEW_NOT_VERDICT',classification:'REVIEW_LEAD',count:profitLeads.length,tradeIds:profitLeads.map(t=>t.id)});
  if(lowExecutionEdge.length)s.issues.push({code:'EXECUTION_EDGE_DECAY_BELOW_1_25',classification:'CONFIRMED_LOGIC_MISMATCH',
    count:lowExecutionEdge.length,tradeIds:lowExecutionEdge.map(t=>t.id)});
  if(liquidityRebounds.length)s.issues.push({code:'LIQUIDITY_STOP_REBOUND_REVIEW_NOT_VERDICT',classification:'REVIEW_LEAD',
    count:liquidityRebounds.length,tradeIds:liquidityRebounds.map(r=>String(r.tradeId))});
  if(Number(sampling.notAdmittedAttempts)>0&&rejected.length===0)s.issues.push({code:'COUNTERFACTUAL_ADMISSION_STARVATION',
    classification:'CONFIRMED_DIAGNOSTIC_ISSUE',count:Number(sampling.notAdmittedAttempts)});
  if(open.length>10)s.issues.push({code:'ACTIVE_POSITION_COUNT_ABOVE_TEN',classification:'CONFIRMED_PORTFOLIO_STATE',count:open.length});
  if(rejected.length&&!rejected.some(r=>obj(r.checkpointCoverage)['60']==='VALID'))s.issues.push({code:'NO_VALID_60M_CANDIDATE_RESULTS',classification:'INSUFFICIENT_EVIDENCE',count:rejected.length});
  return s;
}
export function mergeReviewArchive(s:ReviewSnapshot,page:ArchivePage){
  if(page.accountStartedAt!==s.meta.accountStartedAt||page.asOf!==s.meta.exportedAt)throw new Error('REVIEW_ACCOUNT_OR_CUTOFF_CHANGED');
  s.trades=mergeTradeRows(s.trades,page.trades.filter(t=>t.openedAt>=s.meta.accountStartedAt&&t.openedAt<=s.meta.exportedAt),s.coverage.conflictingTradeIds);
  s.coverage.conflictingTradeIds=[...new Set([...s.coverage.conflictingTradeIds,...(page.conflictingTradeIds??[])])];
  s.coverage.archiveRecordsRead+=page.recordsRead;s.coverage.archivePagesRead++;s.coverage.archiveNextCursor=page.nextCursor;s.coverage.archiveExhausted=page.exhausted;
  return finalizeReviewSnapshot(s);
}
/** One button, one file; bounded requests yield between archive pages. Guest/member
 * legacy responses are returned unchanged and cannot gain owner diagnostics. */
export async function collectReviewSnapshot(fetcher:typeof fetch,progress?:(n:number,total:number)=>void){
  const response=await fetcher('/api/forward/export',{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw new Error('SNAPSHOT_EXPORT_FAILED');
  const initial=await response.text(),size=(s:string)=>new TextEncoder().encode(s).length;
  if(size(initial)>REVIEW_MAX_BYTES)throw new Error('REVIEW_INITIAL_SIZE_LIMIT');
  const data=JSON.parse(initial) as ReviewSnapshot;
  let totalBytes=size(initial);const deadline=Date.now()+60_000;
  // Native diagnostics are a separate, authenticated actor-local read. A failure
  // never prevents exporting PAPER and never invokes account sync or Gate reads.
  if(data.runtime?.privateLiveReviewAvailable===true||obj(data).liveReviewAvailable===true){
    try{
      const r=await fetcher('/api/live/review',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(15_000)});
      if(!r.ok)throw new Error(`LIVE_REVIEW_HTTP_${r.status}`);
      const raw=await r.text();totalBytes+=size(raw);
      if(totalBytes>REVIEW_MAX_BYTES)throw new Error('LIVE_REVIEW_SIZE_LIMIT');
      const live=JSON.parse(raw) as LiveReview;
      if(live.version!==LIVE_REVIEW_VERSION)throw new Error('LIVE_REVIEW_VERSION_MISMATCH');
      data.liveReview=live;
      const seen=new Set<string>();
      if(live.context.sessionAt>0)for(let i=0;i<16&&!live.coverage.exhausted;i++){
        if(Date.now()>=deadline){live.coverage.limitReached=true;break;}
        const cursor=live.coverage.nextCursor;if(cursor&&seen.has(cursor))throw new Error('LIVE_REVIEW_REPEATED_CURSOR');
        if(cursor)seen.add(cursor);
        const q=new URLSearchParams({page:'closed',session:String(live.context.sessionAt),asOf:String(live.context.asOf),account:String(live.context.accountUser??'')});
        if(cursor)q.set('cursor',cursor);
        const pageResponse=await fetcher('/api/live/review?'+q,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(15_000)});
        if(!pageResponse.ok)throw new Error(`LIVE_REVIEW_PAGE_HTTP_${pageResponse.status}`);
        const rawPage=await pageResponse.text();totalBytes+=size(rawPage);
        if(totalBytes>REVIEW_MAX_BYTES){live.coverage.limitReached=true;break;}
        const page=JSON.parse(rawPage) as {context:LiveReview['context'];positions:LiveReview['positions'];recordsRead:number;nextCursor:string|null;exhausted:boolean};
        if(JSON.stringify(page.context)!==JSON.stringify(live.context))throw new Error('LIVE_REVIEW_CONTEXT_CHANGED');
        const previousPositions=live.positions,combined=new Map(live.positions.map(p=>[p.id,p]));
        for(const p of page.positions){const old=combined.get(p.id);combined.set(p.id,old?.settlement?old:p);}
        live.positions=[...combined.values()];
        if(size(JSON.stringify(data))>REVIEW_MAX_BYTES){live.positions=previousPositions;live.coverage.limitReached=true;break;}
        live.coverage.pagesRead++;live.coverage.recordsRead+=page.recordsRead;
        live.coverage.nextCursor=page.nextCursor;live.coverage.exhausted=page.exhausted;
      }
      if(!live.coverage.exhausted&&live.context.sessionAt>0)live.coverage.limitReached=true;
    }catch(e){
      const error=e instanceof Error?e.message:'LIVE_REVIEW_UNAVAILABLE';
      if(data.liveReview)data.liveReview.coverage.error=error;
      else if(data.runtime)data.runtime.liveReviewError=error;
      else obj(data).liveReviewError=error;
    }
  }
  if(data.version!==REVIEW_SNAPSHOT_VERSION)return data;
  finalizeReviewSnapshot(data);
  if(size(JSON.stringify(data))>REVIEW_MAX_BYTES){delete data.liveReview;data.runtime.liveReviewError='LIVE_REVIEW_FILE_SIZE_LIMIT';finalizeReviewSnapshot(data);}
  const seen=new Set<string>();
  // Complete ledger counts do not imply complete exit evidence. Hot compaction
  // can remove assessments while retaining every settlement row.
  const needsArchive=()=>!data.coverage.complete||Number(data.summary.positionAssessmentMissing)>0||Number(data.summary.exitTraceMissing)>0
    ||Number(data.summary.inverseLossArchiveMissing)>0;
  // 3072 archive packets maximum per click, no background polling or writes.
  for(let page=0;page<64&&needsArchive()&&!data.coverage.archiveExhausted;page++){
    if(Date.now()>=deadline){data.coverage.exportLimitReached=true;break;}
    const cursor=data.coverage.archiveNextCursor;
    if(cursor&&seen.has(cursor)){data.coverage.archiveError='REPEATED_CURSOR';break;}
    if(cursor)seen.add(cursor);
    const q=new URLSearchParams({page:'archive',accountStartedAt:String(data.meta.accountStartedAt),asOf:String(data.meta.exportedAt)});
    if(cursor)q.set('cursor',cursor);
    try{
      const r=await fetcher('/api/forward/export?'+q,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(15_000)});
      if(!r.ok)throw new Error(`ARCHIVE_HTTP_${r.status}`);
      const text=await r.text();totalBytes+=size(text);
      if(totalBytes>REVIEW_MAX_BYTES){data.coverage.exportLimitReached=true;break;}
      const previousTrades=data.trades,previousCoverage=structuredClone(data.coverage);
      mergeReviewArchive(data,JSON.parse(text) as ArchivePage);
      if(size(JSON.stringify(data))>REVIEW_MAX_BYTES){data.trades=previousTrades;data.coverage=previousCoverage;
        data.coverage.exportLimitReached=true;finalizeReviewSnapshot(data);break;}
      progress?.(data.coverage.includedClosed,data.coverage.expectedClosed);
    }catch(e){data.coverage.archiveError=e instanceof Error?e.message:'ARCHIVE_UNAVAILABLE';break;}
  }
  if(needsArchive()&&!data.coverage.archiveExhausted&&!data.coverage.archiveError)data.coverage.exportLimitReached=true;
  return finalizeReviewSnapshot(data);
}
