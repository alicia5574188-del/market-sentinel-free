export const REGION_LIFECYCLE_VERSION="region-lifecycle-v1";
export const REGION_BAR_MS=300_000;
export const REGION_WINDOW_BARS=[12,18,24,36,48] as const;
export const REGION_DETACH_WIDTHS=.60;
export const REGION_SIGNAL_TTL_BARS=2;

export type RegionCandle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type RegionStatus="NO_REGION"|"IN_REGION"|"PROBE_UP"|"PROBE_DOWN"|"ACCEPTED_UP"|"ACCEPTED_DOWN"|"DETACHED_UP"|"DETACHED_DOWN";
export type RegionBoundary="UPPER"|"LOWER";
export type RegionEntryKind="MIGRATION"|"REJECTION";
export type RegionZone={
  id:string;symbol:string;startAt:number;endAt:number;confirmedAt:number;bars:number;
  lower:number;upper:number;center:number;width:number;widthRate:number;
  touchesUpper:number;touchesLower:number;crossings:number;
};
export type RegionEntrySignal={
  version:typeof REGION_LIFECYCLE_VERSION;id:string;symbol:string;kind:RegionEntryKind;side:"LONG"|"SHORT";
  boundary:RegionBoundary;completedAt:number;expiresAt:number;signalPrice:number;stopPrice:number;targetPrice:number|null;
  regionId:string;regionConfirmedAt:number;regionLower:number;regionUpper:number;regionCenter:number;regionWidth:number;regionWidthRate:number;
  reason:string;
};
export type RegionLifecycleState={
  version:typeof REGION_LIFECYCLE_VERSION;symbol:string;initializedAt:number;observedAt:number;lastProcessedAt:number;
  zone:RegionZone|null;status:RegionStatus;probeStartedAt:number|null;probeExtreme:number|null;
  acceptedAt:number|null;detachedAt:number|null;upperConsumedAt:number|null;lowerConsumedAt:number|null;reason:string;
};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const median=(values:number[])=>{
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return 0;
  return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;
};
const quantile=(values:number[],p:number)=>{
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return 0;
  return a[Math.max(0,Math.min(a.length-1,Math.floor((a.length-1)*p)))]!;
};
const hash=(text:string)=>{let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);return(h>>>0).toString(36);};
const completeAt=(row:RegionCandle)=>row.time*1000+REGION_BAR_MS;
const valid=(row:RegionCandle)=>[row.time,row.open,row.high,row.low,row.close,row.volume].every(Number.isFinite)
  &&row.time>0&&row.open>0&&row.close>0&&row.low>0&&row.high>=Math.max(row.open,row.close)&&row.low<=Math.min(row.open,row.close)&&row.volume>=0;
const contiguous=(rows:RegionCandle[])=>rows.every((row,i)=>valid(row)&&(i===0||row.time===rows[i-1]!.time+300));

function centerCrossings(closes:number[],center:number){
  let crossings=0,prior=0;
  for(const close of closes){
    const side=close>center?1:close<center?-1:0;
    if(side&&prior&&side!==prior)crossings++;
    if(side)prior=side;
  }
  return crossings;
}

