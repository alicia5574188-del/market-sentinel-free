import type {Trade} from './forward-relations.ts';
import type {ReviewJournal, TradeReview} from './review-trace.ts';

export const REVIEW_SNAPSHOT_VERSION='market-intelligence-review-v2';
const ARCHIVE_PREFIX='forward-relations:v1:archive:';
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const arr=<T>(v:unknown):T[]=>Array.isArray(v)?v:[];
type ObjectRow=Record<string,unknown>;
const obj=(v:unknown):ObjectRow=>v&&typeof v==='object'&&!Array.isArray(v)?v as ObjectRow:{};
const sum=(rows:Trade[],key:keyof Trade)=>rows.reduce((n,t)=>n+(finite(t[key])?t[key] as number:0),0);
const timestamp=(v:unknown)=>finite(v)?new Date(v).toISOString():null;
const beijing=(at:number)=>new Date(at+8*3600_000).toISOString().replace('Z','+08:00');
export type ArchivePage={accountStartedAt:number;asOf:number;trades:Trade[];recordsRead:number;nextCursor:string|null;exhausted:boolean};
type ArchiveReader={list<T>(options:{prefix:string;start:string;end:string;reverse:boolean;limit:number}):Promise<Map<string,T>>};
/** Bounded, strictly read-only page. No remote market data and no account mutation. */
export async function readReviewArchivePage(storage:ArchiveReader,accountStartedAt:number,asOf:number,cursor:string|null):Promise<ArchivePage>{
  if(!Number.isSafeInteger(accountStartedAt)||accountStartedAt<=0||!Number.isSafeInteger(asOf)||asOf<accountStartedAt)throw new Error('INVALID_REVIEW_RANGE');
  const start=ARCHIVE_PREFIX+String(accountStartedAt).padStart(16,'0');
  const end=ARCHIVE_PREFIX+String(asOf+1).padStart(16,'0');
  if(cursor&&(!/^forward-relations:v1:archive:\d{16}:\d+$/.test(cursor)||cursor<start||cursor>=end))throw new Error('INVALID_REVIEW_CURSOR');
  const rows=await storage.list<{startedAt?:number;trades?:Trade[];reviews?:{tradeId:string;review:TradeReview}[]}>({prefix:ARCHIVE_PREFIX,start,end:cursor??end,reverse:true,limit:12});
  const trades:Trade[]=[];
  for(const packet of rows.values()){
    if(packet.startedAt!==accountStartedAt)continue;
    const reviews=new Map((packet.reviews??[]).map(r=>[r.tradeId,r.review]));
    for(const t of packet.trades??[]){
      if(t?.id&&t.status==='CLOSED'&&t.openedAt>=accountStartedAt&&t.openedAt<=asOf&&(t.closedAt===null||t.closedAt<=asOf))
        trades.push(reviews.has(t.id)?{...t,review:reviews.get(t.id)}:t);
    }
  }
  return{accountStartedAt,asOf,trades,recordsRead:rows.size,nextCursor:rows.size===12?[...rows.keys()].at(-1)!:null,exhausted:rows.size<12};
}
export type ReviewSnapshot={
  version:typeof REVIEW_SNAPSHOT_VERSION;
  meta:{exportedAt:number;exportedAtBeijing:string;buildSha:string|null;strategyFingerprint:string|null;policyVersion:unknown;
    accountStartedAt:number;accountStartedAtBeijing:string;sourceUpdatedAt:unknown;marketUpdatedAt:unknown;readOnly:true};
  summary:ObjectRow;coverage:{expectedClosed:number;includedClosed:number;openCount:number;missingClosed:number;complete:boolean;
    archiveRecordsRead:number;archivePagesRead:number;archiveExhausted:boolean;archiveNextCursor:string|null;
    exportLimitReached:boolean;archiveError:string|null;conflictingTradeIds:string[]};
  account:ObjectRow;trades:Trade[];opportunities:unknown[];market:ObjectRow;research:ObjectRow;runtime:ObjectRow;
  decisionJournal:ReviewJournal|null;issues:{code:string;classification:'CONFIRMED_DATA_ISSUE'|'REVIEW_LEAD'|'INSUFFICIENT_EVIDENCE';count:number;tradeIds?:string[]}[];
};
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
    byId.set(t.id,{...older,...newer,review:newer.review??older.review,positionIntelligence:newer.positionIntelligence??older.positionIntelligence});
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
function grouped(rows:Trade[],key:(t:Trade)=>string){
  const groups=new Map<string,Trade[]>();for(const row of rows){const k=key(row);groups.set(k,[...(groups.get(k)??[]),row]);}
  return Object.fromEntries([...groups].map(([k,r])=>[k,performance(r)]));
}
export function checkpointCoverage(row:ObjectRow,at:number){
  const start=Number(row.startedAt),checkpoints=arr<ObjectRow>(row.checkpoints),unavailable=arr<number>(row.unavailableCheckpoints);
  return Object.fromEntries([5,15,30,60,120,240].map(m=>{
    const target=start+m*60_000,cp=checkpoints.find(x=>x.minutes===m);
    const valid=cp&&finite(cp.marketAt)&&finite(cp.price)&&cp.price>0&&finite(cp.targetAt)&&Math.abs(cp.targetAt-target)<=1000
      &&cp.marketAt>=start&&cp.marketAt<=target+90_000&&cp.marketAt>=target-6*60_000;
    return[m,valid?'VALID':unavailable.includes(m)?'UNAVAILABLE':at<target?'PENDING':'DUE_NOT_OBSERVED'];
  }));
}
export function buildReviewSnapshot(input:{view:ObjectRow;buildSha:string|null;strategyFingerprint:string|null;exportedAt:number;
  marketData?:unknown;counterfactual?:unknown;shadow?:unknown;runtime?:ObjectRow;journal?:ReviewJournal|null}):ReviewSnapshot{
  const v=input.view,startedAt=Number(v.startedAt),rawShadow=obj(input.shadow),rawCounter=obj(input.counterfactual);
  const currentShadow=arr<ObjectRow>(rawShadow.trades).filter(t=>Number(t.openedAt)>=startedAt);
  const olderShadow=arr<ObjectRow>(rawShadow.trades).filter(t=>Number(t.openedAt)<startedAt);
  const post=arr<ObjectRow>(rawCounter.postExit).filter(t=>Number(t.openedAt)>=startedAt);
  const rejected=arr<ObjectRow>(rawCounter.rejectedOpportunities).filter(t=>Number(t.observedAt)>=startedAt);
  const pick=(keys:string[])=>Object.fromEntries(keys.map(k=>[k,v[k]??null]));
  const trades=mergeTradeRows(arr<Trade>(v.positions),arr<Trade>(v.history),[]);
  const snapshot:ReviewSnapshot={version:REVIEW_SNAPSHOT_VERSION,
    meta:{exportedAt:input.exportedAt,exportedAtBeijing:beijing(input.exportedAt),buildSha:input.buildSha,strategyFingerprint:input.strategyFingerprint,
      policyVersion:v.policyVersion??null,accountStartedAt:startedAt,accountStartedAtBeijing:beijing(startedAt),sourceUpdatedAt:v.updatedAt??null,
      marketUpdatedAt:obj(v.marketIntelligence).updatedAt??null,readOnly:true},summary:{},
    coverage:{expectedClosed:Number(v.resolved)||0,includedClosed:0,openCount:arr(v.positions).length,missingClosed:0,complete:false,
      archiveRecordsRead:0,archivePagesRead:0,archiveExhausted:false,archiveNextCursor:null,exportLimitReached:false,archiveError:null,conflictingTradeIds:[]},
    account:pick(['initialEquity','balance','equity','floating','netPnl','grossPnl','fees','fundingAllowance','maxDrawdown','turnover','resolved','wins','daily','cost','storage','stalePositions']),
    trades,opportunities:arr(v.opportunities),
    market:{intelligence:v.marketIntelligence??null,environmentRouter:v.environmentRouter??null,hypothesisResearch:v.hypothesisResearch??null,
      marketPulse:v.marketPulse??null,geometry:rawShadow.marketGeometry??[],geometrySummary:rawShadow.summary?obj(rawShadow.summary).rollingGeometry:null},
    research:{shadowUpdatedAt:rawShadow.updatedAt??null,counterfactualUpdatedAt:rawCounter.updatedAt??null,
      tradeQuality:currentShadow,retiredTrades:arr(rawShadow.retiredTrades),priorAccount:{excludedShadowCount:olderShadow.length+arr(rawShadow.retiredTrades).length,excludedShadowTradeIds:olderShadow.map(t=>t.tradeId),
        excludedOpenRecords:olderShadow.filter(t=>t.status==='OPEN').length,status:'ISOLATED_NOT_ASSUMED_CLOSED'},
      postExit:post.map(r=>({...r,checkpointCoverage:checkpointCoverage(r,input.exportedAt)})),
      rejectedOpportunities:rejected.map(r=>({...r,checkpointCoverage:checkpointCoverage(r,input.exportedAt),
        blockerScope:r.blockerScope??'LEGACY_AGGREGATE_NOT_CANDIDATE_CAUSE'})),
      sampling:rawCounter.sampling??null,
      notes:{peakProfit:'Observed or modeled, not achievable profit entitlement.',postExit:'Later prices cannot be used as entry-time knowledge.',
        discovery:'Bounded observed samples, not a full-market replay.',timeUnit:'Unix milliseconds; *_Rate is decimal, not percent.'}},
    runtime:{...input.runtime,marketData:input.marketData??null,liveMirror:v.liveMirror??null,entryValidation:v.entryValidation??null,
      entryDiagnostics:v.entryDiagnostics??null,events:arr(v.events)},decisionJournal:input.journal??null,issues:[]};
  return finalizeReviewSnapshot(snapshot);
}
export function finalizeReviewSnapshot(s:ReviewSnapshot):ReviewSnapshot{
  const closed=s.trades.filter(t=>t.status==='CLOSED'&&t.openedAt>=s.meta.accountStartedAt),open=s.trades.filter(t=>t.status==='OPEN');
  s.coverage.includedClosed=closed.length;s.coverage.missingClosed=Math.max(0,s.coverage.expectedClosed-closed.length);
  s.coverage.complete=s.coverage.missingClosed===0&&closed.length===s.coverage.expectedClosed&&s.coverage.conflictingTradeIds.length===0;
  const traceMissing=closed.filter(t=>!t.review?.terminal),piMissing=closed.filter(t=>!t.positionIntelligence&&!t.review?.terminal?.assessments.length);
  const profitLeads=closed.filter(t=>t.favorable*t.notional>Math.max(2,(t.entryFee+t.exitFee)*4)
    &&(t.netPnl??0)<t.favorable*t.notional*.4).sort((a,b)=>b.favorable*b.notional-a.favorable*a.notional).slice(0,5),
    lowExecutionEdge=closed.filter(t=>Number(t.entryContext?.edgeRatio)<1.25).sort((a,b)=>(a.netPnl??0)-(b.netPnl??0)).slice(0,8);
  const rejected=arr<ObjectRow>(s.research.rejectedOpportunities),sampling=obj(s.research.sampling),
    postExit=arr<ObjectRow>(s.research.postExit),liquidityRebounds=postExit.filter(r=>r.exitReason==='LIQUIDITY_HYPOTHESIS_INVALIDATED'
      &&arr<ObjectRow>(r.checkpoints).some(p=>[5,15,30].includes(Number(p.minutes))&&Number(p.netAfterCostRate)>.002)).slice(0,8),
    maturity=Object.fromEntries([5,15,30,60,120,240].map(m=>{
    const statuses=rejected.map(r=>obj(r.checkpointCoverage)[m]);return[m,{tracked:statuses.length,
      valid:statuses.filter(v=>v==='VALID').length,pending:statuses.filter(v=>v==='PENDING').length,
      unavailable:statuses.filter(v=>v==='UNAVAILABLE').length,dueNotObserved:statuses.filter(v=>v==='DUE_NOT_OBSERVED').length}];}));
  const mirror=obj(s.runtime.liveMirror),rows=arr<ObjectRow>(mirror.rows),ownerOff=rows.length>0&&rows.every(r=>r.status==='OWNER_OFF');
  s.summary={accountCumulative:{equity:s.account.equity,netEquityChange:s.account.netPnl,realizedGross:s.account.grossPnl,
      fees:s.account.fees,fundingAllowance:s.account.fundingAllowance,floating:s.account.floating,closedCount:s.coverage.expectedClosed},
    includedClosedPerformance:performance(closed),byEntryPlan:grouped(closed,t=>t.entryContext?.tradePlan??'LEGACY_UNCLASSIFIED'),
    byEntryEnvironment:grouped(closed,t=>t.entryContext?.environment??'UNKNOWN'),byExit:grouped(closed,t=>t.exitReason??'UNKNOWN'),
    byEntryStrategyFingerprint:grouped(closed,t=>t.review?.entryStrategyFingerprint??'UNKNOWN_LEGACY'),
    activeCount:open.length,exitTraceMissing:traceMissing.length,positionAssessmentMissing:piMissing.length,
    counterfactualMaturity:maturity,liveAssessment:ownerOff?'OWNER_OFF_NOT_A_COPY_FAILURE':(s.runtime.liveAssessment??'SEE_SCOPED_LIVE_EVIDENCE'),
    observedOrderWindow:{from:timestamp(closed.length?Math.min(...closed.map(t=>t.openedAt)):null),to:timestamp(closed.length?Math.max(...closed.map(t=>t.closedAt??0)):null)}};
  s.issues=[];
  if(!s.coverage.complete)s.issues.push({code:'TRADE_HISTORY_INCOMPLETE_OR_CONFLICTING',classification:'CONFIRMED_DATA_ISSUE',count:s.coverage.missingClosed+s.coverage.conflictingTradeIds.length});
  if(traceMissing.length)s.issues.push({code:'CAUSAL_EXIT_TRACE_MISSING',classification:'INSUFFICIENT_EVIDENCE',count:traceMissing.length});
  if(profitLeads.length)s.issues.push({code:'PROFIT_GIVEBACK_REVIEW_NOT_VERDICT',classification:'REVIEW_LEAD',count:profitLeads.length,tradeIds:profitLeads.map(t=>t.id)});
  if(lowExecutionEdge.length)s.issues.push({code:'EXECUTION_EDGE_DECAY_BELOW_1_25',classification:'REVIEW_LEAD',
    count:lowExecutionEdge.length,tradeIds:lowExecutionEdge.map(t=>t.id)});
  if(liquidityRebounds.length)s.issues.push({code:'LIQUIDITY_STOP_REBOUND_REVIEW_NOT_VERDICT',classification:'REVIEW_LEAD',
    count:liquidityRebounds.length,tradeIds:liquidityRebounds.map(r=>String(r.tradeId))});
  if(Number(sampling.notAdmittedAttempts)>0&&rejected.length===0)s.issues.push({code:'COUNTERFACTUAL_ADMISSION_STARVATION',
    classification:'CONFIRMED_DATA_ISSUE',count:Number(sampling.notAdmittedAttempts)});
  if(open.length>10)s.issues.push({code:'ACTIVE_POSITION_COUNT_ABOVE_TEN',classification:'REVIEW_LEAD',count:open.length});
  if(rejected.length&&!rejected.some(r=>obj(r.checkpointCoverage)['60']==='VALID'))s.issues.push({code:'NO_VALID_60M_CANDIDATE_RESULTS',classification:'INSUFFICIENT_EVIDENCE',count:rejected.length});
  return s;
}
export function mergeReviewArchive(s:ReviewSnapshot,page:ArchivePage){
  if(page.accountStartedAt!==s.meta.accountStartedAt||page.asOf!==s.meta.exportedAt)throw new Error('REVIEW_ACCOUNT_OR_CUTOFF_CHANGED');
  s.trades=mergeTradeRows(s.trades,page.trades.filter(t=>t.openedAt>=s.meta.accountStartedAt&&t.openedAt<=s.meta.exportedAt),s.coverage.conflictingTradeIds);
  s.coverage.archiveRecordsRead+=page.recordsRead;s.coverage.archivePagesRead++;s.coverage.archiveNextCursor=page.nextCursor;s.coverage.archiveExhausted=page.exhausted;
  return finalizeReviewSnapshot(s);
}
/** One button, one file; bounded requests yield between archive pages. Guest/member
 * legacy responses are returned unchanged and cannot gain owner diagnostics. */
