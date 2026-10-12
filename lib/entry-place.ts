type Bar={time:number;high:number;low:number;close:number;volume:number};

export type EntryPlace={action:"ALLOW"|"WAIT";reason:string};

const NEAR=0.0035;
const ACCEPT=0.002;

function completed(rows:Bar[]|undefined,now:number,barMs:number){
  return (rows??[]).filter(b=>b.time>0&&b.high>=b.low&&b.low>0&&b.close>0&&b.time*1000+barMs<=now)
    .sort((a,b)=>a.time-b.time);
}

function fold(rows:Bar[],bucketSec:number):Bar[]{
  const groups=new Map<number,Bar>();
  for(const bar of rows){
    const time=Math.floor(bar.time/bucketSec)*bucketSec,prev=groups.get(time);
    if(!prev)groups.set(time,{...bar,time});
    else groups.set(time,{...prev,high:Math.max(prev.high,bar.high),low:Math.min(prev.low,bar.low),close:bar.close,volume:prev.volume+bar.volume});
  }
  return [...groups.values()].sort((a,b)=>a.time-b.time);
}

function median(values:number[]){
  if(!values.length)return 0;
  const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]!:(sorted[mid-1]!+sorted[mid]!)/2;
}

/** Where a frozen plan may fill. Direction is already chosen. This only refuses
 * the print at a wall, the wrong half of the range, or a stop inside the noise. */
export function placeEntry(input:{
  side:"LONG"|"SHORT";price:number;now:number;fiveMinute?:Bar[];daily?:Bar[];minute?:Bar[];invalidation:number|null;
}):EntryPlace{
  const daily=completed(input.daily,input.now,86_400_000);
  const five=completed(input.fiveMinute,input.now,300_000);
  const bars=daily.length>=30?daily:fold(five,14_400).length>=20?fold(five,14_400):[];
  if(bars.length<15||!(input.price>0))return {action:"ALLOW",reason:""};
  let high=bars[0]!.high,highAt=bars[0]!.time,low=bars[0]!.low,lowAt=bars[0]!.time,acceptedHighAt=-1,acceptedLowAt=-1;
  for(const bar of bars.slice(1)){
    if(bar.close>high*(1+ACCEPT))acceptedHighAt=bar.time;
    else if(bar.high>high){high=bar.high;highAt=bar.time;}
    if(bar.close<low*(1-ACCEPT))acceptedLowAt=bar.time;
    else if(bar.low<low){low=bar.low;lowAt=bar.time;}
  }
  if(!(high>low)||bars.length<15)return {action:"ALLOW",reason:""};
  const span=high-low,pos=(input.price-low)/span;
  const laterHigh=bars.filter(bar=>bar.time>highAt);
  const laterLow=bars.filter(bar=>bar.time>lowAt);
  const highTouches=laterHigh.filter(bar=>bar.high>=high*(1-NEAR)&&bar.close<=high*(1+0.001)).length;
  const lowTouches=laterLow.filter(bar=>bar.low<=low*(1+NEAR)&&bar.close>=low*(1-0.001)).length;
  const acceptedHigh=acceptedHighAt>highAt&&input.price>high;
  const acceptedLow=acceptedLowAt>lowAt&&input.price<low;
  const atHigh=input.price>=high*(1-NEAR)&&input.price<=high*(1+0.004);
  const atLow=input.price<=low*(1+NEAR)&&input.price>=low*(1-0.004);

  let decision:EntryPlace;
  if(acceptedHigh)decision=input.side==="LONG"
    ?{action:"ALLOW",reason:""}
    :{action:"WAIT",reason:"前高已经站稳，这一段不做空。"};
  else if(acceptedLow)decision=input.side==="SHORT"
    ?{action:"ALLOW",reason:""}
    :{action:"WAIT",reason:"前低已经跌破并留在下面，这一段不做多。"};
  else if(atHigh)decision={action:"WAIT",reason:highTouches<=1
    ?"第一次接近前高，这个位置先当压力，不在这一下成交。":"前高已经被多次接近，不在这个价位成交，等价格离开再做。"};
  else if(atLow)decision={action:"WAIT",reason:lowTouches<=1
    ?"第一次接近前低，这个位置先当支撑，不在这一下成交。":"前低已经被多次接近，不在这个价位成交，等价格离开再做。"};
  else if(input.side==="LONG"&&pos>=0.58&&pos<=0.90)decision={action:"ALLOW",reason:""};
  else if(input.side==="SHORT"&&pos>=0.10&&pos<=0.42)decision={action:"ALLOW",reason:""};
  else if(input.side==="LONG")decision={action:"WAIT",reason:"做多要在中间偏上成交，现在还没到这个位置。"};
  else decision={action:"WAIT",reason:"做空要在中间偏下成交，现在还没到这个位置。"};

  if(decision.action!=="ALLOW")return decision;
  const noise=median(completed(input.minute,input.now,60_000).slice(-8).map(bar=>(bar.high-bar.low)/bar.close));
  const invalid=input.invalidation;
  const distance=invalid!=null&&invalid>0
    ?(input.side==="LONG"?(input.price-invalid)/input.price:(invalid-input.price)/input.price)
    :null;
  if(distance!=null&&distance<Math.max(noise,0.0015))
    return {action:"WAIT",reason:"成交价离失效位比最近1分钟的正常波动还近，等它离失效位再远一点。"};
  return {action:"ALLOW",reason:""};
}
