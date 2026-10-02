/** Bounded, observational PAPER exit research. No orders or decision feedback. */
import type {ForwardState,Quote,Trade} from './forward-relations.ts';
import {INVERSE_COST,INVERSE_FEE_POLICY} from './inverse-fee.ts';

export const INVERSE_LOSS_RESEARCH_VERSION='inverse-loss-exit-research-v1';
export const INVERSE_LOSS_RESEARCH_BYTES=16*1024;
export const INVERSE_LOSS_RESEARCH_POINTS=20;
export const INVERSE_LOSS_RESEARCH_THRESHOLD=10;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const round=(v:number)=>Math.round(v*1e8)/1e8+0;
const size=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
type SourceEvidence={at:number;decision:string;phase:string;holdScore:number;continuationRatio:number;
  advantageChange:number;dataConfidence:number;reviewBars:number;barAt:number;support:string[];concerns:string[];
  remainingSpaceRate:number|null;expectedPullbackRate:number|null;currentAdvantage:number|null;
  assessments:[string,string,number,boolean][];exitBasis:string|null};
export type InverseLossPoint={
  at:number;quoteAt:number;status:'OPEN'|'CLOSED';reasons:string[];paperPrice:number;remainingQuantity:number;
  grossFloating:number;paperExitNet:number;estimatedExitFee:number;feeRate:number;feePolicy:string;
  executablePrice:number|null;executableExitNet:number|null;sourceEvidence:SourceEvidence|null;
  sourceProtection:{stop:number;distanceRate:number;action:string|null;reason:string|null;phase:string|null;peakNetRate:number|null};
  market:{at:number;major:string;short:string;transition:string;breadth:number|null};
  inverseEvidence:{directionScore:number|null;oppositeScore:number|null;path:number|null;alignedResidualZ:number|null;
    alignedVenuePressure:number|null;alignedBook:number|null;alignedLiquidity:number|null;sourceCount:number|null};
};
type Anchor='entry'|'firstLoss5'|'firstLoss10'|'worstLoss'|'bestBeforeLoss10'|'bestAfterLoss10'
  |'firstSourceReview'|'firstSourceExit'|'firstRecovery5'|'firstRecovery2'|'firstRecoveryNonnegative'|'terminal';
export type InverseLossResearch={
  version:typeof INVERSE_LOSS_RESEARCH_VERSION;accountStartedAt:number;sourceId:string;observedSince:number;
  fromEntry:boolean;inheritedGrossMae:number;legacyDeepLossBeforeObservation:boolean;lastObservedAt:number;
  lastSampleAt:number;lastSourceSignature:string;lastLossBand:number;observations:number;maxObservationGapMs:number;
  points:InverseLossPoint[];anchors:Partial<Record<Anchor,number>>;preLossWindow:number[];
  droppedPoints:number;droppedAnchors:string[];automaticExit:false;
};

function evidence(t:Trade|undefined,now:number):SourceEvidence|null{
  const p=t?.positionIntelligence;if(!p||p.updatedAt>now)return null;
  return{at:p.updatedAt,decision:p.decision,phase:p.phase,holdScore:round(p.holdValueScore),
    continuationRatio:round(p.continuationRatio),advantageChange:round(p.advantageChange),dataConfidence:round(p.dataConfidence),
    reviewBars:p.reviewBars,barAt:p.lastCompletedBar,support:[...p.supportFamilies],concerns:[...p.concernFamilies],
    remainingSpaceRate:finite(p.remainingSpaceRate)?round(p.remainingSpaceRate):null,
    expectedPullbackRate:finite(p.expectedPullbackRate)?round(p.expectedPullbackRate):null,
    currentAdvantage:finite(p.currentAdvantage)?round(p.currentAdvantage):null,
    assessments:p.assessments.map(a=>[a.family,a.stance,round(a.severity),a.contextOnly===true]),exitBasis:p.exitBasis??null};
}
const band=(gross:number)=>gross< -40?40:gross< -30?30:gross< -20?20:gross< -15?15:gross< -10?10:gross< -5?5:gross< -2?2:gross<0?1:0;
const pointAt=(r:InverseLossResearch,key:Anchor)=>r.points.find(p=>p.at===r.anchors[key]);
const first=(r:InverseLossResearch,key:Anchor,at:number)=>{
  // A discarded first event stays missing; a later event must not impersonate it.
  if(!r.droppedAnchors.includes(key))r.anchors[key]??=at;
};

