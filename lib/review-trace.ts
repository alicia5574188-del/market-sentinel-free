import {RESEARCH_PLAN_VERSION} from './research-plan.ts';
import {realizedNetPnl,realizedContribution} from "./trade-realization.ts";
import {PAPER_COST, type ForwardState, type Trade, type Quote} from './forward-relations.ts';

export const REVIEW_TRACE_VERSION = 'decision-review-v2';
export const REVIEW_JOURNAL_KEY = 'market-intelligence:review:v2:journal';
export const REVIEW_JOURNAL_BYTES = 80 * 1024;
export type ReviewEvent = {
  at:number; id:string; symbol:string; stage:string; reason:string; price?:number;
  buildSha?:string;strategyFingerprint?:string;planVersion?:string;
  research?:{level:string;entryAction:string;riskScale:number;sourceAt:number|null;hypothesisIds:string[]};
  quoteAt?:number; side?:"LONG"|"SHORT"; tradeId?:string; plan?:string; expiresAt?:number; invalidationPrice?:number|null;
};
export type TradeReviewPoint = {
  at:number; quoteAt:number|null; barAt:number|null; decision:string; netPnl:number;
  stopPrice:number; floorRate:number; concerns:string[]; support:string[];
  action?:string;requestedAction?:string;reasonCode?:string;researchLevel?:string;marketLevel?:string;
  evidenceGroups?:string[];referencePrice?:number|null;evidenceBars?:number[];
  remainingContracts?:number;partialRealizedNetPnl?:number;price?:number;reductionResult?:string;
};
export type TradeReview = {
  version:typeof REVIEW_TRACE_VERSION; accountStartedAt:number; observedSince:number; fromEntry:boolean;
  entryBuildSha:string|null; entryStrategyFingerprint:string|null; lastBuildSha:string;
  initialStopPrice:number|null; firstNetPositiveAt:number|null; firstConcernAt:number|null;
  peakGrossPnl:number; peakGrossAt:number|null; peakNetPnl:number|null; peakNetAt:number|null;
  peakAssessment:TradeReviewPoint|null; timeline:TradeReviewPoint[]; droppedPoints:number;
  exitBuildSha?:string; exitStrategyFingerprint?:string;
  diagnosticVersion?:'research-plan-audit-v1';entryPlanVersion?:string;
  policySpans?:{at:number;buildSha:string;strategyFingerprint:string}[];droppedPolicySpans?:number;
  milestones?:{firstMarketCaution?:TradeReviewPoint;firstLocalReview?:TradeReviewPoint;firstProtection?:TradeReviewPoint;reductions:TradeReviewPoint[]};
  terminal?:{trigger:string|null; evidence:Trade['exitAudit']; assessment:TradeReviewPoint;
    reviewSince:number|null; reviewBars:number|null; dataConfidence:number|null; assessments:unknown[]};
};
const size=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);

/** Metadata only. Called after the trading calculation, before its existing commit.
 * No signal, money, stop, order, changed flag or checkpoint cadence is modified. */
