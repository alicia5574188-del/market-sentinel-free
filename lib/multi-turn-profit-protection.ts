export const MULTI_TURN_PROFIT_PROTECTION_VERSION="multi-turn-profit-floor-v3";
// Persisted v3 and v4 share the same record shape. A policy rollback must not
// make either deployed generation unreadable or erase an existing floor.
export type MultiTurnProfitVersion=typeof MULTI_TURN_PROFIT_PROTECTION_VERSION|"multi-turn-profit-floor-v4";
export const supportedProfitVersion=(value:unknown):value is MultiTurnProfitVersion=>
  value===MULTI_TURN_PROFIT_PROTECTION_VERSION||value==="multi-turn-profit-floor-v4";

export type MultiTurnProfitSignal={
  continuationScore?:number|null;
  turnProbability?:number|null;
  phase?:string|null;
  rawDirectionAligned?:boolean|null;
};

export type MultiTurnProfitFloor={
  version:MultiTurnProfitVersion;
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
  if(reachedR<.70)return .20;
  if(reachedR<1.20)return .20+(reachedR-.70)/.50*.15;
  if(reachedR<2)return .35+(reachedR-1.20)/.80*.15;
  if(reachedR<3)return .50+(reachedR-2)*.12;
  if(reachedR<5)return .62+(reachedR-3)/2*.10;
  return Math.min(.84,.80+.02*Math.log2(Math.max(1,reachedR/5)));
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
    adjustment-=.04;
  if(continuation!=null&&continuation<=.42){adjustment+=.10;weak=true;}
  if(turn!=null&&turn>=.45){adjustment+=.08;weak=true;}
  if(phase==="WATCH"||phase==="TURNING"){adjustment+=.06;weak=true;}
  if(signal.rawDirectionAligned===false){adjustment+=.10;weak=true;}
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
  // Profit protection does not arm on noise. It waits for a move that is
  // meaningful versus both modeled round-trip cost and original structural risk.
  const activationRate=Math.max(modeledCost*2.5,Math.min(.45*riskRate,.015));
  if(favorable<activationRate)return null;

  const {adjustment,mode}=signalAdjustment(signal);
  const base=baseRetention(reachedR),minRetention=Math.max(.18,base-.10);
  const retentionRate=clip(base+adjustment,minRetention,.88);
  // Once protection is armed, a normal giveback may not turn a meaningful
  // winner into an after-cost loser. The floor itself remains monotonic upstream.
  const costPositiveFloor=modeledCost+Math.max(.0010,modeledCost*.50);
  const breathingRoom=Math.max(.0018,.10*riskRate);
  const floorRate=Math.min(favorable-breathingRoom,Math.max(favorable*retentionRate,costPositiveFloor));
  if(!(floorRate>modeledCost&&floorRate<favorable))return null;
  const lockedR=floorRate/riskRate;
  return{
    version:MULTI_TURN_PROFIT_PROTECTION_VERSION,
    reachedR,lockedR,floorRate,retentionRate:floorRate/favorable,
    activationRate,checkpointBand:Math.floor(lockedR*4+1e-9),mode,
  };
}
