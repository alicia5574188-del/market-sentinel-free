export const MULTI_TURN_PROFIT_PROTECTION_VERSION="multi-turn-profit-floor-v4";

export type MultiTurnProfitSignal={
  continuationScore?:number|null;
  turnProbability?:number|null;
  phase?:string|null;
  rawDirectionAligned?:boolean|null;
  edgeRatio?:number|null;
  directionStrength?:number|null;
  turnRisk?:number|null;
  ageRatio?:number|null;
};

export type MultiTurnProfitFloor={
  version:typeof MULTI_TURN_PROFIT_PROTECTION_VERSION;
  reachedR:number;
  lockedR:number;
  floorRate:number;
  retentionRate:number;
  activationRate:number;
  checkpointBand:number;
  mode:"STRONG_TREND"|"HEALTHY_TREND"|"NORMAL"|"WEAKENING";
};

export type MultiTurnTradeProfitProtection=MultiTurnProfitFloor&{
  peakR:number;
  updatedAt:number;
};

const clip=(v:number,a:number,b:number)=>Math.min(b,Math.max(a,v));

function baseRetention(reachedR:number){
  if(reachedR<.60)return .18;
  if(reachedR<1)return .22+(reachedR-.60)/.40*.18;
  return Math.min(.78,.42+.13*Math.log2(Math.max(1,reachedR)));
}

function signalAdjustment(signal?:MultiTurnProfitSignal|null){
  if(!signal)return{adjustment:0,mode:"NORMAL" as const};
  const continuation=signal.continuationScore,turn=signal.turnProbability,phase=signal.phase??"FLOW";
  const aligned=signal.rawDirectionAligned!==false;
  let adjustment=0;
  let weak=false;
  if(continuation!=null&&turn!=null&&phase==="FLOW"&&aligned&&continuation>=.72&&turn<=.20)
    adjustment-=.08;
  else if(continuation!=null&&turn!=null&&phase==="FLOW"&&aligned&&continuation>=.58&&turn<=.25)
    adjustment-=.03;
  if(continuation!=null&&continuation<=.42){adjustment+=.08;weak=true;}
  if(turn!=null&&turn>=.45){adjustment+=.06;weak=true;}
  if(phase==="WATCH"||phase==="TURNING"){adjustment+=.06;weak=true;}
  if(signal.rawDirectionAligned===false){adjustment+=.08;weak=true;}
  if(signal.edgeRatio!=null&&signal.edgeRatio<1){adjustment+=.10;weak=true;}
  if(signal.edgeRatio!=null&&signal.edgeRatio<.70){adjustment+=.12;weak=true;}
  if(signal.directionStrength!=null&&signal.directionStrength<.40){adjustment+=.08;weak=true;}
  if(signal.turnRisk!=null&&signal.turnRisk>=.45){adjustment+=.08;weak=true;}
  if(signal.ageRatio!=null&&signal.ageRatio>=1&&signal.edgeRatio!=null&&signal.edgeRatio<1.20){adjustment+=.06;weak=true;}
  const mode=weak?"WEAKENING":adjustment<=-.06?"STRONG_TREND":adjustment<0?"HEALTHY_TREND":"NORMAL";
  return{adjustment,mode} as const;
}

/**
 * Reactive profit protection only. It never predicts a top and never exits just
 * because continuation weakens. Observed MFE raises a floor; the owning frame
 * can only tighten how much of that already-observed profit may be returned.
 *
 * One R is original plannedRisk/notional. Very wide-stop trades also arm after
 * a material absolute move so a 4h/1d winner cannot give back 5-10% simply
 * because that move is still below one R.
 */
export function multiTurnProfitFloor(
  favorable:number,
  riskRate:number,
  modeledCost=.0022,
  signal?:MultiTurnProfitSignal|null,
):MultiTurnProfitFloor|null{
  if(![favorable,riskRate,modeledCost].every(Number.isFinite)||riskRate<=0||favorable<=0)return null;
  const reachedR=favorable/riskRate;
  const activationRate=Math.max(modeledCost+.0010,Math.min(.45*riskRate,.025));
  if(favorable<activationRate)return null;

  const {adjustment,mode}=signalAdjustment(signal);
  const minRetention=reachedR>=1?.35:.15;
  const retentionRate=clip(baseRetention(reachedR)+adjustment,minRetention,.88);
  const costPositiveFloor=modeledCost+.0010;
  const breathingRoom=Math.max(.0015,.10*riskRate);
  const floorRate=Math.min(favorable-breathingRoom,Math.max(favorable*retentionRate,costPositiveFloor));
  if(!(floorRate>modeledCost&&floorRate<favorable))return null;
  const lockedR=floorRate/riskRate;
  return{
    version:MULTI_TURN_PROFIT_PROTECTION_VERSION,
    reachedR,lockedR,floorRate,retentionRate:floorRate/favorable,
    activationRate,checkpointBand:Math.floor(lockedR*4+1e-9),mode,
  };
}
