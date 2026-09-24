import type { RegionCandle } from "./region-lifecycle.ts";

export type RegionOpportunitySide="LONG"|"SHORT";
export type RegionBarrier={
  side:RegionOpportunitySide;lower:number;upper:number;touches:number;lastAt:number;strength:number;
};
export type RegionOpportunityStructure={
  averageRange:number;
  longBarrier:RegionBarrier|null;shortBarrier:RegionBarrier|null;
  nextLongBarrier:RegionBarrier|null;nextShortBarrier:RegionBarrier|null;
  longTrigger:number;shortTrigger:number;
};

const completeAt=(row:RegionCandle)=>row.time*1000+300_000;
const finite=(v:number)=>Number.isFinite(v);
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const median=(values:number[])=>{
  const a=values.filter(finite).sort((x,y)=>x-y);
  if(!a.length)return 0;
  return a.length%2?a[(a.length-1)/2]!:(a[a.length/2-1]!+a[a.length/2]!)/2;
};
const valid=(row:RegionCandle)=>[row.time,row.open,row.high,row.low,row.close,row.volume].every(finite)
  &&row.time>0&&row.open>0&&row.close>0&&row.low>0&&row.high>=Math.max(row.open,row.close)
  &&row.low<=Math.min(row.open,row.close)&&row.volume>=0;

function barrierClusters(input:{
  rows:RegionCandle[];side:RegionOpportunitySide;lower:number;upper:number;center:number;width:number;
  averageRange:number;costRate:number;cutoff:number;
}):RegionBarrier[]{
  const rows=input.rows.filter(row=>valid(row)&&completeAt(row)<=input.cutoff).sort((a,b)=>a.time-b.time).slice(-96);
  if(rows.length<7)return[];
  const merge=Math.max(input.width*.12,input.averageRange*.60,input.center*input.costRate*.35);
  // Very small excursions immediately outside the accepted region are boundary
  // probes, not a separate pressure/support layer. A distinct obstacle must be
  // materially separated from the region before it can move the effective trigger.
  const minGap=Math.max(input.width*.12,input.averageRange*.40,input.center*input.costRate*.25);
  const maxDistance=Math.max(input.width*3,input.averageRange*10,input.center*.035);
  const raw:Array<{price:number;reject:number;at:number}>=[];
  for(let i=2;i<rows.length-3;i++){
    const row=rows[i]!,prev=rows.slice(i-2,i),next=rows.slice(i+1,i+3),future=rows.slice(i+1,i+4);
    if(input.side==="LONG"){
      const price=row.high;
      const local=prev.every(x=>price>=x.high)&&next.every(x=>price>=x.high);
      const reject=price-Math.min(...future.map(x=>x.close));
      if(local&&price>input.upper+minGap&&price-input.upper<=maxDistance
        &&reject>=Math.max(input.averageRange*.45,input.width*.05))raw.push({price,reject,at:completeAt(row)});
    }else{
      const price=row.low;
      const local=prev.every(x=>price<=x.low)&&next.every(x=>price<=x.low);
      const reject=Math.max(...future.map(x=>x.close))-price;
      if(local&&price<input.lower-minGap&&input.lower-price<=maxDistance
        &&reject>=Math.max(input.averageRange*.45,input.width*.05))raw.push({price,reject,at:completeAt(row)});
    }
  }
  const ordered=raw.sort((a,b)=>a.price-b.price),clusters:Array<{prices:number[];reject:number;at:number}>=[];
  for(const row of ordered){
    const last=clusters.at(-1),anchor=last?median(last.prices):NaN;
    if(last&&Math.abs(row.price-anchor)<=merge){last.prices.push(row.price);last.reject=Math.max(last.reject,row.reject);last.at=Math.max(last.at,row.at);}
    else clusters.push({prices:[row.price],reject:row.reject,at:row.at});
  }
  const significant=clusters.filter(c=>c.prices.length>=2||c.reject>=Math.max(input.averageRange*1.10,input.width*.18)).map(c=>{
    const lower=Math.min(...c.prices),upper=Math.max(...c.prices),touches=c.prices.length;
    const rejectionScore=clip(c.reject/Math.max(input.averageRange,input.width*.10,1e-12)/2);
    const touchScore=clip((touches-1)/3);
    return{side:input.side,lower,upper,touches,lastAt:c.at,strength:clip(.55+rejectionScore*.25+touchScore*.20)} satisfies RegionBarrier;
  });
  return input.side==="LONG"
    ?significant.sort((a,b)=>a.lower-b.lower||b.strength-a.strength)
    :significant.sort((a,b)=>b.upper-a.upper||b.strength-a.strength);
}

