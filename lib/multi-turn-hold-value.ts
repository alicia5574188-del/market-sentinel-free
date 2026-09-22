import { TURN_CONFIG, type TurnFrameState, type TurnTimeframe } from "./multi-turn-engine.ts";

export const MULTI_TURN_HOLD_VALUE_VERSION = "multi-turn-time-space-v1";
export const MULTI_TURN_BEST_HOLD_BARS = 6;
export const MULTI_TURN_STRONG_EXTENSION_BARS = 12;
export const MULTI_TURN_HARD_EXTENSION_BARS = 18;

export type MultiTurnHoldAction = "HOLD" | "EXIT_PROFIT" | "EXIT_RISK";
export type MultiTurnHoldValue = {
  version: typeof MULTI_TURN_HOLD_VALUE_VERSION;
  action: MultiTurnHoldAction;
  evaluatedAt: number;
  bestHoldMinutes: number;
  strongExtensionMinutes: number;
  hardExtensionMinutes: number;
  heldMinutes: number;
  ageRatio: number;
  directionStrength: number;
  turnRisk: number;
  remainingSpaceRate: number;
  pullbackRiskRate: number;
  edgeRatio: number;
  requiredEdgeRatio: number;
  strongContinuation: boolean;
  exceptionalContinuation: boolean;
  reason: string;
};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const safeRatio=(a:number,b:number)=>a/Math.max(b,1e-9);

export function multiTurnHoldWindows(timeframe:TurnTimeframe){
  const minutes=TURN_CONFIG[timeframe].minutes;
  return{
    bestHoldMinutes:Math.max(30,minutes*MULTI_TURN_BEST_HOLD_BARS),
    strongExtensionMinutes:Math.max(60,minutes*MULTI_TURN_STRONG_EXTENSION_BARS),
    hardExtensionMinutes:Math.min(TURN_CONFIG[timeframe].maxHoldMinutes,
      Math.max(90,minutes*MULTI_TURN_HARD_EXTENSION_BARS)),
    minimumEvaluationMinutes:Math.max(10,minutes*2),
  };
}

export function evaluateMultiTurnHoldValue(input:{
  timeframe:TurnTimeframe;
  frame:TurnFrameState;
  side:"LONG"|"SHORT";
  openedAt:number;
  now:number;
  returnRate:number;
  favorableRate:number;
  modeledCostRate:number;
}):MultiTurnHoldValue{
  const{timeframe,frame,side,openedAt,now,returnRate,favorableRate}=input;
  const modeledCostRate=Math.max(0,input.modeledCostRate);
  const windows=multiTurnHoldWindows(timeframe);
  const heldMinutes=Math.max(0,(now-openedAt)/60_000),ageRatio=heldMinutes/windows.bestHoldMinutes;
  const rawAligned=frame.rawDirection==="NEUTRAL"||frame.rawDirection===side;
  const directionStrength=clip(.55*frame.directionConfidence+.45*frame.continuationScore);
  const turnRisk=clip(.50*frame.triggerProbability
    +.18*frame.evidence.structure+.10*frame.evidence.changePoint+.08*frame.evidence.cusum
    +.08*frame.propagationPressure+.06*(rawAligned?0:1));
  const giveback=Math.max(0,favorableRate-returnRate);
  // "Remaining space" is the expected move still available from the current
  // completed-frame state, discounted by weakening continuation and turn risk.
  const remainingSpaceRate=Math.max(0,
    frame.expectedMoveRate*(.55+1.00*directionStrength)*(1-.45*turnRisk)-modeledCostRate);
  // Pullback risk expands as the owning direction weakens, reversal evidence
  // grows, or a profitable trade has already started giving back.
  const pullbackRiskRate=Math.max(frame.atrRate*.55,
    frame.atrRate*(.72+.95*turnRisk+.55*(1-directionStrength))+.20*giveback);
  const edgeRatio=safeRatio(remainingSpaceRate,pullbackRiskRate);
  const strongContinuation=rawAligned&&directionStrength>=.70&&frame.continuationScore>=.55
    &&frame.triggerProbability<=.35&&frame.phase!=="TURNING";
  const exceptionalContinuation=rawAligned&&directionStrength>=.82&&frame.continuationScore>=.68
    &&frame.triggerProbability<=.20&&frame.phase==="FLOW";

  let requiredEdgeRatio:number;
  if(ageRatio<.5)requiredEdgeRatio=.55;
  else if(ageRatio<1)requiredEdgeRatio=.65+.35*((ageRatio-.5)/.5);
  else if(ageRatio<2)requiredEdgeRatio=1+.35*(ageRatio-1);
  else requiredEdgeRatio=Math.min(1.50,1.35+.15*(ageRatio-2));
  if(strongContinuation)requiredEdgeRatio-=.10;
  if(exceptionalContinuation)requiredEdgeRatio-=.12;
  requiredEdgeRatio=Math.max(.50,requiredEdgeRatio);

  let action:MultiTurnHoldAction="HOLD",reason:string;
  const weakSpace=edgeRatio<requiredEdgeRatio;
  const clearlyUnfavorable=edgeRatio<.60&&turnRisk>=.45;
  const takeProfit=returnRate>modeledCostRate;

  if(heldMinutes<windows.minimumEvaluationMinutes){
    reason="尚未达到所属周期的最小持仓观察时间；先保留原始结构止损和转折退出权威。";
  }else if(heldMinutes>=windows.hardExtensionMinutes){
    action=takeProfit?"EXIT_PROFIT":"EXIT_RISK";
    reason=`已持有${heldMinutes.toFixed(0)}分钟，达到${timeframe}级别时间—空间硬上限${windows.hardExtensionMinutes}分钟；即使未正式反转也不再无限等待。`;
  }else if(heldMinutes>=windows.strongExtensionMinutes&&!exceptionalContinuation){
    action=takeProfit?"EXIT_PROFIT":"EXIT_RISK";
    reason=`已超过${timeframe}级别强延续区间${windows.strongExtensionMinutes}分钟，而当前方向确定性/延续性不足以支持超时持有。`;
  }else if(heldMinutes>=windows.bestHoldMinutes&&weakSpace&&!strongContinuation){
    action=takeProfit?"EXIT_PROFIT":"EXIT_RISK";
    reason=`已超过${timeframe}最佳持仓时间${windows.bestHoldMinutes}分钟；预计剩余空间${(remainingSpaceRate*100).toFixed(2)}%小于当前需要覆盖的回调风险${(pullbackRiskRate*100).toFixed(2)}%。`;
  }else if(heldMinutes>=windows.bestHoldMinutes*.5&&clearlyUnfavorable){
    action=takeProfit?"EXIT_PROFIT":"EXIT_RISK";
    reason=`方向确定性正在恶化，预计回调风险${(pullbackRiskRate*100).toFixed(2)}%已明显压过剩余空间${(remainingSpaceRate*100).toFixed(2)}%；继续持有性价比不足。`;
  }else if(heldMinutes>=windows.bestHoldMinutes&&weakSpace){
    // Strong directions may exceed the nominal best hold, but only while their
    // space/risk balance remains close enough to the required threshold.
    if(edgeRatio<requiredEdgeRatio*.82){
      action=takeProfit?"EXIT_PROFIT":"EXIT_RISK";
      reason=`虽仍有方向优势，但时间压力升高后剩余空间/回调风险仅${edgeRatio.toFixed(2)}，低于继续持有要求${requiredEdgeRatio.toFixed(2)}。`;
    }else reason=`已超过最佳持仓时间，但方向仍强，剩余空间/回调风险${edgeRatio.toFixed(2)}接近继续持有要求；允许延长观察。`;
  }else{
    reason=`当前继续持有价值仍为正：剩余空间/回调风险${edgeRatio.toFixed(2)}，方向强度${(directionStrength*100).toFixed(0)}%，转折风险${(turnRisk*100).toFixed(0)}%。`;
  }

  return{version:MULTI_TURN_HOLD_VALUE_VERSION,action,evaluatedAt:now,
    bestHoldMinutes:windows.bestHoldMinutes,strongExtensionMinutes:windows.strongExtensionMinutes,
    hardExtensionMinutes:windows.hardExtensionMinutes,heldMinutes,ageRatio,directionStrength,turnRisk,
    remainingSpaceRate,pullbackRiskRate,edgeRatio,requiredEdgeRatio,strongContinuation,exceptionalContinuation,reason};
}

