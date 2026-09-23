export const MICRO_RESTART_VERSION="micro-restart-v1";

export type MicroCandle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type MicroSide="LONG"|"SHORT";
export type BreakoutQuality={
  ok:boolean;impulseRate:number;bodyRate:number;adverseWickRate:number;wickToBody:number;closeLocation:number;reason:string;
};
export type MicroRestartResult={
  state:"WAIT"|"FAIL"|"READY";reason:string;pullbackCloseRate:number;pullbackExtremeRate:number;
  cumulativeAdverseBodyRate:number;restartAt:number|null;restartPrice:number|null;supportPrice:number|null;
};

const finite=(v:number)=>Number.isFinite(v);
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const direction=(side:MicroSide)=>side==="LONG"?1:-1;

export function microDirectionalBar(row:MicroCandle,side:MicroSide){
  const d=direction(side),range=Math.max(row.high-row.low,1e-12),body=Math.max(0,d*(row.close-row.open));
  const adverseWick=side==="LONG"?Math.max(0,row.high-Math.max(row.open,row.close))
    :Math.max(0,Math.min(row.open,row.close)-row.low);
  const closeLocation=side==="LONG"?(row.close-row.low)/range:(row.high-row.close)/range;
  return{bodyRate:body/Math.max(row.open,1e-12),adverseWickRate:adverseWick/Math.max(row.open,1e-12),
    wickToBody:adverseWick/Math.max(body,1e-12),closeLocation:clip(closeLocation)};
}

export function assessStrongBreakout(input:{bar:MicroCandle;side:MicroSide;triggerPrice:number;costRate:number;regionWidthRate:number}):BreakoutQuality{
  const {bar,side,triggerPrice,costRate,regionWidthRate}=input,d=direction(side),metrics=microDirectionalBar(bar,side);
  const impulseRate=d*(bar.close/Math.max(triggerPrice,1e-12)-1);
  const minImpulse=Math.max(.0030,costRate*1.10,regionWidthRate*.10);
  const minBody=Math.max(.0020,costRate*.75,regionWidthRate*.055);
  const ok=[bar.time,bar.open,bar.high,bar.low,bar.close,bar.volume,triggerPrice].every(finite)&&bar.high>=bar.low&&bar.low>0
    &&impulseRate>=minImpulse&&metrics.bodyRate>=minBody&&metrics.closeLocation>=.74&&metrics.wickToBody<=.38;
  const reason=!ok
    ?`突破K不够强：推进${(impulseRate*100).toFixed(2)}%，实体${(metrics.bodyRate*100).toFixed(2)}%，反向影线/实体${metrics.wickToBody.toFixed(2)}，收盘位置${(metrics.closeLocation*100).toFixed(0)}%。`
    :`强突破K成立：推进${(impulseRate*100).toFixed(2)}%，实体${(metrics.bodyRate*100).toFixed(2)}%，反向影线受控。`;
  return{ok,impulseRate,bodyRate:metrics.bodyRate,adverseWickRate:metrics.adverseWickRate,
    wickToBody:metrics.wickToBody,closeLocation:metrics.closeLocation,reason};
}

