import { readFileSync, writeFileSync } from 'node:fs';

const DATASET=process.env.RESEARCH_DATASET??'/tmp/gate-history-causal-anomaly-44m-5m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/causal-anomaly-response-switch-44m.json';
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
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}
const rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12);

const SPECIAL={minAbsRelative4:0.012,minRobustScore:1.8,minRunnerGap:0.002};
const episode=new Map([[1,null],[-1,null]]),events=[];
let synchronizedBars=0,episodesStarted=0;
const master=datasets.find(d=>d.symbol==='BTC_USDT')??datasets[0];
function emit(type,time,direction,f,ctx,extra={}){events.push({type,time,direction,side:direction>0?'UP':'DOWN',symbol:f.symbol,f,ctx,...extra});}

for(let mi=288;mi<master.rows.length-60;mi++){
  const time=master.rows[mi].time,rows=[];
  for(const d of datasets){
    while(d.pointer<d.rows.length&&d.rows[d.pointer].time<time)d.pointer++;
    const i=d.pointer;if(i>=d.rows.length||d.rows[i].time!==time||!valid(d,i,48))continue;
    const r=d.rows[i],p=d.rows[i-1],h4=d.rows[i-48],h15=d.rows[i-3];
    const prev=d.rows.slice(i-12,i);
    rows.push({symbol:d.symbol,rows:d.rows,index:i,close:r.close,r5:r.close/p.close-1,r15:r.close/h15.close-1,r4:r.close/h4.close-1,volumeBurst:r.volume/Math.max(median(prev.map(x=>x.volume)),1e-12),rangeBurst:rangeRate(r)/Math.max(median(prev.map(rangeRate)),1e-6)});
  }
  if(rows.length<9)continue;synchronizedBars++;
  const m5=median(rows.map(x=>x.r5)),m15=median(rows.map(x=>x.r15)),m4=median(rows.map(x=>x.r4));
  const es=rows.map(x=>({...x,rel5:x.r5-m5,rel15:x.r15-m15,rel4:x.r4-m4})),scale4=Math.max(0.001,median(es.map(x=>Math.abs(x.rel4)))),bySym=new Map(es.map(x=>[x.symbol,x]));
  for(const direction of [1,-1]){
    const ranked=es.filter(x=>direction*x.rel4>0).sort((a,b)=>direction*(b.rel4-a.rel4)),f=ranked[0],runner=ranked[1];
    let cur=null;if(f){const magnitude=direction*f.rel4,runnerMag=runner?direction*runner.rel4:0,runnerGap=Math.max(0,magnitude-runnerMag),robustScore=magnitude/scale4;if(magnitude>=SPECIAL.minAbsRelative4&&robustScore>=SPECIAL.minRobustScore&&runnerGap>=SPECIAL.minRunnerGap)cur={f,magnitude,runnerGap,robustScore};}
    const prior=episode.get(direction);
    if(!cur){episode.set(direction,null);continue;}
    if(prior&&prior.symbol!==cur.f.symbol&&prior.ageBars>=6){const old=bySym.get(prior.symbol);if(old&&direction*old.rel4>=0.005)emit('LOST',time,direction,old,es,{ageBars:prior.ageBars,leadDrawdown:Math.max(0,prior.peakMagnitude-direction*old.rel4),pullback:Math.max(0,-direction*(old.close/prior.priceExtreme-1)),relative5:direction*old.rel5,relative15:direction*old.rel15,market5:direction*m5,market15:direction*m15,climax:prior.maxVolumeBurst>=2||prior.maxRangeBurst>=2});}
    let ep=prior;
    if(!ep||ep.symbol!==cur.f.symbol){
      ep={symbol:cur.f.symbol,startTime:time,startPrice:cur.f.close,ageBars:1,peakMagnitude:cur.magnitude,priceExtreme:cur.f.close,maxVolumeBurst:cur.f.volumeBurst,maxRangeBurst:cur.f.rangeBurst,expandEmitted:false,fadeEmitted:false,deepEmitted:false,reaccelEmitted:false,hadFade:false};episode.set(direction,ep);episodesStarted++;
      emit('START',time,direction,cur.f,es,{ageBars:1,leadDrawdown:0,pullback:0,relative5:direction*cur.f.rel5,relative15:direction*cur.f.rel15,market5:direction*m5,market15:direction*m15,climax:false});
    }else{
      ep.ageBars++;ep.peakMagnitude=Math.max(ep.peakMagnitude,cur.magnitude);ep.priceExtreme=direction>0?Math.max(ep.priceExtreme,cur.f.close):Math.min(ep.priceExtreme,cur.f.close);ep.maxVolumeBurst=Math.max(ep.maxVolumeBurst,cur.f.volumeBurst);ep.maxRangeBurst=Math.max(ep.maxRangeBurst,cur.f.rangeBurst);
    }
    const dd=Math.max(0,ep.peakMagnitude-cur.magnitude),pullback=Math.max(0,-direction*(cur.f.close/ep.priceExtreme-1)),rel5=direction*cur.f.rel5,rel15=direction*cur.f.rel15,market5=direction*m5,market15=direction*m15,climax=ep.maxVolumeBurst>=2||ep.maxRangeBurst>=2;
    if(!ep.expandEmitted&&ep.ageBars>=3&&dd<=0.0005&&rel15>=0.001){ep.expandEmitted=true;emit('EXPAND',time,direction,cur.f,es,{ageBars:ep.ageBars,leadDrawdown:dd,pullback,relative5:rel5,relative15:rel15,market5,market15,climax});}
    if(!ep.fadeEmitted&&ep.ageBars>=3&&dd>=0.0015&&pullback>=0.0008&&rel5<=-0.0005){ep.fadeEmitted=true;ep.hadFade=true;emit(climax?'FADE_CLIMAX':'FADE',time,direction,cur.f,es,{ageBars:ep.ageBars,leadDrawdown:dd,pullback,relative5:rel5,relative15:rel15,market5,market15,climax});}
    if(!ep.deepEmitted&&ep.ageBars>=6&&dd>=0.003&&pullback>=0.002){ep.deepEmitted=true;ep.hadFade=true;emit('DEEP_FADE',time,direction,cur.f,es,{ageBars:ep.ageBars,leadDrawdown:dd,pullback,relative5:rel5,relative15:rel15,market5,market15,climax});}
    if(ep.hadFade&&!ep.reaccelEmitted&&dd<=0.0005&&rel5>=0.0005){ep.reaccelEmitted=true;emit('REACCEL',time,direction,cur.f,es,{ageBars:ep.ageBars,leadDrawdown:dd,pullback,relative5:rel5,relative15:rel15,market5,market15,climax});}
  }
}

