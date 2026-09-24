export const MULTI_TURN_PROFIT_PROTECTION_VERSION="multi-turn-profit-floor-v3";
export const ANCHOR_FLOW_PROFIT_PROTECTION_VERSION="anchor-flow-profit-floor-v1";
export const REGION_LAUNCH_PROFIT_PROTECTION_VERSION="region-launch-profit-floor-v1";
export const REGION_MIGRATION_PROFIT_PROTECTION_VERSION="region-migration-profit-floor-v1";
// Persisted generations share the same record shape. A policy rollout must not
// make an earlier deployed floor unreadable or erase an existing protection line.
export type MultiTurnProfitVersion=typeof MULTI_TURN_PROFIT_PROTECTION_VERSION|"multi-turn-profit-floor-v4"
  |typeof ANCHOR_FLOW_PROFIT_PROTECTION_VERSION|typeof REGION_LAUNCH_PROFIT_PROTECTION_VERSION|typeof REGION_MIGRATION_PROFIT_PROTECTION_VERSION;
export const supportedProfitVersion=(value:unknown):value is MultiTurnProfitVersion=>
  value===MULTI_TURN_PROFIT_PROTECTION_VERSION||value==="multi-turn-profit-floor-v4"
  ||value===ANCHOR_FLOW_PROFIT_PROTECTION_VERSION||value===REGION_LAUNCH_PROFIT_PROTECTION_VERSION
  ||value===REGION_MIGRATION_PROFIT_PROTECTION_VERSION;

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


/**
 * AnchorFlow profit protection.
 *
 * A good 5m restart is expected to produce prompt executable profit. Until the
 * observed move exceeds the entry expectation, keep about 80% of MFE. Only
 * profits materially beyond that expectation earn progressively more breathing
 * room, and weakening owning-frame evidence tightens rather than loosens the
 * floor. This is a monotonic floor input; the caller owns persistence and the
 * exchange-native stop mirror.
 */
export function anchorFlowProfitFloor(
  favorable:number,
  riskRate:number,
  modeledCost=.0022,
  expectedMoveRate=0,
  signal?:MultiTurnProfitSignal|null,
):MultiTurnProfitFloor|null{
  if(![favorable,riskRate,modeledCost,expectedMoveRate].every(Number.isFinite)||riskRate<=0||favorable<=0)return null;
  const reachedR=favorable/riskRate;
  const activationRate=Math.max(modeledCost*1.6,Math.min(.25*riskRate,.006));
  if(favorable<activationRate)return null;

  const expected=Math.max(activationRate,expectedMoveRate>0?expectedMoveRate:riskRate);
  const progress=favorable/expected;
  let base=.80;
  if(progress>1&&progress<=1.5)base=.80-(progress-1)/.5*.02;
  else if(progress>1.5&&progress<=2)base=.78-(progress-1.5)/.5*.03;
  else if(progress>2&&progress<=3)base=.75-(progress-2)*.03;
  else if(progress>3)base=.70;

  const {adjustment,mode}=signalAdjustment(signal);
  // Strong continuation does not justify early giveback. Only already-earned
  // excess progress loosens the base; weakening evidence can tighten it.
  const retentionRate=clip(base+Math.max(0,adjustment),base,.92);
  const costPositiveFloor=modeledCost+Math.max(.0006,modeledCost*.20);
  const breathingRoom=Math.max(.0008,Math.min(.0018,modeledCost*.35));
  const floorRate=Math.min(favorable-breathingRoom,Math.max(favorable*retentionRate,costPositiveFloor));
  if(!(floorRate>modeledCost&&floorRate<favorable))return null;
  return{
    version:ANCHOR_FLOW_PROFIT_PROTECTION_VERSION,
    reachedR,lockedR:floorRate/riskRate,floorRate,
    retentionRate:floorRate/favorable,activationRate,
    checkpointBand:Math.floor(floorRate/riskRate*4+1e-9),mode,
  };
}


/**
 * RegionLaunch protection starts earlier and keeps more of a fast move than
 * ordinary AnchorFlow. The entry thesis is precisely that a valid launch should
 * not spend much time giving back profit. Only already-earned progress far
 * beyond the original expectation is allowed progressively more room.
 */
