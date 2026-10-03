import { readFileSync, writeFileSync } from 'node:fs';

const SIGNAL_DATASET=process.env.RESEARCH_SIGNAL_DATASET??'/tmp/gate-history-analog-44m-1h.json';
const EXECUTION_DATASET=process.env.RESEARCH_EXECUTION_DATASET??'/tmp/gate-history-analog-44m-5m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/historical-analog-direction-resolver-44m.json';
const FRICTION=Number(process.env.RESEARCH_FRICTION??0.0014);
const STRESS_FRICTION=Number(process.env.RESEARCH_STRESS_FRICTION??0.0022);
const SLIPPAGE=Number(process.env.RESEARCH_ENTRY_SLIPPAGE??0.00025);
const signalRaw=JSON.parse(readFileSync(SIGNAL_DATASET,'utf8'));
const executionRaw=JSON.parse(readFileSync(EXECUTION_DATASET,'utf8'));
if(signalRaw.interval!=='1h'||executionRaw.interval!=='5m'||signalRaw.months.join()!==executionRaw.months.join())throw new Error('Requires matching canonical 1h + 5m datasets');
if(signalRaw.months.length!==44||signalRaw.symbols.length!==11)throw new Error('Requires frozen 44m / 11-symbol core universe');

const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>xs.length?sum(xs)/xs.length:0;
const median=xs=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b),m=Math.floor(ys.length/2);return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2;};
const clip=(x,a=-4,b=4)=>Math.max(a,Math.min(b,x));
const monthStart=m=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=signalRaw.from*1000,toMs=signalRaw.now*1000,discoveryEnd=monthStart(signalRaw.months[30]),validationEnd=monthStart(signalRaw.months[38]);
const executionBySymbol=new Map(executionRaw.datasets.map(d=>[d.symbol,d.rows]));
const ret=(rows,i,h)=>rows[i].close/rows[i-h].close-1;
const rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12);
function gapPrefix(rows,step){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+step));return p;}
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}

const byTime=new Map();
for(const {symbol,rows} of signalRaw.datasets){
  const gp=gapPrefix(rows,3600);
  for(let i=168;i<rows.length-9;i++){
    if(gp[i]!==gp[i-168]||rows[i+1].time!==rows[i].time+3600)continue;
    const prior24=rows.slice(i-24,i),vr=rows[i].volume/Math.max(median(prior24.map(x=>x.volume)),1e-12),rr=rangeRate(rows[i])/Math.max(median(prior24.map(rangeRate)),1e-6);
    const f={symbol,rows,index:i,current:rows[i],r1:ret(rows,i,1),r4:ret(rows,i,4),r12:ret(rows,i,12),r24:ret(rows,i,24),prev1:rows[i-1].close/rows[i-2].close-1,prev4:rows[i-1].close/rows[i-5].close-1,volumeRatio:vr,rangeRatio:rr};
    const a=byTime.get(rows[i].time)??[];a.push(f);byTime.set(rows[i].time,a);
  }
}

const contexts=[];
for(const [time,rows] of byTime){
  if(rows.length<9)continue;
  const c={m1:median(rows.map(x=>x.r1)),m4:median(rows.map(x=>x.r4)),m12:median(rows.map(x=>x.r12)),m24:median(rows.map(x=>x.r24)),pm1:median(rows.map(x=>x.prev1)),pm4:median(rows.map(x=>x.prev4)),breadth1Up:rows.filter(x=>x.r1>0).length/rows.length,breadth4Up:rows.filter(x=>x.r4>0).length/rows.length};
  const es=rows.map(f=>({...f,rel1:f.r1-c.m1,rel4:f.r4-c.m4,rel12:f.r12-c.m12,rel24:f.r24-c.m24,prevRel1:f.prev1-c.pm1,prevRel4:f.prev4-c.pm4}));
  const scale4=Math.max(0.001,median(es.map(x=>Math.abs(x.rel4))));
  contexts.push({time,rows:es,c,scale4});
}
contexts.sort((a,b)=>a.time-b.time);

