export const MULTI_TURN_PROFIT_PROTECTION_VERSION="multi-turn-profit-floor-v3";

export type MultiTurnProfitMode="UNKNOWN"|"STRONG"|"NORMAL"|"WEAK"|"DEFENSIVE"|"REVERSAL";
export type MultiTurnProfitContext={
  continuationScore?:number|null;
  turnProbability?:number|null;
  phase?:string|null;
  directionAligned?:boolean|null;
};
export type MultiTurnProfitFloor={
  version:typeof MULTI_TURN_PROFIT_PROTECTION_VERSION;
  reachedR:number;
  lockedR:number;
  floorRate:number;
  retentionRate:number;
  mode:MultiTurnProfitMode;
  armedBy:"R"|"ABSOLUTE_MFE"|"BOTH"|"PRIOR";
};

const R_RETENTION=[
  {x:1.0,y:.15},
  {x:1.5,y:.35},
  {x:2.0,y:.45},
  {x:3.0,y:.55},
  {x:5.0,y:.62},
  {x:8.0,y:.68},
  {x:12.0,y:.72},
  {x:20.0,y:.76},
  {x:30.0,y:.78},
] as const;

const ABS_RETENTION=[
  {x:.02,y:.15},
  {x:.04,y:.30},
  {x:.06,y:.40},
  {x:.10,y:.50},
  {x:.20,y:.60},
  {x:.40,y:.68},
] as const;

function interpolate(points:readonly {x:number;y:number}[],value:number){
  if(value<=points[0].x)return points[0].y;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];
    if(value<=b.x){
      const w=(value-a.x)/Math.max(b.x-a.x,1e-9);
      return a.y+(b.y-a.y)*w;
    }
  }
  return points.at(-1)!.y;
}

function contextMode(context?:MultiTurnProfitContext|null):{mode:MultiTurnProfitMode;boost:number}{
  if(!context)return{mode:"UNKNOWN",boost:.08};
  if(context.directionAligned===false)return{mode:"REVERSAL",boost:.14};
  const continuation=Number.isFinite(context.continuationScore)?Number(context.continuationScore):null;
  const turn=Number.isFinite(context.turnProbability)?Number(context.turnProbability):null;
  const phase=context.phase??null;
  if(phase==="TURNING"||(turn!=null&&turn>=.65)||(continuation!=null&&continuation<.25))
    return{mode:"DEFENSIVE",boost:.14};
  if(phase==="WATCH"||(turn!=null&&turn>=.40)||(continuation!=null&&continuation<.45))
    return{mode:"WEAK",boost:.10};
  if(phase==="FLOW"&&continuation!=null&&continuation>=.72&&turn!=null&&turn<=.18)
    return{mode:"STRONG",boost:0};
  return{mode:"NORMAL",boost:.04};
}

/**
 * Hybrid trailing floor:
 * - R normalizes trades with different original stop/cost geometry.
 * - Absolute MFE prevents wide-stop 4h/1d trades from giving a large real gain
 *   all the way back simply because that gain has not yet reached one R.
 * - Owning-timeframe continuation/turn state only tightens protection. The
 *   persisted floor in the caller is monotonic and can never be loosened later.
 */
export function multiTurnProfitFloor(
  favorable:number,
  riskRate:number,
  modeledCost=.0022,
  context?:MultiTurnProfitContext|null,
  priorFloorRate=0,
):MultiTurnProfitFloor|null{
  if(![favorable,riskRate,modeledCost,priorFloorRate].every(Number.isFinite)||riskRate<=0||favorable<=0||priorFloorRate<0)return null;
  const reachedR=favorable/riskRate;
  const rActive=reachedR>=1;
  const absoluteActive=favorable>=.02;
  if(!rActive&&!absoluteActive&&!(priorFloorRate>0))return null;

  const {mode,boost}=contextMode(context);
  const rRetention=rActive?Math.min(.82,interpolate(R_RETENTION,reachedR)+boost):0;
  const absoluteRetention=absoluteActive?Math.min(.82,interpolate(ABS_RETENTION,favorable)+boost):0;
  const targetRetention=Math.max(rRetention,absoluteRetention);
  const costPositiveFloor=modeledCost+.0010;
  const target=Math.max(priorFloorRate,favorable*targetRetention,costPositiveFloor);
  const breathingRoom=Math.max(.0015,Math.min(.006,favorable*.12));
  const floorRate=Math.min(favorable-breathingRoom,target);
  if(!(floorRate>0&&floorRate<favorable))return null;
  const rDominant=rActive&&rRetention>=absoluteRetention,absDominant=absoluteActive&&absoluteRetention>=rRetention;
  const armedBy:MultiTurnProfitFloor["armedBy"]=priorFloorRate>0&&priorFloorRate>=favorable*targetRetention
    ?"PRIOR":rDominant&&absDominant?"BOTH":rDominant?"R":"ABSOLUTE_MFE";
  return{
    version:MULTI_TURN_PROFIT_PROTECTION_VERSION,
    reachedR,
    lockedR:floorRate/riskRate,
    floorRate,
    retentionRate:floorRate/favorable,
    mode,
    armedBy,
  };
}
