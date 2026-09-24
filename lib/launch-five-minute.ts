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
    const boundary=side==="LONG"?box.upper:box.lower;
    const outsideBody=side==="LONG"
      ?Math.max(0,b.close-Math.max(b.open,boundary))
      :Math.max(0,Math.min(b.open,boundary)-b.close);
    const outsideBodyShare=outsideBody/Math.max(body,1e-12);
    const strongShape=directed&&metrics.closeLocation>=.75&&metrics.wickToBody<=.35&&outsideBodyShare>=.25;
    // An unfinished 5m candle may switch to 1m only while it is STILL several
    // times the recent average range. Once that body collapses, the old fast
    // qualification is gone; it cannot be carried forward from an earlier tick.
    const fast=strongShape&&multiple>=3&&metrics.bodyRate>=input.costRate*.75;
    const closed=(b.time+300)*1000<=now;
    // The slower path is still a real 5m breakout, not a marginal close outside.
    // Require a long body, a meaningful share of that body beyond the full box,
    // a strong close, and controlled adverse wick before looking at 1m follow-through.
    const accepted=closed&&directed&&body>=Math.max(range*1.20,averageBody*1.60,b.open*input.costRate*.90)
      &&outsideBodyShare>=.20&&metrics.closeLocation>=.72&&metrics.wickToBody<=.45;
    if(fast&&(!proof||proof.state==="CLOSED"))proof={state:"FAST",side,bar:b,bodyMultiple:multiple,
      reason:`5分钟实体为前期平均振幅${multiple.toFixed(2)}倍，且实体有${(outsideBodyShare*100).toFixed(0)}%已经真正离开完整边界；允许切换1分钟确认。`};
    else if(accepted&&!proof)proof={state:"CLOSED",side,bar:b,bodyMultiple:multiple,
      reason:`5分钟已用长实体在完整边界外有效收盘，实体外离占比${(outsideBodyShare*100).toFixed(0)}%；观察第一根1分钟强延续，或区间外小回调后的再次突破。`};
  }
  return proof?{...proof,current}:{state:"WAIT",current,reason:"5分钟尚未有效离开完整区间：未收盘需实体达到前期平均振幅3倍；较慢离区等收盘和后续确认，长影线不算突破。"};
}

/** The slow route starts AFTER the outside 5m close. It accepts either a
 * genuinely strong first 1m continuation beyond the closed 5m extreme, or a
 * shallow pullback followed by a close beyond the entire pullback high/low. */
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
    if(d*(b.close-input.boundary)<=0||giveback>body*.35||adverse>body*.45)
      return empty("FAIL","较慢离区后回到区间，或回调已超过原5分钟实体的35%/累计反向实体超过45%；不再属于小回调，本次离区失效。");
    const metrics=microDirectionalBar(b,side),beyond=side==="LONG"?b.close>oldHigh:b.close<oldLow;
    if(i===0&&!reversal&&beyond&&metrics.bodyRate>=Math.max(.0010,input.costRate*.40)
      &&metrics.closeLocation>=.78&&metrics.wickToBody<=.30){
      return{state:"READY",confirmation:"CONTINUATION",reason:"5分钟区间外收盘后，第一根完整1分钟K继续突破5分钟离区极值，实体、收盘位置与影线均满足强延续确认。",
        pullbackCloseRate:0,pullbackExtremeRate:Math.max(0,giveback)/bar.close,
        cumulativeAdverseBodyRate:adverse/bar.open,restartAt:(b.time+60)*1000,restartPrice:b.close,supportPrice:side==="LONG"?low:high};
    }
    if(hadPullback&&!reversal&&beyond&&metrics.bodyRate>=Math.max(.0008,input.costRate*.30)
      &&metrics.closeLocation>=.68&&metrics.wickToBody<=.45){
      return{state:"READY",confirmation:"PULLBACK_RESTART",reason:"5分钟区间外收盘后仅小回调，当前1分钟实体重新突破整段回调极值。",
        pullbackCloseRate:Math.max(0,giveback)/bar.close,pullbackExtremeRate:Math.max(0,giveback)/bar.close,
        cumulativeAdverseBodyRate:adverse/bar.open,restartAt:(b.time+60)*1000,restartPrice:b.close,supportPrice:side==="LONG"?low:high};
    }
    hadPullback=hadPullback||reversal;prior=b.close;
  }
  return empty("WAIT","5分钟已在区间外收盘；等待第一根1分钟强延续，或小回调后重新超过整段回调极值。");
}
