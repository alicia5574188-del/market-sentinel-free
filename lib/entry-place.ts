type Bar={time:number;high:number;low:number;close:number;volume:number};

export type EntryPlace={action:"ALLOW"|"WAIT";reason:string;location:EntryLocation};
export type CycleLocation={
  scale:"日线"|"4小时"|"30分钟";pos:number|null;zone:string;
  highTouches:number|null;lowTouches:number|null;priorHigh:number|null;priorLow:number|null;
};
export type EntryLocation={cycles:CycleLocation[]};

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

function readRange(bars:Bar[],price:number){
  let high=bars[0]!.high,highAt=bars[0]!.time,low=bars[0]!.low,lowAt=bars[0]!.time,acceptedHighAt=-1,acceptedLowAt=-1;
  for(const bar of bars.slice(1)){
    if(bar.close>high*(1+ACCEPT))acceptedHighAt=bar.time;
    else if(bar.high>high){high=bar.high;highAt=bar.time;}
    if(bar.close<low*(1-ACCEPT))acceptedLowAt=bar.time;
    else if(bar.low<low){low=bar.low;lowAt=bar.time;}
  }
  if(!(high>low)||!(price>0))return null;
  const laterHigh=bars.filter(bar=>bar.time>highAt),laterLow=bars.filter(bar=>bar.time>lowAt);
  return {high,low,pos:(price-low)/(high-low),
    highTouches:laterHigh.filter(bar=>bar.high>=high*(1-NEAR)&&bar.close<=high*(1+0.001)).length,
    lowTouches:laterLow.filter(bar=>bar.low<=low*(1+NEAR)&&bar.close>=low*(1-0.001)).length,
    acceptedHigh:acceptedHighAt>highAt&&price>high,acceptedLow:acceptedLowAt>lowAt&&price<low,
    atHigh:price>=high*(1-NEAR)&&price<=high*(1+0.004),atLow:price<=low*(1+NEAR)&&price>=low*(1-0.004)};
}

function zoneOf(range:NonNullable<ReturnType<typeof readRange>>){
  if(range.acceptedHigh)return "前高已站稳";
  if(range.acceptedLow)return "前低已跌破";
  if(range.atHigh)return range.highTouches<=1?"第一次接近前高":"多次接近前高";
  if(range.atLow)return range.lowTouches<=1?"第一次接近前低":"多次接近前低";
  if(range.pos>=0.58&&range.pos<=0.90)return "中间偏上";
  if(range.pos>=0.10&&range.pos<=0.42)return "中间偏下";
  if(range.pos>0.90)return "偏高";
  if(range.pos<0.10)return "偏低";
  return "中间";
}

function cycle(scale:CycleLocation["scale"],bars:Bar[],price:number,minimum:number):CycleLocation{
  const range=bars.length>=minimum?readRange(bars,price):null;
  if(!range)return {scale,pos:null,zone:"样本不足",highTouches:null,lowTouches:null,priorHigh:null,priorLow:null};
  return {scale,pos:Number(range.pos.toFixed(4)),zone:zoneOf(range),highTouches:range.highTouches,lowTouches:range.lowTouches,
    priorHigh:range.high,priorLow:range.low};
}

/** Where a frozen plan may fill. Direction is already chosen. This only refuses
 * the print at a wall, the wrong half of the range, or a stop inside the noise. */
export function placeEntry(input:{
  side:"LONG"|"SHORT";price:number;now:number;fiveMinute?:Bar[];daily?:Bar[];minute?:Bar[];invalidation:number|null;
}):EntryPlace{
  const daily=completed(input.daily,input.now,86_400_000);
  const five=completed(input.fiveMinute,input.now,300_000);
  const four=fold(five,14_400);
  const location:EntryLocation={cycles:[
    cycle("日线",daily,input.price,30),
    cycle("4小时",four,input.price,20),
    cycle("30分钟",five.slice(-6),input.price,6),
  ]};
  const bars=daily.length>=30?daily:four.length>=20?four:[];
  const range=bars.length>=15?readRange(bars,input.price):null;
  if(!range)return {action:"ALLOW",reason:"",location};
  let decision:EntryPlace;
  if(range.acceptedHigh)decision=input.side==="LONG"
    ?{action:"ALLOW",reason:"",location}
    :{action:"WAIT",reason:"前高已经站稳，这一段不做空。",location};
  else if(range.acceptedLow)decision=input.side==="SHORT"
    ?{action:"ALLOW",reason:"",location}
    :{action:"WAIT",reason:"前低已经跌破并留在下面，这一段不做多。",location};
  else if(range.atHigh)decision={action:"WAIT",reason:range.highTouches<=1
    ?"第一次接近前高，这个位置先当压力，不在这一下成交。":"前高已经被多次接近，不在这个价位成交，等价格离开再做。",location};
  else if(range.atLow)decision={action:"WAIT",reason:range.lowTouches<=1
    ?"第一次接近前低，这个位置先当支撑，不在这一下成交。":"前低已经被多次接近，不在这个价位成交，等价格离开再做。",location};
  else if(input.side==="LONG"&&range.pos>=0.58&&range.pos<=0.90)decision={action:"ALLOW",reason:"",location};
  else if(input.side==="SHORT"&&range.pos>=0.10&&range.pos<=0.42)decision={action:"ALLOW",reason:"",location};
  else if(input.side==="LONG")decision={action:"WAIT",reason:"做多要在中间偏上成交，现在还没到这个位置。",location};
  else decision={action:"WAIT",reason:"做空要在中间偏下成交，现在还没到这个位置。",location};
  if(decision.action!=="ALLOW")return decision;
  const noise=median(completed(input.minute,input.now,60_000).slice(-8).map(bar=>(bar.high-bar.low)/bar.close));
  const invalid=input.invalidation;
  const distance=invalid!=null&&invalid>0
    ?(input.side==="LONG"?(input.price-invalid)/input.price:(invalid-input.price)/input.price)
    :null;
  if(distance!=null&&distance<Math.max(noise,0.0015))
    return {action:"WAIT",reason:"成交价离失效位比最近1分钟的正常波动还近，等它离失效位再远一点。",location};
  return decision;
}