function chainTrigger(input:{side:RegionOpportunitySide;boundary:number;width:number;center:number;averageRange:number;costRate:number;barriers:RegionBarrier[]}){
  // Only the nearest meaningful obstacle is allowed to replace the region edge
  // as the effective trigger. Stacking several historical levels into one giant
  // hurdle would recreate the old "wait for a special setup" problem and hide
  // valid opportunities. A farther level is kept only as remaining-space context.
  const nearGap=Math.max(input.width*1.50,input.averageRange*4,input.center*input.costRate*4);
  const distinctGap=Math.max(input.width*.06,input.averageRange*.30,input.center*input.costRate*.20);
  const first=input.barriers.find(barrier=>{
    const gap=input.side==="LONG"?barrier.lower-input.boundary:input.boundary-barrier.upper;
    return gap>=-distinctGap;
  })??null;
  const use=first&&((input.side==="LONG"?first.lower-input.boundary:input.boundary-first.upper)<=nearGap)?first:null;
  const trigger=use?(input.side==="LONG"?Math.max(input.boundary,use.upper):Math.min(input.boundary,use.lower)):input.boundary;
  const next=input.barriers.find(barrier=>{
    if(barrier===use)return false;
    const gap=input.side==="LONG"?barrier.lower-trigger:trigger-barrier.upper;
    return gap>distinctGap;
  })??null;
  return{trigger,used:use,next};
}

export function detectRegionOpportunityStructure(input:{
  rows:RegionCandle[];lower:number;upper:number;center:number;width:number;confirmedAt:number;now:number;costRate:number;departureAt?:number|null;
}):RegionOpportunityStructure{
  const completed=input.rows.filter(row=>valid(row)&&completeAt(row)<=input.now).sort((a,b)=>a.time-b.time);
  const reference=completed.slice(-24);
  const averageRange=Math.max(input.center*.0002,median(reference.map(row=>row.high-row.low)),input.width*.08);
  const cutoff=Math.min(input.now,(input.departureAt??input.now)-1);
  const long=barrierClusters({...input,rows:completed,side:"LONG",averageRange,cutoff});
  const short=barrierClusters({...input,rows:completed,side:"SHORT",averageRange,cutoff});
  const longChain=chainTrigger({side:"LONG",boundary:input.upper,width:input.width,center:input.center,averageRange,costRate:input.costRate,barriers:long});
  const shortChain=chainTrigger({side:"SHORT",boundary:input.lower,width:input.width,center:input.center,averageRange,costRate:input.costRate,barriers:short});
  return{averageRange,longBarrier:longChain.used,shortBarrier:shortChain.used,nextLongBarrier:longChain.next,nextShortBarrier:shortChain.next,
    longTrigger:longChain.trigger,shortTrigger:shortChain.trigger};
}

export function regionOpportunityMaxChase(input:{
  side:RegionOpportunitySide;trigger:number;regionWidth:number;center:number;costRate:number;nextBarrier?:RegionBarrier|null;
}){
  const structural=input.regionWidth/Math.max(input.trigger,1e-12)*.35;
  const nextSpace=input.nextBarrier
    ?(input.side==="LONG"?input.nextBarrier.lower-input.trigger:input.trigger-input.nextBarrier.upper)/Math.max(input.trigger,1e-12)*.30
    :Infinity;
  const raw=Math.min(.006,structural,nextSpace);
  return Math.max(Math.max(.0008,input.costRate*.35),Number.isFinite(raw)&&raw>0?raw:structural);
}

