import { readFileSync, writeFileSync } from 'node:fs';

const SIGNAL_DATASET = process.env.RESEARCH_SIGNAL_DATASET ?? '/tmp/gate-history-leader-structure-44m-1h.json';
const EXECUTION_DATASET = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-leader-structure-44m-5m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/leader-structure-state-audit-44m.json';
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const STRESS_FRICTION = Number(process.env.RESEARCH_STRESS_FRICTION ?? 0.0022);
const SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const HOLD_HOURS = 8;

const signalRaw = JSON.parse(readFileSync(SIGNAL_DATASET, 'utf8'));
const executionRaw = JSON.parse(readFileSync(EXECUTION_DATASET, 'utf8'));
if (signalRaw.interval !== '1h' || executionRaw.interval !== '5m' || signalRaw.months.join() !== executionRaw.months.join()) throw new Error('Requires matching canonical 1h + 5m datasets');
if (signalRaw.months.length !== 44 || signalRaw.symbols.length !== 11) throw new Error('Requires frozen 44m / 11-symbol core universe');

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => xs.length ? sum(xs) / xs.length : 0;
const median = (xs) => { if (!xs.length) return 0; const ys = [...xs].sort((a,b)=>a-b); return ys[Math.floor(ys.length/2)]; };
const sign = (x) => x > 0 ? 1 : x < 0 ? -1 : 0;
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const monthStart = (m) => Date.UTC(Number(m.slice(0,4)), Number(m.slice(4,6))-1, 1);
const fromMs = signalRaw.from * 1000;
const toMs = signalRaw.now * 1000;
const discoveryEnd = monthStart(signalRaw.months[30]);
const validationEnd = monthStart(signalRaw.months[38]);
const executionBySymbol = new Map(executionRaw.datasets.map((d)=>[d.symbol,d.rows]));
const ret = (rows,i,h) => rows[i].close / rows[i-h].close - 1;
function gapPrefix(rows){ const p=[0]; for(let i=1;i<rows.length;i+=1)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+3600)); return p; }
function lowerBound(rows,time){ let lo=0,hi=rows.length; while(lo<hi){ const mid=Math.floor((lo+hi)/2); if(rows[mid].time<time)lo=mid+1; else hi=mid; } return lo; }
function pearson(xs,ys){ if(xs.length!==ys.length||xs.length<8)return NaN; const mx=mean(xs),my=mean(ys); let n=0,dx=0,dy=0; for(let i=0;i<xs.length;i+=1){const a=xs[i]-mx,b=ys[i]-my;n+=a*b;dx+=a*a;dy+=b*b;} return dx>1e-12&&dy>1e-12?n/Math.sqrt(dx*dy):NaN; }
function q(xs,p){ const ys=xs.filter(Number.isFinite).sort((a,b)=>a-b); if(!ys.length)return NaN; const pos=(ys.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos); return lo===hi?ys[lo]:ys[lo]+(ys[hi]-ys[lo])*(pos-lo); }

const byTime=new Map();
for(const {symbol,rows} of signalRaw.datasets){
  const gaps=gapPrefix(rows);
  for(let i=168;i<rows.length-1;i+=1){
    if(gaps[i]!==gaps[i-168]||rows[i+1].time!==rows[i].time+3600)continue;
    const f={symbol,rows,index:i,r1:ret(rows,i,1),r4:ret(rows,i,4),r24:ret(rows,i,24)};
    const arr=byTime.get(rows[i].time)??[];arr.push(f);byTime.set(rows[i].time,arr);
  }
}
const contexts=[];
for(const [time,rows] of byTime){
  if(rows.length<9)continue;
  const c={median1:median(rows.map(r=>r.r1)),median4:median(rows.map(r=>r.r4)),median24:median(rows.map(r=>r.r24)),breadth1:rows.filter(r=>r.r1>0).length/rows.length,breadth4:rows.filter(r=>r.r4>0).length/rows.length};
  const enriched=rows.map(f=>({...f,relative1:f.r1-c.median1,relative4:f.r4-c.median4,relative24:f.r24-c.median24}));
  contexts.push({time,rows:enriched,context:c});
}
contexts.sort((a,b)=>a.time-b.time);
const contextByTime=new Map(contexts.map(x=>[x.time,x]));