const SPECIAL={minAbsRelative4:0.012,minRobustScore:1.8,minRunnerGap:0.002};
const events=[];let id=0;const lastEmit=new Map();
for(const ctx of contexts){
  for(const direction of [1,-1]){
    const ranked=ctx.rows.filter(f=>direction*f.rel4>0).sort((a,b)=>direction*(b.rel4-a.rel4));
    if(ranked.length<2)continue;
    const f=ranked[0],magnitude=direction*f.rel4,runnerMagnitude=direction*ranked[1].rel4,runnerGap=Math.max(0,magnitude-runnerMagnitude),robustScore=magnitude/ctx.scale4;
    if(magnitude<SPECIAL.minAbsRelative4||robustScore<SPECIAL.minRobustScore||runnerGap<SPECIAL.minRunnerGap)continue;
    const dedupeKey=`${direction}:${f.symbol}`,last=lastEmit.get(dedupeKey)??-Infinity;if(ctx.time-last<7200)continue;lastEmit.set(dedupeKey,ctx.time);
    const breadth1=direction>0?ctx.c.breadth1Up:1-ctx.c.breadth1Up,breadth4=direction>0?ctx.c.breadth4Up:1-ctx.c.breadth4Up;
    const signedRel1=direction*f.rel1,signedRel4=direction*f.rel4,signedRel12=direction*f.rel12,signedRel24=direction*f.rel24,signedPrevRel1=direction*f.prevRel1,signedPrevRel4=direction*f.prevRel4;
    const signedM1=direction*ctx.c.m1,signedM4=direction*ctx.c.m4,signedM12=direction*ctx.c.m12,signedM24=direction*ctx.c.m24;
    const vector=[
      clip(magnitude/0.05),clip((robustScore-1.8)/2.5),clip(runnerGap/0.02),
      clip(signedRel1/0.03),clip((signedRel1-signedPrevRel1)/0.02),clip((signedRel4-signedPrevRel4)/0.025),
      clip(signedRel12/0.10),clip(signedRel24/0.16),
      clip(signedM1/0.02),clip(signedM4/0.05),clip(signedM12/0.10),clip(signedM24/0.16),
      clip((breadth1-0.5)/0.5),clip((breadth4-0.5)/0.5),
      clip(Math.log(Math.max(f.volumeRatio,1e-6))/1.0),clip(Math.log(Math.max(f.rangeRatio,1e-6))/0.8),clip(ctx.scale4/0.025)
    ];
    events.push({id:id++,time:ctx.time,direction,side:direction>0?'UP':'DOWN',symbol:f.symbol,f,ctx,magnitude,robustScore,runnerGap,vector});
  }
}

const HORIZONS=[2,4],LOOKBACKS=[180,365],KS=[25,50,100],MIN_EDGES=[0.003,0.005],MIN_HIT=0.54,MAX_K=Math.max(...KS);
function rawOutcome(ev,holdHours){
  const rows=executionBySymbol.get(ev.symbol),entryTime=ev.f.rows[ev.f.index+1].time,exitTime=entryTime+holdHours*3600,ei=lowerBound(rows,entryTime),xi=lowerBound(rows,exitTime);
  if(rows[ei]?.time!==entryTime||rows[xi]?.time!==exitTime)return null;for(let i=ei+1;i<=xi;i++)if(rows[i].time!==rows[i-1].time+300)return null;
  return ev.direction*(rows[xi].open/rows[ei].open-1);
}
for(const ev of events){ev.outcomes={};for(const h of HORIZONS)ev.outcomes[h]=rawOutcome(ev,h);}
const bySide={UP:events.filter(e=>e.side==='UP'),DOWN:events.filter(e=>e.side==='DOWN')};
function distance(a,b){let s=0;for(let i=0;i<a.length;i++){const d=a[i]-b[i];s+=d*d;}return s;}
function insertNearest(arr,item){
  let lo=0,hi=arr.length;while(lo<hi){const m=(lo+hi)>>1;if(arr[m].dist<=item.dist)lo=m+1;else hi=m;}arr.splice(lo,0,item);if(arr.length>MAX_K)arr.pop();
}
const analogCache=new Map();
function buildAnalogs(holdHours,lookbackDays){
  const key=`${holdHours}:${lookbackDays}`;if(analogCache.has(key))return analogCache.get(key);
  const out=new Map(),lookbackSec=lookbackDays*86400,matureSec=holdHours*3600;
  for(const side of ['UP','DOWN']){
    const xs=bySide[side];
    for(let i=0;i<xs.length;i++){
      const cur=xs[i],near=[];
      for(let j=i-1;j>=0;j--){const p=xs[j];if(p.time<cur.time-lookbackSec)break;if(p.time+matureSec>cur.time||p.outcomes[holdHours]==null)continue;insertNearest(near,{dist:distance(cur.vector,p.vector),value:p.outcomes[holdHours]});}
      out.set(cur.id,near);
    }
  }
  analogCache.set(key,out);return out;
}
function analogStats(ev,holdHours,lookbackDays,k){const near=buildAnalogs(holdHours,lookbackDays).get(ev.id)??[];if(near.length<k)return null;const xs=near.slice(0,k),vals=xs.map(x=>x.value),m=mean(vals),hit=vals.filter(x=>x>0).length/vals.length;return{n:vals.length,meanContinuation:m,continuationHit:hit,meanDistance:mean(xs.map(x=>x.dist))};}