export function regionOpportunityExpectedMove(input:{
  side:RegionOpportunitySide;trigger:number;regionWidth:number;averageRange:number;costRate:number;nextBarrier?:RegionBarrier|null;
}){
  const base=Math.max(input.costRate*2.2,input.regionWidth/Math.max(input.trigger,1e-12)*.80,
    input.averageRange/Math.max(input.trigger,1e-12)*2.2);
  const cap=input.nextBarrier
    ?Math.max(0,(input.side==="LONG"?input.nextBarrier.lower-input.trigger:input.trigger-input.nextBarrier.upper)/Math.max(input.trigger,1e-12)*.82)
    :.08;
  return Math.max(0,Math.min(.08,base,cap||base));
}

function minuteMetrics(row:RegionCandle,side:RegionOpportunitySide){
  const d=side==="LONG"?1:-1,range=Math.max(row.high-row.low,1e-12),body=Math.max(0,d*(row.close-row.open));
  const wick=side==="LONG"?Math.max(0,row.high-Math.max(row.open,row.close)):Math.max(0,Math.min(row.open,row.close)-row.low);
  const closeLocation=side==="LONG"?(row.close-row.low)/range:(row.high-row.close)/range;
  return{bodyRate:body/Math.max(row.open,1e-12),wickToBody:wick/Math.max(body,1e-12),closeLocation:clip(closeLocation)};
}

export type RegionRotationSetup={
  side:RegionOpportunitySide;at:number;price:number;stop:number;target:number;reason:string;
};

export function findRegionRotationSetup(input:{
  minutes:RegionCandle[];side:RegionOpportunitySide;lower:number;upper:number;center:number;width:number;now:number;costRate:number;consumedAt?:number|null;
}):RegionRotationSetup|null{
  if(input.consumedAt!=null)return null;
  const rows=input.minutes.filter(row=>valid(row)&&(row.time+60)*1000<=input.now).sort((a,b)=>a.time-b.time).slice(-8);
  if(rows.length<2)return null;
  const latest=rows.at(-1)!;if(input.now-(latest.time+60)*1000>75_000)return null;
  const edgeBand=input.width*.20,reclaim=input.width*.08,buffer=Math.max(input.width*.06,input.center*input.costRate*.25);
  const candidates=rows.slice(0,-1).slice(-5);
  if(input.side==="LONG"){
    if(latest.close>=input.center-input.width*.05)return null;
    const probe=[...candidates].reverse().find(row=>row.low<=input.lower+edgeBand&&row.close<=input.lower+input.width*.28);
    if(!probe)return null;
    const since=rows.filter(row=>row.time>=probe.time),metrics=minuteMetrics(latest,"LONG"),prior=rows.at(-2)!;
    const resumed=latest.close>latest.open&&latest.close>=input.lower+reclaim&&latest.close>Math.max(probe.close,prior.close)
      &&metrics.bodyRate>=Math.max(.0007,input.costRate*.25)&&metrics.closeLocation>=.66&&metrics.wickToBody<=.65;
    const stop=Math.min(...since.map(row=>row.low))-buffer,target=input.center;
    const reward=(target-latest.close)/Math.max(latest.close,1e-12),risk=(latest.close-stop)/Math.max(latest.close,1e-12);
    if(!resumed||reward<=input.costRate*1.15||reward/Math.max(risk+input.costRate,1e-12)<1)return null;
    return{side:"LONG",at:(latest.time+60)*1000,price:latest.close,stop,target,
      reason:"区域下沿进入外侧边缘后出现拒绝，1分钟重新收回并恢复向上；按区域轮转参与，第一目标为区域中心。"};
  }
  if(latest.close<=input.center+input.width*.05)return null;
  const probe=[...candidates].reverse().find(row=>row.high>=input.upper-edgeBand&&row.close>=input.upper-input.width*.28);
  if(!probe)return null;
  const since=rows.filter(row=>row.time>=probe.time),metrics=minuteMetrics(latest,"SHORT"),prior=rows.at(-2)!;
  const resumed=latest.close<latest.open&&latest.close<=input.upper-reclaim&&latest.close<Math.min(probe.close,prior.close)
    &&metrics.bodyRate>=Math.max(.0007,input.costRate*.25)&&metrics.closeLocation>=.66&&metrics.wickToBody<=.65;
  const stop=Math.max(...since.map(row=>row.high))+buffer,target=input.center;
  const reward=(latest.close-target)/Math.max(latest.close,1e-12),risk=(stop-latest.close)/Math.max(latest.close,1e-12);
  if(!resumed||reward<=input.costRate*1.15||reward/Math.max(risk+input.costRate,1e-12)<1)return null;
  return{side:"SHORT",at:(latest.time+60)*1000,price:latest.close,stop,target,
    reason:"区域上沿进入外侧边缘后出现拒绝，1分钟重新收回并恢复向下；按区域轮转参与，第一目标为区域中心。"};
}

