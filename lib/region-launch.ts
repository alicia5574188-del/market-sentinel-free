import { REGION_BAR_MS, REGION_LIFECYCLE_VERSION, type RegionCandle, type RegionEntrySignal, type RegionLifecycleState, type RegionZone } from "./region-lifecycle.ts";
import type { MultiTurnState } from "./multi-turn-engine.ts";
import { assessStrongBreakout, microDirectionalBar, evaluateMicroRestart } from "./micro-restart.ts";
import {launchFiveMinuteEvidence,evaluateSlowLaunchRestart} from "./launch-five-minute.ts";
import {detectRegionOpportunityStructure,findRegionRetestSetup,findRegionRotationSetup,regionOpportunityExpectedMove,regionOpportunityMaxChase,
  type RegionBarrier,type RegionOpportunitySide} from "./region-opportunity.ts";

export const REGION_LAUNCH_VERSION="region-launch-v4";
export const REGION_LAUNCH_SIGNAL_MS=120_000;
export const REGION_LAUNCH_MINUTE_MS=60_000;

export type RegionEntryMode="ROTATION"|"RELEASE"|"RETEST";
export type RegionLaunchPhase="WATCH"|"ARMED"|"IGNITION"|"RETEST"|"READY"|"CONSUMED";
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
  readyMode:RegionEntryMode|null;readyEffectiveTrigger:number|null;readyBarrierPrice:number|null;readyNextBarrierPrice:number|null;
  readyTargetPrice:number|null;readyAttempt:number;
  longBarrier:RegionBarrier|null;shortBarrier:RegionBarrier|null;nextLongBarrier:RegionBarrier|null;nextShortBarrier:RegionBarrier|null;
  effectiveLongTrigger:number;effectiveShortTrigger:number;averageRange:number;
  releaseSide:"LONG"|"SHORT"|null;releaseAt:number|null;releaseTrigger:number|null;releaseExtreme:number|null;
  releaseAttemptsLong:number;releaseAttemptsShort:number;
  rotationLongConsumedAt:number|null;rotationShortConsumedAt:number|null;
  consumedAt:number|null;consumedSide:"LONG"|"SHORT"|null;reason:string;
  launchPath?:"EARLY"|"FAST"|"CLOSED";departureAfter?:number;currentFiveMinute?:RegionCandle;fiveMinuteBodyMultiple?:number;
};
export type RegionLaunchSignal=RegionEntrySignal&{
  entryModel:"REGION_LAUNCH";entryMode:RegionEntryMode;launchVersion:typeof REGION_LAUNCH_VERSION;
  launchTriggerPrice:number;launchEffectiveTrigger:number;launchBarrierPrice:number|null;launchNextBarrierPrice:number|null;
  launchCompressionLower:number;launchCompressionUpper:number;launchCompressionBars:number;
  launchFailedDepartures:number;launchImpulseRate:number;launchConfirmationMs:number;launchExpectedMoveRate:number;
  launchMaxChaseRate:number;launchAttempt:number;
};
type Quote={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const finite=(v:number)=>Number.isFinite(v);
const completeAt=(row:RegionCandle)=>row.time*1000+REGION_BAR_MS;
const minuteCompleteAt=(row:RegionCandle)=>row.time*1000+REGION_LAUNCH_MINUTE_MS;
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
  return Math.round(Math.max(.0025,Math.min(.0060,cost*1.25))*1e8)/1e8;
}

