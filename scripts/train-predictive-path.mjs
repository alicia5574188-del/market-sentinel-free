import {readFileSync,writeFileSync} from "node:fs";
import {buildPredictiveFeatures} from "../lib/predictive-path-features.ts";

const INPUT=process.env.PREDICTIVE_DATASET??"/tmp/gate-predictive-12m.json";
const ANCILLARY=process.env.PREDICTIVE_ANCILLARY??"/tmp/gate-predictive-ancillary.json";
const OUTPUT=process.env.PREDICTIVE_ARTIFACT??"lib/predictive-path-artifact-v1.json";
const raw=JSON.parse(readFileSync(INPUT,"utf8"));
const ancillaryRaw=JSON.parse(readFileSync(ANCILLARY,"utf8"));
if(raw.interval!=="5m")throw new Error("Predictive trainer requires Gate 5m dataset");
const horizons={15:3,30:6,60:12,120:24},STRIDE=Math.max(1,Number(process.env.PREDICTIVE_STRIDE??3)),
  MAX_SAMPLES=Math.max(20_000,Number(process.env.PREDICTIVE_MAX_SAMPLES??260_000)),COST=.0019;
const datasets=raw.datasets??[],seriesBySymbol=new Map(datasets.map(d=>[d.symbol,(d.rows??[]).filter(x=>x&&x.open>0&&x.close>0).sort((a,b)=>a.time-b.time)]));
const timeIndex=new Map();
for(const [symbol,rows] of seriesBySymbol)timeIndex.set(symbol,new Map(rows.map((row,i)=>[row.time,i])));
const breadth=new Map();
for(const rows of seriesBySymbol.values())for(let i=3;i<rows.length;i++){const r=rows[i].close/rows[i-3].close-1,v=breadth.get(rows[i].time)??{sum:0,count:0};v.sum+=Math.sign(r);v.count++;breadth.set(rows[i].time,v);}
function priorAt(rows,time){let lo=0,hi=rows.length-1,best=-1;while(lo<=hi){const m=(lo+hi)>>1;if(Number(rows[m].time)<=time){best=m;lo=m+1;}else hi=m-1;}return best;}
function marketReturn(symbol,time,bars){const rows=seriesBySymbol.get(symbol),idx=timeIndex.get(symbol)?.get(time);return rows&&idx!=null&&idx>=bars?rows[idx].close/rows[idx-bars].close-1:0;}
function ancillaryAt(symbol,time){
  const d=ancillaryRaw.datasets?.[symbol]??{},stats=d.stats??[],funding=d.funding??[],premium=d.premium??[],
    si=priorAt(stats,time),fi=priorAt(funding,time),pi=priorAt(premium,time),s=si>=0?stats[si]:null,prev=si>0?stats[si-1]:null,
    oi=Number(s?.openInterestUsd??s?.openInterest??0),prevOi=Number(prev?.openInterestUsd??prev?.openInterest??0),
    longLiq=Number(s?.longLiqUsd??0),shortLiq=Number(s?.shortLiqUsd??0),liqSum=longLiq+shortLiq,b=breadth.get(time);
  return{fundingRate:fi>=0?Number(funding[fi].rate??0):0,basisRate:pi>=0?Number(premium[pi].close??0):0,
    openInterest:oi,openInterestChangeRate:prevOi>0?oi/prevOi-1:0,
    liquidationLongNotionalRate:oi>0?longLiq/oi:0,liquidationShortNotionalRate:oi>0?shortLiq/oi:0,
    liquidationImbalance:liqSum>0?(shortLiq-longLiq)/liqSum:0,
    takerLongShortLog:Number(s?.lsrTaker)>0?Math.log(Number(s.lsrTaker)):0,
    accountLongShortLog:Number(s?.lsrAccount)>0?Math.log(Number(s.lsrAccount)):0,
    topLongShortLog:Number(s?.topLsrSize)>0?Math.log(Number(s.topLsrSize)):0,
    btcReturn15m:marketReturn("BTC_USDT",time,3),btcReturn60m:marketReturn("BTC_USDT",time,12),
    ethReturn15m:marketReturn("ETH_USDT",time,3),ethReturn60m:marketReturn("ETH_USDT",time,12),
    marketBreadth:b?.count?b.sum/b.count:0};
}
const samples=[];
for(const dataset of datasets){
  const rows=(dataset.rows??[]).filter(x=>x&&x.open>0&&x.high>=x.low&&x.low>0&&x.close>0).sort((a,b)=>a.time-b.time);
  for(let i=60;i<rows.length-25;i+=STRIDE){
    const current=rows[i],bars=rows.slice(i-80,i+1),feature=buildPredictiveFeatures({symbol:dataset.symbol,decisionAt:(current.time+300)*1000,bars5m:bars,
      ancillary:ancillaryAt(dataset.symbol,current.time)});
    if(!feature)continue;
    const entry=current.close,ret={},future={};
    for(const [k,h] of Object.entries(horizons)){const end=rows[i+h];ret[k]=end.close/entry-1;future[k]=end;}
    const path60=rows.slice(i+1,i+13),maxHigh=Math.max(...path60.map(x=>x.high)),minLow=Math.min(...path60.map(x=>x.low));
    const longMfe=Math.max(0,maxHigh/entry-1),longMae=Math.max(0,1-minLow/entry),shortMfe=longMae,shortMae=longMfe;
    const touch=(side)=>{
      const target=side==="LONG"?entry*1.01:entry*.99,risk=side==="LONG"?entry*.995:entry*1.005;
      for(const bar of path60){const t=side==="LONG"?bar.high>=target:bar.low<=target,r=side==="LONG"?bar.low<=risk:bar.high>=risk;
        if(t&&r)return null;if(t)return 1;if(r)return 0;}return null;
    };
    const next10=rows.slice(i+1,i+3),longRegret=Math.max(0,(entry-Math.min(...next10.map(x=>x.low)))/entry),
      shortRegret=Math.max(0,(Math.max(...next10.map(x=>x.high))-entry)/entry);
    samples.push({at:feature.decisionAt,x:feature.values,names:feature.names,ret,longMfe,longMae,shortMfe,shortMae,
      longTouch:touch("LONG"),shortTouch:touch("SHORT"),longRegret,shortRegret});
  }
}
if(samples.length<20_000)throw new Error("Insufficient predictive samples: "+samples.length);
samples.sort((a,b)=>a.at-b.at);
const step=Math.max(1,Math.floor(samples.length/MAX_SAMPLES)),used=samples.filter((_,i)=>i%step===0).slice(0,MAX_SAMPLES),
  n=used.length,t1=used[Math.floor(n*.70)].at,t2=used[Math.floor(n*.85)].at,embargo=120*60_000,
  train=used.filter(s=>s.at<t1-embargo),validation=used.filter(s=>s.at>=t1&&s.at<t2-embargo),test=used.filter(s=>s.at>=t2);