export function captureTradeReviews(previous:ForwardState,next:ForwardState,now:number,buildSha:string,strategyFingerprint:string,quotes:Record<string,Quote>){
  const prior=new Map([...previous.positions,...previous.history].map(t=>[t.id,t]));
  for(const t of [...next.positions,...next.history]){
    const old=prior.get(t.id); if(t.status==='CLOSED'&&old?.status==='CLOSED')continue;
    const fromEntry=!old&&t.openedAt===now;
    const review:TradeReview=t.review?structuredClone(t.review):{
      version:REVIEW_TRACE_VERSION,accountStartedAt:next.startedAt,observedSince:now,fromEntry,
      entryBuildSha:fromEntry?buildSha:null,entryStrategyFingerprint:fromEntry?strategyFingerprint:null,lastBuildSha:buildSha,
      initialStopPrice:fromEntry?t.stopPrice:null,firstNetPositiveAt:null,firstConcernAt:null,
      peakGrossPnl:(old?.favorable??t.favorable)*t.notional,peakGrossAt:null,peakNetPnl:null,peakNetAt:null,
      peakAssessment:null,timeline:[],droppedPoints:0};
    const q=quotes[t.symbol],quoteAt=q?.observedAt??null;
    // Do not label a stale mark as a new observation or first profitable quote.
    const fresh=!!q&&q.fresh&&q.observedAt<=now&&now-q.observedAt<=10_000;
    const gross=realizedContribution(t)+(t.side==='LONG'?1:-1)*t.quantity*(t.lastPrice-t.entryPrice);
    const modeledNet=gross-t.entryFee-t.quantity*t.lastPrice*PAPER_COST.feeRate-t.notional*PAPER_COST.fundingAllowancePerDay*Math.max(0,now-t.openedAt)/86_400_000;
    const net=t.status==='CLOSED'?(t.netPnl??modeledNet):modeledNet;
    const pi=t.positionIntelligence,wm=t.winnerManagement,integrated=t.entryContext?.winnerPlan?.researchVersion===RESEARCH_PLAN_VERSION;
    const point:TradeReviewPoint={at:now,quoteAt,barAt:pi?.lastCompletedBar??null,decision:pi?.decision??'UNASSESSED',
      netPnl:net,stopPrice:t.stopPrice,floorRate:t.profitFloorRate??0,concerns:pi?.concernFamilies??[],support:pi?.supportFamilies??[],...(integrated?{
        action:fromEntry?'ENTRY':t.status==='CLOSED'?'EXIT':wm?.appliedAction??'HOLD',requestedAction:wm?.requestedAction,
        reasonCode:t.status==='CLOSED'?t.exitReason??'UNKNOWN':wm?.actionReason,
        researchLevel:wm?.research?.level,marketLevel:wm?.research?.context.level,
        evidenceGroups:wm?.research?.evidenceGroups,referencePrice:wm?.research?.referencePrice,evidenceBars:wm?.research?.bars,
        price:t.lastPrice,remainingContracts:t.status==='OPEN'?t.contracts:0,partialRealizedNetPnl:realizedNetPnl(t),reductionResult:wm?.reductionResult}: {})};
    if(integrated){
      review.diagnosticVersion='research-plan-audit-v1';review.entryPlanVersion=RESEARCH_PLAN_VERSION;
      review.policySpans??=[];
      if(review.policySpans.at(-1)?.buildSha!==buildSha)review.policySpans.push({at:now,buildSha,strategyFingerprint});
      while(review.policySpans.length>4){review.policySpans.splice(1,1);review.droppedPolicySpans=(review.droppedPolicySpans??0)+1;}
      review.milestones??={reductions:[]};
      const anchors=review.milestones;
      if(fresh){
        if(point.marketLevel==='CAUTION')anchors.firstMarketCaution??=point;
        if(['LOCAL_REVIEW','PROTECT','INVALIDATED'].includes(point.researchLevel??''))anchors.firstLocalReview??=point;
        if(t.stopPrice!==(old?.stopPrice??t.stopPrice))anchors.firstProtection??=point;
        if((t.realization?.sequence??0)>(old?.realization?.sequence??0)&&anchors.reductions.length<2)anchors.reductions.push(point);
      }
    }
    if(fresh){
      if(net>0&&review.firstNetPositiveAt===null)review.firstNetPositiveAt=now;
      if(point.concerns.length&&review.firstConcernAt===null)review.firstConcernAt=now;
      if(review.peakNetPnl===null||net>review.peakNetPnl){review.peakNetPnl=net;review.peakNetAt=now;review.peakAssessment=point;}
      const peak=t.status==='CLOSED'?(t.grossPnl??0):t.realization?(t.realization.gross+(t.side==="LONG"?1:-1)*t.quantity*(t.lastPrice-t.entryPrice)):t.favorable*t.notional;
      if(peak>review.peakGrossPnl){review.peakGrossPnl=peak;review.peakGrossAt=quoteAt;}
    }
    const last=review.timeline.at(-1);
    if(fresh||t.status==='CLOSED'){
      const changed=!last||t.status==='CLOSED'||last.decision!==point.decision
        ||last.concerns.join()!==point.concerns.join()||last.support.join()!==point.support.join()
        ||last.stopPrice!==point.stopPrice||last.action!==point.action||last.researchLevel!==point.researchLevel||last.marketLevel!==point.marketLevel;
      if(changed)review.timeline.push(point);
    }
    while(review.timeline.length>6){review.timeline.splice(1,1);review.droppedPoints++;}
    review.lastBuildSha=buildSha;
    if(t.status==='CLOSED'){
      review.exitBuildSha=buildSha;review.exitStrategyFingerprint=strategyFingerprint;
      review.terminal={trigger:t.exitReason,evidence:integrated&&t.exitAudit?{...t.exitAudit,evidence:{authority:t.exitAudit.evidence?.authority,fullEvidencePath:'trade.exitAudit'}}:t.exitAudit,assessment:point,
        reviewSince:pi?.reviewSince??null,reviewBars:pi?.reviewBars??null,dataConfidence:pi?.dataConfidence??null,
        assessments:(pi?.assessments??[]).map(a=>({family:a.family,stance:a.stance,severity:a.severity,contextOnly:a.contextOnly===true}))};
    }
    while(size(review)>(integrated?6144:3072)&&review.timeline.length>1){review.timeline.splice(0,1);review.droppedPoints++;}
    t.review=review;
  }
}
export type DiscoveryReview={at:number;sourceAt:number|null;catalogCount:number;radarInputCount:number;eligibleCount:number;
  selected:{symbol:string;rank:number;source:string;score:number}[];
  sampledOutside:{symbol:string;shortMoveRate:number;reason:string}[]};
