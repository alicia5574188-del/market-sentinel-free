import { REGION_BAR_MS, REGION_LIFECYCLE_VERSION, type RegionCandle, type RegionEntrySignal, type RegionLifecycleState, type RegionZone } from "./region-lifecycle.ts";
import type { MultiTurnState } from "./multi-turn-engine.ts";
import { assessStrongBreakout, evaluateMicroRestart } from "./micro-restart.ts";
import {launchFiveMinuteEvidence,evaluateSlowLaunchRestart} from "./launch-five-minute.ts";

export const REGION_LAUNCH_VERSION="region-launch-v3";
export const REGION_LAUNCH_SIGNAL_MS=120_000;
export const REGION_LAUNCH_MINUTE_MS=60_000;

export type RegionLaunchPhase="WATCH"|"ARMED"|"IGNITION"|"READY"|"CONSUMED";
export type RegionLaunchCompression={
  id:string;startAt:number;endAt:number;bars:number;lower:number;upper:number;center:number;width:number;widthRate:number;
  crossings:number;overlapPairs:number;coreLower?:number;coreUpper?:number;averageRange?:number;averageBody?:number;
};
export type RegionLaunchState={
  version:typeof REGION_LAUNCH_VERSION;symbol:string;phase:RegionLaunchPhase;createdAt:number;updatedAt:number;lastProcessedAt:number;
  motherRegionId:string;motherConfirmedAt:number;motherLower:number;motherUpper:number;motherCenter:number;motherWidth:number;
  motherWidthRate:number;motherBars:number;motherTouchesUpper:number;motherTouchesLower:number;motherCrossings:number;
  failedDepartures:number;departureSide:"LONG"|"SHORT"|null;departureAt:number|null;lastReentryAt:number|null;
  compression:RegionLaunchCompression|null;quality:number;armedAt:number|null;armedInsideObserved:boolean;cooldownUntil:number;
  ignitionSide:"LONG"|"SHORT"|null;ignitionAt:number|null;triggerPrice:number|null;
  breakoutOpen:number|null;breakoutHigh:number|null;breakoutLow:number|null;breakoutClose:number|null;
  breakoutImpulseRate:number|null;breakoutWickRate:number|null;pullbackExtreme:number|null;lastMinuteAt:number|null;
  readyAt:number|null;readySide:"LONG"|"SHORT"|null;readySignalPrice:number|null;readyStopPrice:number|null;
  readyImpulseRate:number|null;readyExpectedMoveRate:number|null;readyMaxChaseRate:number|null;readyConfirmationMs:number|null;
  readyConfirmation?:"CONTINUATION"|"PULLBACK_RESTART";
  consumedAt:number|null;consumedSide:"LONG"|"SHORT"|null;reason:string;
  launchPath?:"FAST"|"CLOSED";departureAfter?:number;currentFiveMinute?:RegionCandle;fiveMinuteBodyMultiple?:number;
};
export type RegionLaunchSignal=RegionEntrySignal&{
  entryModel:"REGION_LAUNCH";launchVersion:typeof REGION_LAUNCH_VERSION;
  launchTriggerPrice:number;launchCompressionLower:number;launchCompressionUpper:number;launchCompressionBars:number;
  launchFailedDepartures:number;launchImpulseRate:number;launchConfirmationMs:number;launchExpectedMoveRate:number;
  launchMaxChaseRate:number;
};
type Quote={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const finite=(v:number)=>Number.isFinite(v);
const completeAt=(row:RegionCandle)=>row.time*1000+REGION_BAR_MS;
const quantile=(values:number[],p:number)=>{
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  return a.length?a[Math.max(0,Math.min(a.length-1,Math.floor((a.length-1)*p)))]!:0;
};
const crossings=(closes:number[],center:number)=>{
  let count=0,prior=0;
  for(const close of closes){
    const side=close>center?1:close<center?-1:0;
    if(side&&prior&&side!==prior)count++;
    if(side)prior=side;
  }
  return count;
};
const overlap=(a:{low:number;high:number},b:{low:number;high:number})=>Math.max(0,Math.min(a.high,b.high)-Math.max(a.low,b.low))
  /Math.max(1e-12,Math.min(a.high-a.low,b.high-b.low));

export function regionLaunchValidationProofRate(modeledCostRate:number){
  const cost=finite(modeledCostRate)?Math.max(0,modeledCostRate):0;
  // A valid burst should become meaningfully profitable quickly. Validation
  // below round-trip modeled cost merely proves motion, not a usable entry.
  return Math.max(.0025,Math.min(.0060,cost*1.25));
}

function compressionFrom(rows:RegionCandle[],mother:Pick<RegionLaunchState,
  "motherLower"|"motherUpper"|"motherCenter"|"motherWidth"|"motherWidthRate"|"motherBars"|"motherConfirmedAt">,
  costRate:number):RegionLaunchCompression|null{
  const completed=rows.filter(r=>[r.time,r.open,r.high,r.low,r.close,r.volume].every(finite)&&r.open>0&&r.close>0
    &&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)&&r.low>0&&r.volume>=0)
    .sort((a,b)=>a.time-b.time);
  if(!completed.length||mother.motherBars<12)return null;

  // Detection may use a robust statistical core, but execution must use every
  // wick belonging to the actual mature region. This is the trading box.
  const firstComplete=mother.motherConfirmedAt-(mother.motherBars-1)*REGION_BAR_MS;
  const historical=completed.filter(r=>completeAt(r)>=firstComplete&&completeAt(r)<=mother.motherConfirmedAt);
  // Normal production paths contain the full mother history. Compact fixtures or
  // a newly restored cache may not; in that case keep the lifecycle bounds as a
  // conservative fallback until the missing historical bars arrive rather than
  // inventing a smaller child box.
  const base=historical.length>=Math.min(12,mother.motherBars)?historical:[];
  const envelope=[...base];
  let lower=base.length?Math.min(mother.motherLower,...base.map(r=>r.low)):mother.motherLower;
  let upper=base.length?Math.max(mother.motherUpper,...base.map(r=>r.high)):mother.motherUpper;
  // After confirmation, a candle that CLOSES inside remains part of the same
  // winding region and its wick expands the boundary. The first outside close
  // freezes the box; it is never swallowed into a rolling child box.
  for(const row of completed.filter(r=>completeAt(r)>mother.motherConfirmedAt)){
    if(row.close<lower||row.close>upper)break;
    envelope.push(row);
    lower=Math.min(lower,row.low);upper=Math.max(upper,row.high);
    if(envelope.length>=Math.max(12,mother.motherBars)+12)break;
  }
  if(!(upper>lower&&lower>0))return null;
  const closes=envelope.length?envelope.map(r=>r.close):[mother.motherCenter];
  const center=quantile(closes,.50),width=upper-lower,widthRate=width/Math.max(center,1e-12);
  if(widthRate<Math.max(.0015,costRate*1.50)||widthRate>.25)return null;
  const cross=crossings(closes,center);
  let overlaps=0;for(let i=1;i<envelope.length;i++)if(overlap(envelope[i-1]!,envelope[i]!)>=.15)overlaps++;
  const reference=(envelope.length?envelope:completed.filter(r=>completeAt(r)>mother.motherConfirmedAt).slice(0,20)).slice(-20);
  if(!reference.length)return null;
  const startRow=envelope[0]??reference[0]!,endRow=envelope.at(-1)??reference[0]!;
  return{id:`rc-${startRow.time}-${endRow.time}-${lower.toPrecision(8)}-${upper.toPrecision(8)}`,
    startAt:completeAt(startRow),endAt:Math.max(mother.motherConfirmedAt,completeAt(endRow)),bars:Math.max(mother.motherBars,envelope.length),
    lower,upper,center,width,widthRate,coreLower:mother.motherLower,coreUpper:mother.motherUpper,
    averageRange:reference.reduce((n,r)=>n+r.high-r.low,0)/reference.length,
    averageBody:reference.reduce((n,r)=>n+Math.abs(r.close-r.open),0)/reference.length,
    crossings:cross,overlapPairs:overlaps};
}

