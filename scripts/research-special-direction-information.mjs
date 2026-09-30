import { readFileSync, writeFileSync } from 'node:fs';

const DATASET=process.env.RESEARCH_SIGNAL_DATASET??'/tmp/gate-history-direction-info-44m-1h.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/special-direction-information-44m.json';
const raw=JSON.parse(readFileSync(DATASET,'utf8'));
if(raw.interval!=='1h'||raw.months.length!==44||raw.symbols.length!==11)throw new Error('Requires frozen 44m / 11-symbol canonical 1h dataset');
const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>xs.length?sum(xs)/xs.length:0;
const median=xs=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b),m=Math.floor(ys.length/2);return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2;};
const quantile=(xs,q)=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b),p=(ys.length-1)*q,lo=Math.floor(p),hi=Math.ceil(p);return lo===hi?ys[lo]:ys[lo]+(ys[hi]-ys[lo])*(p-lo);};
const monthStart=m=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=raw.from*1000,toMs=raw.now*1000,discoveryEnd=monthStart(raw.months[30]),validationEnd=monthStart(raw.months[38]);
const ret=(rows,i,h)=>rows[i].close/rows[i-h].close-1,rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12);
function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+3600));return p;}

const byTime=new Map();
for(const {symbol,rows} of raw.datasets){
  const gp=gapPrefix(rows);
  for(let i=168;i<rows.length-5;i++){
    if(gp[i]!==gp[i-168]||rows[i+1].time!==rows[i].time+3600)continue;
    const prior24=rows.slice(i-24,i),f={symbol,rows,index:i,current:rows[i],r1:ret(rows,i,1),r4:ret(rows,i,4),r12:ret(rows,i,12),r24:ret(rows,i,24),r168:ret(rows,i,168),prev1:rows[i-1].close/rows[i-2].close-1,prev4:rows[i-1].close/rows[i-5].close-1,volumeRatio:rows[i].volume/Math.max(median(prior24.map(x=>x.volume)),1e-12),rangeRatio:rangeRate(rows[i])/Math.max(median(prior24.map(rangeRate)),1e-9)};
    const a=byTime.get(rows[i].time)??[];a.push(f);byTime.set(rows[i].time,a);
  }
}
const contexts=[];
for(const [time,rows] of byTime){
  if(rows.length<9)continue;
  const c={m1:median(rows.map(x=>x.r1)),m4:median(rows.map(x=>x.r4)),m12:median(rows.map(x=>x.r12)),m24:median(rows.map(x=>x.r24)),m168:median(rows.map(x=>x.r168)),pm1:median(rows.map(x=>x.prev1)),pm4:median(rows.map(x=>x.prev4)),b1u:rows.filter(x=>x.r1>0).length/rows.length,b4u:rows.filter(x=>x.r4>0).length/rows.length,b168u:rows.filter(x=>x.r168>0).length/rows.length};
  const es=rows.map(f=>({...f,rel1:f.r1-c.m1,rel4:f.r4-c.m4,rel12:f.r12-c.m12,rel24:f.r24-c.m24,rel168:f.r168-c.m168,prevRel1:f.prev1-c.pm1,prevRel4:f.prev4-c.pm4}));
  const scale4=Math.max(0.001,median(es.map(x=>Math.abs(x.rel4)))),dispersion24=median(es.map(x=>Math.abs(x.rel24))),dispersion168=median(es.map(x=>Math.abs(x.rel168)));
  contexts.push({time,rows:es,c,scale4,dispersion24,dispersion168});
}
contexts.sort((a,b)=>a.time-b.time);

