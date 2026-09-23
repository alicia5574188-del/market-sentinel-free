import { type TurnFrameState, type TurnTimeframe } from "./multi-turn-engine.ts";
import { evaluateMultiTurnHoldValue, type MultiTurnHoldValue } from "./multi-turn-hold-value.ts";
import { evaluateMultiTurnExitOverlay } from "./multi-turn-exit.ts";
import { type MultiTurnTradeProfitProtection } from "./multi-turn-profit-protection.ts";
import type { ExitDecision } from "./forward-protection.ts";

export const MULTI_TURN_EXIT_CONTROLLER_VERSION="multi-turn-exit-controller-v1";
export type MultiTurnExitControllerResult={version:typeof MULTI_TURN_EXIT_CONTROLLER_VERSION;holdValue:MultiTurnHoldValue|null;profitProtection:MultiTurnTradeProfitProtection|null;decision:ExitDecision|null;};

/** Pure exit authority: decision only. No account/storage/Gate/LIVE/UI side effects. */
export function evaluateMultiTurnExitController(input:{timeframe:TurnTimeframe;side:"LONG"|"SHORT";openedAt:number;now:number;returnRate:number;favorableRate:number;plannedRisk:number;notional:number;modeledCostRate:number;entryExpectedMoveRate:number;stopRate:number;horizonMinutes:number;frame:TurnFrameState|null;priorProtection?:MultiTurnTradeProfitProtection|null;profitPolicy?:"DEFAULT"|"EXTERNAL";}):MultiTurnExitControllerResult{
  const holdValue=input.frame?evaluateMultiTurnHoldValue({timeframe:input.timeframe,frame:input.frame,side:input.side,openedAt:input.openedAt,now:input.now,returnRate:input.returnRate,favorableRate:input.favorableRate,modeledCostRate:input.modeledCostRate}):null;
  const overlay=evaluateMultiTurnExitOverlay({timeframe:input.timeframe,side:input.side,openedAt:input.openedAt,now:input.now,returnRate:input.returnRate,favorableRate:input.favorableRate,riskRate:input.plannedRisk/Math.max(input.notional,1e-9),modeledCostRate:input.modeledCostRate,entryExpectedMoveRate:input.entryExpectedMoveRate,frame:input.frame,priorProtection:input.priorProtection,profitPolicy:input.profitPolicy});
  let decision:ExitDecision|null=null;
  if(input.returnRate<=-input.stopRate)decision={trigger:"HARD_STOP",reason:"Multi-Turn硬止损：当前可执行价触及该周期原始结构风险边界",boundaryRate:-input.stopRate};
  else if(input.frame&&input.frame.direction!==input.side&&input.frame.lastTurnAt!=null&&input.frame.lastTurnAt>=input.openedAt)decision={trigger:"MULTI_TURN",reason:`${input.timeframe}已确认转向${input.frame.direction==="LONG"?"多":"空"}；退出原${input.side==="LONG"?"多":"空"}向仓位`,boundaryRate:null};
  else if(input.frame&&input.frame.direction===input.side&&input.frame.phase==="TURNING"&&input.frame.triggerProbability>=.90&&input.frame.evidence.structure>=.65&&(input.frame.evidence.cusum>=.60||input.frame.evidence.changePoint>=.65))decision={trigger:"MULTI_TURN",reason:`${input.timeframe}转折概率达到${(input.frame.triggerProbability*100).toFixed(0)}%，结构破坏与序贯变化同时成立；提前退出该周期旧方向`,boundaryRate:null};
  else if(overlay.decision)decision=overlay.decision;
  else if(holdValue&&holdValue.action!=="HOLD")decision={trigger:"HOLD_VALUE",reason:`时间—空间持仓价值退出：${holdValue.reason}`,boundaryRate:null};
  else if(input.now-input.openedAt>=input.horizonMinutes*60_000)decision={trigger:"MAX_LIFETIME",reason:`${input.timeframe}超过异常安全寿命上限；退出以防止孤立陈旧持仓，不作为正常策略期限`,boundaryRate:null};
  return{version:MULTI_TURN_EXIT_CONTROLLER_VERSION,holdValue,profitProtection:overlay.profitProtection,decision};
}
