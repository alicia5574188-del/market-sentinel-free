import { readFileSync, writeFileSync } from 'node:fs';

const DATASET=process.env.RESEARCH_DATASET??'/tmp/gate-history-anomaly-lifecycle-44m-5m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/anomaly-episode-lifecycle-44m.json';
const raw=JSON.parse(readFileSync(DATASET,'utf8'));
if(raw.interval!=='5m'||raw.months.length!==44||raw.symbols.length!==11)throw new Error('Requires frozen 44m / 11-symbol canonical 5m dataset');

const sum=xs=>xs.reduce((a,b)=>a+b,0);
const mean=xs=>xs.length?sum(xs)/xs.length:0;
const median=xs=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b),m=Math.floor(ys.length/2);return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2;};
const monthStart=m=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=raw.from*1000,toMs=raw.now*1000,discoveryEnd=monthStart(raw.months[30]),validationEnd=monthStart(raw.months[38]);
const datasets=raw.datasets.map(d=>({symbol:d.symbol,rows:d.rows,pointer:0,gaps:null}));
function gaps(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+300));return p;}
for(const d of datasets)d.gaps=gaps(d.rows);
const bySymbol=new Map(datasets.map(d=>[d.symbol,d.rows]));
function valid(d,i,bars){return i>=bars&&d.gaps[i]===d.gaps[i-bars];}
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}
const rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12);

const SPECIAL={minAbsRelative4:0.012,minRobustScore:1.8,minRunnerGap:0.002};
const episode=new Map([[1,null],[-1,null]]);
const prevRel4=new Map(),prevRelTime=new Map();
const events=[];
let synchronizedBars=0,specialBars=0,episodesStarted=0;
const master=datasets.find(d=>d.symbol==='BTC_USDT')??datasets[0];