function outcome(ev,holdBars){
  const rows=bySymbol.get(ev.symbol),i=ev.f.index,j=i+holdBars;if(j>=rows.length||rows[j].time!==rows[i].time+holdBars*300)return null;for(let k=i+1;k<=j;k++)if(rows[k].time!==rows[k-1].time+300)return null;
  const sr=rows[j].close/rows[i].close-1,peer=[];for(const p of ev.ctx){const r=p.rows,pi=p.index,pj=pi+holdBars;if(pj>=r.length||r[pj].time!==r[pi].time+holdBars*300)continue;let ok=true;for(let k=pi+1;k<=pj;k++)if(r[k].time!==r[k-1].time+300){ok=false;break;}if(ok)peer.push(r[pj].close/r[pi].close-1);}if(peer.length<9)return null;const mr=median(peer),contAbs=ev.direction*sr,contRel=ev.direction*(sr-mr);return{contAbs,contRel};
}
const TYPES=['START','EXPAND','FADE','FADE_CLIMAX','DEEP_FADE','REACCEL','LOST'];
const HORIZONS=[24,48]; // 2h,4h
const WINDOWS=[30,60,90,180];
const GATES=[
  {id:'LOOSE',minN:25,minRel:0.0003,minAbs:0.0003,minHit:0.50},
  {id:'CONSENSUS',minN:25,minRel:0.0003,minAbs:0.0003,minHit:0.53},
  {id:'COST_AWARE',minN:25,minRel:0.0005,minAbs:0.0015,minHit:0.52},
];
const enrichedEvents=new Map();
for(const h of HORIZONS)enrichedEvents.set(h,events.flatMap(e=>{const y=outcome(e,h);return y?[{...e,y}]:[];}).sort((a,b)=>a.time-b.time));

