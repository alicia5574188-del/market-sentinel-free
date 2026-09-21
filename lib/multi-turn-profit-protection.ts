export const MULTI_TURN_PROFIT_PROTECTION_VERSION="multi-turn-profit-floor-v1";

export type MultiTurnProfitFloor={
  version:typeof MULTI_TURN_PROFIT_PROTECTION_VERSION;
  tier:number;armedAtMfe:number;floorRate:number;retentionRate:number;
};

const TIERS=[
  {mfe:.01,floor:.0035},
  {mfe:.02,floor:.0080},
  {mfe:.04,floor:.0180},
  {mfe:.06,floor:.0300},
  {mfe:.08,floor:.0450},
  {mfe:.12,floor:.0700},
  {mfe:.20,floor:.1300},
  {mfe:.30,floor:.2000},
  {mfe:.40,floor:.2800},
  {mfe:.50,floor:.3600},
] as const;

/**
 * Stepwise profit floor for Multi-Turn positions.
 * It does not try to retain 85% of MFE. Small winners get room to breathe,
 * while larger winners progressively lock a majority of the reached move.
 * modeledCost is the current estimated round-trip drag; the first floor must
 * remain positive after that drag.
 */
export function multiTurnProfitFloor(favorable:number,modeledCost=.0022):MultiTurnProfitFloor|null{
  if(!Number.isFinite(favorable)||favorable<.01)return null;
  let selected:typeof TIERS[number]=TIERS[0],tier=0;
  for(let i=0;i<TIERS.length;i++)if(favorable>=TIERS[i].mfe){selected=TIERS[i];tier=i;}
  const floorRate=Math.min(favorable-Math.max(.0015,modeledCost*.35),
    Math.max(selected.floor,modeledCost+.0010));
  if(!(floorRate>0&&floorRate<favorable))return null;
  return{version:MULTI_TURN_PROFIT_PROTECTION_VERSION,tier,armedAtMfe:selected.mfe,
    floorRate,retentionRate:floorRate/favorable};
}