function addEvent(type,e,ctxRows){events.push({...e,type,ctxRows});}
for(let mi=288;mi<master.rows.length-60;mi++){
  const time=master.rows[mi].time,rows=[];
  for(const d of datasets){
    while(d.pointer<d.rows.length&&d.rows[d.pointer].time<time)d.pointer++;
    const i=d.pointer;if(i>=d.rows.length||d.rows[i].time!==time||!valid(d,i,48))continue;
    const r=d.rows[i],p=d.rows[i-1],h4=d.rows[i-48],h15=d.rows[i-3];
    const histVol=d.rows.slice(i-12,i).map(x=>x.volume),histRange=d.rows.slice(i-12,i).map(rangeRate);
    rows.push({symbol:d.symbol,rows:d.rows,index:i,close:r.close,r5:r.close/p.close-1,r15:r.close/h15.close-1,r4:r.close/h4.close-1,volumeBurst:r.volume/Math.max(median(histVol),1e-12),rangeBurst:rangeRate(r)/Math.max(median(histRange),1e-6)});
  }
  if(rows.length<9)continue;synchronizedBars++;
  const m5=median(rows.map(x=>x.r5)),m15=median(rows.map(x=>x.r15)),m4=median(rows.map(x=>x.r4));
  const es=rows.map(x=>({...x,rel5:x.r5-m5,rel15:x.r15-m15,rel4:x.r4-m4}));
  const scale4=Math.max(0.001,median(es.map(x=>Math.abs(x.rel4))));
  const bySym=new Map(es.map(x=>[x.symbol,x]));

  for(const direction of [1,-1]){
    const ranked=es.filter(x=>direction*x.rel4>0).sort((a,b)=>direction*(b.rel4-a.rel4));
    const f=ranked[0],runner=ranked[1];
    let current=null;
    if(f){
      const magnitude=direction*f.rel4,runnerMagnitude=runner?direction*runner.rel4:0,runnerGap=Math.max(0,magnitude-runnerMagnitude),robustScore=magnitude/scale4;
      if(magnitude>=SPECIAL.minAbsRelative4&&robustScore>=SPECIAL.minRobustScore&&runnerGap>=SPECIAL.minRunnerGap)current={f,magnitude,runnerGap,robustScore};
    }
    const prior=episode.get(direction);
    if(!current){episode.set(direction,null);continue;}
    specialBars++;

    // Losing the top-special position is itself a relationship transition. Record the old leader/laggard
    // if it had persisted for at least 30m and is still directionally unusual at the handoff.
    if(prior&&prior.symbol!==current.f.symbol&&prior.ageBars>=6){
      const old=bySym.get(prior.symbol);
      if(old&&direction*old.rel4>=0.005){
        const previous=prevRelTime.get(old.symbol)===time-300?prevRel4.get(old.symbol):null;
        addEvent('LOST_LEADERSHIP',{time,direction,symbol:old.symbol,f:old,ageBars:prior.ageBars,magnitude:direction*old.rel4,peakMagnitude:prior.peakMagnitude,leadDrawdown:prior.peakMagnitude-direction*old.rel4,pullback:Math.max(0,-direction*(old.close/prior.priceExtreme-1)),relative5:direction*old.rel5,relative15:direction*old.rel15,market5:direction*m5,market15:direction*m15,anomalyDelta:Number.isFinite(previous)?direction*(old.rel4-previous):NaN,maxVolumeBurst:prior.maxVolumeBurst,maxRangeBurst:prior.maxRangeBurst,volumeBurst:old.volumeBurst,rangeBurst:old.rangeBurst},es);
      }
    }

    let ep=prior;
    if(!ep||ep.symbol!==current.f.symbol){
      ep={symbol:current.f.symbol,startTime:time,startPrice:current.f.close,ageBars:1,peakMagnitude:current.magnitude,peakGap:current.runnerGap,priceExtreme:current.f.close,maxVolumeBurst:current.f.volumeBurst,maxRangeBurst:current.f.rangeBurst,maxLeadDrawdown:0,hadFade:false};
      episode.set(direction,ep);episodesStarted++;
    }else{
      ep.ageBars++;
      ep.peakMagnitude=Math.max(ep.peakMagnitude,current.magnitude);
      ep.peakGap=Math.max(ep.peakGap,current.runnerGap);
      ep.priceExtreme=direction>0?Math.max(ep.priceExtreme,current.f.close):Math.min(ep.priceExtreme,current.f.close);
      ep.maxVolumeBurst=Math.max(ep.maxVolumeBurst,current.f.volumeBurst);
      ep.maxRangeBurst=Math.max(ep.maxRangeBurst,current.f.rangeBurst);
    }
    const previous=prevRelTime.get(current.f.symbol)===time-300?prevRel4.get(current.f.symbol):null;
    const leadDrawdown=Math.max(0,ep.peakMagnitude-current.magnitude),pullback=Math.max(0,-direction*(current.f.close/ep.priceExtreme-1));
    ep.maxLeadDrawdown=Math.max(ep.maxLeadDrawdown,leadDrawdown);if(leadDrawdown>=0.0015)ep.hadFade=true;
    const e={time,direction,symbol:current.f.symbol,f:current.f,ageBars:ep.ageBars,magnitude:current.magnitude,runnerGap:current.runnerGap,robustScore:current.robustScore,peakMagnitude:ep.peakMagnitude,leadDrawdown,pullback,relative5:direction*current.f.rel5,relative15:direction*current.f.rel15,market5:direction*m5,market15:direction*m15,anomalyDelta:Number.isFinite(previous)?direction*(current.f.rel4-previous):NaN,maxVolumeBurst:ep.maxVolumeBurst,maxRangeBurst:ep.maxRangeBurst,volumeBurst:current.f.volumeBurst,rangeBurst:current.f.rangeBurst};

    if(ep.ageBars<=6&&leadDrawdown<=0.0005&&e.relative5>=0.0005)addEvent('FRESH_EXPAND',e,es);
    if(ep.ageBars>=7&&leadDrawdown<=0.001&&e.relative15>=0.001)addEvent('MATURE_EXPAND',e,es);
    const earlyFade=ep.ageBars>=3&&leadDrawdown>=0.0015&&pullback>=0.0008&&e.relative5<=-0.0005;
    if(earlyFade)addEvent('EARLY_FADE',e,es);
    if(earlyFade&&e.market5>=0)addEvent('FADE_MARKET_SAME',e,es);
    const deepFade=ep.ageBars>=6&&leadDrawdown>=0.003&&pullback>=0.002;
    if(deepFade)addEvent('DEEP_FADE',e,es);
    if(deepFade&&e.market15>=0)addEvent('DEEP_FADE_MARKET_SAME',e,es);
    if(earlyFade&&(ep.maxVolumeBurst>=2||ep.maxRangeBurst>=2))addEvent('CLIMAX_FADE',e,es);
    if(ep.hadFade&&leadDrawdown<=0.0005&&e.relative5>=0.0005)addEvent('REACCEL_AFTER_FADE',e,es);
  }
  for(const f of es){prevRel4.set(f.symbol,f.rel4);prevRelTime.set(f.symbol,time);}
}

