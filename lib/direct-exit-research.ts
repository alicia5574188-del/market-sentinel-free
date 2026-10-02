/** Optional actual-order diagnostics. Never a trading input or a write trigger. */
import type {ForwardState,Trade,Quote} from './forward-relations.ts';
import {realizedContribution} from './trade-realization.ts';

export const DIRECT_EXIT_RESEARCH_VERSION='actual-exit-research-v1';
export const DIRECT_EXIT_RESEARCH_BYTES=4096, DIRECT_EXIT_RESEARCH_POINTS=8, DIRECT_EXIT_HOT_CLOSED=8;
export type ExitResearchPoint={at:number;quoteAt:number;kind:string;floating:number;exitNet:number|null;price:number|null;
  contracts:number;paidFees:number;exitFee:number|null;decision:string;reason:string;barAt:number;
  premiseSide:'LONG'|'SHORT';support:string[];concerns:string[];confirmationAt:number|null;confirmedSide:string|null;
  flowConfirmed:boolean|null;confirmationBars:number[];premiseDecision:string;premiseScore:number|null;
  market:string;concurrentDeepLosses:number;sameSideOpen:number};
export type DirectExitResearch={version:typeof DIRECT_EXIT_RESEARCH_VERSION;observedSince:number;lastObservedAt:number;
  fromEntry:boolean;migrated:boolean;resumedAfterOmission:boolean;firstLoss10At:number|null;worstFloating:number;
  worstExitNet:number|null;bestAfter10:number|null;recoveryMask:number;droppedPoints:number;maxObservationGapMs:number;points:ExitResearchPoint[];
  anchors:Record<string,number>;finalNet?:number;exitReason?:string};
const bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const short=(s:unknown,n=80)=>typeof s==='string'?s.slice(0,n):'';
export function boundedDirectExitResearch(value:unknown):DirectExitResearch|undefined{
  const r=value as DirectExitResearch|undefined;
  if(!r||r.version!==DIRECT_EXIT_RESEARCH_VERSION||!Array.isArray(r.points)||r.points.length>DIRECT_EXIT_RESEARCH_POINTS
    ||!r.anchors||Object.keys(r.anchors).length>8||!Object.values(r.anchors).every(finite)||!finite(r.observedSince)||!finite(r.lastObservedAt)
    ||!finite(r.worstFloating)||!finite(r.maxObservationGapMs)
    ||r.points.some(p=>!p||![p.at,p.quoteAt,p.floating,p.contracts,p.paidFees].every(finite)||typeof p.reason!=='string')
    ||bytes(r)>DIRECT_EXIT_RESEARCH_BYTES)return undefined;
  return structuredClone(r);
}
export function withoutDirectExitResearch(t:Trade):Trade{
  if(!t.directExitResearch&&!t.unified?.researchObservation)return t;
  const row={...t,...(t.directExitResearch?{directExitResearchOmitted:true as const}:{})};delete row.directExitResearch;
  if(row.unified?.researchObservation){row.unified={...row.unified};delete row.unified.researchObservation;}
  return row;
}
/** Keep only eight recent closed traces hot; cold financial archives retain
 * the full trace when it fits their existing packet, with explicit gaps otherwise. */