function compressionFrom(rows:RegionCandle[],mother:Pick<RegionLaunchState,
  "motherLower"|"motherUpper"|"motherCenter"|"motherWidth"|"motherWidthRate"|"motherBars"|"motherConfirmedAt">,
  costRate:number):RegionLaunchCompression|null{
  const completed=rows.filter(r=>[r.time,r.open,r.high,r.low,r.close,r.volume].every(finite)&&r.open>0&&r.close>0
    &&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)&&r.low>0&&r.volume>=0).sort((a,b)=>a.time-b.time);
  if(!completed.length||mother.motherBars<12)return null;
  const firstComplete=mother.motherConfirmedAt-(mother.motherBars-1)*REGION_BAR_MS;
  const historical=completed.filter(r=>completeAt(r)>=firstComplete&&completeAt(r)<=mother.motherConfirmedAt);
  const base=historical.length>=Math.min(12,mother.motherBars)?historical:[];
  const envelope=[...base],lower=mother.motherLower,upper=mother.motherUpper;
  for(const row of completed.filter(r=>completeAt(r)>mother.motherConfirmedAt)){
    if(row.close<lower||row.close>upper)break;
    envelope.push(row);
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

function initial(symbol:string,zone:RegionZone,rows:RegionCandle[],now:number,costRate:number):RegionLaunchState{
  const structure=detectRegionOpportunityStructure({rows,lower:zone.lower,upper:zone.upper,center:zone.center,width:zone.width,
    confirmedAt:zone.confirmedAt,now,costRate});
  return{version:REGION_LAUNCH_VERSION,symbol,phase:"WATCH",createdAt:now,updatedAt:now,lastProcessedAt:zone.confirmedAt,
    motherRegionId:zone.id,motherConfirmedAt:zone.confirmedAt,motherLower:zone.lower,motherUpper:zone.upper,motherCenter:zone.center,
    motherWidth:zone.width,motherWidthRate:zone.widthRate,motherBars:zone.bars,motherTouchesUpper:zone.touchesUpper,
    motherTouchesLower:zone.touchesLower,motherCrossings:zone.crossings,failedDepartures:0,departureSide:null,departureAt:null,lastReentryAt:null,
    compression:null,quality:.5,armedAt:null,armedInsideObserved:false,cooldownUntil:0,ignitionSide:null,ignitionAt:null,triggerPrice:null,
    breakoutOpen:null,breakoutHigh:null,breakoutLow:null,breakoutClose:null,breakoutImpulseRate:null,breakoutWickRate:null,
    pullbackExtreme:null,lastMinuteAt:null,readyAt:null,readySide:null,readySignalPrice:null,readyStopPrice:null,readyImpulseRate:null,
    readyExpectedMoveRate:null,readyMaxChaseRate:null,readyConfirmationMs:null,readyMode:null,readyEffectiveTrigger:null,readyBarrierPrice:null,
    readyNextBarrierPrice:null,readyTargetPrice:null,readyAttempt:1,longBarrier:structure.longBarrier,shortBarrier:structure.shortBarrier,
    nextLongBarrier:structure.nextLongBarrier,nextShortBarrier:structure.nextShortBarrier,effectiveLongTrigger:structure.longTrigger,
    effectiveShortTrigger:structure.shortTrigger,averageRange:structure.averageRange,releaseSide:null,releaseAt:null,releaseTrigger:null,
    releaseExtreme:null,releaseAttemptsLong:0,releaseAttemptsShort:0,rotationLongConsumedAt:null,rotationShortConsumedAt:null,
    consumedAt:null,consumedSide:null,reason:"成熟缠绕区域进入机会生命周期：区域轮转、有效释放和突破回踩都可参与。"};
}
function clearIgnition(s:RegionLaunchState){
  s.ignitionSide=null;s.ignitionAt=null;s.triggerPrice=null;s.breakoutOpen=null;s.breakoutHigh=null;s.breakoutLow=null;
  s.breakoutClose=null;s.breakoutImpulseRate=null;s.breakoutWickRate=null;s.pullbackExtreme=null;s.lastMinuteAt=null;
  s.launchPath=undefined;s.currentFiveMinute=undefined;s.fiveMinuteBodyMultiple=undefined;
}
function clearReady(s:RegionLaunchState){
  s.readyAt=null;s.readySide=null;s.readySignalPrice=null;s.readyStopPrice=null;s.readyImpulseRate=null;
  s.readyExpectedMoveRate=null;s.readyMaxChaseRate=null;s.readyConfirmationMs=null;s.readyConfirmation=undefined;
  s.readyMode=null;s.readyEffectiveTrigger=null;s.readyBarrierPrice=null;s.readyNextBarrierPrice=null;s.readyTargetPrice=null;s.readyAttempt=1;
}
function clearRelease(s:RegionLaunchState){
  s.releaseSide=null;s.releaseAt=null;s.releaseTrigger=null;s.releaseExtreme=null;s.launchPath=undefined;
}
function sideAttempts(s:RegionLaunchState,side:RegionOpportunitySide){return side==="LONG"?s.releaseAttemptsLong:s.releaseAttemptsShort;}
function incrementAttempt(s:RegionLaunchState,side:RegionOpportunitySide){
  if(side==="LONG")s.releaseAttemptsLong++;else s.releaseAttemptsShort++;
}
function motherQuality(s:RegionLaunchState,compression:RegionLaunchCompression|null){
  const age=clip((s.motherBars-12)/36),touch=clip((s.motherTouchesUpper+s.motherTouchesLower-4)/10),
    cross=clip((s.motherCrossings-3)/6),fails=clip(s.failedDepartures/3),
    continuity=compression?clip((compression.bars-s.motherBars)/12):0;
  return clip(.48+age*.14+touch*.12+cross*.12+fails*.08+(compression?.bars ? .06 : 0)+continuity*.05,.35,.95);
}

function refreshStructure(s:RegionLaunchState,rows:RegionCandle[],now:number,costRate:number){
  const structure=detectRegionOpportunityStructure({rows,lower:s.motherLower,upper:s.motherUpper,center:s.motherCenter,width:s.motherWidth,
    confirmedAt:s.motherConfirmedAt,now,costRate,departureAt:s.departureAt});
  s.longBarrier=structure.longBarrier;s.shortBarrier=structure.shortBarrier;
  s.nextLongBarrier=structure.nextLongBarrier;s.nextShortBarrier=structure.nextShortBarrier;
  s.effectiveLongTrigger=structure.longTrigger;s.effectiveShortTrigger=structure.shortTrigger;s.averageRange=structure.averageRange;
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
    if(s.rotationLongConsumedAt!=null&&close>=s.motherCenter)s.rotationLongConsumedAt=null;
    if(s.rotationShortConsumedAt!=null&&close<=s.motherCenter)s.rotationShortConsumedAt=null;
    if(s.releaseSide==="LONG"&&close<=s.motherCenter){s.releaseAttemptsLong=0;clearRelease(s);}
    if(s.releaseSide==="SHORT"&&close>=s.motherCenter){s.releaseAttemptsShort=0;clearRelease(s);}
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
    if(!state||state.version!==REGION_LAUNCH_VERSION||state.motherRegionId!==zone.id)state=initial(symbol,zone,rows,input.now,input.costRate);
    processDepartures(state,rows);refreshStructure(state,rows,input.now,input.costRate);
    if(state.phase!=="CONSUMED"&&state.phase!=="READY"&&state.phase!=="IGNITION"&&state.phase!=="RETEST"){
      const observedCompression=compressionFrom(rows,state,input.costRate);
      state.compression=observedCompression;state.quality=motherQuality(state,observedCompression);
      if(observedCompression){
        state.phase="ARMED";state.armedAt=state.armedAt??input.now;state.cooldownUntil=0;
        state.reason=`成熟缠绕区域继续观察；上方有效触发${state.effectiveLongTrigger.toPrecision(7)}，下方有效触发${state.effectiveShortTrigger.toPrecision(7)}。前方近压制/支撑会并入触发位，不再把“离开区域”直接等同成交。`;
      }else{
        state.phase="WATCH";state.armedAt=null;clearIgnition(state);clearReady(state);
        state.reason="成熟区域存在，但当前5分钟路径不足以形成可执行边缘/释放结构；继续观察。";
      }
    }else state.quality=motherQuality(state,state.compression);
    state.updatedAt=input.now;states[symbol]=state;
  }
  for(const [symbol,state] of Object.entries(states)){
    if(input.lifecycles[symbol]?.zone||state.phase==="CONSUMED")continue;
    if(input.now-state.updatedAt>24*60*60_000)delete states[symbol];
  }
  return{states};
}

