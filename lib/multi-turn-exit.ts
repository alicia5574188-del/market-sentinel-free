import { TURN_CONFIG, type TurnFrameState, type TurnTimeframe } from "./multi-turn-engine.ts";
import { multiTurnHoldWindows } from "./multi-turn-hold-value.ts";
import { MULTI_TURN_PROFIT_PROTECTION_VERSION, multiTurnProfitFloor, supportedProfitVersion,
  type MultiTurnTradeProfitProtection } from "./multi-turn-profit-protection.ts";
import type { ExitDecision } from "./forward-protection.ts";

export const MULTI_TURN_EXIT_OVERLAY_VERSION="multi-turn-exit-overlay-v1";

export type MultiTurnExitOverlay={
  version:typeof MULTI_TURN_EXIT_OVERLAY_VERSION;
  profitProtection:MultiTurnTradeProfitProtection|null;
  decision:ExitDecision|null;
  releaseMinutes:number;
  meaningfulProgressRate:number;
};

const aligned=(frame:TurnFrameState,side:"LONG"|"SHORT")=>
  frame.rawDirection==="NEUTRAL"||frame.rawDirection===side;

/**
 * Additive exit overlay only.
 *
 * Baseline hold-value, hard stop, owning-timeframe turn and safety lifetime stay
 * authoritative in forward-relations. This helper owns just two additions:
 * 1) a monotonic floor derived from already-observed favorable price;
 * 2) release of a slot after the normal best-hold window (never later than 24h)
 *    when the trade has made no meaningful favorable progress.
 *
 * It has no storage/network/LIVE dependency and introduces no persisted policy
 * version. Deployed v3/v4 floors are read for continuity; all new floors use v3.
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
}):MultiTurnExitOverlay{
  const modeledCostRate=Math.max(0,input.modeledCostRate);
  const riskRate=Math.max(1e-9,input.riskRate);
  const prior=input.priorProtection&&supportedProfitVersion(input.priorProtection.version)
    ?input.priorProtection:null;
  const signal=input.frame?{
    continuationScore:input.frame.continuationScore,
    turnProbability:input.frame.triggerProbability,
    phase:input.frame.phase,
    rawDirectionAligned:aligned(input.frame,input.side),
  }:null;
  const next=multiTurnProfitFloor(input.favorableRate,riskRate,modeledCostRate,signal);
  let protection:MultiTurnTradeProfitProtection|null=prior?{...prior}:null;
  if(next){
    const floorRate=Math.max(prior?.floorRate??0,next.floorRate);
    protection={...next,version:MULTI_TURN_PROFIT_PROTECTION_VERSION,
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
      releaseMinutes:Math.min(multiTurnHoldWindows(input.timeframe).bestHoldMinutes,24*60),
      meaningfulProgressRate:0};
  }

  const windows=multiTurnHoldWindows(input.timeframe);
  const releaseMinutes=Math.min(windows.bestHoldMinutes,24*60);
  const heldMinutes=Math.max(0,(input.now-input.openedAt)/60_000);
  const meaningfulProgressRate=Math.max(modeledCostRate*1.5,
    Math.min(Math.max(0,input.entryExpectedMoveRate)*.30,riskRate*.50));
  const noMeaningfulProgress=input.favorableRate<meaningfulProgressRate
    &&input.returnRate<=modeledCostRate;
  if(heldMinutes>=releaseMinutes&&noMeaningfulProgress){
    const profitable=input.returnRate>modeledCostRate;
    return{version:MULTI_TURN_EXIT_OVERLAY_VERSION,profitProtection:protection,
      decision:{trigger:"HOLD_VALUE",
        reason:`无进展持仓释放：已持有${heldMinutes.toFixed(0)}分钟，超过${input.timeframe}无进展观察上限${releaseMinutes}分钟；最高顺向${(input.favorableRate*100).toFixed(2)}%仍低于有效进展${(meaningfulProgressRate*100).toFixed(2)}%，释放风险额度。`,
        boundaryRate:null},
      releaseMinutes,meaningfulProgressRate};
  }

  return{version:MULTI_TURN_EXIT_OVERLAY_VERSION,profitProtection:protection,decision:null,
    releaseMinutes,meaningfulProgressRate};
}
