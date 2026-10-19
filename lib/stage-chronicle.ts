/** 研究层阶段是怎么接上的。只记在订单上和导出里，不参与开仓或出场。 */
export const STAGE_CHRONICLE_VERSION="stage-chronicle-v1";

export type StageName="SHOCK"|"TREND"|"ROTATION"|"TRANSITION";
export type StageSnap={
  sync:number|null;breadth:number|null;expansion:number|null;aligned_flow:number|null;
  pressure:number|null;persistence:number|null;btc:number|null;eth:number|null;factor:number|null;
  /** 切换时大盘因子（等权全币）最近 30 分钟涨跌 %。有这个键的快照，回填的 factor_pct 是同一批币从切换到现在的等权涨跌。 */
  factor_30m_pct?:number|null;
};
export type StageFwd={btc_pct:number|null;eth_pct:number|null;factor_pct:number|null;at:number};
export type StageChange={
  at:number;
  stage:StageName;
  prior:StageName|null;
  trendSide:"LONG"|"SHORT"|null;
  snap?:StageSnap;
  fwd?:{m30?:StageFwd;m60?:StageFwd;m120?:StageFwd};
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
export const STAGE_CHANGE_CAP=2_000;
const CHANGE_CAP=STAGE_CHANGE_CAP;

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
    const next=changeAt(row.at,asStage(row.stage),row.prior==null?null:asStage(row.prior),asSide(row.trendSide));
    if(row.snap)next.snap=cleanSnap(row.snap);
    if(row.fwd)next.fwd=cleanFwd(row.fwd);
    rows.push(next);
  }
  return (rows.length?rows:[fallback]).slice(-CHANGE_CAP);
}
function numOrNull(value:unknown){
  return typeof value==="number"&&Number.isFinite(value)?value:null;
}
function cleanSnap(raw:StageSnap):StageSnap{
  return {sync:numOrNull(raw.sync),breadth:numOrNull(raw.breadth),expansion:numOrNull(raw.expansion),
    aligned_flow:numOrNull(raw.aligned_flow),pressure:numOrNull(raw.pressure),persistence:numOrNull(raw.persistence),
    btc:numOrNull(raw.btc),eth:numOrNull(raw.eth),factor:numOrNull(raw.factor),
    ...("factor_30m_pct" in raw?{factor_30m_pct:numOrNull(raw.factor_30m_pct)}:{})};
}
function cleanLeg(raw:StageFwd|undefined):StageFwd|undefined{
  if(!raw||typeof raw.at!=="number")return undefined;
  return {btc_pct:numOrNull(raw.btc_pct),eth_pct:numOrNull(raw.eth_pct),factor_pct:numOrNull(raw.factor_pct),at:raw.at};
}
function cleanFwd(raw:NonNullable<StageChange["fwd"]>):NonNullable<StageChange["fwd"]>{
  const fwd:NonNullable<StageChange["fwd"]>={};
  const m30=cleanLeg(raw.m30),m60=cleanLeg(raw.m60),m120=cleanLeg(raw.m120);
  if(m30)fwd.m30=m30;if(m60)fwd.m60=m60;if(m120)fwd.m120=m120;
  return fwd;
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
      trendSide:item.trendSide,open:i===changes.length-1,snap:item.snap??null,fwd:item.fwd??null};
  });
}

/** 只填刚写下、还没有快照的那一条。不改阶段时钟。 */
export function attachStageSnap(chronicle:StageChronicle,snap:StageSnap,now:number):StageChronicle{
  const last=chronicle.changes.at(-1);
  if(!last||last.snap||Math.abs(last.at-now)>5_000)return chronicle;
  const changes=chronicle.changes.slice(0,-1).concat({...last,snap:cleanSnap(snap)});
  return {...chronicle,changes};
}

function pct(nowPx:number|null,thenPx:number|null){
  if(nowPx==null||thenPx==null||!(thenPx>0))return null;
  return Math.round((nowPx/thenPx-1)*10_000)/100;
}
/** 价格的几何平均。两时点相除就是这段的等权收益，名字集合变了会失真。不满 8 个币不算市场。 */
export function equalWeightPriceIndex(mids:number[]){
  const ok=mids.filter(v=>typeof v==="number"&&v>0&&Number.isFinite(v));
  if(ok.length<8)return null;
  return Math.exp(ok.reduce((n,v)=>n+Math.log(v),0)/ok.length);
}
/** 等权平均收益，单位是百分比。不满 8 个币返回空。 */
export function equalWeightReturnPct(returns:number[]){
  const ok=returns.filter(v=>typeof v==="number"&&Number.isFinite(v));
  if(ok.length<8)return null;
  return Math.round(ok.reduce((n,v)=>n+v,0)/ok.length*10_000)/100;
}
/** 切换后 30/60/120 分钟，把大盘相对切换时的涨跌补上。只写记录。 */
/**
 * Equal-weight return % of every coin whose 5m closes cover both `at` and its latest bar: close of the last bar that
 * ended at or before `at` versus the latest close. Same coins at both ends. Fewer than 8 coins = null.
 */
export function equalWeightReturnSince(paths:Record<string,readonly {time:number;close:number}[]>|null|undefined,at:number){
  const returns:number[]=[];
  for(const bars of Object.values(paths??{})){
    if(!bars?.length)continue;
    const end=(b:{time:number})=>(b.time<1e12?b.time*1000:b.time)+300_000;
    let base:number|null=null;
    for(const b of bars){if(end(b)<=at&&b.close>0)base=b.close;else if(end(b)>at)break;}
    const last=bars.at(-1)!;
    if(base==null||!(last.close>0)||end(last)<=at)continue;
    returns.push(last.close/base-1);
  }
  return equalWeightReturnPct(returns);
}
/**
 * `factor`: a function (new snapshots) returning the equal-weight return since the switch, or the legacy index level.
 * Old snapshots (no factor_30m_pct) keep the legacy ratio only when a number is given; with a function they get null,
 * because a ratio of two indexes over different coin sets is not a return.
 */
export function fillStageForward(chronicle:StageChronicle|null|undefined,btc:number|null,eth:number|null,factor:number|null|((at:number)=>number|null),now:number):StageChronicle{
  const row=normalizeStageChronicle(chronicle,now);
  let changed=false;
  const slots=[{key:"m30" as const,minutes:30},{key:"m60" as const,minutes:60},{key:"m120" as const,minutes:120}];
  const changes=row.changes.map(item=>{
    if(!item.snap)return item;
    let fwd=item.fwd?{...item.fwd}:{};
    let next=item;
    for(const slot of slots){
      if(fwd[slot.key]||item.at+slot.minutes*60_000>now)continue;
      const modern="factor_30m_pct" in item.snap;
      let factorPct:number|null=null;
      try{factorPct=typeof factor==="function"?(modern?factor(item.at):null):modern?null:pct(factor,item.snap.factor);}catch{factorPct=null;}
      fwd={...fwd,[slot.key]:{btc_pct:pct(btc,item.snap.btc),eth_pct:pct(eth,item.snap.eth),factor_pct:factorPct,at:now}};
      next={...next,fwd};changed=true;
    }
    return next;
  });
  return changed?{...row,changes}:row;
}