export type RegionRetestSetup={
  state:"WAIT"|"FAIL"|"READY";side:RegionOpportunitySide;reason:string;at:number|null;price:number|null;stop:number|null;
};

export function findRegionRetestSetup(input:{
  minutes:RegionCandle[];side:RegionOpportunitySide;trigger:number;releaseAt:number;width:number;center:number;now:number;costRate:number;
}):RegionRetestSetup{
  const rows=input.minutes.filter(row=>valid(row)&&(row.time+60)*1000<=input.now&&(row.time+60)*1000>input.releaseAt)
    .sort((a,b)=>a.time-b.time).slice(-12);
  const empty=(state:"WAIT"|"FAIL",reason:string):RegionRetestSetup=>({state,side:input.side,reason,at:null,price:null,stop:null});
  if(!rows.length)return empty("WAIT","突破已经成立；等待价格第一次回踩有效触发位。");
  const latest=rows.at(-1)!;if(input.now-(latest.time+60)*1000>75_000)return empty("WAIT","回踩路径不是当前新鲜1分钟数据；只继续观察，不补历史成交。");
  const tolerance=Math.max(input.width*.15,input.center*input.costRate*.40);
  const invalidDepth=Math.max(input.width*.20,input.trigger*input.costRate*.35);
  if(input.side==="LONG"&&latest.close<input.trigger-invalidDepth)return empty("FAIL","价格已经重新被有效触发位下方接受；原向上释放失效。");
  if(input.side==="SHORT"&&latest.close>input.trigger+invalidDepth)return empty("FAIL","价格已经重新被有效触发位上方接受；原向下释放失效。");
  const priorRows=rows.slice(0,-1);
  const touchIndex=priorRows.findLastIndex(row=>input.side==="LONG"
    ?row.low<=input.trigger+tolerance&&row.close>=input.trigger-invalidDepth
    :row.high>=input.trigger-tolerance&&row.close<=input.trigger+invalidDepth);
  if(touchIndex<0)return empty("WAIT","第一波已离开有效触发位，但尚未完成一次可定义风险的回踩。");
  const touched=priorRows.slice(touchIndex),metrics=minuteMetrics(latest,input.side),prior=rows.at(-2)!;
  const restart=input.side==="LONG"
    ?latest.close>prior.high&&latest.close>input.trigger&&latest.close>latest.open
    :latest.close<prior.low&&latest.close<input.trigger&&latest.close<latest.open;
  if(!restart||metrics.bodyRate<Math.max(.0008,input.costRate*.25)||metrics.closeLocation<.67||metrics.wickToBody>.60)
    return empty("WAIT","已经回踩有效触发位，但1分钟还没有重新顺向突破回踩局部极值。");
  const buffer=Math.max(input.width*.06,input.center*input.costRate*.25);
  const stop=input.side==="LONG"?Math.min(...touched.map(row=>row.low),latest.low)-buffer:Math.max(...touched.map(row=>row.high),latest.high)+buffer;
  return{state:"READY",side:input.side,reason:"有效触发位第一次回踩没有被重新接受，1分钟重新突破回踩局部极值；允许第二次参与。",
    at:(latest.time+60)*1000,price:latest.close,stop};
}
