import { readFileSync, writeFileSync } from 'node:fs';

const SIGNAL_DATASET = process.env.RESEARCH_SIGNAL_DATASET ?? '/tmp/gate-history-up-leader-exhaustion-44m-1h.json';
const EXECUTION_DATASET = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-up-leader-exhaustion-44m-5m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/up-leader-exhaustion-structure-audit-44m.json';
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const STRESS_FRICTION = Number(process.env.RESEARCH_STRESS_FRICTION ?? 0.0022);
const SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const HOLD_HOURS = 4;

const signalRaw = JSON.parse(readFileSync(SIGNAL_DATASET, 'utf8'));
const executionRaw = JSON.parse(readFileSync(EXECUTION_DATASET, 'utf8'));
if (signalRaw.interval !== '1h' || executionRaw.interval !== '5m' || signalRaw.months.join() !== executionRaw.months.join()) throw new Error('Requires matching canonical 1h + 5m datasets');
if (signalRaw.months.length !== 44 || signalRaw.symbols.length !== 11) throw new Error('Requires frozen 44m / 11-symbol core universe');

const sum = (xs) => xs.reduce((a,b)=>a+b,0);
const mean = (xs) => xs.length ? sum(xs)/xs.length : 0;
const median = (xs) => { if(!xs.length) return 0; const ys=[...xs].sort((a,b)=>a-b); const m=Math.floor(ys.length/2); return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2; };
const sign = (x) => x>0?1:x<0?-1:0;
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const q = (xs,p) => { const ys=xs.filter(Number.isFinite).sort((a,b)=>a-b); if(!ys.length)return NaN; const pos=(ys.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos); return lo===hi?ys[lo]:ys[lo]+(ys[hi]-ys[lo])*(pos-lo); };
const monthStart = (m) => Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=signalRaw.from*1000,toMs=signalRaw.now*1000;
const discoveryEnd=monthStart(signalRaw.months[30]);
const validationEnd=monthStart(signalRaw.months[38]);
const executionBySymbol=new Map(executionRaw.datasets.map(d=>[d.symbol,d.rows]));
const ret=(rows,i,h)=>rows[i].close/rows[i-h].close-1;
function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+3600));return p;}
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}
function pearson(xs,ys){if(xs.length!==ys.length||xs.length<8)return NaN;const mx=mean(xs),my=mean(ys);let n=0,dx=0,dy=0;for(let i=0;i<xs.length;i++){const a=xs[i]-mx,b=ys[i]-my;n+=a*b;dx+=a*a;dy+=b*b;}return dx>1e-12&&dy>1e-12?n/Math.sqrt(dx*dy):NaN;}

const byTime=new Map();
for(const {symbol,rows} of signalRaw.datasets){
  const gp=gapPrefix(rows);
  for(let i=168;i<rows.length-9;i++){
    if(gp[i]!==gp[i-168]||rows[i+1].time!==rows[i].time+3600)continue;
    const f={symbol,rows,index:i,r1:ret(rows,i,1),r4:ret(rows,i,4),r24:ret(rows,i,24),prev1:rows[i-1].close/rows[i-2].close-1,prev4:rows[i-1].close/rows[i-5].close-1};
    const arr=byTime.get(rows[i].time)??[];arr.push(f);byTime.set(rows[i].time,arr);
  }
}
const contexts=[];
for(const [time,rows] of byTime){
  if(rows.length<9)continue;
  const c={
    median1:median(rows.map(r=>r.r1)),median4:median(rows.map(r=>r.r4)),median24:median(rows.map(r=>r.r24)),
    medianPrev1:median(rows.map(r=>r.prev1)),medianPrev4:median(rows.map(r=>r.prev4)),
    breadth1:rows.filter(r=>r.r1>0).length/rows.length,breadth4:rows.filter(r=>r.r4>0).length/rows.length,
  };
  const es=rows.map(f=>({...f,relative1:f.r1-c.median1,relative4:f.r4-c.median4,relative1Prev:f.prev1-c.medianPrev1,relative4Prev:f.prev4-c.medianPrev4}));
  const dispersion4=median(es.map(f=>Math.abs(f.relative4)));
  contexts.push({time,rows:es,context:c,dispersion4,robustScale4:Math.max(0.001,dispersion4)});
}
contexts.sort((a,b)=>a.time-b.time);
const contextByTime=new Map(contexts.map(x=>[x.time,x]));