function trim(r:InverseLossResearch){
  const pins=()=>new Set([...Object.values(r.anchors),...r.preLossWindow]);
  const discard=(i:number)=>{r.points.splice(i,1);r.droppedPoints++;};
  // Keep important causal events and extrema; recent minute samples yield first.
  while(r.points.length>INVERSE_LOSS_RESEARCH_POINTS||size(r)>INVERSE_LOSS_RESEARCH_BYTES){
    const protectedAt=pins(),index=r.points.findIndex(p=>!protectedAt.has(p.at));
    if(index>=0){discard(index);continue;}
    if(r.preLossWindow.length){r.preLossWindow.shift();continue;}
    const key=(['entry','bestBeforeLoss10','firstLoss5','firstSourceReview','firstRecovery2','firstRecovery5','firstSourceExit'] as Anchor[])
      .find(k=>r.anchors[k]!=null);
    if(key){delete r.anchors[key];if(!r.droppedAnchors.includes(key))r.droppedAnchors.push(key);continue;}
    // The five essential anchors are bounded compact points; this branch is a
    // defensive cap for malformed restored metadata, never a financial gate.
    if(r.points.length<=1)break;
    const p=r.points.shift()!;r.droppedPoints++;
    for(const [k,at]of Object.entries(r.anchors))if(at===p.at){delete r.anchors[k as Anchor];r.droppedAnchors.push(k);}
  }
}

/** Called by the existing post-calculation review capture. Only metadata on
 * the inverse leg changes; changed/protectionChanged and persistence cadence
 * stay exactly as selected by the financial engine. */