function barrierPrice(s:RegionLaunchState,side:RegionOpportunitySide){
  const barrier=side==="LONG"?s.longBarrier:s.shortBarrier;
  return barrier?(side==="LONG"?barrier.upper:barrier.lower):null;
}
function nextBarrierPrice(s:RegionLaunchState,side:RegionOpportunitySide){
  const barrier=side==="LONG"?s.nextLongBarrier:s.nextShortBarrier;
  return barrier?(side==="LONG"?barrier.lower:barrier.upper):null;
}
function effectiveTrigger(s:RegionLaunchState,side:RegionOpportunitySide){
  return side==="LONG"?s.effectiveLongTrigger:s.effectiveShortTrigger;
}
function triggerWithBuffer(s:RegionLaunchState,side:RegionOpportunitySide,costRate:number){
  const trigger=effectiveTrigger(s,side),buffer=Math.max(s.motherWidth*.015,s.motherCenter*costRate*.15);
  return side==="LONG"?trigger+buffer:trigger-buffer;
}
function expectedMove(s:RegionLaunchState,side:RegionOpportunitySide,costRate:number){
  return regionOpportunityExpectedMove({side,trigger:effectiveTrigger(s,side),regionWidth:s.motherWidth,averageRange:s.averageRange,
    costRate,nextBarrier:side==="LONG"?s.nextLongBarrier:s.nextShortBarrier});
}
function maxChase(s:RegionLaunchState,side:RegionOpportunitySide,costRate:number){
  return regionOpportunityMaxChase({side,trigger:effectiveTrigger(s,side),regionWidth:s.motherWidth,center:s.motherCenter,costRate,
    nextBarrier:side==="LONG"?s.nextLongBarrier:s.nextShortBarrier});
}
function setReady(s:RegionLaunchState,input:{mode:RegionEntryMode;side:RegionOpportunitySide;at:number;price:number;stop:number;
  effectiveTrigger:number;expected:number;maxChase:number;impulse:number;confirmationMs:number;target?:number|null;confirmation?:"CONTINUATION"|"PULLBACK_RESTART"}){
  s.phase="READY";s.readyMode=input.mode;s.readyAt=input.at;s.readySide=input.side;s.readySignalPrice=input.price;s.readyStopPrice=input.stop;
  s.readyEffectiveTrigger=input.effectiveTrigger;s.readyExpectedMoveRate=input.expected;s.readyMaxChaseRate=input.maxChase;
  s.readyImpulseRate=input.impulse;s.readyConfirmationMs=input.confirmationMs;s.readyTargetPrice=input.target??null;s.readyConfirmation=input.confirmation;
  s.readyBarrierPrice=barrierPrice(s,input.side);s.readyNextBarrierPrice=nextBarrierPrice(s,input.side);
  s.readyAttempt=input.mode==="ROTATION"?1:Math.min(2,sideAttempts(s,input.side)+1);
}
function rememberRelease(s:RegionLaunchState,side:RegionOpportunitySide,at:number,trigger:number,extreme:number){
  s.releaseSide=side;s.releaseAt=s.releaseAt??at;s.releaseTrigger=trigger;
  s.releaseExtreme=s.releaseExtreme==null?extreme:side==="LONG"?Math.max(s.releaseExtreme,extreme):Math.min(s.releaseExtreme,extreme);
}
function releaseBox(s:RegionLaunchState){
  const lower=s.effectiveShortTrigger,upper=s.effectiveLongTrigger,center=(lower+upper)/2,width=upper-lower;
  return{...s.compression!,lower,upper,center,width};
}
function earlyReleaseSetup(s:RegionLaunchState,rows:RegionCandle[],current:RegionCandle|undefined,now:number,costRate:number){
  if(!rows.length)return null;
  const latest=rows.at(-1)!,at=minuteCompleteAt(latest);if(now-at>75_000)return null;
  const longTrigger=triggerWithBuffer(s,"LONG",costRate),shortTrigger=triggerWithBuffer(s,"SHORT",costRate);
  const side:RegionOpportunitySide|null=latest.close>longTrigger?"LONG":latest.close<shortTrigger?"SHORT":null;
  if(!side)return null;
  const d=side==="LONG"?1:-1,trigger=effectiveTrigger(s,side),metrics=microDirectionalBar(latest,side);
  // Official/aggregated unfinished 5m is preferred, but a just-completed fresh
  // 1m bar is already enough to participate near the effective trigger. This
  // avoids waiting several minutes only to chase the same valid release later.
  const active=current??latest,fiveMetrics=microDirectionalBar(active,side),
    multiple=Math.abs(active.close-active.open)/Math.max(s.averageRange,1e-12);
  const hasBarrier=barrierPrice(s,side)!=null,minimumMultiple=hasBarrier?1.45:1.25;
  const progress=d*(latest.close/Math.max(trigger,1e-12)-1);
  const strong=multiple>=minimumMultiple&&fiveMetrics.bodyRate>0&&metrics.bodyRate>=Math.max(.0008,costRate*.25)
    &&metrics.closeLocation>=.70&&metrics.wickToBody<=.65&&progress>=Math.max(.0005,costRate*.15);
  if(!strong)return null;
  const buffer=Math.max(s.motherWidth*.06,trigger*costRate*.25);
  const stop=side==="LONG"?latest.low-buffer:latest.high+buffer;
  return{side,at,price:latest.close,stop,multiple,progress};
}