function topSet(state,n=3){return new Set([...state.rows].sort((a,b)=>b.relative4-a.relative4).slice(0,n).map(r=>r.symbol));}
function jaccard(a,b){const inter=[...a].filter(x=>b.has(x)).length,uni=new Set([...a,...b]).size;return uni?inter/uni:0;}
function structureFeatures(state){
  const prev24=[];for(let h=23;h>=0;h--){const s=contextByTime.get(state.time-h*3600);if(!s)return null;prev24.push(s);}
  const prev8=prev24.slice(-8),prev4=prev24.slice(-4),prev9=prev24.slice(-9);
  const marketSeries=prev24.map(s=>s.context.median1);
  const corrs=signalRaw.symbols.flatMap(sym=>{const ys=prev24.map(s=>s.rows.find(r=>r.symbol===sym)?.r1);if(ys.some(v=>!Number.isFinite(v)))return[];const c=pearson(ys,marketSeries);return Number.isFinite(c)?[c]:[];});
  const corr24=median(corrs);
  const sync24=mean(prev24.map(s=>{const m=sign(s.context.median1);if(!m)return 0.5;return s.rows.filter(r=>sign(r.r1)===m).length/s.rows.length;}));
  const breadthPersistence4=mean(prev4.map(s=>s.context.breadth1));
  const trendPersistence8=mean(prev8.map(s=>Number(s.context.median1>0)));
  const past4=contextByTime.get(state.time-4*3600);if(!past4)return null;
  const rankPersistence4=jaccard(topSet(state),topSet(past4));
  let flips=0,den=0;for(let i=1;i<prev9.length;i++){const a=sign(prev9[i-1].context.median1),b=sign(prev9[i].context.median1);if(a&&b){den++;flips+=Number(a!==b);}}
  const flipRate8=den?flips/den:0;
  const retention=clamp(state.context.median1/Math.max(Math.abs(state.context.median4)/4,0.0005),-2,3);
  const dispersion4=state.dispersion4;
  const priorDispersion=median(prev4.slice(0,-1).map(s=>s.dispersion4));
  const dispersionRatio=priorDispersion>1e-9?dispersion4/priorDispersion:1;
  const breadthImpulse=state.context.breadth1-mean(prev4.slice(0,-1).map(s=>s.context.breadth1));
  const market24=state.context.median24;
  return {corr24,sync24,breadthPersistence4,trendPersistence8,rankPersistence4,flipRate8,retention,dispersion4,dispersionRatio,breadthImpulse,market24};
}

// User hypothesis translated causally: pick the most exceptional prior 4h riser, then only consider it
// after its own 1h return turns negative while the market median is still positive and its relative lead shrinks.
const EVENT_RULE={minRelative4:0.012,minRobustScore:1.8,minRunnerGap:0.002,absoluteTurnMax:-0.001,marketSameMin:0.0005,anomalyShrinkMax:-0.001};
const events=[];
for(const state of contexts){
  const ranked=[...state.rows].sort((a,b)=>b.relative4-a.relative4);
  const f=ranked[0],second=ranked[1];if(!f||!second)continue;
  const magnitude=f.relative4,runnerGap=magnitude-second.relative4,robustScore=magnitude/state.robustScale4;
  if(magnitude<EVENT_RULE.minRelative4||robustScore<EVENT_RULE.minRobustScore||runnerGap<EVENT_RULE.minRunnerGap)continue;
  const prevGapSame=f.relative4Prev-Math.max(...state.rows.filter(x=>x.symbol!==f.symbol).map(x=>x.relative4Prev));
  const anomalyDelta=f.relative4-f.relative4Prev,gapDelta=runnerGap-prevGapSame;
  if(f.r1>EVENT_RULE.absoluteTurnMax||state.context.median1<EVENT_RULE.marketSameMin||anomalyDelta>EVENT_RULE.anomalyShrinkMax||gapDelta>0)continue;
  const features=structureFeatures(state);if(!features)continue;
  events.push({time:state.time,f,magnitude,runnerGap,robustScore,anomalyDelta,gapDelta,features});
}