export type MultiTurnTimeFallback = {
  action: MultiTurnHoldAction;
  heldMinutes: number;
  requiredProgressRate: number;
  reason: string;
};

/**
 * Frame-independent safety valve.
 *
 * The rich hold-value model above only runs when the owning timeframe has a
 * fresh completed frame. A missing/stale high-timeframe frame must not turn a
 * 4h/1d position into an indefinitely reserved risk slot. This fallback uses
 * only facts already frozen on the trade plus the current executable return:
 * after the normal six-bar best-hold window, a position that has never made
 * meaningful progress and is not even cost-positive may release its slot.
 * The original hard-extension window remains an unconditional safety ceiling.
 *
 * No state version or persisted record is introduced here.
 */
export function evaluateMultiTurnTimeFallback(input:{
  timeframe:TurnTimeframe;
  openedAt:number;
  now:number;
  returnRate:number;
  favorableRate:number;
  modeledCostRate:number;
  entryExpectedMoveRate:number;
}):MultiTurnTimeFallback|null{
  const windows=multiTurnHoldWindows(input.timeframe);
  const heldMinutes=Math.max(0,(input.now-input.openedAt)/60_000);
  const modeledCostRate=Math.max(0,input.modeledCostRate);
  const expectedMoveRate=Math.max(modeledCostRate,input.entryExpectedMoveRate);
  if(heldMinutes<windows.bestHoldMinutes)return null;

  if(heldMinutes>=windows.hardExtensionMinutes){
    const action:MultiTurnHoldAction=input.returnRate>modeledCostRate?"EXIT_PROFIT":"EXIT_RISK";
    return{action,heldMinutes,requiredProgressRate:0,
      reason:`已持有${heldMinutes.toFixed(0)}分钟并达到${input.timeframe}时间—空间硬上限${windows.hardExtensionMinutes}分钟；所属周期数据即使暂缺也不能无限占用仓位。`};
  }

  const requiredRatio=heldMinutes>=windows.strongExtensionMinutes?.60:.35;
  const requiredProgressRate=Math.max(modeledCostRate*2,expectedMoveRate*requiredRatio);
  if(input.favorableRate>=requiredProgressRate||input.returnRate>modeledCostRate)return null;

  return{action:"EXIT_RISK",heldMinutes,requiredProgressRate,
    reason:`已超过${input.timeframe}最佳持仓时间${windows.bestHoldMinutes}分钟，但最高顺向仅${(input.favorableRate*100).toFixed(2)}%，低于最小进展${(requiredProgressRate*100).toFixed(2)}%，当前收益也未覆盖成本；释放长期无进展仓位。`};
}
