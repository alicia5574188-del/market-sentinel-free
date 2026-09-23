import {microDirectionalBar,type MicroCandle,type MicroSide,type MicroRestartResult} from "./micro-restart.ts";

const BAR=300_000;
const valid=(b:MicroCandle)=>[b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)
  &&b.open>0&&b.close>0&&b.low>0&&b.high>=Math.max(b.open,b.close)&&b.low<=Math.min(b.open,b.close)&&b.volume>=0;
export type LaunchBox={endAt:number;lower:number;upper:number;center:number;width:number;averageRange?:number;averageBody?:number};
export type FiveMinuteEvidence={state:"WAIT"|"FAIL"|"FAST"|"CLOSED";reason:string;side?:MicroSide;bar?:MicroCandle;
  current?:MicroCandle;bodyMultiple?:number};

/** Only complete, contiguous one-minute bars beginning at the actual 5m open
 * may describe an unfinished 5m candle. Never relabel the latest 1m open as it. */
export function launchFiveMinuteEvidence(input:{box:LaunchBox;minutes:MicroCandle[];fiveMinutes?:MicroCandle[];
  now:number;costRate:number;after?:number;livePrice?:number;previousCurrent?:MicroCandle;
  activeSide?:MicroSide;activeAt?:number;fastQualifiedAt?:number;initialFastBody?:number}):FiveMinuteEvidence{
  const {box,now}=input,after=Math.max(box.endAt,input.after??0),bucket=Math.floor(now/BAR)*300;
  const map=new Map<number,MicroCandle>();
  for(const b of input.fiveMinutes??[])if(valid(b)&&b.time%300===0&&(b.time+300)*1000<=now&&b.time*1000>=after)map.set(b.time,b);
  const minutes=[...new Map(input.minutes.filter(b=>valid(b)&&b.time%60===0&&(b.time+60)*1000<=now).map(b=>[b.time,b])).values()].sort((a,b)=>a.time-b.time);
  const groups=new Map<number,MicroCandle[]>();
  for(const b of minutes){const key=Math.floor(b.time/300)*300;if(key*1000<after)continue;groups.set(key,[...(groups.get(key)??[]),b]);}
  for(const [key,rows] of groups){
    if(rows[0]!.time!==key||rows.some((b,i)=>i>0&&b.time!==rows[i-1]!.time+60))continue;
    if(key!==bucket&&rows.length!==5)continue;
    if(map.has(key))continue;
    const first=rows[0]!,last=rows.at(-1)!;
    map.set(key,{time:key,open:first.open,high:Math.max(...rows.map(b=>b.high)),low:Math.min(...rows.map(b=>b.low)),
      close:last.close,volume:rows.reduce((n,b)=>n+b.volume,0)});
  }
  const current=map.get(bucket),price=input.livePrice;
  if(current){
    if(input.previousCurrent?.time===bucket){current.high=Math.max(current.high,input.previousCurrent.high);current.low=Math.min(current.low,input.previousCurrent.low);}
    if(price!=null&&Number.isFinite(price)&&price>0){current.high=Math.max(current.high,price);current.low=Math.min(current.low,price);current.close=price;}
  }
  const rows=[...map.values()].sort((a,b)=>a.time-b.time),range=box.averageRange??box.width,
    averageBody=box.averageBody??range*.5,buffer=Math.max(box.width*.02,box.center*input.costRate*.20);
  let proof:FiveMinuteEvidence|null=null;
  for(const b of rows){
    if(input.activeSide&&(b.time+300)*1000>=(input.activeAt??0)&&(input.activeSide==="LONG"?b.close<=box.upper:b.close>=box.lower))
      return{state:"FAIL",reason:"5分钟价格已回到完整缠绕区间；撤销此前的1分钟追击资格。",current};
    const side=b.close>box.upper+buffer?"LONG":b.close<box.lower-buffer?"SHORT":null;
    if(proof){
      const returned=proof.side==="LONG"?b.close<=box.upper:b.close>=box.lower;
      if(returned)return{state:"FAIL",reason:"5分钟价格已收回完整缠绕区间；本次离区失效，不能沿用先前1分钟触发。",current};
    }
    if(!side)continue;
    const metrics=microDirectionalBar(b,side),body=Math.abs(b.close-b.open),multiple=body/Math.max(range,1e-12);
    const directed=(side==="LONG"?1:-1)*(b.close-b.open)>0;
    const strongShape=directed&&metrics.closeLocation>=.75&&metrics.wickToBody<=.35;
    const retainedFast=input.fastQualifiedAt!=null&&b.time===Math.floor((input.fastQualifiedAt-1)/BAR)*300
      &&body>=Math.max(range*.60,(input.initialFastBody??0)*.50);
    const fast=strongShape&&(multiple>=3||retainedFast)&&metrics.bodyRate>=input.costRate*.75;
    const closed=(b.time+300)*1000<=now;
    const accepted=closed&&directed&&body>=Math.max(range*.60,averageBody,b.open*input.costRate*.75)
      &&metrics.closeLocation>=.70&&metrics.wickToBody<=.50;
    if(fast&&(!proof||proof.state==="CLOSED"))proof={state:"FAST",side,bar:b,bodyMultiple:multiple,
      reason:`${retainedFast&&multiple<3?"5分钟此前已达异常强离区，回调后当前":"5分钟"}实体为前期平均振幅${multiple.toFixed(2)}倍，完整边界外强势离区；允许1分钟确认。`};
    else if(accepted&&!proof)proof={state:"CLOSED",side,bar:b,bodyMultiple:multiple,
      reason:"5分钟已在完整边界外有效收盘；观察下一根加速，或区间外小回调后的再次突破。"};
  }
  return proof?{...proof,current}:{state:"WAIT",current,reason:"5分钟尚未有效离开完整区间：未收盘需实体达到前期平均振幅3倍；较慢离区等收盘和后续确认，长影线不算突破。"};
}