const POLICIES=[];
for(const holdHours of HORIZONS)for(const lookbackDays of LOOKBACKS)for(const k of KS)for(const minEdge of MIN_EDGES)POLICIES.push({id:`H${holdHours}H_L${lookbackDays}_K${k}_E${Math.round(minEdge*10000)}`,holdHours,lookbackDays,k,minEdge,minHit:MIN_HIT});
const signalCache=new Map();
function signals(policy){
  if(signalCache.has(policy.id))return signalCache.get(policy.id);const out=[];
  for(const ev of events){const s=analogStats(ev,policy.holdHours,policy.lookbackDays,policy.k);if(!s)continue;let mode=null;if(s.meanContinuation>=policy.minEdge&&s.continuationHit>=policy.minHit)mode='CONTINUE';else if(s.meanContinuation<=-policy.minEdge&&(1-s.continuationHit)>=policy.minHit)mode='REVERSE';if(!mode)continue;out.push({ev,mode,tradeDirection:mode==='CONTINUE'?ev.direction:-ev.direction,analog:s});}
  out.sort((a,b)=>a.ev.time-b.ev.time||b.analog.meanDistance-a.analog.meanDistance);signalCache.set(policy.id,out);return out;
}
function resolve(sig,policy,friction=FRICTION,slippage=SLIPPAGE){
  const ev=sig.ev,rows=executionBySymbol.get(ev.symbol),entryTime=ev.f.rows[ev.f.index+1].time,exitTime=entryTime+policy.holdHours*3600,ei=lowerBound(rows,entryTime),xi=lowerBound(rows,exitTime);if(rows[ei]?.time!==entryTime||rows[xi]?.time!==exitTime)return null;for(let i=ei+1;i<=xi;i++)if(rows[i].time!==rows[i-1].time+300)return null;
  const d=sig.tradeDirection,entry=rows[ei].open*(1+d*slippage),exit=rows[xi].open*(1-d*slippage),gross=d*(exit/entry-1),net=gross-friction;return{symbol:ev.symbol,sideClass:ev.side,mode:sig.mode,openedAt:entryTime*1000,closedAt:exitTime*1000,grossReturn:gross,netReturn:net,analog:sig.analog};
}
const tradeCache=new Map();
function trades(policy,friction=FRICTION,slippage=SLIPPAGE){const key=`${policy.id}:${friction}:${slippage}`;if(tradeCache.has(key))return tradeCache.get(key);const raw=signals(policy).flatMap(s=>{const t=resolve(s,policy,friction,slippage);return t?[t]:[];}).sort((a,b)=>a.openedAt-b.openedAt);const out=[],busy=new Map();for(const t of raw){if((busy.get(t.symbol)??0)>t.openedAt)continue;out.push(t);busy.set(t.symbol,t.closedAt);}tradeCache.set(key,out);return out;}
function monthlyRows(rows,start,end){return signalRaw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1);if(s<start||e>end)return[];const xs=rows.filter(t=>t.openedAt>=s&&t.openedAt<e);return[{month:m,trades:xs.length,value:sum(xs.map(t=>t.netReturn))}];});}
function metrics(ts,start,end){const rows=ts.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netReturn>0),l=rows.filter(t=>t.netReturn<=0),monthly=monthlyRows(rows,start,end),bySymbol=Object.fromEntries([...new Set(rows.map(t=>t.symbol))].map(s=>[s,sum(rows.filter(t=>t.symbol===s).map(t=>t.netReturn))])),pos=Object.values(bySymbol).filter(v=>v>0),pt=sum(pos);return{trades:rows.length,tradesPerDay:rows.length/Math.max(1,(end-start)/86400000),totalNetReturn:sum(rows.map(t=>t.netReturn)),meanNetReturn:mean(rows.map(t=>t.netReturn)),profitFactor:l.length?sum(g.map(t=>t.netReturn))/Math.abs(sum(l.map(t=>t.netReturn))):g.length?99:0,winRate:rows.length?g.length/rows.length:0,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.value>0).length,largestPositiveSymbolShare:pt?Math.max(...pos)/pt:1,byMode:{CONTINUE:{trades:rows.filter(t=>t.mode==='CONTINUE').length,value:sum(rows.filter(t=>t.mode==='CONTINUE').map(t=>t.netReturn))},REVERSE:{trades:rows.filter(t=>t.mode==='REVERSE').length,value:sum(rows.filter(t=>t.mode==='REVERSE').map(t=>t.netReturn))}},monthly};}
const foldBounds=[[0,10],[10,20],[20,30]];
function audit(policy){
  const base=trades(policy),stress=trades(policy,STRESS_FRICTION),adverse=trades(policy,FRICTION,SLIPPAGE*2),d=metrics(base,fromMs,discoveryEnd),ds=metrics(stress,fromMs,discoveryEnd),da=metrics(adverse,fromMs,discoveryEnd),v=metrics(base,discoveryEnd,validationEnd),sv=metrics(stress,discoveryEnd,validationEnd),av=metrics(adverse,discoveryEnd,validationEnd),e=metrics(base,validationEnd,toMs),se=metrics(stress,validationEnd,toMs),ae=metrics(adverse,validationEnd,toMs),folds=foldBounds.map(([a,b])=>metrics(base,monthStart(signalRaw.months[a]),monthStart(signalRaw.months[b])));
  const discoveryQualified=d.trades>=250&&d.totalNetReturn>0&&d.profitFactor>=1.08&&d.activeMonths>=18&&d.positiveMonths>=Math.ceil(d.activeMonths*0.55)&&d.largestPositiveSymbolShare<=0.45&&folds.filter(x=>x.totalNetReturn>0).length>=2&&folds.at(-1).totalNetReturn>0&&ds.totalNetReturn>0&&ds.profitFactor>=1&&da.totalNetReturn>0&&da.profitFactor>=1;
  const validationPass=discoveryQualified&&v.trades>=60&&v.totalNetReturn>0&&v.profitFactor>=1.03&&sv.totalNetReturn>0&&sv.profitFactor>=1&&av.totalNetReturn>0&&av.profitFactor>=1;
  const evaluationPass=validationPass&&e.trades>=30&&e.totalNetReturn>0&&e.profitFactor>=1.03&&se.totalNetReturn>0&&se.profitFactor>=1&&ae.totalNetReturn>0&&ae.profitFactor>=1;
  return{policy,discovery:d,discoveryStress:ds,discoveryAdverse:da,discoveryFolds:folds,validation:v,stressValidation:sv,adverseValidation:av,evaluation:e,stressEvaluation:se,adverseEvaluation:ae,discoveryQualified,validationPass,evaluationPass};
}
const audits=POLICIES.map(audit),qualified=audits.filter(a=>a.discoveryQualified).sort((a,b)=>(b.discovery.profitFactor-a.discovery.profitFactor)||(b.discovery.totalNetReturn-a.discovery.totalNetReturn)),shortlist=qualified.slice(0,3).map(a=>a.policy.id),heldOutChecks=audits.filter(a=>shortlist.includes(a.policy.id)),accepted=heldOutChecks.filter(a=>a.validationPass&&a.evaluationPass),decision=accepted.length?'EXTERNAL_HOLDOUT_REQUIRED':shortlist.length?'NO_HELDOUT_PASS':'NO_DISCOVERY_ANALOG';
const result={research:'historical-analog-direction-resolver',premise:'first select the most cross-sectionally unusual coin, then choose continuation or reversal from only previously matured historically similar full market states instead of a fixed directional doctrine',canonical:{signalSha256:signalRaw.sha256,executionSha256:executionRaw.sha256,months:signalRaw.months.length,symbols:signalRaw.symbols},special:SPECIAL,featureVector:['magnitude','robustScore','runnerGap','relative1','relative1Acceleration','relative4Acceleration','relative12','relative24','market1','market4','market12','market24','breadth1','breadth4','volumeBurst','rangeBurst','dispersion4'],eventCount:events.length,horizonsHours:HORIZONS,lookbackDays:LOOKBACKS,kValues:KS,minEdges:MIN_EDGES,minHit:MIN_HIT,audits,shortlist,heldOutChecks,accepted:accepted.map(a=>a.policy.id),decision,protocolNote:'Neighbor outcomes are admitted only after their own holding horizon has fully matured before the current event. Hyperparameters are fixed before held-out inspection; shortlist is discovery-only. This is state-conditioned causal analog matching, not recent-PnL promotion or a shadow strategy. Research-only; no PAPER/LIVE/production mutation.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,eventCount:events.length,shortlist,accepted:result.accepted,topDiscovery:audits.slice().sort((a,b)=>b.discovery.profitFactor-a.discovery.profitFactor).slice(0,10).map(a=>({id:a.policy.id,qualified:a.discoveryQualified,d:a.discovery,v:a.validation,e:a.evaluation}))},null,2));