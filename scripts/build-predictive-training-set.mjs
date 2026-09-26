import {createWriteStream,readFileSync,writeFileSync} from "node:fs";
import {once} from "node:events";
import {buildPredictiveFeatures} from "../lib/predictive-path-features.ts";

const INPUT=process.env.PREDICTIVE_DATASET??"/tmp/gate-predictive-12m.json";
const ANCILLARY=process.env.PREDICTIVE_ANCILLARY??"/tmp/gate-predictive-ancillary.json";
const OUTPUT=process.env.PREDICTIVE_TRAINING_SET??"/tmp/predictive-training.jsonl";
const META=process.env.PREDICTIVE_TRAINING_META??"/tmp/predictive-training-meta.json";
const STRIDE=Math.max(1,Number(process.env.PREDICTIVE_STRIDE??3));
const raw=JSON.parse(readFileSync(INPUT,"utf8")),ancillaryRaw=JSON.parse(readFileSync(ANCILLARY,"utf8"));
if(raw.interval!=="5m")throw new Error("Predictive training set requires Gate 5m data");
const datasets=raw.datasets??[],seriesBySymbol=new Map(datasets.map(d=>[d.symbol,(d.rows??[]).filter(x=>x&&x.open>0&&x.close>0).sort((a,b)=>a.time-b.time)])),
  timeIndex=new Map();
for(const [symbol,rows] of seriesBySymbol)timeIndex.set(symbol,new Map(rows.map((row,i)=>[row.time,i])));
const breadth=new Map();
for(const rows of seriesBySymbol.values())for(let i=3;i<rows.length;i++){
  const r=rows[i].close/rows[i-3].close-1,v=breadth.get(rows[i].time)??{sum:0,count:0};v.sum+=Math.sign(r);v.count++;breadth.set(rows[i].time,v);
}
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
function firstTouch(path,entry,side){
  const target=side==="LONG"?entry*1.01:entry*.99,risk=side==="LONG"?entry*.995:entry*1.005;
  for(const bar of path){const t=side==="LONG"?bar.high>=target:bar.low<=target,r=side==="LONG"?bar.low<=risk:bar.high>=risk;
    if(t&&r)return null;if(t)return 1;if(r)return 0;}return null;
}
const out=createWriteStream(OUTPUT,{encoding:"utf8"});let count=0,featureNames=null;
for(const dataset of datasets){
  const rows=seriesBySymbol.get(dataset.symbol)??[];
  for(let i=60;i<rows.length-25;i+=STRIDE){
    const current=rows[i];if(current.time<Number(ancillaryRaw.from??0))continue;
    const feature=buildPredictiveFeatures({symbol:dataset.symbol,decisionAt:(current.time+300)*1000,bars5m:rows.slice(i-80,i+1),
      ancillary:ancillaryAt(dataset.symbol,current.time)});
    if(!feature)continue;if(!featureNames)featureNames=feature.names;
    if(feature.names.length!==featureNames.length||feature.names.some((x,j)=>x!==featureNames[j]))throw new Error("feature schema drift");
    const entry=current.close,path60=rows.slice(i+1,i+13),next10=rows.slice(i+1,i+3),ret={};
    for(const [k,h] of Object.entries({15:3,30:6,60:12,120:24}))ret[k]=rows[i+h].close/entry-1;
    const maxHigh=Math.max(...path60.map(x=>x.high)),minLow=Math.min(...path60.map(x=>x.low));
    const row={at:feature.decisionAt,symbol:dataset.symbol,x:feature.values,ret,
      longMfe:Math.max(0,maxHigh/entry-1),longMae:Math.max(0,1-minLow/entry),
      longTouch:firstTouch(path60,entry,"LONG"),shortTouch:firstTouch(path60,entry,"SHORT"),
      longRegret:Math.max(0,(entry-Math.min(...next10.map(x=>x.low)))/entry),
      shortRegret:Math.max(0,(Math.max(...next10.map(x=>x.high))-entry)/entry)};
    if(!out.write(JSON.stringify(row)+"\n"))await once(out,"drain");count++;
  }
}
out.end();await once(out,"finish");
if(count<20_000||!featureNames)throw new Error("insufficient predictive training rows "+count);
writeFileSync(META,JSON.stringify({version:"predictive-training-meta-v1",featureNames,rows:count,source:String(raw.source??"gate-5m")})+"\n");
console.log(JSON.stringify({output:OUTPUT,meta:META,rows:count,features:featureNames.length,featureNames},null,2));