function makePolicySignals(policy){
  const all=enrichedEvents.get(policy.holdBars),groups=new Map();for(const e of all){const key=`${e.type}:${e.side}`;const a=groups.get(key)??[];a.push(e);groups.set(key,a);}
  const signals=[];
  for(const [key,xs] of groups){
    const queue=[];let mature=0,sumRel=0,sumAbs=0,contHits=0;
    for(let i=0;i<xs.length;i++){
      const e=xs[i],knownCutoff=e.time-policy.holdBars*300;
      while(mature<i&&xs[mature].time<=knownCutoff){const p=xs[mature++];queue.push(p);sumRel+=p.y.contRel;sumAbs+=p.y.contAbs;contHits+=Number(p.y.contRel>0);}
      const windowStart=e.time-policy.lookbackDays*86400;
      while(queue.length&&queue[0].time<windowStart){const p=queue.shift();sumRel-=p.y.contRel;sumAbs-=p.y.contAbs;contHits-=Number(p.y.contRel>0);}
      const n=queue.length;if(n<policy.gate.minN)continue;const mr=sumRel/n,ma=sumAbs/n,hit=contHits/n;
      let mode=null;if(mr>=policy.gate.minRel&&ma>=policy.gate.minAbs&&hit>=policy.gate.minHit)mode='CONTINUE';else if(mr<=-policy.gate.minRel&&ma<=-policy.gate.minAbs&&(1-hit)>=policy.gate.minHit)mode='REVERSE';if(!mode)continue;
      signals.push({...e,mode,tradeDirection:mode==='CONTINUE'?e.direction:-e.direction,calibration:{n,meanRel:mr,meanAbs:ma,continuationHitRate:hit}});
    }
  }
  return signals.sort((a,b)=>a.time-b.time||b.calibration.n-a.calibration.n);
}
const signalCache=new Map();
function policySignals(policy){if(signalCache.has(policy.id))return signalCache.get(policy.id);const s=makePolicySignals(policy);signalCache.set(policy.id,s);return s;}
function resolve(sig,policy,friction=FRICTION,slippage=SLIPPAGE){const rows=bySymbol.get(sig.symbol),entryTime=sig.time+300,exitTime=entryTime+policy.holdBars*300,ei=lowerBound(rows,entryTime),xi=lowerBound(rows,exitTime);if(rows[ei]?.time!==entryTime||rows[xi]?.time!==exitTime)return null;for(let i=ei+1;i<=xi;i++)if(rows[i].time!==rows[i-1].time+300)return null;const d=sig.tradeDirection,entry=rows[ei].open*(1+d*slippage),exit=rows[xi].open*(1-d*slippage),gross=d*(exit/entry-1),net=gross-friction;return{...sig,openedAt:entryTime*1000,closedAt:exitTime*1000,grossReturn:gross,netReturn:net};}
const tradeCache=new Map();
function trades(policy,friction=FRICTION,slippage=SLIPPAGE){const key=`${policy.id}:${friction}:${slippage}`;if(tradeCache.has(key))return tradeCache.get(key);const rows=policySignals(policy).flatMap(s=>{const t=resolve(s,policy,friction,slippage);return t?[t]:[];}).sort((a,b)=>a.openedAt-b.openedAt);const out=[],busy=new Map();for(const t of rows){if((busy.get(t.symbol)??0)>t.openedAt)continue;out.push(t);busy.set(t.symbol,t.closedAt);}tradeCache.set(key,out);return out;}
function monthRows(ts,start,end){return raw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1);if(s<start||e>end)return[];const xs=ts.filter(t=>t.openedAt>=s&&t.openedAt<e);return[{month:m,trades:xs.length,value:sum(xs.map(t=>t.netReturn))}];});}
function metrics(ts,start,end){const rows=ts.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netReturn>0),l=rows.filter(t=>t.netReturn<=0),monthly=monthRows(rows,start,end);return{trades:rows.length,tradesPerDay:rows.length/Math.max(1,(end-start)/86400000),totalNetReturn:sum(rows.map(t=>t.netReturn)),meanNetReturn:mean(rows.map(t=>t.netReturn)),profitFactor:l.length?sum(g.map(t=>t.netReturn))/Math.abs(sum(l.map(t=>t.netReturn))):g.length?99:0,winRate:rows.length?g.length/rows.length:0,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.value>0).length,byMode:{CONTINUE:{trades:rows.filter(t=>t.mode==='CONTINUE').length,value:sum(rows.filter(t=>t.mode==='CONTINUE').map(t=>t.netReturn))},REVERSE:{trades:rows.filter(t=>t.mode==='REVERSE').length,value:sum(rows.filter(t=>t.mode==='REVERSE').map(t=>t.netReturn))}},monthly};}
const folds=[[0,10],[10,20],[20,30]];
function audit(policy){const base=trades(policy),stress=trades(policy,STRESS_FRICTION),adverse=trades(policy,FRICTION,SLIPPAGE*2),d=metrics(base,fromMs,discoveryEnd),ds=metrics(stress,fromMs,discoveryEnd),da=metrics(adverse,fromMs,discoveryEnd),v=metrics(base,discoveryEnd,validationEnd),e=metrics(base,validationEnd,toMs),fs=folds.map(([a,b])=>metrics(base,monthStart(raw.months[a]),monthStart(raw.months[b])));const q=d.trades>=250&&d.totalNetReturn>0&&d.profitFactor>=1.06&&d.activeMonths>=18&&d.positiveMonths>=Math.ceil(d.activeMonths*0.53)&&fs.filter(x=>x.totalNetReturn>0).length>=2&&fs.at(-1).totalNetReturn>0&&ds.totalNetReturn>0&&ds.profitFactor>=1&&da.totalNetReturn>0&&da.profitFactor>=1;return{policy,discovery:d,discoveryStress:ds,discoveryAdverse:da,folds:fs,discoveryQualified:q,score:q?Math.log(Math.max(d.profitFactor,1))*Math.sqrt(d.trades):null,validation:v,evaluation:e};}
const policies=[];for(const holdBars of HORIZONS)for(const lookbackDays of WINDOWS)for(const gate of GATES)policies.push({id:`H${holdBars*5}M_W${lookbackDays}_${gate.id}`,holdBars,lookbackDays,gate});
const audits=policies.map(audit),shortlist=audits.filter(a=>a.discoveryQualified).sort((a,b)=>(b.score??-Infinity)-(a.score??-Infinity)).slice(0,3).map(a=>a.policy.id);
function heldOut(id){const a=audits.find(x=>x.policy.id===id),p=a.policy,stress=trades(p,STRESS_FRICTION),adverse=trades(p,FRICTION,SLIPPAGE*2),validation={base:a.validation,stress:metrics(stress,discoveryEnd,validationEnd),adverse:metrics(adverse,discoveryEnd,validationEnd)},evaluation={base:a.evaluation,stress:metrics(stress,validationEnd,toMs),adverse:metrics(adverse,validationEnd,toMs)},pass=(x,min)=>x.base.trades>=min&&x.base.totalNetReturn>0&&x.base.profitFactor>=1.03&&x.stress.totalNetReturn>0&&x.stress.profitFactor>=1&&x.adverse.totalNetReturn>0&&x.adverse.profitFactor>=1;return{policyId:id,validation,evaluation,validationPass:pass(validation,50),evaluationPass:pass(evaluation,30)};}
const heldOutChecks=shortlist.map(heldOut),accepted=heldOutChecks.filter(x=>x.validationPass&&x.evaluationPass).map(x=>x.policyId),decision=accepted.length?'FORWARD_CANDIDATE':'NO_RELEASE';
const result={research:'causal-anomaly-response-switch',premise:'direction is not hard-coded: for each anomaly lifecycle transition, the engine measures only fully matured similar market responses inside a trailing window and chooses continuation/reversion only when trailing relative and absolute responses agree',canonical:{sha256:raw.sha256,months:raw.months.length,symbols:raw.symbols},special:SPECIAL,eventCounts:Object.fromEntries(TYPES.map(t=>[t,events.filter(e=>e.type===t).length])),horizonsMinutes:HORIZONS.map(x=>x*5),lookbackDays:WINDOWS,gates:GATES,policies:audits,shortlist,heldOutChecks,accepted,decision,protocolNote:'Calibration uses raw market responses, never strategy PnL or shadow promotion. A past event label enters calibration only after its full 2h/4h outcome is already observable. Current entry is always the next completed 5m boundary. Production/PAPER/LIVE untouched.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,eventCounts:result.eventCounts,shortlist,heldOutChecks,accepted,topDiscovery:audits.slice().sort((a,b)=>b.discovery.profitFactor-a.discovery.profitFactor).slice(0,10).map(x=>({policy:x.policy.id,qualified:x.discoveryQualified,discovery:x.discovery,stress:x.discoveryStress,adverse:x.discoveryAdverse,folds:x.folds,validation:x.validation,evaluation:x.evaluation,signals:policySignals(x.policy).length}))},null,2));