function regionCandidate(symbol:string,window:RegionCandle[],costRate:number):RegionZone|null{
  if(!contiguous(window)||window.length<12)return null;
  const closes=window.map(x=>x.close),lows=window.map(x=>x.low),highs=window.map(x=>x.high);
  const typicalRanges=window.map(x=>(x.high-x.low)/Math.max(x.close,1e-12));
  const lower=quantile(lows,.25),upper=quantile(highs,.75);
  if(!(lower>0&&upper>lower))return null;
  const width=upper-lower,center=clip(median(closes),lower,upper),widthRate=width/Math.max(center,1e-12);
  const medianRange=Math.max(.0002,median(typicalRanges));
  const minWidthRate=Math.max(.0015,costRate*2.2,medianRange*1.20);
  const maxWidthRate=Math.min(.20,Math.max(minWidthRate*2.0,medianRange*8.5));
  if(widthRate<minWidthRate||widthRate>maxWidthRate)return null;

  const inside=closes.filter(x=>x>=lower&&x<=upper).length/window.length;
  const crossings=centerCrossings(closes,center);
  const touchesUpper=window.filter(x=>x.high>=upper-width*.12).length;
  const touchesLower=window.filter(x=>x.low<=lower+width*.12).length;
  const drift=Math.abs(closes.at(-1)!-closes[0]!)/width;
  const half=Math.floor(window.length/2);
  const halfShift=Math.abs(median(closes.slice(0,half))-median(closes.slice(half)))/width;
  const lastInside=closes.at(-1)!>=lower&&closes.at(-1)!<=upper;
  if(!lastInside||inside<.68||crossings<3||touchesUpper<2||touchesLower<2||drift>.65||halfShift>.38)return null;

  const startAt=completeAt(window[0]!),endAt=completeAt(window.at(-1)!);
  const id=`rg-${symbol}-${window[0]!.time}-${window.at(-1)!.time}-${hash([lower,upper].map(x=>x.toPrecision(10)).join(":"))}`;
  return{id,symbol,startAt,endAt,confirmedAt:endAt,bars:window.length,lower,upper,center,width,widthRate,touchesUpper,touchesLower,crossings};
}

export function findLatestMatureRegion(input:{symbol:string;rows:RegionCandle[];now:number;costRate:number}):RegionZone|null{
  const rows=input.rows.filter(row=>valid(row)&&completeAt(row)<=input.now).sort((a,b)=>a.time-b.time);
  if(rows.length<12)return null;
  const earliest=Math.max(0,rows.length-144);
  for(let end=rows.length-1;end>=earliest;end--){
    const found:RegionZone[]=[];
    for(const size of REGION_WINDOW_BARS){
      const start=end-size+1;if(start<earliest)continue;
      const candidate=regionCandidate(input.symbol,rows.slice(start,end+1),input.costRate);
      if(candidate)found.push(candidate);
    }
    if(found.length)return found.sort((a,b)=>b.bars-a.bars||b.widthRate-a.widthRate)[0]!;
  }
  return null;
}

function distinctRegion(a:RegionZone,b:RegionZone){
  if(b.confirmedAt<=a.confirmedAt)return false;
  const overlap=Math.max(0,Math.min(a.upper,b.upper)-Math.max(a.lower,b.lower));
  const overlapRatio=overlap/Math.max(1e-12,Math.min(a.width,b.width));
  const centerShift=Math.abs(b.center-a.center)/Math.max(a.width,b.width,1e-12);
  return overlapRatio<.35||centerShift>.75;
}

function migrationSignal(zone:RegionZone,row:RegionCandle,side:"LONG"|"SHORT",costRate:number):RegionEntrySignal{
  const d=side==="LONG"?1:-1,boundary:RegionBoundary=side==="LONG"?"UPPER":"LOWER";
  const signalPrice=row.close;
  const stopPrice=side==="LONG"?zone.upper-zone.width*.20:zone.lower+zone.width*.20;
  const completedAt=completeAt(row);
  return{version:REGION_LIFECYCLE_VERSION,id:`rs-${zone.id}-M-${side}-${completedAt}`,symbol:zone.symbol,kind:"MIGRATION",side,boundary,
    completedAt,expiresAt:completedAt+REGION_SIGNAL_TTL_BARS*REGION_BAR_MS,signalPrice,stopPrice,targetPrice:null,
    regionId:zone.id,regionConfirmedAt:zone.confirmedAt,regionLower:zone.lower,regionUpper:zone.upper,regionCenter:zone.center,
    regionWidth:zone.width,regionWidthRate:zone.widthRate,
    reason:`5m区域${zone.lower.toPrecision(6)}-${zone.upper.toPrecision(6)}外连续收盘被接受，顺${side==="LONG"?"上":"下"}迁移进入；重新接受旧区域即失效。`};
}