const SPECIAL={minAbsRelative4:0.012,minRobustScore:1.8,minRunnerGap:0.002};
const events=[];let id=0;const lastEmit=new Map(),episode=new Map([[1,{symbol:null,age:0,lastTime:null}],[-1,{symbol:null,age:0,lastTime:null}]]);
for(const ctx of contexts){
  for(const direction of [1,-1]){
    const ranked=ctx.rows.filter(f=>direction*f.rel4>0).sort((a,b)=>direction*(b.rel4-a.rel4));if(ranked.length<2)continue;
    const f=ranked[0],magnitude=direction*f.rel4,runnerMagnitude=direction*ranked[1].rel4,runnerGap=Math.max(0,magnitude-runnerMagnitude),robustScore=magnitude/ctx.scale4;
    let ep=episode.get(direction);if(ep.symbol===f.symbol&&ep.lastTime===ctx.time-3600)ep={symbol:f.symbol,age:ep.age+1,lastTime:ctx.time};else ep={symbol:f.symbol,age:1,lastTime:ctx.time};episode.set(direction,ep);
    if(magnitude<SPECIAL.minAbsRelative4||robustScore<SPECIAL.minRobustScore||runnerGap<SPECIAL.minRunnerGap)continue;
    const dk=`${direction}:${f.symbol}`,last=lastEmit.get(dk)??-Infinity;if(ctx.time-last<7200)continue;lastEmit.set(dk,ctx.time);
    const b1=direction>0?ctx.c.b1u:1-ctx.c.b1u,b4=direction>0?ctx.c.b4u:1-ctx.c.b4u,b168=direction>0?ctx.c.b168u:1-ctx.c.b168u,d=new Date(ctx.time*1000),hour=d.getUTCHours();
    const features={
      magnitude,robustScore,runnerGap,
      relative1:direction*f.rel1,relative1Acceleration:direction*(f.rel1-f.prevRel1),relative4Acceleration:direction*(f.rel4-f.prevRel4),relative12:direction*f.rel12,relative24:direction*f.rel24,relative168:direction*f.rel168,
      own1:direction*f.r1,own24:direction*f.r24,own168:direction*f.r168,
      market1:direction*ctx.c.m1,market4:direction*ctx.c.m4,market24:direction*ctx.c.m24,market168:direction*ctx.c.m168,
      breadth1:b1,breadth4:b4,breadth168:b168,volumeRatio:f.volumeRatio,rangeRatio:f.rangeRatio,dispersion4:ctx.scale4,dispersion24:ctx.dispersion24,dispersion168:ctx.dispersion168,episodeAge:ep.age
    };
    const future={};for(const h of [2,4]){if(f.index+h<f.rows.length&&f.rows[f.index+h].time===f.current.time+h*3600)future[h]=direction*(f.rows[f.index+h].close/f.current.close-1);else future[h]=null;}
    events.push({id:id++,time:ctx.time,side:direction>0?'UP':'DOWN',direction,symbol:f.symbol,features,session:hour<8?'UTC_00_07':hour<16?'UTC_08_15':'UTC_16_23',weekend:[0,6].includes(d.getUTCDay())?'WEEKEND':'WEEKDAY',future});
  }
}
const FEATURE_NAMES=['magnitude','robustScore','runnerGap','relative1','relative1Acceleration','relative4Acceleration','relative12','relative24','relative168','own1','own24','own168','market1','market4','market24','market168','breadth1','breadth4','breadth168','volumeRatio','rangeRatio','dispersion4','dispersion24','dispersion168','episodeAge'];
const SIDES=['UP','DOWN'],HORIZONS=[2,4];
function monthKey(sec){const d=new Date(sec*1000);return`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
function summarize(xs,h,mode){const vals=xs.map(e=>e.future[h]).filter(v=>v!=null),signed=vals.map(v=>mode*v),months=new Map();for(const e of xs){const v=e.future[h];if(v==null)continue;const k=monthKey(e.time),a=months.get(k)??[];a.push(mode*v);months.set(k,a);}const mm=[...months.values()].map(mean);return{samples:vals.length,meanContinuation:mean(vals),meanSigned:mean(signed),hitRate:signed.length?signed.filter(v=>v>0).length/signed.length:0,activeMonths:mm.length,positiveSignedMonths:mm.filter(v=>v>0).length};}
const discoveryEvents=events.filter(e=>e.time*1000>=fromMs&&e.time*1000<discoveryEnd),validationEvents=events.filter(e=>e.time*1000>=discoveryEnd&&e.time*1000<validationEnd),evaluationEvents=events.filter(e=>e.time*1000>=validationEnd&&e.time*1000<toMs);
const cells=[];
for(const side of SIDES){
  const ds=discoveryEvents.filter(e=>e.side===side);
  for(const feature of FEATURE_NAMES){const vals=ds.map(e=>e.features[feature]),q33=quantile(vals,1/3),q67=quantile(vals,2/3);for(const bin of ['LOW','MID','HIGH'])for(const h of HORIZONS){const take=e=>bin==='LOW'?e.features[feature]<=q33:bin==='HIGH'?e.features[feature]>q67:e.features[feature]>q33&&e.features[feature]<=q67;const drows=ds.filter(take),rawMean=mean(drows.map(e=>e.future[h]).filter(v=>v!=null)),mode=rawMean>=0?1:-1,dstat=summarize(drows,h,mode);const vstat=summarize(validationEvents.filter(e=>e.side===side&&take(e)),h,mode),estat=summarize(evaluationEvents.filter(e=>e.side===side&&take(e)),h,mode);const discoveryQualified=dstat.samples>=250&&dstat.meanSigned>=0.0025&&dstat.hitRate>=0.54&&dstat.activeMonths>=18&&dstat.positiveSignedMonths>=Math.ceil(dstat.activeMonths*0.55);cells.push({kind:'FEATURE',side,feature,bin,horizonHours:h,q33,q67,mode:mode>0?'CONTINUE':'REVERSE',discovery:dstat,validation:vstat,evaluation:estat,discoveryQualified});}}
  for(const categorical of ['session','weekend']){const values=[...new Set(ds.map(e=>e[categorical]))];for(const value of values)for(const h of HORIZONS){const take=e=>e[categorical]===value,drows=ds.filter(take),rawMean=mean(drows.map(e=>e.future[h]).filter(v=>v!=null)),mode=rawMean>=0?1:-1,dstat=summarize(drows,h,mode),vstat=summarize(validationEvents.filter(e=>e.side===side&&take(e)),h,mode),estat=summarize(evaluationEvents.filter(e=>e.side===side&&take(e)),h,mode),discoveryQualified=dstat.samples>=250&&dstat.meanSigned>=0.0025&&dstat.hitRate>=0.54&&dstat.activeMonths>=18&&dstat.positiveSignedMonths>=Math.ceil(dstat.activeMonths*0.55);cells.push({kind:'CATEGORY',side,feature:categorical,bin:value,horizonHours:h,mode:mode>0?'CONTINUE':'REVERSE',discovery:dstat,validation:vstat,evaluation:estat,discoveryQualified});}}
}
const qualified=cells.filter(c=>c.discoveryQualified).sort((a,b)=>(b.discovery.meanSigned*Math.sqrt(b.discovery.samples))-(a.discovery.meanSigned*Math.sqrt(a.discovery.samples))),shortlist=qualified.slice(0,12);
for(const c of shortlist){c.validationPass=c.validation.samples>=80&&c.validation.meanSigned>0.0005&&c.validation.hitRate>0.50;c.evaluationPass=c.evaluation.samples>=40&&c.evaluation.meanSigned>0.0005&&c.evaluation.hitRate>0.50;}
const stable=shortlist.filter(c=>c.validationPass&&c.evaluationPass),decision=stable.length?'STABLE_DIRECTION_FEATURE':'NO_STABLE_DIRECTION_FEATURE';
const result={research:'special-direction-information',premise:'after specialness selection, audit which slow/fast coin-vs-market state variables contain stable directional information before fitting another trading policy',canonical:{sha256:raw.sha256,months:raw.months.length,symbols:raw.symbols},special:SPECIAL,eventCount:events.length,featureNames:FEATURE_NAMES,cells,shortlist,stable,decision,protocolNote:'Feature bins are frozen from discovery terciles and applied unchanged to validation/evaluation. Direction mode is chosen from discovery sign only. This is an information audit, not a production strategy or shadow-promotion mechanism.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,eventCount:events.length,qualified:qualified.length,shortlist:shortlist.map(c=>({side:c.side,feature:c.feature,bin:c.bin,h:c.horizonHours,mode:c.mode,d:c.discovery,v:c.validation,e:c.evaluation,validationPass:c.validationPass,evaluationPass:c.evaluationPass})),stable:stable.map(c=>({side:c.side,feature:c.feature,bin:c.bin,h:c.horizonHours,mode:c.mode}))},null,2));