export function regionLaunchProfitFloor(
  favorable:number,
  riskRate:number,
  modeledCost=.0022,
  expectedMoveRate=0,
  _signal?:MultiTurnProfitSignal|null,
):MultiTurnProfitFloor|null{
  if(![favorable,riskRate,modeledCost,expectedMoveRate].every(Number.isFinite)||riskRate<=0||favorable<=0)return null;
  const reachedR=favorable/riskRate;
  // RegionLaunch v4 protects by realized price progress, not by a forecast.
  // Before 0.5R the structural stop owns the trade. From 0.5R the trade may no
  // longer give everything back; at 1R retain at least ~65% MFE, at 2R+ ~80%.
  const activationRate=Math.max(modeledCost*1.10,riskRate*.50);
  if(favorable<activationRate)return null;

  let retentionRate:number;
  if(reachedR<1)retentionRate=.35+(reachedR-.50)/.50*.30;
  else if(reachedR<2)retentionRate=.65+(reachedR-1)*.15;
  else retentionRate=Math.min(.88,.80+.04*Math.log2(Math.max(1,reachedR/2)));

  retentionRate=clip(retentionRate,.35,.88);
  const costPositiveFloor=modeledCost+Math.max(.00035,modeledCost*.15);
  const breathingRoom=Math.max(.0005,Math.min(.0012,riskRate*.12));
  const floorRate=Math.min(favorable-breathingRoom,Math.max(favorable*retentionRate,costPositiveFloor));
  if(!(floorRate>modeledCost&&floorRate<favorable))return null;
  return{
    version:REGION_LAUNCH_PROFIT_PROTECTION_VERSION,
    reachedR,lockedR:floorRate/riskRate,floorRate,
    retentionRate:floorRate/favorable,activationRate,
    checkpointBand:Math.floor(floorRate/riskRate*4+1e-9),mode:"NORMAL",
  };
}


/**
 * Region MIGRATION profit protection.
 *
 * A 5m accepted migration is expected to keep making immediate forward progress.
 * Once an executable move is meaningfully above round-trip cost, its observed
 * profit may no longer fall all the way back to the original structural stop.
 * This floor is intentionally quicker and tighter than the old multi-timeframe
 * overlay, while still leaving a real pullback buffer and never predicting a top.
 */
export function regionMigrationProfitFloor(
  favorable:number,
  riskRate:number,
  modeledCost=.0022,
):MultiTurnProfitFloor|null{
  if(![favorable,riskRate,modeledCost].every(Number.isFinite)||riskRate<=0||favorable<=0)return null;
  const reachedR=favorable/riskRate;
  const activationRate=Math.max(modeledCost*1.75,Math.min(.35*riskRate,.0075));
  if(favorable<activationRate)return null;

  let retentionRate:number;
  if(reachedR<.75)retentionRate=.35;
  else if(reachedR<1.25)retentionRate=.45+(reachedR-.75)/.50*.10;
  else if(reachedR<2)retentionRate=.55+(reachedR-1.25)/.75*.10;
  else if(reachedR<4)retentionRate=.65+(reachedR-2)/2*.12;
  else if(reachedR<8)retentionRate=.77+(reachedR-4)/4*.08;
  else retentionRate=Math.min(.90,.85+.02*Math.log2(Math.max(1,reachedR/8)));

  const costPositiveFloor=modeledCost+Math.max(.0006,modeledCost*.25);
  const breathingRoom=Math.max(.0010,Math.min(.0025,.08*riskRate));
  const floorRate=Math.min(favorable-breathingRoom,Math.max(favorable*retentionRate,costPositiveFloor));
  if(!(floorRate>modeledCost&&floorRate<favorable))return null;
  return{
    version:REGION_MIGRATION_PROFIT_PROTECTION_VERSION,
    reachedR,lockedR:floorRate/riskRate,floorRate,
    retentionRate:floorRate/favorable,activationRate,
    checkpointBand:Math.floor(floorRate/riskRate*4+1e-9),mode:"NORMAL",
  };
}