export type ReviewJournal={version:typeof REVIEW_TRACE_VERSION;accountStartedAt:number;startedAt:number;updatedAt:number;persistedAt:number;
  candidates:{id:string;symbol:string;firstObservedAt:number;lastObservedAt:number;tradeId:string|null;events:ReviewEvent[]}[];
  discovery:DiscoveryReview[];droppedCandidates:number;droppedEvents:number;droppedDiscovery:number};
export function initialReviewJournal(startedAt:number,now:number):ReviewJournal{
  return{version:REVIEW_TRACE_VERSION,accountStartedAt:startedAt,startedAt:now,updatedAt:now,persistedAt:0,
    candidates:[],discovery:[],droppedCandidates:0,droppedEvents:0,droppedDiscovery:0};
}
export function appendReviewEvents(j:ReviewJournal,events:ReviewEvent[],now:number){
  for(const event of events){
    let row=j.candidates.find(r=>r.id===event.id);
    if(!row){row={id:event.id,symbol:event.symbol,firstObservedAt:event.at,lastObservedAt:event.at,tradeId:null,events:[]};j.candidates.push(row);}
    row.lastObservedAt=event.at;if(event.tradeId)row.tradeId=event.tradeId;
    const last=row.events.at(-1),signature=(e:ReviewEvent)=>[e.stage,e.reason.replace(/[-+]?\d+(\.\d+)?/g,'#'),e.buildSha,e.planVersion,e.research?.level,e.research?.entryAction].join('|');
    if(!last||signature(last)!==signature(event))row.events.push({...event,reason:event.reason.slice(0,220),research:event.research?{level:event.research.level,entryAction:event.research.entryAction,riskScale:event.research.riskScale,sourceAt:event.research.sourceAt,hypothesisIds:event.research.hypothesisIds.slice(0,3)}:undefined});
    // Same-state numeric updates are not additional transitions.
    while(row.events.length>10){row.events.splice(1,1);j.droppedEvents++;}
  }
  if(events.length)j.updatedAt=now;
  trimReviewJournal(j);
}
export function recordDiscoveryReview(j:ReviewJournal,row:DiscoveryReview){
  const prior=j.discovery.at(-1);
  if(prior&&Math.floor(prior.at/300_000)===Math.floor(row.at/300_000))j.discovery[j.discovery.length-1]=row;
  else j.discovery.push(row);
  j.updatedAt=row.at;trimReviewJournal(j);
}
export function trimReviewJournal(j:ReviewJournal){
  const evictCandidate=()=>{const unarmed=j.candidates.findIndex(r=>!r.tradeId&&!r.events.some(e=>e.stage==='AUTHORIZED'));
    j.candidates.splice(unarmed<0?0:unarmed,1);j.droppedCandidates++;};
  while(j.candidates.length>64)evictCandidate();
  while(j.discovery.length>36){j.discovery.shift();j.droppedDiscovery++;}
  while(size(j)>REVIEW_JOURNAL_BYTES){
    if(j.discovery.length>1){j.discovery.shift();j.droppedDiscovery++;}
    else if(j.candidates.length>1)evictCandidate();
    else break;
  }
}
export function normalizeReviewJournal(value:unknown,startedAt:number,now:number){
  const v=value as ReviewJournal|undefined;
  if(!v||v.version!==REVIEW_TRACE_VERSION||v.accountStartedAt!==startedAt||!Array.isArray(v.candidates)||!Array.isArray(v.discovery))return initialReviewJournal(startedAt,now);
  const j=structuredClone(v);j.persistedAt=finite(j.persistedAt)?j.persistedAt:0;trimReviewJournal(j);return j;
}
