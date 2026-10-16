/** 研究层阶段是怎么接上的。只记在订单上，不参与开仓或出场。 */
export const STAGE_CHRONICLE_VERSION="stage-chronicle-v1";

export type StageName="SHOCK"|"TREND"|"ROTATION"|"TRANSITION";

export type StageChronicle={
  version:typeof STAGE_CHRONICLE_VERSION;
  stage:StageName;
  stageSince:number;
  previousStage:StageName|null;
  lastShockEndedAt:number|null;
  /** 这一轮里，名字写成同步爆发的次数。这一轮没开始时是 0。 */
  push:number;
  roundActive:boolean;
  syncPeak:number|null;
};

export type StageStamp={
  liveStage:StageName;
  priorStage:StageName|null;
  stageAgeMin:number;
  minutesSinceShock:number|null;
  shockPush:number;
  syncDrop:number|null;
};

const STAGES:readonly StageName[]=["SHOCK","TREND","ROTATION","TRANSITION"];

export function initialStageChronicle(now:number):StageChronicle{
  return {version:STAGE_CHRONICLE_VERSION,stage:"TRANSITION",stageSince:now,previousStage:null,
    lastShockEndedAt:null,push:0,roundActive:false,syncPeak:null};
}

function asStage(value:unknown):StageName{
  return STAGES.includes(value as StageName)?value as StageName:"TRANSITION";
}
function num(value:unknown){
  return typeof value==="number"&&Number.isFinite(value)?value:null;
}

export function normalizeStageChronicle(raw:unknown,now:number):StageChronicle{
  const row=raw as Partial<StageChronicle>|null|undefined;
  if(!row||row.version!==STAGE_CHRONICLE_VERSION)return initialStageChronicle(now);
  return {
    version:STAGE_CHRONICLE_VERSION,
    stage:asStage(row.stage),
    stageSince:num(row.stageSince)??now,
    previousStage:row.previousStage==null?null:asStage(row.previousStage),
    lastShockEndedAt:num(row.lastShockEndedAt),
    push:Math.max(0,Math.floor(num(row.push)??0)),
    roundActive:row.roundActive===true,
    syncPeak:num(row.syncPeak),
  };
}

/**
 * 阶段时钟按研究层四个名字走。第几次推动跟着爆发段：段没结束前再次写成同步爆发，次数加一。
 * 段结束后次数回到 0。同步度高点只在这一轮里更新。
 */
export function advanceStageChronicle(prev:StageChronicle|null|undefined,environment:string,synchrony:number|null|undefined,roundActive:boolean,now:number):StageChronicle{
  const base=normalizeStageChronicle(prev,now);
  const stage=asStage(environment);
  const sync=num(synchrony);
  const changed=stage!==base.stage;
  let push=base.push;
  let peak=base.syncPeak;
  let active=base.roundActive;
  if(!roundActive){
    push=0;peak=null;active=false;
  }else if(!base.roundActive){
    push=1;peak=sync;active=true;
  }else if(stage==="SHOCK"&&base.stage!=="SHOCK"){
    push=base.push+1;active=true;
    if(sync!=null)peak=Math.max(base.syncPeak??sync,sync);
  }else{
    active=true;
    if(sync!=null)peak=Math.max(base.syncPeak??sync,sync);
    if(push<1)push=1;
  }
  return {
    version:STAGE_CHRONICLE_VERSION,
    stage,
    stageSince:changed?now:base.stageSince,
    previousStage:changed?base.stage:base.previousStage,
    lastShockEndedAt:changed&&base.stage==="SHOCK"?now:base.lastShockEndedAt,
    push,roundActive:active,syncPeak:peak,
  };
}

function mins(ms:number){
  return Math.round(ms/60_000*10)/10;
}

export function stageStamp(chronicle:StageChronicle|null|undefined,synchrony:number|null|undefined,now:number):StageStamp{
  const row=normalizeStageChronicle(chronicle,now);
  const sync=num(synchrony);
  const sinceShock=row.stage==="SHOCK"||row.lastShockEndedAt==null?null:mins(Math.max(0,now-row.lastShockEndedAt));
  const drop=row.roundActive&&row.syncPeak!=null&&sync!=null?Math.round(Math.max(0,row.syncPeak-sync)*10000)/10000:null;
  return {
    liveStage:row.stage,
    priorStage:row.previousStage,
    stageAgeMin:mins(Math.max(0,now-row.stageSince)),
    minutesSinceShock:sinceShock,
    shockPush:row.roundActive?row.push:0,
    syncDrop:drop,
  };
}
