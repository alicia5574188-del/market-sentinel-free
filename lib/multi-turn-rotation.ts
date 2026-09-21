import { TURN_CONFIG, type TurnCandidate, type TurnFrameState, type TurnTimeframe } from "./multi-turn-engine.ts";
import { multiTurnHoldWindows, type MultiTurnHoldValue } from "./multi-turn-hold-value.ts";

export const MULTI_TURN_ROTATION_VERSION="multi-turn-selective-risk-rotation-v1";
export const MULTI_TURN_ROTATION_COOLDOWN_MS=60*60_000;

export type RotationOpportunity={
  version:typeof MULTI_TURN_ROTATION_VERSION;
  eligible:boolean;
  score:number;
  edgeRatio:number;
  directionStrength:number;
  turnRisk:number;
  remainingSpaceRate:number;
  pullbackRiskRate:number;
  reason:string;
};

export type RotationHolding={
  id:string;symbol:string;side:"LONG"|"SHORT";timeframe:TurnTimeframe;openedAt:number;holdValue:MultiTurnHoldValue;
};
export type RotationWeakness={holding:RotationHolding;score:number;reason:string};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const valueScore=(edgeRatio:number,directionStrength:number,turnRisk:number)=>
  Math.max(0,edgeRatio)*(0.60+clip(directionStrength))*(1-.50*clip(turnRisk));

export function multiTurnRotationReentryCooldownMs(timeframe:TurnTimeframe){
  return Math.max(60*60_000,Math.min(8*60*60_000,TURN_CONFIG[timeframe].minutes*2*60_000));
}

export function rotationRiskSaturated(input:{equity:number;totalRisk:number;sideRisk:number;sleeveRisk:number;riskCap:number}){
  if(!(input.equity>0))return false;
  return input.totalRisk>=input.equity*.095
    ||input.sideRisk>=input.equity*.065*.95
    ||input.sleeveRisk>=input.equity*input.riskCap*.95;
}

export function evaluateRotationOpportunity(input:{candidate:TurnCandidate;frame:TurnFrameState;remainingSpaceRate:number;costRate:number}):RotationOpportunity{
  const{candidate,frame}=input;
  const directionStrength=clip(.55*candidate.confidence+.45*candidate.continuationScore);
  const rawAligned=frame.rawDirection==="NEUTRAL"||frame.rawDirection===candidate.side;
  const turnRisk=clip(.50*frame.triggerProbability+.18*frame.evidence.structure+.10*frame.evidence.changePoint
    +.08*frame.evidence.cusum+.08*frame.propagationPressure+.06*(rawAligned?0:1));
  const pullbackRiskRate=Math.max(frame.atrRate*.55,
    frame.atrRate*(.72+.95*turnRisk+.55*(1-directionStrength)));
  const remainingSpaceRate=Math.max(0,input.remainingSpaceRate);
  const edgeRatio=remainingSpaceRate/Math.max(pullbackRiskRate,1e-9);
  const score=valueScore(edgeRatio,directionStrength,turnRisk);
  const eligible=rawAligned&&directionStrength>=.72&&candidate.continuationScore>=.58
    &&turnRisk<=.30&&edgeRatio>=1.45
    &&remainingSpaceRate>=Math.max(input.costRate*2.2,frame.atrRate*.90);
  const reason=eligible
    ?`强候选：方向强度${(directionStrength*100).toFixed(0)}%，转折风险${(turnRisk*100).toFixed(0)}%，剩余空间/回调风险${edgeRatio.toFixed(2)}。`
    :`候选未达到择优换仓强度：方向${(directionStrength*100).toFixed(0)}%，转折风险${(turnRisk*100).toFixed(0)}%，空间比${edgeRatio.toFixed(2)}。`;
  return{version:MULTI_TURN_ROTATION_VERSION,eligible,score,edgeRatio,directionStrength,turnRisk,
    remainingSpaceRate,pullbackRiskRate,reason};
}

export function rankWeakRotationHoldings(input:{holdings:RotationHolding[];now:number}){
  const rows:RotationWeakness[]=[];
  for(const holding of input.holdings){
    const h=holding.holdValue,windows=multiTurnHoldWindows(holding.timeframe);
    if(h.action!=="HOLD"||h.strongContinuation||h.exceptionalContinuation)continue;
    if(input.now-holding.openedAt<Math.max(windows.minimumEvaluationMinutes*60_000,windows.bestHoldMinutes*.25*60_000))continue;
    const weakEdge=Math.min(.82,h.requiredEdgeRatio*.78);
    const weak=h.edgeRatio<=weakEdge&&(h.directionStrength<=.58||h.turnRisk>=.45);
    if(!weak)continue;
    const score=valueScore(h.edgeRatio,h.directionStrength,h.turnRisk);
    rows.push({holding,score,
      reason:`弱持仓：剩余空间/回调风险${h.edgeRatio.toFixed(2)}，方向强度${(h.directionStrength*100).toFixed(0)}%，转折风险${(h.turnRisk*100).toFixed(0)}%。`});
  }
  return rows.sort((a,b)=>a.score-b.score||a.holding.openedAt-b.holding.openedAt||a.holding.symbol.localeCompare(b.holding.symbol));
}

export function rotationAdvantageEnough(opportunity:RotationOpportunity,weakness:RotationWeakness){
  if(!opportunity.eligible)return false;
  const oldEdge=weakness.holding.holdValue.edgeRatio;
  return opportunity.score>=weakness.score*1.75
    &&opportunity.score-weakness.score>=.65
    &&opportunity.edgeRatio-oldEdge>=.60;
}