const discoveryEvents=events.filter(e=>e.time*1000<discoveryEnd);
const featureNames=['corr24','sync24','breadthPersistence4','trendPersistence8','rankPersistence4','flipRate8','retention','dispersion4','dispersionRatio','breadthImpulse','market24'];
const thresholds=Object.fromEntries(featureNames.map(name=>{const xs=discoveryEvents.map(e=>e.features[name]);return[name,{q33:q(xs,1/3),q67:q(xs,2/3),median:q(xs,0.5)}];}));
const hi=(e,n)=>e.features[n]>=thresholds[n].q67;
const lo=(e,n)=>e.features[n]<=thresholds[n].q33;
const GATES=[
  {id:'ALL',test:()=>true},
  {id:'CORR_HIGH',test:e=>hi(e,'corr24')},{id:'CORR_LOW',test:e=>lo(e,'corr24')},
  {id:'SYNC_HIGH',test:e=>hi(e,'sync24')},{id:'SYNC_LOW',test:e=>lo(e,'sync24')},
  {id:'BREADTH_HIGH',test:e=>hi(e,'breadthPersistence4')},{id:'BREADTH_LOW',test:e=>lo(e,'breadthPersistence4')},
  {id:'TREND_PERSIST_HIGH',test:e=>hi(e,'trendPersistence8')},{id:'TREND_PERSIST_LOW',test:e=>lo(e,'trendPersistence8')},
  {id:'RANK_STICKY_HIGH',test:e=>hi(e,'rankPersistence4')},{id:'RANK_STICKY_LOW',test:e=>lo(e,'rankPersistence4')},
  {id:'LOW_FLIP',test:e=>lo(e,'flipRate8')},{id:'HIGH_FLIP',test:e=>hi(e,'flipRate8')},
  {id:'RETENTION_HIGH',test:e=>hi(e,'retention')},{id:'RETENTION_LOW',test:e=>lo(e,'retention')},
  {id:'DISPERSION_HIGH',test:e=>hi(e,'dispersion4')},{id:'DISPERSION_LOW',test:e=>lo(e,'dispersion4')},
  {id:'DISPERSION_RISING',test:e=>hi(e,'dispersionRatio')},{id:'DISPERSION_FALLING',test:e=>lo(e,'dispersionRatio')},
  {id:'BREADTH_IMPULSE_HIGH',test:e=>hi(e,'breadthImpulse')},{id:'BREADTH_IMPULSE_LOW',test:e=>lo(e,'breadthImpulse')},
  {id:'MARKET24_HIGH',test:e=>hi(e,'market24')},{id:'MARKET24_LOW',test:e=>lo(e,'market24')},
  {id:'ORDERED_TREND',test:e=>hi(e,'corr24')&&hi(e,'trendPersistence8')&&lo(e,'flipRate8')},
  {id:'ROTATIONAL',test:e=>lo(e,'corr24')&&hi(e,'flipRate8')&&hi(e,'dispersion4')},
  {id:'CROWDED_BREADTH',test:e=>hi(e,'sync24')&&hi(e,'breadthPersistence4')},
  {id:'IDIOSYNCRATIC_LEADER',test:e=>lo(e,'corr24')&&hi(e,'dispersion4')&&lo(e,'rankPersistence4')},
  {id:'DIFFUSE_TREND',test:e=>hi(e,'breadthPersistence4')&&lo(e,'dispersion4')},
  {id:'UNSTICKY_RANK',test:e=>lo(e,'rankPersistence4')&&hi(e,'flipRate8')},
];