/** The slow route starts AFTER the outside 5m close, then requires a genuine
 * shallow pullback and a close beyond its entire high/low, not a tiny last bar. */
export function evaluateSlowLaunchRestart(input:{bar:MicroCandle;following:MicroCandle[];side:MicroSide;
  boundary:number;costRate:number}):MicroRestartResult{
  const {bar,side}=input,d=side==="LONG"?1:-1,body=Math.abs(bar.close-bar.open),start=bar.time+300;
  const empty=(state:MicroRestartResult["state"],reason:string):MicroRestartResult=>({state,reason,pullbackCloseRate:0,
    pullbackExtremeRate:0,cumulativeAdverseBodyRate:0,restartAt:null,restartPrice:null,supportPrice:null});
  const rows=input.following.filter(b=>valid(b)&&b.time>=start).sort((a,b)=>a.time-b.time);
  let high=bar.close,low=bar.close,adverse=0,hadPullback=false,prior=bar.close;
  for(let i=0;i<rows.length;i++){
    const b=rows[i]!;
    if(b.time!==start+i*60)return empty("WAIT","较慢离区的1分钟回调路径尚未连续，等待补齐。");
    const reversal=d*(b.close-prior)<0||d*(b.close-b.open)<0;
    const oldHigh=high,oldLow=low;
    high=Math.max(high,b.high);low=Math.min(low,b.low);adverse+=Math.max(0,-d*(b.close-b.open));
    const giveback=side==="LONG"?bar.close-low:high-bar.close;
    if(d*(b.close-input.boundary)<=0||giveback>body*.50||adverse>body*.70)
      return empty("FAIL","较慢离区后回到区间或回调超过原5分钟实体允许幅度；本次离区失效。");
    const metrics=microDirectionalBar(b,side),beyond=side==="LONG"?b.close>oldHigh:b.close<oldLow;
    if(hadPullback&&!reversal&&beyond&&metrics.bodyRate>=Math.max(.0006,input.costRate*.25)
      &&metrics.closeLocation>=.65&&metrics.wickToBody<=.50){
      return{state:"READY",confirmation:"PULLBACK_RESTART",reason:"5分钟区间外收盘后仅小回调，当前1分钟实体重新突破整段回调极值。",
        pullbackCloseRate:Math.max(0,giveback)/bar.close,pullbackExtremeRate:Math.max(0,giveback)/bar.close,
        cumulativeAdverseBodyRate:adverse/bar.open,restartAt:(b.time+60)*1000,restartPrice:b.close,supportPrice:side==="LONG"?low:high};
    }
    hadPullback=hadPullback||reversal;prior=b.close;
  }
  return empty("WAIT","5分钟已在区间外收盘；等待后续突然加速，或小回调后重新超过整段回调极值。");
}