if(!train.length||!validation.length||!test.length)throw new Error("Predictive split empty");
const featureNames=train[0].names;
if(used.some(s=>s.names.length!==featureNames.length||s.names.some((x,i)=>x!==featureNames[i])))throw new Error("Feature schema drift");
const width=featureNames.length,mean=Array(width).fill(0),scale=Array(width).fill(0);
for(const s of train)for(let j=0;j<width;j++)mean[j]+=s.x[j]/train.length;
for(const s of train)for(let j=0;j<width;j++)scale[j]+=(s.x[j]-mean[j])**2/train.length;
for(let j=0;j<width;j++){scale[j]=Math.sqrt(scale[j]);if(scale[j]<1e-6)scale[j]=1;}
const zx=(s)=>s.x.map((v,i)=>(v-mean[i])/scale[i]),clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),sigmoid=x=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
function fitLinear(rows,target,epochs=7,lr=.035,l2=.001){
  let b=0,w=Array(width).fill(0);
  for(let e=0;e<epochs;e++){let gb=0,gw=Array(width).fill(0),count=0;
    for(const s of rows){const y=clamp(target(s),-.15,.15);if(!Number.isFinite(y))continue;const x=zx(s),p=b+w.reduce((z,v,i)=>z+v*x[i],0),err=clamp(p-y,-.1,.1);
      gb+=err;for(let i=0;i<width;i++)gw[i]+=err*x[i];count++;}
    if(!count)continue;b-=lr*gb/count;for(let i=0;i<width;i++)w[i]-=lr*(gw[i]/count+l2*w[i]);}
  return{bias:b,weights:w};
}
function fitLogistic(rows,target,epochs=8,lr=.05,l2=.001){
  let b=0,w=Array(width).fill(0);
  const eligible=rows.filter(s=>target(s)===0||target(s)===1);
  for(let e=0;e<epochs;e++){let gb=0,gw=Array(width).fill(0);
    for(const s of eligible){const y=target(s),x=zx(s),z=b+w.reduce((q,v,i)=>q+v*x[i],0),err=sigmoid(z)-y;gb+=err;for(let i=0;i<width;i++)gw[i]+=err*x[i];}
    const count=Math.max(1,eligible.length);b-=lr*gb/count;for(let i=0;i<width;i++)w[i]-=lr*(gw[i]/count+l2*w[i]);}
  return{bias:b,weights:w};
}
function fitPlatt(head,rows,target){
  let a=1,b=0;const eligible=rows.filter(s=>target(s)===0||target(s)===1);
  for(let e=0;e<80;e++){let ga=0,gb=0;for(const s of eligible){const x=zx(s),z=head.bias+head.weights.reduce((q,v,i)=>q+v*x[i],0),p=sigmoid(a*z+b),err=p-target(s);ga+=err*z;gb+=err;}
    const n=Math.max(1,eligible.length);a-=.08*ga/n;b-=.08*gb/n;}return{a,b};
}
function calibrated(head,s){const x=zx(s),z=head.bias+head.weights.reduce((q,v,i)=>q+v*x[i],0),c=head.calibration;return sigmoid(c.a*z+c.b);}
function brier(head,rows,target){const eligible=rows.filter(s=>target(s)===0||target(s)===1);return eligible.reduce((n,s)=>n+(calibrated(head,s)-target(s))**2,0)/Math.max(1,eligible.length);}
function accuracy(head,rows,target){const eligible=rows.filter(s=>target(s)===0||target(s)===1);return eligible.reduce((n,s)=>n+Number((calibrated(head,s)>=.5)===(target(s)===1)),0)/Math.max(1,eligible.length);}
function mae(head,rows,target){return rows.reduce((n,s)=>{const x=zx(s),p=head.bias+head.weights.reduce((q,v,i)=>q+v*x[i],0);return n+Math.abs(p-target(s));},0)/rows.length;}
const direction={},expectedReturn={},metrics={trainSamples:train.length,validationSamples:validation.length,testSamples:test.length,totalSamples:used.length};
for(const h of [15,30,60,120]){
  const key=String(h),dh=fitLogistic(train,s=>Number(s.ret[key]>0));dh.calibration=fitPlatt(dh,validation,s=>Number(s.ret[key]>0));direction[key]=dh;
  expectedReturn[key]=fitLinear(train,s=>s.ret[key]);
  metrics["directionBrier"+key]=brier(dh,test,s=>Number(s.ret[key]>0));
  metrics["directionAccuracy"+key]=accuracy(dh,test,s=>Number(s.ret[key]>0));
  metrics["returnMae"+key]=mae(expectedReturn[key],test,s=>s.ret[key]);
}
const longTargetBeforeRisk60=fitLogistic(train,s=>s.longTouch);longTargetBeforeRisk60.calibration=fitPlatt(longTargetBeforeRisk60,validation,s=>s.longTouch);
const shortTargetBeforeRisk60=fitLogistic(train,s=>s.shortTouch);shortTargetBeforeRisk60.calibration=fitPlatt(shortTargetBeforeRisk60,validation,s=>s.shortTouch);
const longMfe60=fitLinear(train,s=>s.longMfe),longMae60=fitLinear(train,s=>s.longMae),shortMfe60=fitLinear(train,s=>s.shortMfe),shortMae60=fitLinear(train,s=>s.shortMae),
  longEntryRegret10=fitLinear(train,s=>s.longRegret),shortEntryRegret10=fitLinear(train,s=>s.shortRegret);
metrics.longTouchBrier=brier(longTargetBeforeRisk60,test,s=>s.longTouch);metrics.shortTouchBrier=brier(shortTargetBeforeRisk60,test,s=>s.shortTouch);
metrics.longMfeMae=mae(longMfe60,test,s=>s.longMfe);metrics.longMaeMae=mae(longMae60,test,s=>s.longMae);
metrics.longRegretMae=mae(longEntryRegret10,test,s=>s.longRegret);metrics.shortRegretMae=mae(shortEntryRegret10,test,s=>s.shortRegret);
const artifact={version:"predictive-path-v1",trainedAt:Date.now(),source:String(raw.source??"gate-5m")+"+gate-stats-funding-premium",featureNames,mean,scale,costRate:COST,horizons:[15,30,60,120],
  direction,expectedReturn,longMfe60,longMae60,shortMfe60,shortMae60,longTargetBeforeRisk60,shortTargetBeforeRisk60,longEntryRegret10,shortEntryRegret10,metrics};
writeFileSync(OUTPUT,JSON.stringify(artifact)+"\n");
console.log(JSON.stringify({output:OUTPUT,source:artifact.source,features:width,metrics},null,2));