function rejectionSignal(zone:RegionZone,row:RegionCandle,boundary:RegionBoundary,extreme:number,costRate:number):RegionEntrySignal{
  const side=boundary==="UPPER"?"SHORT":"LONG",completedAt=completeAt(row);
  const buffer=Math.max(zone.width*.08,zone.center*costRate*.25);
  const stopPrice=boundary==="UPPER"?extreme+buffer:extreme-buffer;
  return{version:REGION_LIFECYCLE_VERSION,id:`rs-${zone.id}-R-${boundary}-${completedAt}`,symbol:zone.symbol,kind:"REJECTION",side,boundary,
    completedAt,expiresAt:completedAt+REGION_SIGNAL_TTL_BARS*REGION_BAR_MS,signalPrice:row.close,stopPrice,targetPrice:zone.center,
    regionId:zone.id,regionConfirmedAt:zone.confirmedAt,regionLower:zone.lower,regionUpper:zone.upper,regionCenter:zone.center,
    regionWidth:zone.width,regionWidthRate:zone.widthRate,
    reason:`5m区域${boundary==="UPPER"?"上":"下"}沿外探被拒绝并重新收回区域，回归区域中心。`};
}

export function consumeRegionBoundary(state:RegionLifecycleState,boundary:RegionBoundary,at:number):RegionLifecycleState{
  return boundary==="UPPER"?{...state,upperConsumedAt:at}:{...state,lowerConsumedAt:at};
}

