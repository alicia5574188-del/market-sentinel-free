import { readFileSync, writeFileSync } from 'node:fs';

const DATASET=process.env.RESEARCH_DATASET??'/tmp/gate-history-special-compression-44m-5m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/special-compression-resolution-44m.json';
const FRICTION=Number(process.env.RESEARCH_FRICTION??0.0014);
const STRESS_FRICTION=Number(process.env.RESEARCH_STRESS_FRICTION??0.0022);
const SLIPPAGE=Number(process.env.RESEARCH_ENTRY_SLIPPAGE??0.00025);
const raw=JSON.parse(readFileSync(DATASET,'utf8'));
if(raw.interval!=='5m'||raw.months.length!==44||raw.symbols.length!==11)throw new Error('Requires frozen 44m / 11-symbol canonical 5m dataset');
const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>xs.length?sum(xs)/xs.length:0;
const median=xs=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b),m=Math.floor(ys.length/2);return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2;};
const monthStart=m=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=raw.from*1000,toMs=raw.now*1000,discoveryEnd=monthStart(raw.months[30]),validationEnd=monthStart(raw.months[38]);
const datasets=raw.datasets.map(d=>({symbol:d.symbol,rows:d.rows,pointer:0,gaps:null}));
const bySymbol=new Map(datasets.map(d=>[d.symbol,d.rows]));
function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+300));return p;}
for(const d of datasets)d.gaps=gapPrefix(d.rows);
function valid(d,i,bars){return i>=bars&&d.gaps[i]===d.gaps[i-bars];}
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}

// Frozen selector: validated PRICE1 specialness family. Emit only on identity/episode start,
// then add a one-hour same-symbol episode lockout so one shock cannot generate repeated setups.
const selectorEvents=[];let last={symbol:null,time:null,active:false},synchronizedBars=0;
const lastEpisodeBySymbol=new Map();
const master=datasets.find(d=>d.symbol==='BTC_USDT')??datasets[0];
for(let mi=48;mi<master.rows.length-160;mi++){
  const time=master.rows[mi].time,rows=[];
  for(const d of datasets){
    while(d.pointer<d.rows.length&&d.rows[d.pointer].time<time)d.pointer++;
    const i=d.pointer;if(i>=d.rows.length||d.rows[i].time!==time||!valid(d,i,12))continue;
    const r=d.rows[i],h=d.rows[i-12];rows.push({symbol:d.symbol,rows:d.rows,index:i,r1:r.close/h.close-1});
  }
  if(rows.length<9)continue;synchronizedBars++;
  const m1=median(rows.map(x=>x.r1)),es=rows.map(x=>({...x,rel1:x.r1-m1})),scale=Math.max(0.001,median(es.map(x=>Math.abs(x.rel1))));
  const f=[...es].sort((a,b)=>Math.abs(b.rel1)-Math.abs(a.rel1))[0];
  const pass=f&&Math.abs(f.rel1)>=0.006&&Math.abs(f.rel1)/scale>=1.8;
  if(!pass){last={symbol:null,time,active:false};continue;}
  const continuing=last.active&&last.symbol===f.symbol&&last.time===time-300;
  const locked=(lastEpisodeBySymbol.get(f.symbol)??-Infinity)>time-3600;
  if(!continuing&&!locked){
    selectorEvents.push({time,symbol:f.symbol,f,selectorDirection:f.rel1>0?1:-1,rel1:f.rel1,score:Math.abs(f.rel1)/scale});
    lastEpisodeBySymbol.set(f.symbol,time);
  }
  last={symbol:f.symbol,time,active:true};
}

const SETUPS=[];
for(const observeBars of [3,6,12])
for(const compressionMax of [0.7,1.0])
for(const mechanism of ['FOLLOW_TOUCH','CONFIRMED_CLOSE'])
for(const buffer of [0,0.0005])
for(const holdBars of [12,24])
  SETUPS.push({id:`${mechanism}_O${observeBars*5}M_C${Math.round(compressionMax*100)}_B${Math.round(buffer*10000)}_H${holdBars*5}M`,observeBars,compressionMax,mechanism,buffer,holdBars,watchBars:12});

