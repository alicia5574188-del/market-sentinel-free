import { readFileSync, writeFileSync } from 'node:fs';

const DATASET=process.env.RESEARCH_DATASET??'/tmp/gate-history-selector-quality-44m-5m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/specialness-selector-quality-44m.json';
const raw=JSON.parse(readFileSync(DATASET,'utf8'));
if(raw.interval!=='5m'||raw.months.length!==44||raw.symbols.length!==11)throw new Error('Requires frozen 44m / 11-symbol canonical 5m dataset');
const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>xs.length?sum(xs)/xs.length:0;
const median=xs=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b),m=Math.floor(ys.length/2);return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2;};
const monthStart=m=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=raw.from*1000,toMs=raw.now*1000,discoveryEnd=monthStart(raw.months[30]),validationEnd=monthStart(raw.months[38]);
const rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12);
const datasets=raw.datasets.map(d=>({symbol:d.symbol,rows:d.rows,pointer:0,gaps:null,volPrefix:[0],rangePrefix:[0]}));
function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+300));return p;}
for(const d of datasets){d.gaps=gapPrefix(d.rows);for(const r of d.rows){d.volPrefix.push(d.volPrefix.at(-1)+r.volume);d.rangePrefix.push(d.rangePrefix.at(-1)+rangeRate(r));}}
function valid(d,i,bars){return i>=bars&&d.gaps[i]===d.gaps[i-bars];}
const sliceSum=(p,a,b)=>p[b]-p[a];
const rankMap=(rows,key)=>new Map([...rows].sort((a,b)=>b[key]-a[key]).map((x,i)=>[x.symbol,i+1]));