export function trimDirectExitHistory(s:ForwardState,now:number){
  let kept=0;
  for(const t of s.history)if(t.directExitResearch&&t.closedAt!==now&&kept++>=DIRECT_EXIT_HOT_CLOSED){
    delete t.directExitResearch;t.directExitResearchOmitted=true;
  }
}
export function directExecutionTradeProjection(t:Trade):Trade{
  const row={...t};delete row.directExitResearch;delete row.directExitResearchOmitted;
  if(row.unified?.researchObservation){row.unified={...row.unified};delete row.unified.researchObservation;}
  return row;
}
export function captureDirectExitResearch(s:ForwardState,t:Trade,q:Quote|undefined,now:number,fromEntry:boolean){
  if(t.paperOrder&&t.paperOrder.phase!=='FILLED')return;
  if(t.unified?.version!=='dual-thesis-v2')return;
  const terminal=t.status==='CLOSED',fresh=!!q&&q.fresh&&q.observedAt<=now&&now-q.observedAt<=10000
    &&q.bestBid>0&&q.bestAsk>=q.bestBid;
  if(!fresh&&!terminal)return;
  const existing=boundedDirectExitResearch(t.directExitResearch),r:DirectExitResearch=existing??{
    version:DIRECT_EXIT_RESEARCH_VERSION,observedSince:now,lastObservedAt:now,fromEntry,
    migrated:!!t.unified.migratedAt,resumedAfterOmission:!!t.directExitResearchOmitted,
    firstLoss10At:null,worstFloating:0,worstExitNet:null,bestAfter10:null,recoveryMask:0,
    droppedPoints:0,maxObservationGapMs:0,points:[],anchors:{}};
  if(!terminal&&now<=r.lastObservedAt&&existing)return;
  const d=t.side==='LONG'?1:-1,floating=terminal?0:d*t.quantity*(t.lastPrice-t.entryPrice),
    price=terminal?(finite(t.exitPrice)?t.exitPrice:null):fresh?(t.side==='LONG'?q!.bestBid:q!.bestAsk):null,
    exitFee=price===null?null:t.quantity*price*.0005,
    net=terminal?(finite(t.netPnl)?t.netPnl:null):price===null?null:realizedContribution(t)+d*t.quantity*(price-t.entryPrice)-t.entryFee-exitFee!,
    u=t.unified,pi=u.branch==='RETURN'?u.returnLogic?.assessment:t.positionIntelligence,
    observation=u.researchObservation,proof=observation?.confirmation??u.confirmation,
    p:ExitResearchPoint={at:now,quoteAt:fresh?q!.observedAt:t.lastQuoteAt,kind:'OBSERVE',floating,exitNet:net,price,
      contracts:terminal?0:t.contracts,paidFees:t.entryFee+(t.realization?.fees??0)+(terminal?t.exitFee-(t.realization?.fees??0):0),
      exitFee:terminal?0:exitFee,decision:terminal?'EXIT':u.decision,reason:short(terminal?t.exitReason:u.holdReason),
      barAt:u.lastBarAt,premiseSide:u.branch==='RETURN'?(u.returnLogic?.moveSide??t.side):t.side,
      support:(pi?.supportFamilies??[]).slice(0,2).map(x=>short(x,20)),concerns:(pi?.concernFamilies??[]).slice(0,2).map(x=>short(x,20)),
      confirmationAt:proof?.at??null,confirmedSide:proof?.side??null,flowConfirmed:observation?.flowConfirmed??null,
      confirmationBars:(proof?.bars??[]).slice(-3),premiseDecision:pi?.decision??'UNASSESSED',premiseScore:pi?.holdValueScore??null,
      market:short(s.environmentContext.environment,24),concurrentDeepLosses:s.positions.filter(x=>x.lastQuoteAt<=now&&now-x.lastQuoteAt<=10000
        &&(x.side==='LONG'?1:-1)*x.quantity*(x.lastPrice-x.entryPrice)<-10).length,
      sameSideOpen:s.positions.filter(x=>x.side===t.side).length};
  const keys:string[]=[];
  if(!existing)keys.push('observedStart');
  if(!terminal&&floating<-10&&r.firstLoss10At===null){r.firstLoss10At=now;keys.push('firstLoss10');}
  if(!terminal&&floating<r.worstFloating){r.worstFloating=floating;keys.push('worstFloating');}
  if(net!==null&&(r.worstExitNet===null||net<r.worstExitNet)){r.worstExitNet=net;keys.push('worstExitNet');}
  if(r.firstLoss10At!==null&&!terminal){
    if(r.bestAfter10===null||floating>r.bestAfter10){r.bestAfter10=floating;keys.push('bestAfter10');}
    for(const [i,level] of [-5,-2,0].entries())if(floating>=level&&!(r.recoveryMask&(1<<i))){
      r.recoveryMask|=1<<i;keys.push(`recover${i}`);
    }
  }
  if(terminal){keys.push('terminal');r.finalNet=t.netPnl??undefined;r.exitReason=short(t.exitReason);}
  const last=r.points.at(-1),signature=(x:ExitResearchPoint)=>[x.decision,x.reason,x.barAt,x.confirmationAt,x.flowConfirmed,x.market,x.concerns.join(),x.support.join()].join('|');
  if(keys.length||!last||signature(p)!==signature(last)||(r.firstLoss10At!==null&&now-last.at>=60000)){
    p.kind=keys.join('+')||'EVIDENCE_CHANGE';r.points.push(p);for(const k of keys)r.anchors[k]=now;
  }
  r.maxObservationGapMs=Math.max(r.maxObservationGapMs,now-r.lastObservedAt);
  // Anchors are timestamp references, never duplicated large event bodies.
  while(r.points.length>DIRECT_EXIT_RESEARCH_POINTS||bytes(r)>DIRECT_EXIT_RESEARCH_BYTES){
    const pinned=new Set(Object.values(r.anchors)),free=r.points.findIndex(x=>!pinned.has(x.at));
    const index=free>=0?free:r.points.findIndex(x=>x.at!==r.anchors.firstLoss10&&x.at!==r.anchors.terminal);
    if(index<0){t.directExitResearchOmitted=true;delete t.directExitResearch;return;}
    r.points.splice(index,1);r.droppedPoints++;
  }
  // At most eight timestamp anchors; retire the redundant start reference first.
  for(const k of ['observedStart','recover0','recover1'])if(Object.keys(r.anchors).length>8)delete r.anchors[k];
  r.lastObservedAt=now;t.directExitResearch=r;delete t.directExitResearchOmitted;
}
export function directExitResearchView(trades:Trade[]){
  const actual=trades.filter(t=>t.unified?.version==='dual-thesis-v2'),observed=actual.filter(t=>!!t.directExitResearch),
    deep=observed.filter(t=>t.directExitResearch!.firstLoss10At!==null);
  return{version:DIRECT_EXIT_RESEARCH_VERSION,perTradeBytes:DIRECT_EXIT_RESEARCH_BYTES,pointsPerTrade:DIRECT_EXIT_RESEARCH_POINTS,
    hotClosedLimit:DIRECT_EXIT_HOT_CLOSED,observed:observed.length,unobserved:actual.length-observed.length,
    deepLossTrades:deep.map(t=>({tradeId:t.id,branch:t.unified!.branch,side:t.side,firstLoss10At:t.directExitResearch!.firstLoss10At,
      worstFloating:t.directExitResearch!.worstFloating,finalNet:t.netPnl,fromEntry:t.directExitResearch!.fromEntry,
      migrated:t.directExitResearch!.migrated,resumedAfterOmission:t.directExitResearch!.resumedAfterOmission,
      droppedPoints:t.directExitResearch!.droppedPoints,maxObservationGapMs:t.directExitResearch!.maxObservationGapMs,
      missingAnchorKinds:Object.entries(t.directExitResearch!.anchors).filter(([,at])=>!t.directExitResearch!.points.some(p=>p.at===at)).map(([kind])=>kind),
      candidates:t.directExitResearch!.points.filter(p=>p.exitNet!==null).map(p=>({at:p.at,kind:p.kind,exitNet:p.exitNet,
        improvementVsFinal:t.status==='CLOSED'&&finite(t.netPnl)?p.exitNet!-t.netPnl:null}))})),
    recoveredWinningControls:deep.filter(t=>t.status==='CLOSED'&&(t.netPnl??0)>=0).map(t=>t.id),
    limitations:['BBO_EXIT_ESTIMATE_NOT_LIVE_FILL','EXTREMA_ARE_HINDSIGHT_NOT_EXIT_RULES','BOUNDED_EVENTS_NOT_CONTINUOUS_PATH',
      'RETURN_PREMISE_SIDE_IS_OBSERVED_PUSH_SIDE','NO_FEEDBACK_REPLAY_OR_POST_EXIT_PATH','PRE_SLOT_CRASH_CAN_LOSE_OPTIONAL_OBSERVATIONS']};
}