function relatedMother(s:RegionLaunchState,zone:RegionZone){
  if(zone.id===s.motherRegionId)return true;
  const overlapWidth=Math.max(0,Math.min(s.motherUpper,zone.upper)-Math.max(s.motherLower,zone.lower));
  const overlapRatio=overlapWidth/Math.max(1e-12,Math.min(s.motherWidth,zone.width));
  const centerDistance=Math.abs(zone.center-s.motherCenter)/Math.max(s.motherWidth,1e-12);
  const childLike=zone.width<=s.motherWidth*.90&&zone.center>=s.motherLower-s.motherWidth*.30&&zone.center<=s.motherUpper+s.motherWidth*.30;
  return childLike||overlapRatio>=.25&&centerDistance<=1.10;
}

function initial(symbol:string,zone:RegionZone,now:number):RegionLaunchState{
  return{version:REGION_LAUNCH_VERSION,symbol,phase:"WATCH",createdAt:now,updatedAt:now,lastProcessedAt:zone.confirmedAt,
    motherRegionId:zone.id,motherConfirmedAt:zone.confirmedAt,motherLower:zone.lower,motherUpper:zone.upper,motherCenter:zone.center,
    motherWidth:zone.width,motherWidthRate:zone.widthRate,motherBars:zone.bars,motherTouchesUpper:zone.touchesUpper,
    motherTouchesLower:zone.touchesLower,motherCrossings:zone.crossings,failedDepartures:0,departureSide:null,departureAt:null,lastReentryAt:null,
    compression:null,quality:.5,armedAt:null,armedInsideObserved:false,cooldownUntil:0,ignitionSide:null,ignitionAt:null,triggerPrice:null,
    breakoutOpen:null,breakoutHigh:null,breakoutLow:null,breakoutClose:null,breakoutImpulseRate:null,breakoutWickRate:null,
    pullbackExtreme:null,lastMinuteAt:null,readyAt:null,readySide:null,readySignalPrice:null,
    readyStopPrice:null,readyImpulseRate:null,readyExpectedMoveRate:null,readyMaxChaseRate:null,readyConfirmationMs:null,
    consumedAt:null,consumedSide:null,reason:"成熟母区域已进入长期观察；普通离区失败不会消费区域。"};
}
function clearIgnition(s:RegionLaunchState){
  s.ignitionSide=null;s.ignitionAt=null;s.triggerPrice=null;s.breakoutOpen=null;s.breakoutHigh=null;s.breakoutLow=null;
  s.breakoutClose=null;s.breakoutImpulseRate=null;s.breakoutWickRate=null;s.pullbackExtreme=null;s.lastMinuteAt=null;
  s.launchPath=undefined;s.currentFiveMinute=undefined;s.fiveMinuteBodyMultiple=undefined;
}
function clearReady(s:RegionLaunchState){
  s.readyAt=null;s.readySide=null;s.readySignalPrice=null;s.readyStopPrice=null;s.readyImpulseRate=null;
  s.readyExpectedMoveRate=null;s.readyMaxChaseRate=null;s.readyConfirmationMs=null;s.readyConfirmation=undefined;
}
function motherQuality(s:RegionLaunchState,compression:RegionLaunchCompression|null){
  const age=clip((s.motherBars-12)/36),touch=clip((s.motherTouchesUpper+s.motherTouchesLower-4)/10),
    cross=clip((s.motherCrossings-3)/6),fails=clip(s.failedDepartures/3),
    continuity=compression?clip((compression.bars-s.motherBars)/12):0;
  return clip(.48+age*.14+touch*.12+cross*.12+fails*.08+(compression?.bars ? .06 : 0)+continuity*.05,.35,.95);
}