function topSet(state,d,n=3){ return new Set([...state.rows].sort((a,b)=>d*(b.relative4-a.relative4)).slice(0,n).map(r=>r.symbol)); }
function jaccard(a,b){ const inter=[...a].filter(x=>b.has(x)).length,uni=new Set([...a,...b]).size; return uni?inter/uni:0; }
function structureFeatures(state,d){
  const prev24=[]; for(let h=23;h>=0;h-=1){const s=contextByTime.get(state.time-h*3600); if(!s)return null; prev24.push(s);}
  const prev8=prev24.slice(-8),prev4=prev24.slice(-4),prev9=prev24.slice(-9);
  const alignedBreadth=(s)=>d>0?s.context.breadth4:1-s.context.breadth4;
  const breadthPersistence4=mean(prev4.map(alignedBreadth));
  const trendPersistence8=mean(prev8.map(s=>Number(sign(s.context.median1)===d)));
  const sync24=mean(prev24.map(s=>{const m=sign(s.context.median1); if(!m)return 0.5; return s.rows.filter(r=>sign(r.r1)===m).length/s.rows.length;}));
  const marketSeries=prev24.map(s=>s.context.median1);
  const corrs=signalRaw.symbols.flatMap(sym=>{const ys=prev24.map(s=>s.rows.find(r=>r.symbol===sym)?.r1); if(ys.some(v=>!Number.isFinite(v)))return[]; const c=pearson(ys,marketSeries); return Number.isFinite(c)?[c]:[];});
  const corr24=median(corrs);
  const past4=contextByTime.get(state.time-4*3600); if(!past4)return null;
  const rankPersistence4=jaccard(topSet(state,d),topSet(past4,d));
  let flips=0,den=0; for(let i=1;i<prev9.length;i+=1){const a=sign(prev9[i-1].context.median1),b=sign(prev9[i].context.median1); if(a&&b){den+=1;flips+=Number(a!==b);}}
  const flipRate8=den?flips/den:0;
  const retention=clamp((d*state.context.median1)/Math.max(Math.abs(state.context.median4)/4,0.0005),-2,3);
  const dispersion4=median(state.rows.map(r=>Math.abs(r.relative4)));
  return {corr24,sync24,breadthPersistence4,trendPersistence8,rankPersistence4,flipRate8,retention,dispersion4};
}

// Freeze the raw LEAD_STRONG signal definition from the prior leader-laggard audit.
const STRONG={market4Min:0.020,breadthMin:0.82,gap4Min:0.015,resumeRel1:0.0015,maxPerHour:2};
const signals=[];
for(const state of contexts){
  const d=sign(state.context.median4); if(!d||Math.abs(state.context.median4)<STRONG.market4Min)continue;
  const alignedBreadth=d>0?state.context.breadth4:1-state.context.breadth4; if(alignedBreadth<STRONG.breadthMin)continue;
  const features=structureFeatures(state,d); if(!features)continue;
  const ranked=state.rows.flatMap(f=>{const gap=d*f.relative4;if(gap<STRONG.gap4Min||d*f.relative1<STRONG.resumeRel1)return[];return[{time:state.time,f,direction:d,strength:gap+Math.max(0,d*f.relative1),alignedBreadth,features}];}).sort((a,b)=>b.strength-a.strength||a.f.symbol.localeCompare(b.f.symbol)).slice(0,STRONG.maxPerHour);
  signals.push(...ranked);
}
signals.sort((a,b)=>a.time-b.time||b.strength-a.strength);