export function evaluateMicroRestart(input:{breakout:MicroCandle;following:MicroCandle[];side:MicroSide;triggerPrice:number;
  costRate:number;regionWidthRate:number}):MicroRestartResult{
  const {breakout,side,triggerPrice,costRate}=input,d=direction(side),quality=assessStrongBreakout(input);
  if(!quality.ok)return{state:"FAIL",reason:quality.reason,pullbackCloseRate:0,pullbackExtremeRate:0,
    cumulativeAdverseBodyRate:0,restartAt:null,restartPrice:null,supportPrice:null};
  const rows=input.following.filter(row=>[row.time,row.open,row.high,row.low,row.close,row.volume].every(finite)
    &&row.high>=row.low&&row.low>0).sort((a,b)=>a.time-b.time);
  if(!rows.length)return{state:"WAIT",reason:"强突破K成立，等待小回调后的第一根重新顺向1分钟K。",pullbackCloseRate:0,
    pullbackExtremeRate:0,cumulativeAdverseBodyRate:0,restartAt:null,restartPrice:null,
    supportPrice:side==="LONG"?breakout.low:breakout.high};

  let minClose=breakout.close,maxClose=breakout.close,minLow=breakout.low,maxHigh=breakout.high,cumulativeAdverse=0;
  for(let index=0;index<rows.length;index++){
    const row=rows[index]!,prior=index?rows[index-1]!:breakout;
    minClose=Math.min(minClose,row.close);maxClose=Math.max(maxClose,row.close);minLow=Math.min(minLow,row.low);maxHigh=Math.max(maxHigh,row.high);
    cumulativeAdverse+=Math.max(0,-d*(row.close/Math.max(row.open,1e-12)-1));

    const pullbackClose=side==="LONG"?Math.max(0,(breakout.close-minClose)/breakout.close)
      :Math.max(0,(maxClose-breakout.close)/breakout.close);
    const breakoutExtreme=side==="LONG"?breakout.high:breakout.low;
    const pullbackExtreme=side==="LONG"?Math.max(0,(breakoutExtreme-minLow)/breakoutExtreme)
      :Math.max(0,(maxHigh-breakoutExtreme)/Math.max(breakoutExtreme,1e-12));
    const current=d*(row.close/triggerPrice-1);
    const breakoutStrength=Math.max(quality.bodyRate,quality.impulseRate);

    // "Small pullback" is not a candle count. It is a hard relationship to the
    // original impulse: close giveback <= 50%, cumulative adverse candle bodies
    // <= 70% of the breakout body, and the impulse must remain at least 1.35x
    // the accumulated opposite bodies.
    const tooDeep=current<=0||pullbackClose>breakoutStrength*.50||pullbackExtreme>breakoutStrength*.65
      ||cumulativeAdverse>quality.bodyRate*.70||quality.bodyRate<cumulativeAdverse*1.35;
    if(tooDeep)return{state:"FAIL",
      reason:`回调已经不再属于小回调：突破实体${(quality.bodyRate*100).toFixed(2)}%，累计反向实体${(cumulativeAdverse*100).toFixed(2)}%，收盘回吐${(pullbackClose*100).toFixed(2)}%。母结构继续观察，但本次启动不追。`,
      pullbackCloseRate:pullbackClose,pullbackExtremeRate:pullbackExtreme,cumulativeAdverseBodyRate:cumulativeAdverse,
      restartAt:null,restartPrice:null,supportPrice:side==="LONG"?minLow:maxHigh};

    const metrics=microDirectionalBar(row,side),resumeMove=d*(row.close/prior.close-1);
    const localBreak=side==="LONG"?row.close>prior.high:row.close<prior.low;
    const minResume=Math.max(.0006,costRate*.25);
    const resumed=localBreak&&metrics.bodyRate>=minResume&&metrics.closeLocation>=.62&&metrics.wickToBody<=.65&&resumeMove>0;
    if(resumed)return{state:"READY",
      reason:`小回调后重新启动：突破实体${(quality.bodyRate*100).toFixed(2)}%仍明显大于累计反向实体${(cumulativeAdverse*100).toFixed(2)}%，当前1分钟K重新顺向突破前一根局部${side==="LONG"?"高点":"低点"}。`,
      pullbackCloseRate:pullbackClose,pullbackExtremeRate:pullbackExtreme,cumulativeAdverseBodyRate:cumulativeAdverse,
      restartAt:(row.time+60)*1000,restartPrice:row.close,supportPrice:side==="LONG"?minLow:maxHigh};
  }
  const pullbackClose=side==="LONG"?Math.max(0,(breakout.close-minClose)/breakout.close):Math.max(0,(maxClose-breakout.close)/breakout.close);
  const breakoutExtreme=side==="LONG"?breakout.high:breakout.low;
  const pullbackExtreme=side==="LONG"?Math.max(0,(breakoutExtreme-minLow)/breakoutExtreme):Math.max(0,(maxHigh-breakoutExtreme)/Math.max(breakoutExtreme,1e-12));
  return{state:"WAIT",
    reason:`仍是小回调，但尚未出现重新顺向确认；突破实体${(quality.bodyRate*100).toFixed(2)}%，累计反向实体${(cumulativeAdverse*100).toFixed(2)}%。`,
    pullbackCloseRate:pullbackClose,pullbackExtremeRate:pullbackExtreme,cumulativeAdverseBodyRate:cumulativeAdverse,
    restartAt:null,restartPrice:null,supportPrice:side==="LONG"?minLow:maxHigh};
}