function processDepartures(s:RegionLaunchState,rows:RegionCandle[]){
  const buffer=s.motherWidth*.05;
  for(const row of rows.filter(r=>completeAt(r)>s.lastProcessedAt).sort((a,b)=>a.time-b.time)){
    const at=completeAt(row),close=row.close;
    if(!s.departureSide){
      if(close>s.motherUpper+buffer){s.departureSide="LONG";s.departureAt=at;}
      else if(close<s.motherLower-buffer){s.departureSide="SHORT";s.departureAt=at;}
    }else if(s.departureSide==="LONG"&&close<=s.motherUpper){
      s.failedDepartures++;s.lastReentryAt=at;s.departureSide=null;s.departureAt=null;
    }else if(s.departureSide==="SHORT"&&close>=s.motherLower){
      s.failedDepartures++;s.lastReentryAt=at;s.departureSide=null;s.departureAt=null;
    }
    if(s.phase==="CONSUMED"&&s.consumedSide==="LONG"&&close<=s.motherCenter){
      s.phase="WATCH";s.consumedAt=null;s.consumedSide=null;s.reason="成功发射后价格已重新回到母区域中心；母区域重新获得一次观察资格。";
    }else if(s.phase==="CONSUMED"&&s.consumedSide==="SHORT"&&close>=s.motherCenter){
      s.phase="WATCH";s.consumedAt=null;s.consumedSide=null;s.reason="成功发射后价格已重新回到母区域中心；母区域重新获得一次观察资格。";
    }
    s.lastProcessedAt=at;
  }
}