// Thresholds are outcome-independent: terciles of feature values at discovery signal hours only.
const discoverySignals=signals.filter(s=>s.time*1000<discoveryEnd);
const featureNames=['corr24','sync24','breadthPersistence4','trendPersistence8','rankPersistence4','flipRate8','retention','dispersion4'];
const thresholds=Object.fromEntries(featureNames.map(name=>{const xs=discoverySignals.map(s=>s.features[name]);return[name,{q33:q(xs,1/3),q67:q(xs,2/3),median:q(xs,0.5)}];}));
const hi=(s,n)=>s.features[n]>=thresholds[n].q67;
const lo=(s,n)=>s.features[n]<=thresholds[n].q33;
const GATES=[
  {id:'ALL',test:()=>true},
  {id:'CORR_HIGH',test:s=>hi(s,'corr24')},{id:'CORR_LOW',test:s=>lo(s,'corr24')},
  {id:'SYNC_HIGH',test:s=>hi(s,'sync24')},{id:'SYNC_LOW',test:s=>lo(s,'sync24')},
  {id:'TREND_PERSIST_HIGH',test:s=>hi(s,'trendPersistence8')},{id:'TREND_PERSIST_LOW',test:s=>lo(s,'trendPersistence8')},
  {id:'RANK_STICKY_HIGH',test:s=>hi(s,'rankPersistence4')},{id:'RANK_STICKY_LOW',test:s=>lo(s,'rankPersistence4')},
  {id:'RETENTION_HIGH',test:s=>hi(s,'retention')},{id:'RETENTION_LOW',test:s=>lo(s,'retention')},
  {id:'DISPERSION_HIGH',test:s=>hi(s,'dispersion4')},{id:'DISPERSION_LOW',test:s=>lo(s,'dispersion4')},
  {id:'LOW_FLIP',test:s=>lo(s,'flipRate8')},{id:'HIGH_FLIP',test:s=>hi(s,'flipRate8')},
  {id:'COHERENT_TREND',test:s=>hi(s,'corr24')&&hi(s,'trendPersistence8')&&hi(s,'breadthPersistence4')},
  {id:'ORDERED_LEADERS',test:s=>hi(s,'rankPersistence4')&&hi(s,'retention')},
  {id:'DISP_STICKY',test:s=>hi(s,'dispersion4')&&hi(s,'rankPersistence4')},
  {id:'SYNC_RETENTION',test:s=>hi(s,'sync24')&&hi(s,'retention')},
  {id:'IDIOSYNCRATIC',test:s=>lo(s,'corr24')&&hi(s,'dispersion4')},
];

function resolve(sig,friction=FRICTION,slippage=SLIPPAGE){
  const rows=executionBySymbol.get(sig.f.symbol),entryTime=sig.f.rows[sig.f.index+1].time,exitTime=entryTime+HOLD_HOURS*3600;
  const ei=lowerBound(rows,entryTime),xi=lowerBound(rows,exitTime); if(rows[ei]?.time!==entryTime||rows[xi]?.time!==exitTime)return null;
  const d=sig.direction,entry=rows[ei].open*(1+d*slippage),exit=rows[xi].open*(1-d*slippage),gross=d*(exit/entry-1),net=gross-friction;
  return {symbol:sig.f.symbol,side:d>0?'LONG':'SHORT',openedAt:entryTime*1000,closedAt:exitTime*1000,strength:sig.strength,grossReturn:gross,netReturn:net,features:sig.features};
}
function gateTrades(gate,friction=FRICTION,slippage=SLIPPAGE){
  const rows=signals.filter(gate.test).flatMap(s=>{const t=resolve(s,friction,slippage);return t?[t]:[];}).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength);
  const accepted=[],busy=new Map();
  for(const t of rows){if((busy.get(t.symbol)??0)>t.openedAt)continue;accepted.push(t);busy.set(t.symbol,t.closedAt);} return accepted;
}
function monthRows(trades,start,end){return signalRaw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1);if(s<start||e>end)return[];const xs=trades.filter(t=>t.openedAt>=s&&t.openedAt<e);return[{month:m,trades:xs.length,value:sum(xs.map(t=>t.netReturn))}];});}
function metrics(trades,start,end){const rows=trades.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netReturn>0),l=rows.filter(t=>t.netReturn<=0),monthly=monthRows(rows,start,end);return{trades:rows.length,tradesPerDay:rows.length/Math.max(1,(end-start)/86400000),totalNetReturn:sum(rows.map(t=>t.netReturn)),meanNetReturn:mean(rows.map(t=>t.netReturn)),profitFactor:l.length?sum(g.map(t=>t.netReturn))/Math.abs(sum(l.map(t=>t.netReturn))):g.length?99:0,winRate:rows.length?g.length/rows.length:0,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.value>0).length,monthly};}
const foldBounds=[[0,10],[10,20],[20,30]];
function discoveryAudit(gate){
  const base=gateTrades(gate),stress=gateTrades(gate,STRESS_FRICTION),adverse=gateTrades(gate,FRICTION,SLIPPAGE*2);
  const d=metrics(base,fromMs,discoveryEnd),ds=metrics(stress,fromMs,discoveryEnd),da=metrics(adverse,fromMs,discoveryEnd);
  const folds=foldBounds.map(([a,b])=>metrics(base,monthStart(signalRaw.months[a]),monthStart(signalRaw.months[b])));
  const qualified=d.trades>=120&&d.totalNetReturn>0&&d.profitFactor>=1.06&&d.activeMonths>=18&&d.positiveMonths>=Math.ceil(d.activeMonths*0.50)&&folds.filter(x=>x.totalNetReturn>0).length>=2&&folds.at(-1).totalNetReturn>0&&ds.totalNetReturn>0&&ds.profitFactor>=1&&da.totalNetReturn>0&&da.profitFactor>=1;
  return{gate:gate.id,discovery:d,discoveryStress:ds,discoveryAdverse:da,folds,qualified,score:qualified?Math.log(Math.max(d.profitFactor,1))*Math.sqrt(d.trades):null};
}
const discoveryAudits=GATES.map(discoveryAudit);
const shortlist=discoveryAudits.filter(x=>x.qualified).sort((a,b)=>(b.score??-Infinity)-(a.score??-Infinity)).slice(0,3).map(x=>x.gate);
function heldOut(gateId){
  const gate=GATES.find(g=>g.id===gateId),base=gateTrades(gate),stress=gateTrades(gate,STRESS_FRICTION),adverse=gateTrades(gate,FRICTION,SLIPPAGE*2);
  const validation={base:metrics(base,discoveryEnd,validationEnd),stress:metrics(stress,discoveryEnd,validationEnd),adverse:metrics(adverse,discoveryEnd,validationEnd)};
  const evaluation={base:metrics(base,validationEnd,toMs),stress:metrics(stress,validationEnd,toMs),adverse:metrics(adverse,validationEnd,toMs)};
  const pass=(x,min,months)=>x.base.trades>=min&&x.base.totalNetReturn>0&&x.base.profitFactor>=1.05&&x.base.positiveMonths>=months&&x.stress.totalNetReturn>0&&x.stress.profitFactor>=1&&x.adverse.totalNetReturn>0&&x.adverse.profitFactor>=1;
  return{gate:gateId,validation,evaluation,validationPass:pass(validation,30,4),evaluationPass:pass(evaluation,20,3)};
}
const heldOutChecks=shortlist.map(heldOut),accepted=heldOutChecks.filter(x=>x.validationPass&&x.evaluationPass).map(x=>x.gate);
const decision=accepted.length?'STRUCTURAL_GATE_CANDIDATE':'NO_STRUCTURAL_GATE';