export function advanceRegionLaunchMinutes(input:{states:Record<string,RegionLaunchState>;minutePaths:Record<string,RegionCandle[]>;
  fiveMinutePaths?:Record<string,RegionCandle[]>;quotes?:Record<string,Quote>;frames?:MultiTurnState["frames"];now:number;costRate:number}){
  const states:Record<string,RegionLaunchState>={...input.states};
  for(const [symbol,source] of Object.entries(states)){
    const s=structuredClone(source);
    if(s.version!==REGION_LAUNCH_VERSION||!s.compression||input.now<s.cooldownUntil
      ||!["ARMED","IGNITION","RETEST","READY"].includes(s.phase)){states[symbol]=s;continue;}
    const rows=(input.minutePaths[symbol]??[]).filter(row=>[row.time,row.open,row.high,row.low,row.close,row.volume].every(finite)
      &&row.high>=row.low&&row.low>0&&minuteCompleteAt(row)<=input.now).sort((a,b)=>a.time-b.time);
    if(s.phase==="READY"){states[symbol]=s;continue;}

    if(s.phase==="RETEST"&&s.releaseSide&&s.releaseAt!=null&&s.releaseTrigger!=null){
      if(sideAttempts(s,s.releaseSide)>=2){s.phase="ARMED";clearRelease(s);s.reason="同一释放机会已经完成两次正式参与；等待重新回到区域后形成下一次机会。";}
      else{
        const retest=findRegionRetestSetup({minutes:rows,side:s.releaseSide,trigger:s.releaseTrigger,releaseAt:s.releaseAt,
          width:s.motherWidth,center:s.motherCenter,now:input.now,costRate:input.costRate});
        if(retest.state==="FAIL"){s.phase="ARMED";clearRelease(s);clearIgnition(s);clearReady(s);s.reason=retest.reason;}
        else if(retest.state==="READY"&&retest.at!=null&&retest.price!=null&&retest.stop!=null){
          const d=s.releaseSide==="LONG"?1:-1,impulse=d*(retest.price/s.releaseTrigger-1);
          setReady(s,{mode:"RETEST",side:s.releaseSide,at:retest.at,price:retest.price,stop:retest.stop,effectiveTrigger:s.releaseTrigger,
            expected:expectedMove(s,s.releaseSide,input.costRate),maxChase:maxChase(s,s.releaseSide,input.costRate),impulse,
            confirmationMs:retest.at-s.releaseAt,target:nextBarrierPrice(s,s.releaseSide),confirmation:"PULLBACK_RESTART"});
          s.reason=`RegionLaunch RETEST READY：${retest.reason}`;
        }else s.reason=`RegionLaunch RETEST：${retest.reason}`;
      }
      s.updatedAt=input.now;states[symbol]=s;continue;
    }

    if(s.phase==="ARMED"&&rows.length){
      const longRotation=findRegionRotationSetup({minutes:rows,side:"LONG",lower:s.motherLower,upper:s.motherUpper,center:s.motherCenter,
        width:s.motherWidth,now:input.now,costRate:input.costRate,consumedAt:s.rotationLongConsumedAt});
      const shortRotation=findRegionRotationSetup({minutes:rows,side:"SHORT",lower:s.motherLower,upper:s.motherUpper,center:s.motherCenter,
        width:s.motherWidth,now:input.now,costRate:input.costRate,consumedAt:s.rotationShortConsumedAt});
      const rotation=[longRotation,shortRotation].filter((x):x is NonNullable<typeof x>=>!!x).sort((a,b)=>b.at-a.at)[0];
      if(rotation){
        const d=rotation.side==="LONG"?1:-1,edge=rotation.side==="LONG"?s.motherLower:s.motherUpper;
        setReady(s,{mode:"ROTATION",side:rotation.side,at:rotation.at,price:rotation.price,stop:rotation.stop,effectiveTrigger:edge,
          expected:Math.abs(rotation.target/rotation.price-1),maxChase:Math.max(.0010,s.motherWidth/rotation.price*.15),
          impulse:Math.max(0,d*(rotation.price/edge-1)),confirmationMs:REGION_LAUNCH_MINUTE_MS,target:rotation.target,confirmation:"PULLBACK_RESTART"});
        s.reason=`RegionLaunch ROTATION READY：${rotation.reason}`;s.updatedAt=input.now;states[symbol]=s;continue;
      }
    }

    const quote=input.quotes?.[symbol],livePrice=quote?.fresh&&quote.bestBid>0&&quote.bestAsk>=quote.bestBid
      &&quote.observedAt<=input.now+1000&&input.now-quote.observedAt<=5000?(quote.bestBid+quote.bestAsk)/2:undefined;
    const box=releaseBox(s);
    const five=launchFiveMinuteEvidence({box,minutes:rows,fiveMinutes:input.fiveMinutePaths?.[symbol],now:input.now,costRate:input.costRate,
      after:s.departureAfter,livePrice,previousCurrent:s.currentFiveMinute,activeSide:s.ignitionSide??undefined,activeAt:s.ignitionAt??undefined,
      fastQualifiedAt:s.launchPath==="FAST"?s.ignitionAt??undefined:undefined,
      initialFastBody:s.breakoutClose!=null&&s.breakoutOpen!=null?Math.abs(s.breakoutClose-s.breakoutOpen):undefined});
    s.currentFiveMinute=five.current;

    if(s.phase==="ARMED"){
      const early=earlyReleaseSetup(s,rows,five.current,input.now,input.costRate);
      if(early){
        rememberRelease(s,early.side,early.at,effectiveTrigger(s,early.side),early.price);s.launchPath="EARLY";s.fiveMinuteBodyMultiple=early.multiple;
        setReady(s,{mode:"RELEASE",side:early.side,at:early.at,price:early.price,stop:early.stop,effectiveTrigger:effectiveTrigger(s,early.side),
          expected:expectedMove(s,early.side,input.costRate),maxChase:maxChase(s,early.side,input.costRate),impulse:early.progress,
          confirmationMs:REGION_LAUNCH_MINUTE_MS,target:nextBarrierPrice(s,early.side),confirmation:"CONTINUATION"});
        s.reason=`RegionLaunch RELEASE READY：有效触发位已经包含前方最近压制/支撑；当前5分钟实体约为近期平均振幅${early.multiple.toFixed(2)}倍，1分钟同步强离位且尚未追远，直接参与第一段释放。`;
        s.updatedAt=input.now;states[symbol]=s;continue;
      }
    }

    const cancel=(reason:string)=>{s.failedDepartures++;s.phase="ARMED";s.departureAfter=Math.floor(input.now/REGION_BAR_MS)*REGION_BAR_MS+REGION_BAR_MS;
      clearIgnition(s);clearReady(s);s.reason=reason;};
    if(five.state==="FAIL"){cancel(five.reason);s.updatedAt=input.now;states[symbol]=s;continue;}
    if(five.state==="WAIT"){
      if(s.launchPath==="FAST"){
        s.failedDepartures++;s.phase="ARMED";clearIgnition(s);clearReady(s);
        s.reason="未收盘5分钟K失去原有强离位质量；旧点火资格撤销，但区域与前方障碍继续保留。";
      }else if(s.phase==="IGNITION")s.reason=five.reason;
      else {
        const latest=rows.at(-1),active=five.current??latest;
        const up=latest?latest.close-s.effectiveLongTrigger:0,down=latest?s.effectiveShortTrigger-latest.close:0;
        const multiple=active?Math.abs(active.close-active.open)/Math.max(s.averageRange,1e-12):0;
        s.reason=`区域仍可交易：边缘轮转继续等待；顺势释放必须先突破有效触发位。当前1m收盘${latest?.close?.toPrecision(8)??"—"}，上方触发${s.effectiveLongTrigger.toPrecision(8)}，下方触发${s.effectiveShortTrigger.toPrecision(8)}，当前方向距离${Math.max(up,down).toPrecision(4)}，5m/1m有效实体约${multiple.toFixed(2)}倍平均振幅。`;
      }
      s.updatedAt=input.now;states[symbol]=s;continue;
    }
    if(s.ignitionSide&&s.ignitionSide!==five.side){cancel("有效释放方向已经改变；取消原方向点火，区域继续观察。");s.updatedAt=input.now;states[symbol]=s;continue;}
    s.fiveMinuteBodyMultiple=five.bodyMultiple;

    let slow:ReturnType<typeof evaluateSlowLaunchRestart>|null=null;
    if(five.state==="CLOSED"&&s.launchPath!=="FAST"){
      const b=five.bar!,side=five.side!,trigger=effectiveTrigger(s,side);
      s.launchPath="CLOSED";s.phase="IGNITION";s.ignitionSide=side;s.ignitionAt=completeAt(b);s.triggerPrice=trigger;
      s.breakoutOpen=b.open;s.breakoutHigh=b.high;s.breakoutLow=b.low;s.breakoutClose=b.close;
      rememberRelease(s,side,completeAt(b),trigger,b.close);
      slow=evaluateSlowLaunchRestart({bar:b,following:rows.filter(r=>r.time>=b.time+300),side,boundary:trigger,costRate:input.costRate});
    }

    if(s.phase==="ARMED"&&five.state==="FAST"){
      const side=five.side!,trigger=effectiveTrigger(s,side);
      const fresh=rows.filter(row=>row.time>=five.bar!.time&&minuteCompleteAt(row)>Math.max(s.armedAt??0,s.lastMinuteAt??0,s.departureAfter??0));
      for(const row of fresh){
        const at=minuteCompleteAt(row);s.lastMinuteAt=at;if(input.now-at>75_000)continue;
        const quality=assessStrongBreakout({bar:row,side,triggerPrice:trigger,costRate:input.costRate,regionWidthRate:s.motherWidthRate});
        if(!quality.ok)continue;
        s.phase="IGNITION";s.ignitionSide=side;s.ignitionAt=at;s.triggerPrice=trigger;s.launchPath="FAST";
        s.breakoutOpen=row.open;s.breakoutHigh=row.high;s.breakoutLow=row.low;s.breakoutClose=row.close;
        s.breakoutImpulseRate=quality.impulseRate;s.breakoutWickRate=quality.adverseWickRate;s.pullbackExtreme=side==="LONG"?row.low:row.high;
        rememberRelease(s,side,at,trigger,row.close);s.reason="强释放已越过有效触发位；若当前价格仍在最佳参与区可直接成交，否则自动转为回踩参与。";break;
      }
    }

    if(s.phase==="IGNITION"&&s.ignitionSide&&s.triggerPrice!=null&&s.ignitionAt!=null
      &&s.breakoutOpen!=null&&s.breakoutHigh!=null&&s.breakoutLow!=null&&s.breakoutClose!=null){
      const ignitionAt=s.ignitionAt,side=s.ignitionSide,trigger=s.triggerPrice;
      const breakout:RegionCandle={time:Math.floor((ignitionAt-REGION_LAUNCH_MINUTE_MS)/1000),open:s.breakoutOpen,high:s.breakoutHigh,
        low:s.breakoutLow,close:s.breakoutClose,volume:1};
      const following=rows.filter(row=>minuteCompleteAt(row)>ignitionAt);
      const evaluated=slow??evaluateMicroRestart({breakout,following,side,triggerPrice:trigger,costRate:input.costRate,regionWidthRate:s.motherWidthRate});
      s.pullbackExtreme=evaluated.supportPrice??s.pullbackExtreme;s.lastMinuteAt=Math.max(s.lastMinuteAt??0,...following.map(minuteCompleteAt),ignitionAt);
      if(evaluated.state==="FAIL")cancel(`本次释放后的微结构失效：${evaluated.reason} 区域不删除，等待新的轮转或下一次释放。`);
      else if(evaluated.state==="WAIT")s.reason=`有效触发位已经突破；${evaluated.reason}`;
      else if(evaluated.restartAt!=null&&evaluated.restartPrice!=null){
        if(input.now-evaluated.restartAt>75_000){s.phase="RETEST";clearIgnition(s);clearReady(s);s.reason="确认到达过晚，不补追；保留有效触发位，等待第一次回踩重新参与。";}
        else{
          const support=evaluated.supportPrice!,buffer=Math.max(s.motherWidth*.06,trigger*input.costRate*.25),stop=side==="LONG"?support-buffer:support+buffer;
          const d=side==="LONG"?1:-1,impulse=d*(evaluated.restartPrice/trigger-1);
          setReady(s,{mode:"RELEASE",side,at:evaluated.restartAt,price:evaluated.restartPrice,stop,effectiveTrigger:trigger,
            expected:expectedMove(s,side,input.costRate),maxChase:maxChase(s,side,input.costRate),impulse,
            confirmationMs:evaluated.restartAt-ignitionAt,target:nextBarrierPrice(s,side),confirmation:evaluated.confirmation});
          s.reason=`RegionLaunch RELEASE READY：${evaluated.reason} 最终是否成交只看从有效触发位开始的总追价距离，不再只看确认后的几跳。`;
        }
      }
    }
    s.updatedAt=input.now;states[symbol]=s;
  }
  return{states};
}

