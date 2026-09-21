export const MULTI_TURN_PROFIT_PROTECTION_VERSION="multi-turn-profit-floor-v2";

export type MultiTurnProfitFloor={
  version:typeof MULTI_TURN_PROFIT_PROTECTION_VERSION;
  tier:number;armedAtR:number;reachedR:number;lockedR:number;
  floorRate:number;retentionRate:number;
};

const TIERS=[
  {mfeR:1.0,lockR:.15},
  {mfeR:1.5,lockR:.45},
  {mfeR:2.0,lockR:.80},
  {mfeR:3.0,lockR:1.40},
  {mfeR:5.0,lockR:2.80},
  {mfeR:8.0,lockR:5.00},
  {mfeR:12.0,lockR:8.00},
  {mfeR:20.0,lockR:14.00},
  {mfeR:30.0,lockR:22.00},
] as const;

/**
 * Profit protection is expressed in R, where one R is this trade's original
 * planned loss rate (plannedRisk / notional), including its entry-time modeled
 * trading drag. Leverage and margin therefore do not change the protection
 * geometry. The floor remains in underlying directional-return units because
 * exits are executed from price.
 */
export function multiTurnProfitFloor(favorable:number,riskRate:number,modeledCost=.0022):MultiTurnProfitFloor|null{
  if(![favorable,riskRate,modeledCost].every(Number.isFinite)||riskRate<=0||favorable<=0)return null;
  const reachedR=favorable/riskRate;
  if(reachedR<1)return null;
  let selected:typeof TIERS[number]=TIERS[0],tier=0;
  for(let i=0;i<TIERS.length;i++)if(reachedR>=TIERS[i].mfeR){selected=TIERS[i];tier=i;}
  const costPositiveFloor=modeledCost+.0010;
  const rFloor=selected.lockR*riskRate;
  const breathingRoom=Math.max(.0015,.25*riskRate);
  const floorRate=Math.min(favorable-breathingRoom,Math.max(rFloor,costPositiveFloor));
  if(!(floorRate>modeledCost&&floorRate<favorable))return null;
  return{version:MULTI_TURN_PROFIT_PROTECTION_VERSION,tier,armedAtR:selected.mfeR,reachedR,
    lockedR:floorRate/riskRate,floorRate,retentionRate:floorRate/favorable};
}