export function captureInverseLossResearch(state:ForwardState,t:Trade,source:Trade|undefined,q:Quote|undefined,now:number){
  const copy=t.inverseCopy;if(!copy)return;
  const terminal=t.status==='CLOSED',fill=copy.fills.at(-1),quoteAt=terminal?fill?.quoteAt:t.lastQuoteAt;
  if(!finite(quoteAt)||quoteAt>now||!finite(t.lastPrice)||t.lastPrice<=0)return;
  if(terminal){if(fill?.kind!=='CLOSE'||fill.appliedAt!==now||!finite(t.netPnl))return;}
  else if(!q?.fresh||q.observedAt>now||now-q.observedAt>10_000||now-quoteAt>10_000
    ||q.bestBid<=0||q.bestAsk<q.bestBid||!source||source.lastQuoteAt!==quoteAt||source.lastPrice!==t.lastPrice)return;
  const existing=copy.lossResearch;
  if(existing?.anchors.terminal!=null)return;
  if(existing?.version===INVERSE_LOSS_RESEARCH_VERSION&&existing.accountStartedAt!==state.startedAt)return;
  const r:InverseLossResearch=existing??{version:INVERSE_LOSS_RESEARCH_VERSION,accountStartedAt:state.startedAt,sourceId:copy.sourceId,
    observedSince:now,fromEntry:!terminal&&t.openedAt===now,inheritedGrossMae:round(t.adverse*(t.realization?.initialNotional??t.notional)),
    legacyDeepLossBeforeObservation:t.openedAt!==now&&t.adverse*(t.realization?.initialNotional??t.notional)>INVERSE_LOSS_RESEARCH_THRESHOLD,
    lastObservedAt:now,lastSampleAt:0,lastSourceSignature:'',lastLossBand:0,observations:0,maxObservationGapMs:0,
    points:[],anchors:{},preLossWindow:[],droppedPoints:0,droppedAnchors:[],automaticExit:false};
  if(r.version!==INVERSE_LOSS_RESEARCH_VERSION||r.sourceId!==copy.sourceId||now<r.lastObservedAt)return;
  const d=t.side==='LONG'?1:-1,quantity=terminal?(fill?.quantity??t.quantity):t.quantity,
    gross=round(d*quantity*(t.lastPrice-t.entryPrice)),settled=copy.fills.filter(f=>f.kind!=='OPEN'&&f.kind!=='CLOSE'),
    settledGross=settled.reduce((n,f)=>n+f.gross,0),settledFees=settled.reduce((n,f)=>n+f.fee,0),
    exitFee=round(quantity*t.lastPrice*INVERSE_COST.feeRate),
    net=terminal?t.netPnl!:round(settledGross+gross-t.entryFee-settledFees-exitFee),
    sourceEvidence=evidence(source,now),sourceAction=source?.winnerManagement?.phase==='EXIT'?'EXIT':source?.holdValue?.action??null,
    signature=JSON.stringify([sourceEvidence?.decision,sourceEvidence?.support,sourceEvidence?.concerns,sourceEvidence?.exitBasis,
      source?.stopPrice,sourceAction]),lossBand=band(gross),firstDeep=!terminal&&gross< -INVERSE_LOSS_RESEARCH_THRESHOLD&&r.anchors.firstLoss10==null,
    worst=pointAt(r,'worstLoss'),bestBefore=pointAt(r,'bestBeforeLoss10'),bestAfter=pointAt(r,'bestAfterLoss10'),
    reasons:string[]=[];
  if(!r.observations)reasons.push(r.fromEntry?'ENTRY_OBSERVED':'OBSERVATION_STARTED');
  if(terminal)reasons.push('SOURCE_CLOSE');
  if(firstDeep)reasons.push('FIRST_OBSERVED_GROSS_LOSS_OVER_10');
  if(lossBand!==r.lastLossBand)reasons.push(lossBand>r.lastLossBand?'LOSS_BAND_WORSENED':'LOSS_BAND_RECOVERED');
  if(signature!==r.lastSourceSignature)reasons.push('SOURCE_HOLD_EVIDENCE_CHANGED');
  if(!worst||gross<worst.grossFloating)reasons.push('NEW_OBSERVED_WORST');
  if(!terminal&&r.anchors.firstLoss10!=null&&(!bestAfter||net>bestAfter.paperExitNet))reasons.push('NEW_OBSERVED_BEST_AFTER_DEEP_LOSS');
  if(!terminal&&r.anchors.firstLoss10==null&&!r.droppedAnchors.includes('bestBeforeLoss10')&&(!bestBefore||net>bestBefore.paperExitNet))reasons.push('NEW_OBSERVED_BEST_BEFORE_DEEP_LOSS');
  if(now-r.lastSampleAt>=60_000)reasons.push('MINUTE_SAMPLE');
  r.maxObservationGapMs=Math.max(r.maxObservationGapMs,now-r.lastObservedAt);r.lastObservedAt=now;r.observations++;
  if(!reasons.length)return;
  const symbol=state.extremumRegime.symbols[t.symbol],n=state.extremumRegime.narrative,
    executionFresh=!!q?.fresh&&q.observedAt<=now&&now-q.observedAt<=10_000&&q.bestBid>0&&q.bestAsk>=q.bestBid,
    executablePrice=!terminal&&executionFresh?(t.side==='LONG'?q!.bestBid:q!.bestAsk):null,
    executableNet=executablePrice==null?null:round(settledGross+d*quantity*(executablePrice-t.entryPrice)-t.entryFee-settledFees-quantity*executablePrice*INVERSE_COST.feeRate),
    value=(v:unknown)=>finite(v)?round(v):null,
    p:InverseLossPoint={at:now,quoteAt,status:t.status,reasons,paperPrice:t.lastPrice,remainingQuantity:quantity,grossFloating:gross,
      paperExitNet:net,estimatedExitFee:terminal?fill!.fee:exitFee,feeRate:terminal?(fill?.feeRate??INVERSE_COST.feeRate):INVERSE_COST.feeRate,
      feePolicy:terminal?(fill?.feePolicy??INVERSE_FEE_POLICY):INVERSE_FEE_POLICY,
      executablePrice,executableExitNet:executableNet,sourceEvidence,
      sourceProtection:{stop:copy.sourceStopPrice,distanceRate:round((copy.sourceSide==='LONG'?1:-1)*(t.lastPrice-copy.sourceStopPrice)/t.entryPrice),
        action:sourceAction,reason:source?.winnerManagement?.reason?.slice(0,100)??null,
        phase:source?.winnerManagement?.phase??null,peakNetRate:value(source?.winnerManagement?.peakNetRate)},
      market:{at:state.extremumRegime.updatedAt,major:n.major.bias,short:n.short.bias,transition:n.transition.direction,breadth:value(state.extremumRegime.internals?.breadth3)},
      inverseEvidence:{directionScore:value(t.side==='LONG'?symbol?.longScore:symbol?.shortScore),oppositeScore:value(t.side==='LONG'?symbol?.shortScore:symbol?.longScore),
        path:value(t.side==='LONG'?symbol?.pathLong:symbol?.pathShort),alignedResidualZ:value(symbol?d*symbol.residualZ:null),
        alignedVenuePressure:value(symbol?d*symbol.venuePressure:null),alignedBook:value(executionFresh&&q?.bookImbalance!=null?d*q.bookImbalance:null),
        alignedLiquidity:value(executionFresh&&q?.bidLiquidityChange!=null&&q.askLiquidityChange!=null?d*(q.bidLiquidityChange-q.askLiquidityChange)*.5:null),
        sourceCount:value(q?.sourceCount??symbol?.sourceCount)}};
  // Multiple observations at the same wall time replace, never duplicate IDs.
  const index=r.points.findIndex(x=>x.at===now);if(index>=0)r.points[index]=p;else r.points.push(p);
  if(r.fromEntry)first(r,'entry',now);
  if(!terminal){
    if(gross< -5)first(r,'firstLoss5',now);
    if(firstDeep){r.preLossWindow=r.points.filter(x=>x.status==='OPEN'&&x.at<now).slice(-4).map(x=>x.at);r.anchors.firstLoss10=now;r.anchors.bestAfterLoss10=now;}
    if(!worst||gross<worst.grossFloating)r.anchors.worstLoss=now;
    if(r.anchors.firstLoss10==null&&!r.droppedAnchors.includes('bestBeforeLoss10')&&(!bestBefore||net>bestBefore.paperExitNet))r.anchors.bestBeforeLoss10=now;
    if(r.anchors.firstLoss10!=null&&(!bestAfter||net>bestAfter.paperExitNet))r.anchors.bestAfterLoss10=now;
    if(sourceEvidence?.decision==='REVIEW')first(r,'firstSourceReview',now);
    if(sourceEvidence?.decision==='EXIT')first(r,'firstSourceExit',now);
    if(r.anchors.firstLoss10!=null&&now>r.anchors.firstLoss10){
      if(gross>= -5)first(r,'firstRecovery5',now);
      if(gross>= -2)first(r,'firstRecovery2',now);
      if(net>=0)first(r,'firstRecoveryNonnegative',now);
    }
  }else r.anchors.terminal=now;
  if(reasons.includes('MINUTE_SAMPLE'))r.lastSampleAt=now;
  r.lastSourceSignature=signature;r.lastLossBand=lossBand;trim(r);copy.lossResearch=r;delete copy.lossResearchHotOmitted;
}