function resolve(e,friction=FRICTION,slippage=SLIPPAGE){
  const rows=executionBySymbol.get(e.f.symbol),entryTime=e.f.rows[e.f.index+1].time,exitTime=entryTime+HOLD_HOURS*3600;
  const ei=lowerBound(rows,entryTime),xi=lowerBound(rows,exitTime);if(rows[ei]?.time!==entryTime||rows[xi]?.time!==exitTime)return null;
  const d=-1,entry=rows[ei].open*(1+d*slippage),exit=rows[xi].open*(1-d*slippage),gross=d*(exit/entry-1),net=gross-friction;
  return {symbol:e.f.symbol,openedAt:entryTime*1000,closedAt:exitTime*1000,grossReturn:gross,netReturn:net,features:e.features};
}
function gateTrades(gate,friction=FRICTION,slippage=SLIPPAGE){
  const rows=events.filter(gate.test).flatMap(e=>{const t=resolve(e,friction,slippage);return t?[t]:[];}).sort((a,b)=>a.openedAt-b.openedAt);
  const accepted=[],busy=new Map();for(const t of rows){if((busy.get(t.symbol)??0)>t.openedAt)continue;accepted.push(t);busy.set(t.symbol,t.closedAt);}return accepted;
}
function monthRows(trades,start,end){return signalRaw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1);if(s<start||e>end)return[];const xs=trades.filter(t=>t.openedAt>=s&&t.openedAt<e);return[{month:m,trades:xs.length,value:sum(xs.map(t=>t.netReturn))}];});}
function metrics(trades,start,end){const rows=trades.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netReturn>0),l=rows.filter(t=>t.netReturn<=0),monthly=monthRows(rows,start,end);return{trades:rows.length,tradesPerDay:rows.length/Math.max(1,(end-start)/86400000),totalNetReturn:sum(rows.map(t=>t.netReturn)),meanNetReturn:mean(rows.map(t=>t.netReturn)),profitFactor:l.length?sum(g.map(t=>t.netReturn))/Math.abs(sum(l.map(t=>t.netReturn))):g.length?99:0,winRate:rows.length?g.length/rows.length:0,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.value>0).length,monthly};}
const foldBounds=[[0,10],[10,20],[20,30]];
function discoveryAudit(gate){
  const base=gateTrades(gate),stress=gateTrades(gate,STRESS_FRICTION),adverse=gateTrades(gate,FRICTION,SLIPPAGE*2);
  const d=metrics(base,fromMs,discoveryEnd),ds=metrics(stress,fromMs,discoveryEnd),da=metrics(adverse,fromMs,discoveryEnd);
  const folds=foldBounds.map(([a,b])=>metrics(base,monthStart(signalRaw.months[a]),monthStart(signalRaw.months[b])));
  const qualified=d.trades>=60&&d.totalNetReturn>0&&d.profitFactor>=1.05&&d.activeMonths>=15&&d.positiveMonths>=Math.ceil(d.activeMonths*0.50)&&folds.filter(x=>x.totalNetReturn>0).length>=2&&folds.at(-1).totalNetReturn>0&&ds.totalNetReturn>0&&ds.profitFactor>=1&&da.totalNetReturn>0&&da.profitFactor>=1;
  return{gate:gate.id,discovery:d,discoveryStress:ds,discoveryAdverse:da,folds,qualified,score:qualified?Math.log(Math.max(d.profitFactor,1))*Math.sqrt(d.trades):null};
}
const discoveryAudits=GATES.map(discoveryAudit);
const shortlist=discoveryAudits.filter(x=>x.qualified).sort((a,b)=>(b.score??-Infinity)-(a.score??-Infinity)).slice(0,3).map(x=>x.gate);
function heldOut(gateId){
  const gate=GATES.find(g=>g.id===gateId),base=gateTrades(gate),stress=gateTrades(gate,STRESS_FRICTION),adverse=gateTrades(gate,FRICTION,SLIPPAGE*2);
  const validation={base:metrics(base,discoveryEnd,validationEnd),stress:metrics(stress,discoveryEnd,validationEnd),adverse:metrics(adverse,discoveryEnd,validationEnd)};
  const evaluation={base:metrics(base,validationEnd,toMs),stress:metrics(stress,validationEnd,toMs),adverse:metrics(adverse,validationEnd,toMs)};
  const pass=(x,min)=>x.base.trades>=min&&x.base.totalNetReturn>0&&x.base.profitFactor>=1&&x.stress.totalNetReturn>0&&x.adverse.totalNetReturn>0;
  return{gate:gateId,validation,evaluation,validationPass:pass(validation,15),evaluationPass:pass(evaluation,5)};
}
const heldOutChecks=shortlist.map(heldOut);
const accepted=heldOutChecks.filter(x=>x.validationPass&&x.evaluationPass).map(x=>x.gate);