export function advanceRegionLaunchUniverse(input:{paths:Record<string,RegionCandle[]>;lifecycles:Record<string,RegionLifecycleState>;
  frames?:MultiTurnState["frames"];prior?:Record<string,RegionLaunchState>;now:number;costRate:number}){
  const states:Record<string,RegionLaunchState>={...(input.prior??{})};
  for(const [symbol,lifecycle] of Object.entries(input.lifecycles)){
    const zone=lifecycle.zone,rows=(input.paths[symbol]??[]).filter(r=>completeAt(r)<=input.now);
    if(!zone||!rows.length)continue;
    let state=states[symbol];
    if(!state||!relatedMother(state,zone))state=initial(symbol,zone,input.now);
    else if(state.version!==REGION_LAUNCH_VERSION){
      // Preserve mother/consumption memory and old positions; never execute an
      // old READY built from percentile-only bounds under the new authority.
      state={...state,version:REGION_LAUNCH_VERSION,phase:state.phase==="CONSUMED"?"CONSUMED":"WATCH",compression:null};
      clearIgnition(state);clearReady(state);
    }
    processDepartures(state,rows);
    if(state.phase!=="CONSUMED"&&state.phase!=="READY"&&state.phase!=="IGNITION"){
      const wasArmed=state.phase==="ARMED"&&!!state.compression;
      const observedCompression=compressionFrom(rows,state,input.costRate);
      // The launch box is the full mature winding region, including every wick.
      // While closes remain inside, new rejection wicks may only EXPAND that
      // same box and its identity stays stable. The first outside close freezes
      // the pre-departure box so the breakout can never enlarge its own boundary.
      let compression=observedCompression;
      if(wasArmed){
        const old=state.compression!,latest=rows.at(-1)!;
        if(latest.close<old.lower||latest.close>old.upper){
          compression=input.now<=old.endAt+4*REGION_BAR_MS?old:null;
        }else if(observedCompression){
          const lower=Math.min(old.lower,observedCompression.lower),upper=Math.max(old.upper,observedCompression.upper);
          compression={...observedCompression,id:old.id,startAt:old.startAt,endAt:Math.max(old.endAt,observedCompression.endAt),
            lower,upper,width:upper-lower,widthRate:(upper-lower)/Math.max(observedCompression.center,1e-12)};
        }else if(input.now<=old.endAt+4*REGION_BAR_MS)compression=old;
      }
      state.compression=compression;state.quality=motherQuality(state,compression);
      if(compression){
        state.phase="ARMED";
        if(!wasArmed){state.armedAt=input.now;state.armedInsideObserved=false;clearIgnition(state);clearReady(state);}
        state.reason=`最近成熟5分钟缠绕区域已完整纳入${compression.bars}根K线及全部影线边界，进入ARMED并提前争取实时盘口槽。失败离区累计${state.failedDepartures}次。`;
      }else{
        state.phase="WATCH";state.armedAt=null;state.armedInsideObserved=false;clearIgnition(state);clearReady(state);
        state.reason=`成熟区域继续观察；此前失败离区${state.failedDepartures}次不会消费区域，等待形成可完整追踪的最新缠绕边界。`;
      }
    }
    state.updatedAt=input.now;states[symbol]=state;
  }
  for(const [symbol,state] of Object.entries(states)){
    if(input.lifecycles[symbol]?.zone||state.phase==="CONSUMED")continue;
    if(input.now-state.updatedAt>24*60*60_000)delete states[symbol];
  }
  return{states};
}