const result={research:'leader-structure-state-audit',premise:'test whether pre-entry market structure explains when frozen LEAD_STRONG continuation has edge; no recent PnL or strategy outcome enters the state switch',canonical:{signalSha256:signalRaw.sha256,executionSha256:executionRaw.sha256,months:signalRaw.months.length,symbols:signalRaw.symbols},signalDefinition:STRONG,holdHours:HOLD_HOURS,featureNames,thresholdProtocol:'q33/q67 computed from discovery signal-time feature distributions only, independent of outcomes',thresholds,gates:GATES.map(g=>g.id),signalCounts:{all:signals.length,discovery:discoverySignals.length,validation:signals.filter(s=>s.time*1000>=discoveryEnd&&s.time*1000<validationEnd).length,evaluation:signals.filter(s=>s.time*1000>=validationEnd).length},discoveryAudits,shortlist,heldOutChecks,accepted,decision,protocolNote:'Discovery alone selects at most three predeclared structural gates. Validation/evaluation never choose thresholds or gates. Fixed 8h next-5m-open execution is used as a neutral diagnostic before any exit tuning. Costs include entry+exit adverse slippage plus friction. Research-only; no PAPER/LIVE/production mutation.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,signalCounts:result.signalCounts,thresholds,shortlist,qualified:discoveryAudits.filter(x=>x.qualified).map(x=>({gate:x.gate,discovery:{trades:x.discovery.trades,profitFactor:x.discovery.profitFactor,totalNetReturn:x.discovery.totalNetReturn,positiveMonths:x.discovery.positiveMonths},folds:x.folds.map(f=>({trades:f.trades,profitFactor:f.profitFactor,totalNetReturn:f.totalNetReturn}))})),heldOutChecks:heldOutChecks.map(x=>({gate:x.gate,validation:{trades:x.validation.base.trades,profitFactor:x.validation.base.profitFactor,totalNetReturn:x.validation.base.totalNetReturn,positiveMonths:x.validation.base.positiveMonths},evaluation:{trades:x.evaluation.base.trades,profitFactor:x.evaluation.base.profitFactor,totalNetReturn:x.evaluation.base.totalNetReturn,positiveMonths:x.evaluation.base.positiveMonths},validationPass:x.validationPass,evaluationPass:x.evaluationPass}))},null,2));