function readySignal(s:RegionLaunchState):RegionLaunchSignal|null{
  if(s.phase!=="READY"||s.readyAt==null||!s.readySide||!s.readyMode||s.readySignalPrice==null||s.readyStopPrice==null
    ||s.readyExpectedMoveRate==null||s.readyMaxChaseRate==null||s.readyEffectiveTrigger==null||!s.compression)return null;
  const side=s.readySide,boundary=s.readyMode==="ROTATION"?(side==="LONG"?"LOWER":"UPPER"):(side==="LONG"?"UPPER":"LOWER");
  const kind=s.readyMode==="ROTATION"?"REJECTION":"MIGRATION",target=s.readyMode==="ROTATION"?(s.readyTargetPrice??s.motherCenter):s.readyTargetPrice;
  const modeText=s.readyMode==="ROTATION"?"区域边缘拒绝后向中心轮转":s.readyMode==="RETEST"?"有效触发位回踩后二次启动":"有效触发位首次释放";
  const barrier=s.readyBarrierPrice==null?"前方无近端障碍":`前方障碍已并入触发位 ${s.readyBarrierPrice.toPrecision(8)}`;
  return{version:REGION_LIFECYCLE_VERSION,id:`rl-${s.motherRegionId}-${s.readyMode}-${side}-${s.readyAt}`,symbol:s.symbol,kind,side,boundary,
    completedAt:s.readyAt,expiresAt:s.readyAt+REGION_LAUNCH_SIGNAL_MS,signalPrice:s.readySignalPrice,stopPrice:s.readyStopPrice,targetPrice:target??null,
    regionId:s.motherRegionId,regionConfirmedAt:s.motherConfirmedAt,regionLower:s.motherLower,regionUpper:s.motherUpper,
    regionCenter:s.motherCenter,regionWidth:s.motherWidth,regionWidthRate:s.motherWidthRate,
    reason:`RegionLaunch ${s.readyMode}：${modeText}；${barrier}。有效触发 ${s.readyEffectiveTrigger.toPrecision(8)}，当前只在结构失效点附近参与。`,
    entryModel:"REGION_LAUNCH",entryMode:s.readyMode,launchVersion:REGION_LAUNCH_VERSION,
    launchTriggerPrice:s.readyEffectiveTrigger,launchEffectiveTrigger:s.readyEffectiveTrigger,launchBarrierPrice:s.readyBarrierPrice,
    launchNextBarrierPrice:s.readyNextBarrierPrice,launchCompressionLower:s.compression.lower,launchCompressionUpper:s.compression.upper,
    launchCompressionBars:s.compression.bars,launchFailedDepartures:s.failedDepartures,launchImpulseRate:s.readyImpulseRate??0,
    launchConfirmationMs:s.readyConfirmationMs??0,launchExpectedMoveRate:s.readyExpectedMoveRate,launchMaxChaseRate:s.readyMaxChaseRate,
    launchAttempt:s.readyAttempt};
}