function readySignal(s:RegionLaunchState):RegionLaunchSignal|null{
  if(s.phase!=="READY"||s.readyAt==null||!s.readySide||s.readySignalPrice==null||s.readyStopPrice==null
    ||s.readyImpulseRate==null||s.readyExpectedMoveRate==null||s.readyMaxChaseRate==null||s.readyConfirmationMs==null||!s.compression)return null;
  const side=s.readySide,boundary=side==="LONG"?"UPPER":"LOWER";
  return{version:REGION_LIFECYCLE_VERSION,id:`rl-${s.motherRegionId}-${side}-${s.readyAt}`,symbol:s.symbol,kind:"MIGRATION",side,boundary,
    completedAt:s.readyAt,expiresAt:s.readyAt+REGION_LAUNCH_SIGNAL_MS,signalPrice:s.readySignalPrice,stopPrice:s.readyStopPrice,targetPrice:null,
    regionId:s.motherRegionId,regionConfirmedAt:s.motherConfirmedAt,regionLower:s.motherLower,regionUpper:s.motherUpper,
    regionCenter:s.motherCenter,regionWidth:s.motherWidth,regionWidthRate:s.motherWidthRate,
    reason:`RegionLaunch：完整5分钟缠绕边界${s.compression.lower.toPrecision(8)}–${s.compression.upper.toPrecision(8)}（含影线）；${s.launchPath==="CLOSED"
      ?s.readyConfirmation==="CONTINUATION"?"5分钟区间外收盘后第一根完整1分钟K继续突破":"5分钟区间外收盘后小回调再突破"
      :"5分钟强势离区后1分钟连续突破或小回调重启"}。5分钟实体/前期平均振幅${(s.fiveMinuteBodyMultiple??0).toFixed(2)}倍。`,
    entryModel:"REGION_LAUNCH",launchVersion:REGION_LAUNCH_VERSION,launchTriggerPrice:s.triggerPrice!,
    launchCompressionLower:s.compression.lower,launchCompressionUpper:s.compression.upper,launchCompressionBars:s.compression.bars,
    launchFailedDepartures:s.failedDepartures,launchImpulseRate:s.readyImpulseRate,launchConfirmationMs:s.readyConfirmationMs,
    launchExpectedMoveRate:s.readyExpectedMoveRate,launchMaxChaseRate:s.readyMaxChaseRate};
}


const minuteCompleteAt=(row:RegionCandle)=>row.time*1000+REGION_LAUNCH_MINUTE_MS;
function launchTriggers(s:RegionLaunchState,costRate:number){
  // The live compression owns both launch boundaries. A top compression can
  // break down before the much wider mother region or higher trend turns down.
  const c=s.compression!,triggerBuffer=Math.max(c.width*.02,c.center*costRate*.20);
  return{long:c.upper+triggerBuffer,short:c.lower-triggerBuffer};
}