export async function collectReviewSnapshot(fetcher:typeof fetch,progress?:(n:number,total:number)=>void){
  const response=await fetcher('/api/forward/export',{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw new Error('SNAPSHOT_EXPORT_FAILED');
  const data=await response.json() as ReviewSnapshot;
  if(data.version!==REVIEW_SNAPSHOT_VERSION)return data;
  const seen=new Set<string>();let totalBytes=0;
  // Complete ledger counts do not imply complete exit evidence. Hot compaction
  // can remove assessments while retaining every settlement row.
  const needsArchive=()=>!data.coverage.complete||Number(data.summary.positionAssessmentMissing)>0;
  // 768 archive packets maximum per click, no background polling.
  for(let page=0;page<64&&needsArchive()&&!data.coverage.archiveExhausted;page++){
    const cursor=data.coverage.archiveNextCursor;
    if(cursor&&seen.has(cursor)){data.coverage.archiveError='REPEATED_CURSOR';break;}
    if(cursor)seen.add(cursor);
    const q=new URLSearchParams({page:'archive',accountStartedAt:String(data.meta.accountStartedAt),asOf:String(data.meta.exportedAt)});
    if(cursor)q.set('cursor',cursor);
    try{
      const r=await fetcher('/api/forward/export?'+q,{cache:'no-store',credentials:'same-origin'});
      if(!r.ok)throw new Error(`ARCHIVE_HTTP_${r.status}`);
      const text=await r.text();totalBytes+=new TextEncoder().encode(text).length;
      if(totalBytes>12*1024*1024){data.coverage.exportLimitReached=true;break;}
      mergeReviewArchive(data,JSON.parse(text) as ArchivePage);progress?.(data.coverage.includedClosed,data.coverage.expectedClosed);
    }catch(e){data.coverage.archiveError=e instanceof Error?e.message:'ARCHIVE_UNAVAILABLE';break;}
  }
  if(needsArchive()&&!data.coverage.archiveExhausted&&!data.coverage.archiveError)data.coverage.exportLimitReached=true;
  return finalizeReviewSnapshot(data);
}