export function inverseLossResearchView(trades:Trade[]){
  const paired=trades.filter(t=>t.inverseCopy),recorded=paired.filter(t=>t.inverseCopy?.lossResearch?.version===INVERSE_LOSS_RESEARCH_VERSION),
    deep=recorded.filter(t=>t.inverseCopy!.lossResearch!.anchors.firstLoss10!=null||t.inverseCopy!.lossResearch!.legacyDeepLossBeforeObservation),
    comparisons=recorded.map(t=>{
      const r=t.inverseCopy!.lossResearch!,actual=t.status==='CLOSED'?t.netPnl:null;
      return{tradeId:t.id,sourceId:r.sourceId,status:t.status,observedSince:r.observedSince,fromEntry:r.fromEntry,
        deepLossObserved:r.anchors.firstLoss10!=null,legacyDeepLossBeforeObservation:r.legacyDeepLossBeforeObservation,
        finalNet:actual,candidates:Object.entries(r.anchors).flatMap(([name,at])=>{
          const p=r.points.find(x=>x.at===at);if(!p||p.status!=='OPEN'||(t.closedAt!=null&&p.at>=t.closedAt))return[];
          return[{name,at:p.at,quoteAt:p.quoteAt,net:p.paperExitNet,executableNet:p.executableExitNet,
            improvement:actual==null?null:round(p.paperExitNet-actual),hindsightExtremum:['worstLoss','bestBeforeLoss10','bestAfterLoss10'].includes(name)}];}),
        retainedPoints:r.points.length,droppedPoints:r.droppedPoints,droppedAnchors:r.droppedAnchors,maxObservationGapMs:r.maxObservationGapMs};
    });
  return{version:INVERSE_LOSS_RESEARCH_VERSION,automaticExit:false,thresholdGrossFloatingLoss:INVERSE_LOSS_RESEARCH_THRESHOLD,
    pointLimit:INVERSE_LOSS_RESEARCH_POINTS,byteLimitPerTrade:INVERSE_LOSS_RESEARCH_BYTES,
    coverage:{paired:paired.length,recorded:recorded.length,missing:paired.length-recorded.length,
      omittedClosedHotRecords:paired.filter(t=>t.status==='CLOSED'&&t.inverseCopy!.lossResearchHotOmitted&&!t.inverseCopy!.lossResearch).length,
      omittedOpenHotRecords:paired.filter(t=>t.status==='OPEN'&&t.inverseCopy!.lossResearchHotOmitted&&!t.inverseCopy!.lossResearch).length,
      fromEntry:recorded.filter(t=>t.inverseCopy!.lossResearch!.fromEntry).length,
      deepLossRecords:deep.length,closedDeepLossRecords:deep.filter(t=>t.status==='CLOSED').length,
      recoveryWinnerControls:recorded.filter(t=>t.status==='CLOSED'&&(t.netPnl??0)>0&&t.inverseCopy!.lossResearch!.anchors.firstLoss5!=null).length},
    comparisons,recordPath:'trades[].inverseCopy.lossResearch',
    scope:'PAPER source-mark hypothetical exits; executable BBO comparison is a separate observation, not a LIVE fill.',
    limits:['First observed crossing is not guaranteed first market crossing; existing positions are not backfilled.',
      'Best/worst observed prices are hindsight extrema, not causal exit instructions.',
      'Source holding assessments are source-direction evidence; inverse evidence is raw observation, not its own approved exit policy.',
      'Fixed-size samples can omit intervening paths. No forced-exit feedback or later re-entry is replayed.',
      'No additional persistence cadence; hot storage pressure omits optional traces before financial history. Closed traces remain in immutable archives; open traces can restart with a coverage gap.']};
}