export function advanceRegionLaunchMinutes(input:{states:Record<string,RegionLaunchState>;minutePaths:Record<string,RegionCandle[]>;
  fiveMinutePaths?:Record<string,RegionCandle[]>;quotes?:Record<string,Quote>;frames?:MultiTurnState["frames"];now:number;costRate:number}){
  const states:Record<string,RegionLaunchState>={...input.states};
  for(const [symbol,source] of Object.entries(states)){
    const s=structuredClone(source);
    if(s.version!==REGION_LAUNCH_VERSION||(s.phase!=="ARMED"&&s.phase!=="IGNITION"&&s.phase!=="READY")||!s.compression||input.now<s.cooldownUntil){states[symbol]=s;continue;}
    if(s.phase!=="READY"&&input.now>s.compression.endAt+4*REGION_BAR_MS){
      s.phase="WATCH";s.compression=null;s.launchPath=undefined;clearIgnition(s);clearReady(s);
      s.reason="原5分钟离区观察已过期；母区域保留，重新识别当前缠绕，不追旧突破。";states[symbol]=s;continue;
    }
    const rows=(input.minutePaths[symbol]??[]).filter(row=>[row.time,row.open,row.high,row.low,row.close,row.volume].every(finite)
      &&row.high>=row.low&&row.low>0&&minuteCompleteAt(row)<=input.now).sort((a,b)=>a.time-b.time);
    if(!rows.length){
      if(s.phase==="READY"){s.phase="IGNITION";clearReady(s);s.reason="重新取得当前1分钟路径后核对5分钟离区；旧READY不绕过当前结构确认。";}
      states[symbol]=s;continue;
    }
    const {long:longTrigger,short:shortTrigger}=launchTriggers(s,input.costRate);
    const quote=input.quotes?.[symbol],livePrice=quote?.fresh&&quote.bestBid>0&&quote.bestAsk>=quote.bestBid
      &&quote.observedAt<=input.now+1000&&input.now-quote.observedAt<=5000?(quote.bestBid+quote.bestAsk)/2:undefined;
    const five=launchFiveMinuteEvidence({box:s.compression,minutes:rows,fiveMinutes:input.fiveMinutePaths?.[symbol],
      now:input.now,costRate:input.costRate,after:s.departureAfter,livePrice,previousCurrent:s.currentFiveMinute,
      activeSide:s.ignitionSide??undefined,activeAt:s.ignitionAt??undefined,fastQualifiedAt:s.launchPath==="FAST"?s.ignitionAt??undefined:undefined,
      initialFastBody:s.breakoutClose!=null&&s.breakoutOpen!=null?Math.abs(s.breakoutClose-s.breakoutOpen):undefined});
    s.currentFiveMinute=five.current;
    const cancel=(reason:string)=>{s.failedDepartures++;s.phase="ARMED";s.departureAfter=Math.floor(input.now/REGION_BAR_MS)*REGION_BAR_MS+REGION_BAR_MS;
      s.launchPath=undefined;clearIgnition(s);clearReady(s);s.reason=reason;};
    if(five.state==="FAIL"){cancel(five.reason);states[symbol]=s;continue;}
    if(five.state==="WAIT"){
      // FAST authority exists only while the unfinished 5m candle itself still
      // satisfies the several-times-average full-box departure. If that body
      // shrinks, discard the old 1m ignition immediately. A later entry must
      // either regain FAST strength or wait for a valid outside 5m close.
      if(s.launchPath==="FAST"){
        s.phase="ARMED";clearIgnition(s);clearReady(s);
        s.reason="未收盘5分钟K已失去异常强离区强度；此前1分钟点火资格立即失效，等待重新变强或5分钟有效收盘。";
        states[symbol]=s;continue;
      }
      if(s.phase==="READY"){s.phase="IGNITION";clearReady(s);}
      s.reason=five.reason;states[symbol]=s;continue;
    }
    if(s.launchPath==="FAST"&&five.state==="CLOSED"){
      // The candle once qualified as an unfinished FAST move but finished below
      // the FAST threshold. Do not grandfather the early 1m signal: restart from
      // the actual closed 5m bar and require fresh post-close 1m confirmation.
      s.phase="ARMED";clearIgnition(s);clearReady(s);
    }
    if(s.ignitionSide&&s.ignitionSide!==five.side){cancel("5分钟离区方向已改变；取消原方向追击，等待新的完整结构。");states[symbol]=s;continue;}
    s.fiveMinuteBodyMultiple=five.bodyMultiple;
    if(s.phase==="READY"){states[symbol]=s;continue;}
    if(s.launchPath==="CLOSED"&&five.state==="FAST"){
      s.phase="ARMED";clearIgnition(s);clearReady(s);s.launchPath="FAST";
    }
    let slow:ReturnType<typeof evaluateSlowLaunchRestart>|null=null;
    if(five.state==="CLOSED"&&s.launchPath!=="FAST"){
      const b=five.bar!,side=five.side!;
      s.launchPath="CLOSED";s.phase="IGNITION";s.ignitionSide=side;s.ignitionAt=completeAt(b);
      s.triggerPrice=side==="LONG"?longTrigger:shortTrigger;
      s.breakoutOpen=b.open;s.breakoutHigh=b.high;s.breakoutLow=b.low;s.breakoutClose=b.close;
      slow=evaluateSlowLaunchRestart({bar:b,following:rows.filter(r=>r.time>=b.time+300),side,
        boundary:s.triggerPrice,costRate:input.costRate});
    }

    if(s.phase==="ARMED"){
      const fresh=rows.filter(row=>row.time>=five.bar!.time&&minuteCompleteAt(row)>Math.max(s.armedAt??0,s.lastMinuteAt??0,s.departureAfter??0));
      for(const row of fresh){
        const at=minuteCompleteAt(row);s.lastMinuteAt=at;
        // Late one-minute history can restore observation state, but can never
        // create a retroactive chase after the move has already happened.
        if(input.now-at>75_000){s.reason="RegionLaunch收到迟到的1分钟K，仅补齐观察，不历史补追。";continue;}
        const side=row.close>=longTrigger?"LONG":row.close<=shortTrigger?"SHORT":null;
        if(!side||side!==five.side)continue;
        const trigger=side==="LONG"?longTrigger:shortTrigger;
        const quality=assessStrongBreakout({bar:row,side,triggerPrice:trigger,costRate:input.costRate,regionWidthRate:s.motherWidthRate});
        if(!quality.ok){s.reason=`RegionLaunch继续观察：${quality.reason}`;continue;}
        s.phase="IGNITION";s.ignitionSide=side;s.ignitionAt=at;s.triggerPrice=trigger;
        s.launchPath="FAST";
        s.breakoutOpen=row.open;s.breakoutHigh=row.high;s.breakoutLow=row.low;s.breakoutClose=row.close;
        s.breakoutImpulseRate=quality.impulseRate;s.breakoutWickRate=quality.adverseWickRate;
        s.pullbackExtreme=side==="LONG"?row.low:row.high;
        s.reason="RegionLaunch IGNITION：强势1分钟突破K成立；等待下一根继续强突破，或小回调后的第一根重新顺向1分钟K。";
        break;
      }
    }

    if(s.phase==="IGNITION"&&s.ignitionSide&&s.triggerPrice!=null&&s.ignitionAt!=null
      &&s.breakoutOpen!=null&&s.breakoutHigh!=null&&s.breakoutLow!=null&&s.breakoutClose!=null){
      const ignitionAt=s.ignitionAt,ignitionSide=s.ignitionSide,triggerPrice=s.triggerPrice;
      const breakout:RegionCandle={time:Math.floor((ignitionAt-REGION_LAUNCH_MINUTE_MS)/1000),
        open:s.breakoutOpen,high:s.breakoutHigh,low:s.breakoutLow,close:s.breakoutClose,volume:1};
      const following=rows.filter(row=>minuteCompleteAt(row)>ignitionAt);
      const evaluated=slow??evaluateMicroRestart({breakout,following,side:ignitionSide,triggerPrice,
        costRate:input.costRate,regionWidthRate:s.motherWidthRate});
      s.pullbackExtreme=evaluated.supportPrice??s.pullbackExtreme;
      s.lastMinuteAt=Math.max(s.lastMinuteAt??0,...following.map(minuteCompleteAt),ignitionAt);
      if(evaluated.state==="FAIL"){
        cancel(`RegionLaunch本次启动失败：${evaluated.reason} 成熟母区域继续保留观察。`);
      }else if(evaluated.state==="WAIT"){
        s.reason=`RegionLaunch继续观察：${evaluated.reason}`;
      }else if(evaluated.restartAt!=null&&evaluated.restartPrice!=null){
        const side=ignitionSide,d=side==="LONG"?1:-1,trigger=triggerPrice;
        const impulse=d*(evaluated.restartPrice/trigger-1);
        const maxChase=Math.max(.006,Math.min(.015,Math.max(s.motherWidthRate*.45,input.costRate*3)));
        if(input.now-evaluated.restartAt>75_000){
          s.phase="WATCH";s.cooldownUntil=input.now+REGION_BAR_MS;clearIgnition(s);clearReady(s);
          s.reason="RegionLaunch重新启动1分钟K到达过晚；只记录结构，不历史补追。";
        }else if(impulse>maxChase){
          s.phase="WATCH";s.cooldownUntil=evaluated.restartAt+REGION_BAR_MS;clearIgnition(s);clearReady(s);
          s.reason="RegionLaunch重新启动成立，但确认时已经离完整缠绕边界过远；不补追，等待新的区域或更好位置。";
        }else{
          const support=evaluated.supportPrice!,microBuffer=Math.max(trigger*.0015,s.compression.width*.08,input.costRate*trigger*.30);
          // Never truncate the actual pullback structure to make a trade fit.
          // Entry sizing/remaining-space policy evaluates this full stop.
          const stop=side==="LONG"?support-microBuffer:support+microBuffer;
          const f15=input.frames?.[symbol]?.["15m"];
          const expected=Math.min(.20,Math.max(.015,s.motherWidthRate*1.50,impulse*3,f15?.expectedMoveRate??0));
          s.phase="READY";s.readyAt=evaluated.restartAt;s.readySide=side;s.readySignalPrice=evaluated.restartPrice;s.readyStopPrice=stop;
          s.readyImpulseRate=impulse;s.readyExpectedMoveRate=expected;s.readyMaxChaseRate=maxChase;s.readyConfirmationMs=evaluated.restartAt-ignitionAt;
          s.readyConfirmation=evaluated.confirmation;
          s.reason=`RegionLaunch READY：${evaluated.reason} 等待当前可执行盘口成交。`;
        }
      }
    }
    s.updatedAt=input.now;states[symbol]=s;
  }
  return{states};
}

