/** 研究层阶段是怎么接上的。只记在订单上和导出里，不参与开仓或出场。 */
export const STAGE_CHRONICLE_VERSION="stage-chronicle-v1";

export type StageName="SHOCK"|"TREND"|"ROTATION"|"TRANSITION";
export type StageChange={
  at:number;
  stage:StageName;
  prior:StageName|null;
  trendSide:"LONG"|"SHORT"|null;
};

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
  /** 每次阶段名字变了记一条。只给导出复盘，不参与开仓或出场。 */
  changes:StageChange[];
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
const CHANGE_CAP=2_000;

function changeAt(now:number,stage:StageName,prior:StageName|null,trendSide:"LONG"|"SHORT"|null):StageChange{
  return {at:now,stage,prior,trendSide};
}

export function initialStageChronicle(now:number):StageChronicle{
  return {version:STAGE_CHRONICLE_VERSION,stage:"TRANSITION",stageSince:now,previousStage:null,
    lastShockEndedAt:null,push:0,roundActive:false,syncPeak:null,
    changes:[changeAt(now,"TRANSITION",null,null)]};
}

function asStage(value:unknown):StageName{
  return STAGES.includes(value as StageName)?value as StageName:"TRANSITION";
}
function num(value:unknown){
  return typeof value==="number"&&Number.isFinite(value)?value:null;
}
function asSide(value:unknown):"LONG"|"SHORT"|null{
  return value==="LONG"||value==="SHORT"?value:null;
}
function readChanges(raw:unknown,fallback:StageChange):StageChange[]{
  if(!Array.isArray(raw))return [fallback];
  const rows:StageChange[]=[];
  for(const item of raw){
    const row=item as Partial<StageChange>|null;
    if(!row||typeof row.at!=="number"||!Number.isFinite(row.at))continue;
    rows.push(changeAt(row.at,asStage(row.stage),row.prior==null?null:asStage(row.prior),asSide(row.trendSide)));
  }
  return (rows.length?rows:[fallback]).slice(-CHANGE_CAP);
}

export function normalizeStageChronicle(raw:unknown,now:number):StageChronicle{
  const row=raw as Partial<StageChronicle>|null|undefined;
  if(!row||row.version!==STAGE_CHRONICLE_VERSION)return initialStageChronicle(now);
  const stage=asStage(row.stage);
  const stageSince=num(row.stageSince)??now;
  const previousStage=row.previousStage==null?null:asStage(row.previousStage);
  return {
    version:STAGE_CHRONICLE_VERSION,
    stage,
    stageSince,
    previousStage,
    lastShockEndedAt:num(row.lastShockEndedAt),
    push:Math.max(0,Math.floor(num(row.push)??0)),
    roundActive:row.roundActive===true,
    syncPeak:num(row.syncPeak),
    changes:readChanges(row.changes,changeAt(stageSince,stage,previousStage,null)),
  };
}

/**
 * 阶段时钟按研究层四个名字走。第几次推动跟着爆发段：段没结束前再次写成同步爆发，次数加一。
 * 段结束后次数回到 0。同步度高点只在这一轮里更新。
 * 名字变了才追加一条。同一段里方向后来变了，不改已经写下的那条。
 */
export function advanceStageChronicle(prev:StageChronicle|null|undefined,environment:string,synchrony:number|null|undefined,roundActive:boolean,now:number,trendSide?:"LONG"|"SHORT"|null):StageChronicle{
  const base=normalizeStageChronicle(prev,now);
  const stage=asStage(environment);
  const sync=num(synchrony);
  const changed=stage!==base.stage;
  const side=asSide(trendSide);
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
  const changes=changed?[...base.changes,changeAt(now,stage,base.stage,side)].slice(-CHANGE_CAP):base.changes;
  return {
    version:STAGE_CHRONICLE_VERSION,
    stage,
    stageSince:changed?now:base.stageSince,
    previousStage:changed?base.stage:base.previousStage,
    lastShockEndedAt:changed&&base.stage==="SHOCK"?now:base.lastShockEndedAt,
    push,roundActive:active,syncPeak:peak,changes,
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

/** 导出用。最后一段的 until 是导出时间，open 表示这段还没结束。 */
export function readStageTimeline(chronicle:StageChronicle|null|undefined,now:number){
  const changes=normalizeStageChronicle(chronicle,now).changes;
  return changes.map((item,i)=>{
    const until=i+1<changes.length?changes[i+1]!.at:now;
    return {at:item.at,until,min:mins(Math.max(0,until-item.at)),stage:item.stage,prior:item.prior,
      trendSide:item.trendSide,open:i===changes.length-1};
  });
}
