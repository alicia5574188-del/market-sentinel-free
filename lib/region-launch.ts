import { REGION_BAR_MS, REGION_LIFECYCLE_VERSION, type RegionCandle, type RegionEntrySignal, type RegionLifecycleState, type RegionZone } from "./region-lifecycle.ts";
import type { MultiTurnState } from "./multi-turn-engine.ts";
import { assessStrongBreakout, evaluateMicroRestart } from "./micro-restart.ts";

export const REGION_LAUNCH_VERSION="region-launch-v2";
export const REGION_LAUNCH_SIGNAL_MS=120_000;
export const REGION_LAUNCH_MINUTE_MS=60_000;

export type RegionLaunchPhase="WATCH"|"ARMED"|"IGNITION"|"READY"|"CONSUMED";
export type RegionLaunchCompression={
  id:string;startAt:number;endAt:number;bars:number;lower:number;upper:number;center:number;width:number;widthRate:number;
  crossings:number;overlapPairs:number;
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
  consumedAt:number|null;consumedSide:"LONG"|"SHORT"|null;reason:string;
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
  return Math.max(.0015,Math.min(.0025,cost*.60));
}

function compressionFrom(rows:RegionCandle[],mother:Pick<RegionLaunchState,
  "motherLower"|"motherUpper"|"motherCenter"|"motherWidth"|"motherWidthRate">,costRate:number):RegionLaunchCompression|null{
  const completed=rows.filter(r=>[r.time,r.open,r.high,r.low,r.close,r.volume].every(finite)&&r.high>=r.low&&r.low>0)
    .sort((a,b)=>a.time-b.time);
  for(const size of [10,9,8,7,6,5,4]){
    if(completed.length<size)continue;
    const window=completed.slice(-size);
    if(window.some((r,i)=>i&&r.time!==window[i-1]!.time+300))continue;
    const lows=window.map(r=>r.low),highs=window.map(r=>r.high),closes=window.map(r=>r.close);
    const lower=quantile(lows,.20),upper=quantile(highs,.80);
    if(!(upper>lower&&lower>0))continue;
    const center=quantile(closes,.50),width=upper-lower,widthRate=width/Math.max(center,1e-12);
    const closeSpan=(Math.max(...closes)-Math.min(...closes))/width;
    const drift=Math.abs(closes.at(-1)!-closes[0]!)/width;
    const cross=crossings(closes,center);
    let overlaps=0;for(let i=1;i<window.length;i++)if(overlap(window[i-1]!,window[i]!)>=.15)overlaps++;
    const expandedLow=mother.motherLower-mother.motherWidth*.30,expandedHigh=mother.motherUpper+mother.motherWidth*.30;
    const nearBoundary=Math.min(Math.abs(center-mother.motherUpper),Math.abs(center-mother.motherLower))/mother.motherWidth;
    if(width>mother.motherWidth*.82||widthRate<Math.max(.0008,costRate*.75)||widthRate>Math.max(.06,mother.motherWidthRate*.95)
      ||center<expandedLow||center>expandedHigh||nearBoundary>.60||closeSpan>.90||drift>.55
      ||cross<(size>=6?2:1)||overlaps<Math.max(2,size-2))continue;
    const startAt=completeAt(window[0]!),endAt=completeAt(window.at(-1)!);
    return{id:`rc-${window[0]!.time}-${window.at(-1)!.time}-${lower.toPrecision(8)}-${upper.toPrecision(8)}`,
      startAt,endAt,bars:size,lower,upper,center,width,widthRate,crossings:cross,overlapPairs:overlaps};
  }
  return null;
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
}
function clearReady(s:RegionLaunchState){
  s.readyAt=null;s.readySide=null;s.readySignalPrice=null;s.readyStopPrice=null;s.readyImpulseRate=null;
  s.readyExpectedMoveRate=null;s.readyMaxChaseRate=null;s.readyConfirmationMs=null;
}
function motherQuality(s:RegionLaunchState,compression:RegionLaunchCompression|null){
  const age=clip((s.motherBars-12)/36),touch=clip((s.motherTouchesUpper+s.motherTouchesLower-4)/10),
    cross=clip((s.motherCrossings-3)/6),fails=clip(s.failedDepartures/3),child=compression?clip((compression.bars-4)/6):0;
  return clip(.42+age*.13+touch*.10+cross*.10+fails*.10+(compression?.bars? .10+child*.05:0),.35,.95);
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
    const zone=lifecycle.zone,rows=input.paths[symbol]??[];
    if(!zone||!rows.length)continue;
    let state=states[symbol];
    if(!state||state.version!==REGION_LAUNCH_VERSION||!relatedMother(state,zone))state=initial(symbol,zone,input.now);
    processDepartures(state,rows);
    if(state.phase!=="CONSUMED"&&state.phase!=="READY"&&state.phase!=="IGNITION"){
      const wasArmed=state.phase==="ARMED"&&!!state.compression;
      const observedCompression=compressionFrom(rows,state,input.costRate);
      // A completed breakout 5m bar naturally stops looking compressed. Keep
      // the already-observed box long enough for its 1m confirmation to arrive.
      const compression=observedCompression??(wasArmed&&input.now<=state.compression!.endAt+2*REGION_BAR_MS?state.compression:null);
      state.compression=compression;state.quality=motherQuality(state,compression);
      if(compression){
        state.phase="ARMED";
        if(!wasArmed){state.armedAt=input.now;state.armedInsideObserved=false;clearIgnition(state);clearReady(state);}
        state.reason=`成熟母区域持续保留；已识别${compression.bars}根5m子区压缩，进入ARMED并提前争取实时盘口槽。失败离区累计${state.failedDepartures}次。`;
      }else{
        state.phase="WATCH";state.armedAt=null;state.armedInsideObserved=false;clearIgnition(state);clearReady(state);
        state.reason=`成熟母区域继续观察；此前失败离区${state.failedDepartures}次不会消费区域，等待靠近边界的4–10根5m子区压缩。`;
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
    reason:`RegionLaunch：成熟母区域长期观察 + ${s.compression.bars}根5m子区压缩后，1分钟强势突破K成立；允许回调，直到第一根重新顺向并突破前一根局部高/低点的1分钟K完成后才允许追击。`,
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
  frames?:MultiTurnState["frames"];now:number;costRate:number}){
  const states:Record<string,RegionLaunchState>={...input.states};
  for(const [symbol,source] of Object.entries(states)){
    const s=structuredClone(source);
    if((s.phase!=="ARMED"&&s.phase!=="IGNITION")||!s.compression||input.now<s.cooldownUntil){states[symbol]=s;continue;}
    const rows=(input.minutePaths[symbol]??[]).filter(row=>[row.time,row.open,row.high,row.low,row.close,row.volume].every(finite)
      &&row.high>=row.low&&row.low>0&&minuteCompleteAt(row)<=input.now).sort((a,b)=>a.time-b.time);
    if(!rows.length){states[symbol]=s;continue;}
    const {long:longTrigger,short:shortTrigger}=launchTriggers(s,input.costRate);

    if(s.phase==="ARMED"){
      const fresh=rows.filter(row=>minuteCompleteAt(row)>Math.max(s.armedAt??0,s.lastMinuteAt??0));
      for(const row of fresh){
        const at=minuteCompleteAt(row);s.lastMinuteAt=at;
        // Late one-minute history can restore observation state, but can never
        // create a retroactive chase after the move has already happened.
        if(input.now-at>75_000){s.reason="RegionLaunch收到迟到的1分钟K，仅补齐观察，不历史补追。";continue;}
        const side=row.close>=longTrigger?"LONG":row.close<=shortTrigger?"SHORT":null;
        if(!side)continue;
        const trigger=side==="LONG"?longTrigger:shortTrigger;
        const quality=assessStrongBreakout({bar:row,side,triggerPrice:trigger,costRate:input.costRate,regionWidthRate:s.motherWidthRate});
        if(!quality.ok){s.reason=`RegionLaunch继续观察：${quality.reason}`;continue;}
        s.phase="IGNITION";s.ignitionSide=side;s.ignitionAt=at;s.triggerPrice=trigger;
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
      const evaluated=evaluateMicroRestart({breakout,following,side:ignitionSide,triggerPrice,
        costRate:input.costRate,regionWidthRate:s.motherWidthRate});
      s.pullbackExtreme=evaluated.supportPrice??s.pullbackExtreme;
      s.lastMinuteAt=Math.max(s.lastMinuteAt??0,...following.map(minuteCompleteAt),ignitionAt);
      if(evaluated.state==="FAIL"){
        s.failedDepartures++;s.phase="ARMED";s.cooldownUntil=0;clearIgnition(s);clearReady(s);
        s.reason=`RegionLaunch本次启动失败：${evaluated.reason} 成熟母区域继续保留观察。`;
      }else if(evaluated.state==="WAIT"){
        s.reason=`RegionLaunch继续观察：${evaluated.reason}`;
      }else if(evaluated.restartAt!=null&&evaluated.restartPrice!=null){
        const side=ignitionSide,d=side==="LONG"?1:-1,trigger=triggerPrice;
        const impulse=d*(evaluated.restartPrice/trigger-1);
        const maxChase=Math.max(.009,Math.min(.025,Math.max(s.motherWidthRate*.60,input.costRate*4)));
        if(input.now-evaluated.restartAt>75_000){
          s.phase="WATCH";s.cooldownUntil=input.now+REGION_BAR_MS;clearIgnition(s);clearReady(s);
          s.reason="RegionLaunch重新启动1分钟K到达过晚；只记录结构，不历史补追。";
        }else if(impulse>maxChase){
          s.phase="WATCH";s.cooldownUntil=evaluated.restartAt+REGION_BAR_MS;clearIgnition(s);clearReady(s);
          s.reason="RegionLaunch小回调后重新启动，但确认时离发射边界过远；不补追，等待新的压缩或更好位置。";
        }else{
          const support=evaluated.supportPrice!,microBuffer=Math.max(trigger*.0015,s.compression.width*.08,input.costRate*trigger*.30);
          // Never truncate the actual pullback structure to make a trade fit.
          // Entry sizing/remaining-space policy evaluates this full stop.
          const stop=side==="LONG"?support-microBuffer:support+microBuffer;
          const f15=input.frames?.[symbol]?.["15m"];
          const expected=Math.min(.20,Math.max(.015,s.motherWidthRate*1.50,impulse*3,f15?.expectedMoveRate??0));
          s.phase="READY";s.readyAt=evaluated.restartAt;s.readySide=side;s.readySignalPrice=evaluated.restartPrice;s.readyStopPrice=stop;
          s.readyImpulseRate=impulse;s.readyExpectedMoveRate=expected;s.readyMaxChaseRate=maxChase;s.readyConfirmationMs=evaluated.restartAt-ignitionAt;
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
    if(s.phase!=="READY"){states[symbol]=s;continue;}
    const signal=readySignal(s);
    if(!signal||input.now>signal.expiresAt){s.phase=s.compression?"ARMED":"WATCH";s.cooldownUntil=input.now+REGION_BAR_MS;clearReady(s);clearIgnition(s);states[symbol]=s;continue;}
    if(!q?.fresh||q.bestBid<=0||q.bestAsk<q.bestBid||q.observedAt>input.now+1000||input.now-q.observedAt>5000){states[symbol]=s;continue;}
    const mid=(q.bestBid+q.bestAsk)/2,d=signal.side==="LONG"?1:-1,progress=d*(mid/signal.launchTriggerPrice-1);
    if(progress<=0){s.failedDepartures++;s.phase="ARMED";s.cooldownUntil=0;clearReady(s);clearIgnition(s);
      s.reason="RegionLaunch 1分钟重新顺向确认后，实时盘口又跌回发射边界；取消本次追击但继续保留母区域。";}
    else if(progress>signal.launchMaxChaseRate){s.phase="WATCH";s.cooldownUntil=input.now+REGION_BAR_MS;clearReady(s);clearIgnition(s);
      s.reason="RegionLaunch确认后当前盘口已经超过允许追价距离；不补追，等待新的压缩。";}
    else signals.push(signal);
    s.updatedAt=input.now;states[symbol]=s;
  }
  return{states,signals};
}

export function consumeRegionLaunch(state:RegionLaunchState,side:"LONG"|"SHORT",at:number){
  const s=structuredClone(state);s.phase="CONSUMED";s.consumedAt=at;s.consumedSide=side;s.reason="RegionLaunch READY已通过盘口与账户风险检查并完成模拟开仓；成功发射期间不重复追单。";
  clearIgnition(s);clearReady(s);return s;
}