export function evaluateRegionLifecycle(input:{symbol:string;rows:RegionCandle[];prior?:RegionLifecycleState|null;now:number;costRate:number;suppressSignals?:boolean}){
  const completed=input.rows.filter(row=>valid(row)&&completeAt(row)<=input.now).sort((a,b)=>a.time-b.time);
  const detected=findLatestMatureRegion({symbol:input.symbol,rows:completed,now:input.now,costRate:input.costRate});
  const prior=input.prior??null;
  let zone=prior?.zone??null;
  if(!zone)zone=detected;
  else if(detected&&distinctRegion(zone,detected))zone=detected;
  if(!zone){
    const lastProcessedAt=completed.at(-1)?completeAt(completed.at(-1)!):(prior?.lastProcessedAt??0);
    return{state:{version:REGION_LIFECYCLE_VERSION,symbol:input.symbol,initializedAt:prior?.initializedAt??input.now,observedAt:input.now,
      lastProcessedAt,zone:null,status:"NO_REGION" as const,probeStartedAt:null,probeExtreme:null,acceptedAt:null,detachedAt:null,
      upperConsumedAt:null,lowerConsumedAt:null,reason:"最近5分钟路径尚未形成成熟缠绕区域。"},signals:[] as RegionEntrySignal[]};
  }

  const sameZone=prior?.zone?.id===zone.id;
  let upperConsumedAt=sameZone?(prior?.upperConsumedAt??null):null;
  let lowerConsumedAt=sameZone?(prior?.lowerConsumedAt??null):null;
  const cutoff=prior?.lastProcessedAt??input.now;
  let status:RegionStatus="IN_REGION",probeStartedAt:number|null=null,probeExtreme:number|null=null,acceptedAt:number|null=null,detachedAt:number|null=null;
  let upCount=0,downCount=0,acceptedSide:RegionBoundary|null=null;
  const signals:RegionEntrySignal[]=[];
  const probeBuffer=Math.max(zone.width*.05,zone.center*input.costRate*.15);
  const reentryDepth=zone.width*.15;
  const after=completed.filter(row=>completeAt(row)>zone!.confirmedAt);

  for(const row of after){
    const at=completeAt(row),close=row.close;
    if(upperConsumedAt!=null&&at>upperConsumedAt&&close<=zone.center)upperConsumedAt=null;
    if(lowerConsumedAt!=null&&at>lowerConsumedAt&&close>=zone.center)lowerConsumedAt=null;

    const above=close>zone.upper+probeBuffer,below=close<zone.lower-probeBuffer;
    if(above){
      downCount=0;
      if(acceptedSide==="LOWER")acceptedSide=null;
      if(status!=="PROBE_UP"&&acceptedSide!=="UPPER"){probeStartedAt=at;probeExtreme=row.high;}else probeExtreme=Math.max(probeExtreme??row.high,row.high);
      upCount++;
      if(acceptedSide==="UPPER"||upCount>=2){
        acceptedSide="UPPER";acceptedAt=acceptedAt??at;
        const widths=(close-zone.upper)/zone.width;
        status=widths>REGION_DETACH_WIDTHS?"DETACHED_UP":"ACCEPTED_UP";
        if(status==="DETACHED_UP")detachedAt=detachedAt??at;
        if(upCount===2&&widths<=REGION_DETACH_WIDTHS&&at>cutoff&&!input.suppressSignals&&upperConsumedAt==null)
          signals.push(migrationSignal(zone,row,"LONG",input.costRate));
      }else status="PROBE_UP";
      continue;
    }
    if(below){
      upCount=0;
      if(acceptedSide==="UPPER")acceptedSide=null;
      if(status!=="PROBE_DOWN"&&acceptedSide!=="LOWER"){probeStartedAt=at;probeExtreme=row.low;}else probeExtreme=Math.min(probeExtreme??row.low,row.low);
      downCount++;
      if(acceptedSide==="LOWER"||downCount>=2){
        acceptedSide="LOWER";acceptedAt=acceptedAt??at;
        const widths=(zone.lower-close)/zone.width;
        status=widths>REGION_DETACH_WIDTHS?"DETACHED_DOWN":"ACCEPTED_DOWN";
        if(status==="DETACHED_DOWN")detachedAt=detachedAt??at;
        if(downCount===2&&widths<=REGION_DETACH_WIDTHS&&at>cutoff&&!input.suppressSignals&&lowerConsumedAt==null)
          signals.push(migrationSignal(zone,row,"SHORT",input.costRate));
      }else status="PROBE_DOWN";
      continue;
    }

    const wasProbeUp=status==="PROBE_UP"&&acceptedSide!=="UPPER",wasProbeDown=status==="PROBE_DOWN"&&acceptedSide!=="LOWER";
    if(wasProbeUp&&close<=zone.upper-reentryDepth&&probeExtreme!=null&&at>cutoff&&!input.suppressSignals&&upperConsumedAt==null)
      signals.push(rejectionSignal(zone,row,"UPPER",probeExtreme,input.costRate));
    if(wasProbeDown&&close>=zone.lower+reentryDepth&&probeExtreme!=null&&at>cutoff&&!input.suppressSignals&&lowerConsumedAt==null)
      signals.push(rejectionSignal(zone,row,"LOWER",probeExtreme,input.costRate));
    status="IN_REGION";probeStartedAt=null;probeExtreme=null;upCount=0;downCount=0;acceptedSide=null;acceptedAt=null;detachedAt=null;
  }

  const lastProcessedAt=completed.at(-1)?completeAt(completed.at(-1)!):Math.max(cutoff,zone.confirmedAt);
  const reason=status==="IN_REGION"?"价格仍被最近成熟区域接受；等待边界事件。"
    :status==="PROBE_UP"?"价格正在尝试离开区域上沿，尚未确认接受或拒绝。"
    :status==="PROBE_DOWN"?"价格正在尝试离开区域下沿，尚未确认接受或拒绝。"
    :status==="ACCEPTED_UP"?"区域上方连续收盘被接受；仅在未追远时允许顺向迁移。"
    :status==="ACCEPTED_DOWN"?"区域下方连续收盘被接受；仅在未追远时允许顺向迁移。"
    :status==="DETACHED_UP"?"价格已远离区域上方，不追；等待回测或更高的新区域。"
    :"价格已远离区域下方，不追；等待回测或更低的新区域。";
  return{state:{version:REGION_LIFECYCLE_VERSION,symbol:input.symbol,initializedAt:prior?.initializedAt??input.now,observedAt:input.now,
    lastProcessedAt,zone,status,probeStartedAt,probeExtreme,acceptedAt,detachedAt,upperConsumedAt,lowerConsumedAt,reason},signals};
}

export function evaluateRegionUniverse(input:{paths:Record<string,RegionCandle[]>;prior?:Record<string,RegionLifecycleState>;now:number;costRate:number;suppressSignals?:boolean}){
  const states:{[symbol:string]:RegionLifecycleState}={...(input.prior??{})},signals:RegionEntrySignal[]=[];
  let updated=0;
  for(const [symbol,rows] of Object.entries(input.paths)){
    const result=evaluateRegionLifecycle({symbol,rows,prior:states[symbol]??null,now:input.now,costRate:input.costRate,suppressSignals:input.suppressSignals});
    states[symbol]=result.state;signals.push(...result.signals);updated++;
  }
  return{states,signals,updated};
}
