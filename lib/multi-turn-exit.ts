import { type TurnFrameState, type TurnTimeframe } from "./multi-turn-engine.ts";
import { multiTurnHoldWindows } from "./multi-turn-hold-value.ts";
import { MULTI_TURN_PROFIT_PROTECTION_VERSION, multiTurnProfitFloor, supportedProfitVersion,
  type MultiTurnTradeProfitProtection } from "./multi-turn-profit-protection.ts";
import type { ExitDecision } from "./forward-protection.ts";

export const MULTI_TURN_EXIT_OVERLAY_VERSION="multi-turn-exit-overlay-v1";

export type MultiTurnExitOverlay={
  version:typeof MULTI_TURN_EXIT_OVERLAY_VERSION;
  profitProtection:MultiTurnTradeProfitProtection|null;
  decision:ExitDecision|null;
  bestHoldMinutes:number;
  hardExtensionMinutes:number;
  requiredProgressRate:number;
};

/**
 * The only additive Multi-Turn exit layer.
 *
 * Stable hold-value, hard stop, owning-timeframe turn and lifetime logic remain
 * where they were before the failed exit rewrite. This pure helper contains the
 * two additions that were actually wanted:
 * - monotonic protection of already-observed profit;
 * - the PR #379 frame-independent time fallback for long no-progress holdings.
 *
 * No storage, Worker, LIVE or schema dependency is allowed here. Deployed v3/v4
 * floors remain readable, while all newly computed floors use the stable v3 shape.
 */
export function evaluateMultiTurnExitOverlay(input:{
  timeframe:TurnTimeframe;
  side:"LONG"|"SHORT";
  openedAt:number;
  now:number;
  returnRate:number;
  favorableRate:number;
  riskRate:number;
  modeledCostRate:number;
  entryExpectedMoveRate:number;
  frame:TurnFrameState|null;
  priorProtection?:MultiTurnTradeProfitProtection|null;
  profitPolicy?:"DEFAULT"|"EXTERNAL";
}):MultiTurnExitOverlay{
  const modeledCostRate=Math.max(0,input.modeledCostRate);
  const riskRate=Math.max(1e-9,input.riskRate);
  const windows=multiTurnHoldWindows(input.timeframe);
  const prior=input.priorProtection&&supportedProfitVersion(input.priorProtection.version)
    ?input.priorProtection:null;
  const signal=input.frame?{
    continuationScore:input.frame.continuationScore,
    turnProbability:input.frame.triggerProbability,
    phase:input.frame.phase,
    rawDirectionAligned:input.frame.rawDirection==="NEUTRAL"||input.frame.rawDirection===input.side,
  }:null;

  const next=input.profitPolicy==="EXTERNAL"?null:multiTurnProfitFloor(input.favorableRate,riskRate,modeledCostRate,signal);
  let protection:MultiTurnTradeProfitProtection|null=prior?{...prior}:null;
  if(next){
    const floorRate=Math.max(prior?.floorRate??0,next.floorRate);
    protection={...next,version:next.version,
      floorRate,lockedR:floorRate/riskRate,
      retentionRate:floorRate/Math.max(input.favorableRate,1e-9),
      checkpointBand:Math.floor(floorRate/riskRate*4+1e-9),
      peakR:Math.max(prior?.peakR??0,next.reachedR),updatedAt:input.now};
  }

  if(protection&&input.returnRate<=protection.floorRate){
    return{version:MULTI_TURN_EXIT_OVERLAY_VERSION,profitProtection:protection,
      decision:{trigger:"PROFIT_GIVEBACK",
        reason:`利润路径保护：已观测最高顺向${(input.favorableRate*100).toFixed(2)}%，当前回落触及只能上移的保护线${(protection.floorRate*100).toFixed(2)}%。`,
        boundaryRate:protection.floorRate},
      bestHoldMinutes:windows.bestHoldMinutes,hardExtensionMinutes:windows.hardExtensionMinutes,requiredProgressRate:0};
  }

  // Preserve PR #379's exact frame-independent fallback thresholds, but keep
  // them out of the baseline hold-value model and out of persisted state.
  const heldMinutes=Math.max(0,(input.now-input.openedAt)/60_000);
  if(heldMinutes>=windows.hardExtensionMinutes){
    return{version:MULTI_TURN_EXIT_OVERLAY_VERSION,profitProtection:protection,
      decision:{trigger:"HOLD_VALUE",
        reason:`时间—空间持仓价值退出：已持有${heldMinutes.toFixed(0)}分钟并达到${input.timeframe}时间—空间硬上限${windows.hardExtensionMinutes}分钟；所属周期数据即使暂缺也不能无限占用仓位。`,
        boundaryRate:null},
      bestHoldMinutes:windows.bestHoldMinutes,hardExtensionMinutes:windows.hardExtensionMinutes,requiredProgressRate:0};
  }
  if(heldMinutes<windows.bestHoldMinutes){
    return{version:MULTI_TURN_EXIT_OVERLAY_VERSION,profitProtection:protection,decision:null,
      bestHoldMinutes:windows.bestHoldMinutes,hardExtensionMinutes:windows.hardExtensionMinutes,requiredProgressRate:0};
  }

  const expectedMoveRate=Math.max(modeledCostRate,input.entryExpectedMoveRate);
  const requiredRatio=heldMinutes>=windows.strongExtensionMinutes?.60:.35;
  const requiredProgressRate=Math.max(modeledCostRate*2,expectedMoveRate*requiredRatio);
  if(input.favorableRate>=requiredProgressRate||input.returnRate>modeledCostRate){
    return{version:MULTI_TURN_EXIT_OVERLAY_VERSION,profitProtection:protection,decision:null,
      bestHoldMinutes:windows.bestHoldMinutes,hardExtensionMinutes:windows.hardExtensionMinutes,requiredProgressRate};
  }

  return{version:MULTI_TURN_EXIT_OVERLAY_VERSION,profitProtection:protection,
    decision:{trigger:"HOLD_VALUE",
      reason:`时间—空间持仓价值退出：已超过${input.timeframe}最佳持仓时间${windows.bestHoldMinutes}分钟，但最高顺向仅${(input.favorableRate*100).toFixed(2)}%，低于最小进展${(requiredProgressRate*100).toFixed(2)}%，当前收益也未覆盖成本；释放长期无进展仓位。`,
      boundaryRate:null},
    bestHoldMinutes:windows.bestHoldMinutes,hardExtensionMinutes:windows.hardExtensionMinutes,requiredProgressRate};
}