export function advanceRegionLaunchQuotes(input:{states:Record<string,RegionLaunchState>;quotes:Record<string,Quote>;
  frames?:MultiTurnState["frames"];now:number;costRate:number}){
  const states:Record<string,RegionLaunchState>={...input.states},signals:RegionLaunchSignal[]=[];
  for(const [symbol,source] of Object.entries(states)){
    const s=structuredClone(source),q=input.quotes[symbol];
    if(s.version!==REGION_LAUNCH_VERSION||s.phase!=="READY"){states[symbol]=s;continue;}
    const signal=readySignal(s);
    if(!signal||input.now>signal.expiresAt){s.phase=s.compression?"ARMED":"WATCH";s.cooldownUntil=input.now+REGION_BAR_MS;clearReady(s);clearIgnition(s);states[symbol]=s;continue;}
    if(!q?.fresh||q.bestBid<=0||q.bestAsk<q.bestBid||q.observedAt>input.now+1000||input.now-q.observedAt>5000){states[symbol]=s;continue;}
    const mid=(q.bestBid+q.bestAsk)/2,d=signal.side==="LONG"?1:-1,progress=d*(mid/signal.launchTriggerPrice-1);
    if(progress<=0){s.failedDepartures++;s.phase="ARMED";s.cooldownUntil=0;clearReady(s);clearIgnition(s);
      s.reason="RegionLaunch 1分钟重新顺向确认后，实时盘口又跌回发射边界；取消本次追击但继续保留母区域。";}
    else if(progress>signal.launchMaxChaseRate){s.phase="WATCH";s.cooldownUntil=input.now+REGION_BAR_MS;clearReady(s);clearIgnition(s);
      s.reason="RegionLaunch确认后当前盘口已经超过允许追价距离；不补追，等待新的完整区域机会。";}
    else signals.push(signal);
    s.updatedAt=input.now;states[symbol]=s;
  }
  return{states,signals};
}

export function consumeRegionLaunch(state:RegionLaunchState,side:"LONG"|"SHORT",at:number){
  const s=structuredClone(state);s.phase="CONSUMED";s.consumedAt=at;s.consumedSide=side;s.reason="RegionLaunch READY已通过盘口与账户风险检查并完成模拟开仓；成功发射期间不重复追单。";
  clearIgnition(s);clearReady(s);return s;
}