function featureSummary(start,end){
  const xs=events.filter(e=>e.time*1000>=start&&e.time*1000<end);
  return {events:xs.length,features:Object.fromEntries(featureNames.map(n=>[n,{median:q(xs.map(e=>e.features[n]),0.5),q33:q(xs.map(e=>e.features[n]),1/3),q67:q(xs.map(e=>e.features[n]),2/3)}]))};
}
const allGate=GATES[0],allBase=gateTrades(allGate),allStress=gateTrades(allGate,STRESS_FRICTION),allAdverse=gateTrades(allGate,FRICTION,SLIPPAGE*2);
const rawSegments={
  discovery:{base:metrics(allBase,fromMs,discoveryEnd),stress:metrics(allStress,fromMs,discoveryEnd),adverse:metrics(allAdverse,fromMs,discoveryEnd)},
  validation:{base:metrics(allBase,discoveryEnd,validationEnd),stress:metrics(allStress,discoveryEnd,validationEnd),adverse:metrics(allAdverse,discoveryEnd,validationEnd)},
  evaluation:{base:metrics(allBase,validationEnd,toMs),stress:metrics(allStress,validationEnd,toMs),adverse:metrics(allAdverse,validationEnd,toMs)},
};
const decision=accepted.length?'STRUCTURAL_SWITCH_FOUND':'NO_CAUSAL_SWITCH';
const result={research:'up-leader-exhaustion-structure-audit',premise:'the most exceptional prior-4h riser is only a candidate; this audit asks whether causal market-structure features explain when its confirmed loss of momentum should be shorted',canonical:{signalSha256:signalRaw.sha256,executionSha256:executionRaw.sha256,months:signalRaw.months.length,symbols:signalRaw.symbols},eventRule:EVENT_RULE,holdHours:HOLD_HOURS,featureNames,thresholdProtocol:'all gate thresholds are discovery-event terciles and therefore independent of validation/evaluation outcomes',thresholds,gates:GATES.map(g=>g.id),eventCounts:{all:events.length,discovery:events.filter(e=>e.time*1000<discoveryEnd).length,validation:events.filter(e=>e.time*1000>=discoveryEnd&&e.time*1000<validationEnd).length,evaluation:events.filter(e=>e.time*1000>=validationEnd&&e.time*1000<toMs).length},featureShift:{discovery:featureSummary(fromMs,discoveryEnd),validation:featureSummary(discoveryEnd,validationEnd),evaluation:featureSummary(validationEnd,toMs)},rawSegments,discoveryAudits,shortlist,heldOutChecks,accepted,decision,protocolNote:'The event rule was fixed from the user hypothesis before this structural audit. Gate cutoffs are computed only from discovery feature distributions; validation/evaluation do not choose thresholds or gates. No recent-PnL switch, shadow promotion, or production mutation.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,eventCounts:result.eventCounts,rawSegments,shortlist,heldOutChecks,topDiscovery:discoveryAudits.slice().sort((a,b)=>(b.discovery.profitFactor??0)-(a.discovery.profitFactor??0)).slice(0,8).map(x=>({gate:x.gate,qualified:x.qualified,discovery:x.discovery,stress:x.discoveryStress,adverse:x.discoveryAdverse,folds:x.folds})),featureShift:result.featureShift},null,2));