export function advanceRegionLaunchQuotes(input:{states:Record<string,RegionLaunchState>;quotes:Record<string,Quote>;
  frames?:MultiTurnState["frames"];now:number;costRate:number}){
  const states:Record<string,RegionLaunchState>={...input.states},signals:RegionLaunchSignal[]=[];
  for(const [symbol,source] of Object.entries(states)){
    const s=structuredClone(source),q=input.quotes[symbol];
    if(s.version!==REGION_LAUNCH_VERSION||s.phase!=="READY"){states[symbol]=s;continue;}
    const signal=readySignal(s);
    if(!signal||input.now>signal.expiresAt){s.phase=s.releaseSide?"RETEST":s.compression?"ARMED":"WATCH";clearReady(s);clearIgnition(s);states[symbol]=s;continue;}
    if(!q?.fresh||q.bestBid<=0||q.bestAsk<q.bestBid||q.observedAt>input.now+1000||input.now-q.observedAt>5000){states[symbol]=s;continue;}
    const mid=(q.bestBid+q.bestAsk)/2,d=signal.side==="LONG"?1:-1;
    if(signal.entryMode==="ROTATION"){
      const target=signal.targetPrice??signal.regionCenter,chase=d*(mid/signal.signalPrice-1),failed=signal.side==="LONG"?mid<=signal.stopPrice:mid>=signal.stopPrice;
      const alreadyAtTarget=signal.side==="LONG"?mid>=target:mid<=target;
      if(failed||alreadyAtTarget||chase>signal.launchMaxChaseRate){
        s.phase=s.compression?"ARMED":"WATCH";clearReady(s);clearIgnition(s);
        s.reason=alreadyAtTarget?"区域轮转在成交前已经到达中心，不再补单。":"区域边缘轮转已经离开最佳风险位置；等待下一次边缘行为。";
      }else signals.push(signal);
    }else{
      const progress=d*(mid/signal.launchEffectiveTrigger-1);
      if(progress<=0){
        s.phase="RETEST";rememberRelease(s,signal.side,signal.completedAt,signal.launchEffectiveTrigger,signal.signalPrice);clearReady(s);clearIgnition(s);
        s.reason="有效释放在成交前回到触发位附近；不追，转为观察第一次回踩/重新启动。";
      }else if(progress>signal.launchMaxChaseRate){
        s.phase="RETEST";rememberRelease(s,signal.side,signal.completedAt,signal.launchEffectiveTrigger,mid);clearReady(s);clearIgnition(s);
        s.reason="第一波释放已经超过最佳参与区；不再从确认价计算追远，直接等待有效触发位回踩后的第二次参与。";
      }else signals.push(signal);
    }
    s.updatedAt=input.now;states[symbol]=s;
  }
  return{states,signals};
}