function buildObservation(event,setup){
  const rows=event.f.rows,i=event.f.index,o=setup.observeBars,end=i+o;
  if(end+setup.watchBars+setup.holdBars+2>=rows.length)return null;
  for(let k=i+1;k<=end;k++)if(rows[k].time!==rows[k-1].time+300)return null;
  const half=Math.max(1,Math.floor(o/2));
  let hi=-Infinity,lo=Infinity,firstHi=-Infinity,firstLo=Infinity,secondHi=-Infinity,secondLo=Infinity;
  for(let k=i+1;k<=end;k++){
    hi=Math.max(hi,rows[k].high);lo=Math.min(lo,rows[k].low);
    if(k<=i+half){firstHi=Math.max(firstHi,rows[k].high);firstLo=Math.min(firstLo,rows[k].low);}
    else{secondHi=Math.max(secondHi,rows[k].high);secondLo=Math.min(secondLo,rows[k].low);}
  }
  if(!Number.isFinite(secondHi)){secondHi=firstHi;secondLo=firstLo;}
  const base=Math.max(rows[i].close,1e-12),firstRange=(firstHi-firstLo)/base,secondRange=(secondHi-secondLo)/base;
  const compressionRatio=secondRange/Math.max(firstRange,1e-9);
  if(compressionRatio>setup.compressionMax)return null;
  const upper=hi*(1+setup.buffer),lower=lo*(1-setup.buffer);
  return{end,upper,lower,compressionRatio,observationRange:(hi-lo)/base};
}
function signalFor(event,setup){
  const rows=event.f.rows,obs=buildObservation(event,setup);if(!obs)return null;
  for(let o=1;o<=setup.watchBars;o++){
    const j=obs.end+o;if(rows[j].time!==rows[obs.end].time+o*300)return null;
    const c=rows[j],up=c.high>=obs.upper,down=c.low<=obs.lower;if(up&&down)return null;
    if(setup.mechanism==='FOLLOW_TOUCH'&&(up||down)){
      const d=up?1:-1;return{...event,...obs,direction:d,triggerTime:c.time,entryTime:c.time,entryMode:'STOP_TOUCH',entryRaw:up?obs.upper:obs.lower};
    }
    if(setup.mechanism==='CONFIRMED_CLOSE'){
      if(up&&c.close>obs.upper){const n=rows[j+1];if(!n||n.time!==c.time+300)return null;return{...event,...obs,direction:1,triggerTime:c.time,entryTime:n.time,entryMode:'NEXT_OPEN',entryRaw:n.open};}
      if(down&&c.close<obs.lower){const n=rows[j+1];if(!n||n.time!==c.time+300)return null;return{...event,...obs,direction:-1,triggerTime:c.time,entryTime:n.time,entryMode:'NEXT_OPEN',entryRaw:n.open};}
    }
  }
  return null;
}
const signalCache=new Map();
function signals(setup){if(signalCache.has(setup.id))return signalCache.get(setup.id);const xs=selectorEvents.flatMap(e=>{const s=signalFor(e,setup);return s?[s]:[];}).sort((a,b)=>a.entryTime-b.entryTime||b.score-a.score);signalCache.set(setup.id,xs);return xs;}
function resolve(sig,setup,friction=FRICTION,slippage=SLIPPAGE){
  const rows=bySymbol.get(sig.symbol),ei=lowerBound(rows,sig.entryTime),exitTime=sig.entryTime+setup.holdBars*300,xi=lowerBound(rows,exitTime);
  if(rows[ei]?.time!==sig.entryTime||rows[xi]?.time!==exitTime)return null;
  for(let k=ei+1;k<=xi;k++)if(rows[k].time!==rows[k-1].time+300)return null;
  const d=sig.direction,rawEntry=sig.entryMode==='STOP_TOUCH'?sig.entryRaw:rows[ei].open,entry=rawEntry*(1+d*slippage),exit=rows[xi].open*(1-d*slippage);
  return{...sig,openedAt:sig.entryTime*1000,closedAt:exitTime*1000,grossReturn:d*(exit/entry-1),netReturn:d*(exit/entry-1)-friction};
}
const tradeCache=new Map();
function trades(setup,friction=FRICTION,slippage=SLIPPAGE){
  const key=`${setup.id}:${friction}:${slippage}`;if(tradeCache.has(key))return tradeCache.get(key);
  const rawTrades=signals(setup).flatMap(s=>{const t=resolve(s,setup,friction,slippage);return t?[t]:[];}).sort((a,b)=>a.openedAt-b.openedAt||b.score-a.score);
  const out=[],busy=new Map();for(const t of rawTrades){if((busy.get(t.symbol)??0)>t.openedAt)continue;out.push(t);busy.set(t.symbol,t.closedAt);}tradeCache.set(key,out);return out;
}
function monthRows(ts,start,end){return raw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1);if(s<start||e>end)return[];const xs=ts.filter(t=>t.openedAt>=s&&t.openedAt<e);return[{month:m,trades:xs.length,value:sum(xs.map(t=>t.netReturn))}];});}
function metrics(ts,start,end){
  const rows=ts.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netReturn>0),l=rows.filter(t=>t.netReturn<=0),monthly=monthRows(rows,start,end);
  return{trades:rows.length,tradesPerDay:rows.length/Math.max(1,(end-start)/86400000),totalNetReturn:sum(rows.map(t=>t.netReturn)),meanNetReturn:mean(rows.map(t=>t.netReturn)),profitFactor:l.length?sum(g.map(t=>t.netReturn))/Math.abs(sum(l.map(t=>t.netReturn))):g.length?99:0,winRate:rows.length?g.length/rows.length:0,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.value>0).length,meanCompression:mean(rows.map(t=>t.compressionRatio)),alignment:{withSelector:{trades:rows.filter(t=>t.direction===t.selectorDirection).length,value:sum(rows.filter(t=>t.direction===t.selectorDirection).map(t=>t.netReturn))},againstSelector:{trades:rows.filter(t=>t.direction!==t.selectorDirection).length,value:sum(rows.filter(t=>t.direction!==t.selectorDirection).map(t=>t.netReturn))}},monthly};
}
const folds=[[0,10],[10,20],[20,30]];
function audit(setup){
  const base=trades(setup),stress=trades(setup,STRESS_FRICTION),adverse=trades(setup,FRICTION,SLIPPAGE*2),d=metrics(base,fromMs,discoveryEnd),ds=metrics(stress,fromMs,discoveryEnd),da=metrics(adverse,fromMs,discoveryEnd),v=metrics(base,discoveryEnd,validationEnd),e=metrics(base,validationEnd,toMs),fs=folds.map(([a,b])=>metrics(base,monthStart(raw.months[a]),monthStart(raw.months[b])));
  const q=d.trades>=250&&d.totalNetReturn>0&&d.profitFactor>=1.06&&d.activeMonths>=18&&d.positiveMonths>=Math.ceil(d.activeMonths*0.53)&&fs.filter(x=>x.totalNetReturn>0).length>=2&&fs.at(-1).totalNetReturn>0&&ds.totalNetReturn>0&&ds.profitFactor>=1&&da.totalNetReturn>0&&da.profitFactor>=1;
  return{setup,discovery:d,discoveryStress:ds,discoveryAdverse:da,folds:fs,discoveryQualified:q,score:q?Math.log(Math.max(d.profitFactor,1))*Math.sqrt(d.trades):null,validation:v,evaluation:e,signalCount:signals(setup).length};
}
const audits=SETUPS.map(audit),selected=[];
for(const mechanism of ['FOLLOW_TOUCH','CONFIRMED_CLOSE']){
  const qs=audits.filter(a=>a.setup.mechanism===mechanism&&a.discoveryQualified).sort((a,b)=>(b.score??-Infinity)-(a.score??-Infinity));if(qs.length)selected.push(qs[0].setup.id);
}
function heldOut(id){const a=audits.find(x=>x.setup.id===id),s=a.setup,stress=trades(s,STRESS_FRICTION),adverse=trades(s,FRICTION,SLIPPAGE*2),validation={base:a.validation,stress:metrics(stress,discoveryEnd,validationEnd),adverse:metrics(adverse,discoveryEnd,validationEnd)},evaluation={base:a.evaluation,stress:metrics(stress,validationEnd,toMs),adverse:metrics(adverse,validationEnd,toMs)},pass=(x,min)=>x.base.trades>=min&&x.base.totalNetReturn>0&&x.base.profitFactor>=1.03&&x.stress.totalNetReturn>0&&x.stress.profitFactor>=1&&x.adverse.totalNetReturn>0&&x.adverse.profitFactor>=1;return{setupId:id,validation,evaluation,validationPass:pass(validation,50),evaluationPass:pass(evaluation,30)};}
const heldOutChecks=selected.map(heldOut),accepted=heldOutChecks.filter(x=>x.validationPass&&x.evaluationPass).map(x=>x.setupId),decision=accepted.length?'FORWARD_CANDIDATE':'NO_RELEASE';
const result={research:'special-compression-resolution',premise:'specialness chooses the coin; do not chase the first move. Wait for 15/30/60m post-shock compression, then let a subsequent breakout resolve direction once per episode.',canonical:{sha256:raw.sha256,months:raw.months.length,symbols:raw.symbols},selector:{type:'PRICE1',minAbsRelative1h:0.006,minRobustScore:1.8,episodeLockoutMinutes:60,events:selectorEvents.length},setups:audits,selected,heldOutChecks,accepted,decision,protocolNote:'Research-only. Selector is frozen from the independent selector-quality audit. Compression and resolver grid is predeclared; only discovery may select one setup per resolver family. Validation/evaluation are inspection-only.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,selectorEvents:selectorEvents.length,selected,heldOutChecks,accepted,topDiscovery:audits.slice().sort((a,b)=>b.discovery.profitFactor-a.discovery.profitFactor).slice(0,10).map(a=>({id:a.setup.id,qualified:a.discoveryQualified,signals:a.signalCount,discovery:a.discovery,stress:a.discoveryStress,adverse:a.discoveryAdverse,validation:a.validation,evaluation:a.evaluation}))},null,2));