function future(ev,bars){
  const rows=bySymbol.get(ev.symbol),i=ev.f.index,j=i+bars;if(j>=rows.length||rows[j].time!==rows[i].time+bars*300)return null;
  for(let k=i+1;k<=j;k++)if(rows[k].time!==rows[k-1].time+300)return null;
  const sr=rows[j].close/rows[i].close-1,peer=[];
  for(const p of ev.ctxRows){const r=p.rows,pi=p.index,pj=pi+bars;if(pj>=r.length||r[pj].time!==r[pi].time+bars*300)continue;let ok=true;for(let k=pi+1;k<=pj;k++)if(r[k].time!==r[k-1].time+300){ok=false;break;}if(ok)peer.push(r[pj].close/r[pi].close-1);}
  if(peer.length<9)return null;const mr=median(peer),rel=sr-mr;
  return{continuationRel:ev.direction*rel,reversionRel:-ev.direction*rel,continuationAbs:ev.direction*sr,reversionAbs:-ev.direction*sr};
}
function monthKey(ms){const d=new Date(ms);return`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
function summarize(xs,start,end){
  const out={events:xs.length,eventsPerDay:xs.length/Math.max(1,(end-start)/86400000)};
  for(const [label,bars] of [['30m',6],['1h',12],['2h',24],['4h',48]]){
    const zs=xs.map(e=>({e,x:future(e,bars)})).filter(z=>z.x),months=new Map();
    for(const z of zs){const k=monthKey(z.e.time*1000),a=months.get(k)??[];a.push(z.x.reversionRel);months.set(k,a);}
    const mm=[...months.values()].map(mean);
    out[label]={samples:zs.length,continuationRelMean:mean(zs.map(z=>z.x.continuationRel)),reversionRelMean:mean(zs.map(z=>z.x.reversionRel)),reversionRelWinRate:zs.length?zs.filter(z=>z.x.reversionRel>0).length/zs.length:0,continuationAbsMean:mean(zs.map(z=>z.x.continuationAbs)),reversionAbsMean:mean(zs.map(z=>z.x.reversionAbs)),activeMonths:mm.length,positiveReversionMonths:mm.filter(v=>v>0).length};
  }
  return out;
}
const TYPES=['FRESH_EXPAND','MATURE_EXPAND','EARLY_FADE','FADE_MARKET_SAME','DEEP_FADE','DEEP_FADE_MARKET_SAME','CLIMAX_FADE','REACCEL_AFTER_FADE','LOST_LEADERSHIP'];
function study(start,end){
  const out={};for(const type of TYPES){const base=events.filter(e=>e.type===type&&e.time*1000>=start&&e.time*1000<end);out[type]={ALL:summarize(base,start,end),UP:summarize(base.filter(e=>e.direction>0),start,end),DOWN:summarize(base.filter(e=>e.direction<0),start,end)};}return out;
}
const discovery=study(fromMs,discoveryEnd),validation=study(discoveryEnd,validationEnd),evaluation=study(validationEnd,toMs);
function qualify(s,mode){
  if(s.events<200)return false;const keys=['30m','1h','2h','4h'],vals=keys.map(k=>mode==='REVERSE'?s[k].reversionRelMean:s[k].continuationRelMean),m2=mode==='REVERSE'?s['2h'].reversionRelMean:s['2h'].continuationRelMean;
  return vals.filter(v=>v>0).length>=3&&m2>=0.0005&&s['2h'].activeMonths>=18&&(mode==='REVERSE'?s['2h'].positiveReversionMonths>=Math.ceil(s['2h'].activeMonths*0.53):true);
}
const discoveryCandidates=[];
for(const type of TYPES)for(const side of ['UP','DOWN'])for(const mode of ['CONTINUE','REVERSE'])if(qualify(discovery[type][side],mode))discoveryCandidates.push({type,side,mode});
const heldOutChecks=discoveryCandidates.map(c=>{const pick=(seg)=>seg[c.type][c.side]['2h'];const d=pick(discovery),v=pick(validation),e=pick(evaluation),field=c.mode==='REVERSE'?'reversionRelMean':'continuationRelMean';return{...c,discovery2h:d,validation2h:v,evaluation2h:e,validationSameSign:v[field]>0,evaluationSameSign:e[field]>0};});
const stable=heldOutChecks.filter(x=>x.validationSameSign&&x.evaluationSameSign);
const result={research:'anomaly-episode-lifecycle',premise:'specialness is treated as a lifecycle rather than a one-bar signal: build-up, mature expansion, fade, deep fade, reacceleration, and loss of leadership are measured against the whole market',canonical:{sha256:raw.sha256,months:raw.months.length,symbols:raw.symbols},special:SPECIAL,synchronizedBars,specialBars,episodesStarted,eventCounts:Object.fromEntries(TYPES.map(t=>[t,events.filter(e=>e.type===t).length])),study:{discovery,validation,evaluation},discoveryCandidates,heldOutChecks,stable,protocolNote:'Lifecycle state definitions are fixed before held-out inspection. All state fields use completed 5m candles only. This is an event study, not a production strategy, and does not mutate PAPER/LIVE.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({synchronizedBars,specialBars,episodesStarted,eventCounts:result.eventCounts,discoveryCandidates,heldOutChecks,stable,focus:Object.fromEntries(['EARLY_FADE','FADE_MARKET_SAME','DEEP_FADE','CLIMAX_FADE','LOST_LEADERSHIP','REACCEL_AFTER_FADE'].map(t=>[t,{discovery:discovery[t],validation:validation[t],evaluation:evaluation[t]}]))},null,2));