export function consumeRegionLaunch(state:RegionLaunchState,side:"LONG"|"SHORT",at:number,mode:RegionEntryMode="RELEASE"){
  const s=structuredClone(state);
  if(mode==="ROTATION"){
    if(side==="LONG")s.rotationLongConsumedAt=at;else s.rotationShortConsumedAt=at;
  }else{
    incrementAttempt(s,side);rememberRelease(s,side,s.releaseAt??at,s.readyEffectiveTrigger??effectiveTrigger(s,side),s.readySignalPrice??s.releaseExtreme??0);
  }
  s.phase="CONSUMED";s.consumedAt=at;s.consumedSide=side;s.reason=`RegionLaunch ${mode} 已按当前盘口成交；订单管理与区域机会生命周期分离，平仓不等于放弃这个区域。`;
  clearIgnition(s);clearReady(s);return s;
}

export function rearmRegionLaunchAfterExit(state:RegionLaunchState,input:{
  mode:RegionEntryMode;side:"LONG"|"SHORT";at:number;netPnl:number;structuralFailure:boolean;
}){
  const s=structuredClone(state);s.consumedAt=null;s.consumedSide=null;clearIgnition(s);clearReady(s);s.cooldownUntil=0;
  if(input.mode==="ROTATION"){
    s.phase=s.compression?"ARMED":"WATCH";
    s.reason="区域轮转订单已结束；同一边缘需先完成到中心的重置，区域本身继续保留。";
    return s;
  }
  if(input.structuralFailure){
    s.phase=s.compression?"ARMED":"WATCH";clearRelease(s);
    s.reason="有效触发位已经被重新接受，原释放机会结束；区域继续等待新的轮转或下一轮释放。";
    return s;
  }
  const attempts=sideAttempts(s,input.side);
  if(input.netPnl<=0&&attempts<2&&s.releaseSide===input.side&&s.releaseAt!=null&&s.releaseTrigger!=null){
    s.phase="RETEST";s.reason="第一次参与没有盈利，但有效释放结构尚未失效；立即转入回踩观察，不设置固定5分钟冷却。";
  }else{
    s.phase=s.compression?"ARMED":"WATCH";
    s.reason=input.netPnl>0?"本次机会已兑现利润；区域继续观察下一次独立行为。":"同一释放机会已完成两次正式参与；等待重新接受区域后再开启新机会。";
  }
  return s;
}