const FAMILIES=['PRICE4','PRICE1','VOLUME','RANGE','PRICE_VOLUME','PRICE_RANGE','COMPOSITE'];
const lastState=new Map(FAMILIES.map(f=>[f,{symbol:null,time:null,active:false}]));
const events=[];let synchronizedBars=0;
const master=datasets.find(d=>d.symbol==='BTC_USDT')??datasets[0];
for(let mi=288;mi<master.rows.length-60;mi++){
  const time=master.rows[mi].time,rows=[];
  for(const d of datasets){
    while(d.pointer<d.rows.length&&d.rows[d.pointer].time<time)d.pointer++;
    const i=d.pointer;if(i>=d.rows.length||d.rows[i].time!==time||!valid(d,i,60))continue;
    const r=d.rows[i],r12=d.rows[i-12],r48=d.rows[i-48];
    const volNow=sliceSum(d.volPrefix,i-11,i+1),volBase=sliceSum(d.volPrefix,i-59,i-11)/4;
    const rangeNow=sliceSum(d.rangePrefix,i-11,i+1),rangeBase=sliceSum(d.rangePrefix,i-59,i-11)/4;
    rows.push({symbol:d.symbol,rows:d.rows,index:i,close:r.close,r1:r.close/r12.close-1,r4:r.close/r48.close-1,volumeRatio:volNow/Math.max(volBase,1e-12),rangeRatio:rangeNow/Math.max(rangeBase,1e-9)});
  }
  if(rows.length<9)continue;synchronizedBars++;
  const m1=median(rows.map(x=>x.r1)),m4=median(rows.map(x=>x.r4));
  const es=rows.map(x=>({...x,rel1:x.r1-m1,rel4:x.r4-m4}));
  const scale1=Math.max(0.001,median(es.map(x=>Math.abs(x.rel1)))),scale4=Math.max(0.001,median(es.map(x=>Math.abs(x.rel4))));
  for(const x of es){x.price1Score=Math.abs(x.rel1)/scale1;x.price4Score=Math.abs(x.rel4)/scale4;}
  const rp4=rankMap(es,'price4Score'),rp1=rankMap(es,'price1Score'),rv=rankMap(es,'volumeRatio'),rr=rankMap(es,'rangeRatio');
  for(const x of es){x.price4Rank=rp4.get(x.symbol);x.price1Rank=rp1.get(x.symbol);x.volumeRank=rv.get(x.symbol);x.rangeRank=rr.get(x.symbol);x.compositeRankSum=x.price4Rank+x.volumeRank+x.rangeRank;x.top3Count=[x.price4Rank,x.volumeRank,x.rangeRank].filter(v=>v<=3).length;}
  const choose=(family)=>{
    if(family==='PRICE4'){const x=[...es].sort((a,b)=>b.price4Score-a.price4Score)[0];return x&&Math.abs(x.rel4)>=0.012&&x.price4Score>=1.8?x:null;}
    if(family==='PRICE1'){const x=[...es].sort((a,b)=>b.price1Score-a.price1Score)[0];return x&&Math.abs(x.rel1)>=0.006&&x.price1Score>=1.8?x:null;}
    if(family==='VOLUME'){const x=[...es].sort((a,b)=>b.volumeRatio-a.volumeRatio)[0];return x&&x.volumeRatio>=1.8?x:null;}
    if(family==='RANGE'){const x=[...es].sort((a,b)=>b.rangeRatio-a.rangeRatio)[0];return x&&x.rangeRatio>=1.5?x:null;}
    if(family==='PRICE_VOLUME'){const xs=es.filter(x=>x.price4Rank<=3&&x.volumeRank<=3&&Math.abs(x.rel4)>=0.006&&x.volumeRatio>=1.3).sort((a,b)=>(a.price4Rank+a.volumeRank)-(b.price4Rank+b.volumeRank));return xs[0]??null;}
    if(family==='PRICE_RANGE'){const xs=es.filter(x=>x.price4Rank<=3&&x.rangeRank<=3&&Math.abs(x.rel4)>=0.006&&x.rangeRatio>=1.2).sort((a,b)=>(a.price4Rank+a.rangeRank)-(b.price4Rank+b.rangeRank));return xs[0]??null;}
    const xs=es.filter(x=>x.top3Count>=2&&x.compositeRankSum<=12).sort((a,b)=>a.compositeRankSum-b.compositeRankSum);return xs[0]??null;
  };
  for(const family of FAMILIES){
    const x=choose(family),last=lastState.get(family);
    if(!x){lastState.set(family,{symbol:null,time,active:false});continue;}
    const continuing=last.active&&last.symbol===x.symbol&&last.time===time-300;
    if(!continuing)events.push({family,time,symbol:x.symbol,f:x,ctx:es,features:{rel1:x.rel1,rel4:x.rel4,price1Score:x.price1Score,price4Score:x.price4Score,volumeRatio:x.volumeRatio,rangeRatio:x.rangeRatio,price4Rank:x.price4Rank,volumeRank:x.volumeRank,rangeRank:x.rangeRank}});
    lastState.set(family,{symbol:x.symbol,time,active:true});
  }
}
function future(ev,bars){
  const r=ev.f.rows,i=ev.f.index,j=i+bars;if(j>=r.length||r[j].time!==r[i].time+bars*300)return null;for(let k=i+1;k<=j;k++)if(r[k].time!==r[k-1].time+300)return null;
  const start=r[i].close,absRet=Math.abs(r[j].close/start-1);let ex=0;for(let k=i+1;k<=j;k++)ex=Math.max(ex,Math.abs(r[k].high/start-1),Math.abs(r[k].low/start-1));
  const peers=[];for(const p of ev.ctx){const pr=p.rows,pi=p.index,pj=pi+bars;if(pj>=pr.length||pr[pj].time!==pr[pi].time+bars*300)continue;let ok=true;for(let k=pi+1;k<=pj;k++)if(pr[k].time!==pr[k-1].time+300){ok=false;break;}if(!ok)continue;const ps=pr[pi].close;let pex=0;for(let k=pi+1;k<=pj;k++)pex=Math.max(pex,Math.abs(pr[k].high/ps-1),Math.abs(pr[k].low/ps-1));peers.push({absRet:Math.abs(pr[pj].close/ps-1),excursion:pex});}
  if(peers.length<9)return null;const peerAbs=median(peers.map(x=>x.absRet)),peerEx=median(peers.map(x=>x.excursion));return{absRet,excursion:ex,peerAbs,peerExcursion:peerEx,excessAbs:absRet-peerAbs,excessExcursion:ex-peerEx,excursionRatio:ex/Math.max(peerEx,1e-9)};
}
function monthKey(ms){const d=new Date(ms);return`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
function summarize(xs,start,end){const out={events:xs.length,eventsPerDay:xs.length/Math.max(1,(end-start)/86400000)};for(const [label,bars] of [['30m',6],['1h',12],['2h',24],['4h',48]]){const zs=xs.map(e=>({e,x:future(e,bars)})).filter(z=>z.x),months=new Map();for(const z of zs){const k=monthKey(z.e.time*1000),a=months.get(k)??[];a.push(z.x.excessExcursion);months.set(k,a);}const mm=[...months.values()].map(mean);out[label]={samples:zs.length,meanAbsReturn:mean(zs.map(z=>z.x.absRet)),peerMeanAbsReturn:mean(zs.map(z=>z.x.peerAbs)),meanExcessAbs:mean(zs.map(z=>z.x.excessAbs)),meanExcursion:mean(zs.map(z=>z.x.excursion)),peerMeanExcursion:mean(zs.map(z=>z.x.peerExcursion)),meanExcessExcursion:mean(zs.map(z=>z.x.excessExcursion)),meanExcursionRatio:mean(zs.map(z=>z.x.excursionRatio)),activeMonths:mm.length,positiveExcessExcursionMonths:mm.filter(v=>v>0).length};}return out;}
function study(start,end){return Object.fromEntries(FAMILIES.map(f=>[f,summarize(events.filter(e=>e.family===f&&e.time*1000>=start&&e.time*1000<end),start,end)]));}
const discovery=study(fromMs,discoveryEnd),validation=study(discoveryEnd,validationEnd),evaluation=study(validationEnd,toMs);
function discoveryQualified(s){const hs=['30m','1h','2h','4h'].map(k=>s[k]);return s.events>=150&&hs.filter(x=>x.meanExcessExcursion>0).length>=3&&s['2h'].meanExcursionRatio>=1.10&&s['2h'].activeMonths>=18&&s['2h'].positiveExcessExcursionMonths>=Math.ceil(s['2h'].activeMonths*0.55);}
const qualified=FAMILIES.filter(f=>discoveryQualified(discovery[f]));
const heldOutChecks=qualified.map(f=>({family:f,discovery2h:discovery[f]['2h'],validation2h:validation[f]['2h'],evaluation2h:evaluation[f]['2h'],validationPass:validation[f]['2h'].meanExcessExcursion>0&&validation[f]['2h'].meanExcursionRatio>1.05,evaluationPass:evaluation[f]['2h'].meanExcessExcursion>0&&evaluation[f]['2h'].meanExcursionRatio>1.05}));
const accepted=heldOutChecks.filter(x=>x.validationPass&&x.evaluationPass).map(x=>x.family),decision=accepted.length?'SELECTOR_FOUND':'NO_SELECTOR';
const result={research:'specialness-selector-quality',premise:'selection is evaluated independently of direction: a useful specialness selector should identify coins that subsequently move more than the peer median, regardless of whether that move is up or down',canonical:{sha256:raw.sha256,months:raw.months.length,symbols:raw.symbols},families:FAMILIES,synchronizedBars,eventCounts:Object.fromEntries(FAMILIES.map(f=>[f,events.filter(e=>e.family===f).length])),study:{discovery,validation,evaluation},qualified,heldOutChecks,accepted,decision,protocolNote:'Each family emits only when its top special identity changes/enters, reducing repeated-bar dependence. No directional assumption, PnL, shadow promotion, or production mutation is used.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,eventCounts:result.eventCounts,qualified,heldOutChecks,accepted,study:result.study},null,2));
