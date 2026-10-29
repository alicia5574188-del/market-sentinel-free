import { readFileSync, writeFileSync } from 'node:fs';

const SIGNAL_DATASET = process.env.RESEARCH_SIGNAL_DATASET ?? '/tmp/gate-history-market-confirmed-44m-1h.json';
const EXECUTION_DATASET = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-market-confirmed-44m-5m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/market-confirmed-first-break-44m.json';
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const STRESS_FRICTION = Number(process.env.RESEARCH_STRESS_FRICTION ?? 0.0022);
const SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);

const signalRaw = JSON.parse(readFileSync(SIGNAL_DATASET, 'utf8'));
const executionRaw = JSON.parse(readFileSync(EXECUTION_DATASET, 'utf8'));
if (signalRaw.interval !== '1h' || executionRaw.interval !== '5m' || signalRaw.months.join() !== executionRaw.months.join()) throw new Error('Requires matching canonical 1h + 5m datasets');
if (signalRaw.months.length !== 44 || signalRaw.symbols.length !== 11) throw new Error('Requires frozen 44m / 11-symbol core universe');

const sum = (xs) => xs.reduce((a,b)=>a+b,0);
const mean = (xs) => xs.length ? sum(xs)/xs.length : 0;
const median = (xs) => { if (!xs.length) return 0; const ys=[...xs].sort((a,b)=>a-b); const m=Math.floor(ys.length/2); return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2; };
const monthStart = (m) => Date.UTC(Number(m.slice(0,4)), Number(m.slice(4,6))-1, 1);
const fromMs = signalRaw.from*1000, toMs = signalRaw.now*1000;
const discoveryEnd = monthStart(signalRaw.months[30]);
const validationEnd = monthStart(signalRaw.months[38]);
const executionBySymbol = new Map(executionRaw.datasets.map(d=>[d.symbol,d.rows]));
const ret = (rows,i,h) => rows[i].close/rows[i-h].close-1;
function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+3600));return p;}
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}

// Build synchronized causal cross-sections. Selection finds the unusual coin; trade direction is decided later.
const byTime=new Map();
for(const {symbol,rows} of signalRaw.datasets){
  const gp=gapPrefix(rows);
  for(let i=168;i<rows.length-9;i++){
    if(gp[i]!==gp[i-168]||rows[i+1].time!==rows[i].time+3600)continue;
    const f={symbol,rows,index:i,current:rows[i],r1:ret(rows,i,1),r4:ret(rows,i,4),prev1:rows[i-1].close/rows[i-2].close-1,prev4:rows[i-1].close/rows[i-5].close-1};
    const a=byTime.get(rows[i].time)??[];a.push(f);byTime.set(rows[i].time,a);
  }
}
const contexts=[];
for(const [time,rows] of byTime){
  if(rows.length<9)continue;
  const c={median1:median(rows.map(r=>r.r1)),median4:median(rows.map(r=>r.r4)),medianPrev1:median(rows.map(r=>r.prev1)),medianPrev4:median(rows.map(r=>r.prev4))};
  const es=rows.map(f=>({...f,relative1:f.r1-c.median1,relative4:f.r4-c.median4,relative1Prev:f.prev1-c.medianPrev1,relative4Prev:f.prev4-c.medianPrev4,context:c}));
  const scale=Math.max(0.001,median(es.map(f=>Math.abs(f.relative4))));
  contexts.push({time,rows:es,scale});
}
contexts.sort((a,b)=>a.time-b.time);

const SPECIAL={minAbsRelative4:0.012,minRobustScore:1.8,minRunnerGap:0.002};
const events=[];
for(const ctx of contexts){
  for(const direction of [1,-1]){
    const ranked=ctx.rows.filter(f=>direction*f.relative4>0).sort((a,b)=>direction*(b.relative4-a.relative4));
    if(ranked.length<2)continue;
    const f=ranked[0],magnitude=direction*f.relative4,runnerMagnitude=direction*ranked[1].relative4,runnerGap=Math.max(0,magnitude-runnerMagnitude),robustScore=magnitude/ctx.scale;
    if(magnitude<SPECIAL.minAbsRelative4||robustScore<SPECIAL.minRobustScore||runnerGap<SPECIAL.minRunnerGap)continue;
    const relPressure=direction*f.relative1,prevRelPressure=direction*f.relative1Prev,marketPressure=direction*f.context.median1,absolutePressure=direction*f.r1,anomalyDelta=direction*(f.relative4-f.relative4Prev);
    const prevGapSame=direction*f.relative4Prev-Math.max(...ctx.rows.filter(x=>x.symbol!==f.symbol).map(x=>direction*x.relative4Prev));
    const gapDelta=runnerGap-prevGapSame;
    const oppositeBreadth=ctx.rows.filter(x=>(-direction)*x.r1>0).length/ctx.rows.length;
    const firstBreak=relPressure<=-0.001&&prevRelPressure>0;
    if(!firstBreak)continue;
    events.push({time:ctx.time,f,direction,sideClass:direction>0?'UP_LEADER':'DOWN_LAGGARD',magnitude,runnerGap,robustScore,relPressure,prevRelPressure,marketPressure,absolutePressure,anomalyDelta,gapDelta,oppositeBreadth});
  }
}

// All thresholds below are fixed before this run. The key hypothesis is that the unusual coin is traded only when the overall market turns in the same direction as the proposed reversal.
const CONDITIONS={
  TURN:e=>e.marketPressure<=-0.0005,
  STRONG_TURN:e=>e.marketPressure<=-0.0010,
  TURN_BREADTH:e=>e.marketPressure<=-0.0005&&e.oppositeBreadth>=0.60,
  TURN_SHRINK:e=>e.marketPressure<=-0.0005&&e.anomalyDelta<=-0.001,
  TURN_GAP_SHRINK:e=>e.marketPressure<=-0.0005&&e.gapDelta<=0,
  TURN_FULL_SHRINK:e=>e.marketPressure<=-0.0005&&e.anomalyDelta<=-0.001&&e.gapDelta<=0,
  ABS_TURN:e=>e.marketPressure<=-0.0005&&e.absolutePressure<=-0.001,
  ABS_TURN_BREADTH:e=>e.marketPressure<=-0.0005&&e.absolutePressure<=-0.001&&e.oppositeBreadth>=0.60,
};
const HORIZONS=[2,4,8];
const SIDES=['UP_LEADER','DOWN_LAGGARD'];

function resolvedTrade(e,holdHours,friction=FRICTION,slippage=SLIPPAGE){
  const rows=executionBySymbol.get(e.f.symbol),entryTime=e.f.rows[e.f.index+1].time,exitTime=entryTime+holdHours*3600;
  const ei=lowerBound(rows,entryTime),xi=lowerBound(rows,exitTime);
  if(rows[ei]?.time!==entryTime||rows[xi]?.time!==exitTime)return null;
  const d=-e.direction;
  const entry=rows[ei].open*(1+d*slippage),exit=rows[xi].open*(1-d*slippage);
  const gross=d*(exit/entry-1),net=gross-friction;
  return {symbol:e.f.symbol,sideClass:e.sideClass,side:d>0?'LONG':'SHORT',openedAt:entryTime*1000,closedAt:exitTime*1000,grossReturn:gross,netReturn:net};
}
function cellTrades(condition,side,holdHours,friction=FRICTION,slippage=SLIPPAGE){
  const fn=CONDITIONS[condition];
  const rows=events.filter(e=>e.sideClass===side&&fn(e)).flatMap(e=>{const t=resolvedTrade(e,holdHours,friction,slippage);return t?[t]:[];}).sort((a,b)=>a.openedAt-b.openedAt);
  const accepted=[],busyUntil=new Map();
  for(const t of rows){if((busyUntil.get(t.symbol)??0)>t.openedAt)continue;accepted.push(t);busyUntil.set(t.symbol,t.closedAt);}
  return accepted;
}
function metrics(trades,start,end){
  const rows=trades.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netReturn>0),l=rows.filter(t=>t.netReturn<=0);
  const monthly=signalRaw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1);if(s<start||e>end)return[];const xs=rows.filter(t=>t.openedAt>=s&&t.openedAt<e);return[{month:m,trades:xs.length,value:sum(xs.map(t=>t.netReturn))}];});
  return {trades:rows.length,tradesPerDay:rows.length/Math.max(1,(end-start)/86400000),totalNetReturn:sum(rows.map(t=>t.netReturn)),meanNetReturn:mean(rows.map(t=>t.netReturn)),profitFactor:l.length?sum(g.map(t=>t.netReturn))/Math.abs(sum(l.map(t=>t.netReturn))):g.length?99:0,winRate:rows.length?g.length/rows.length:0,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.value>0).length,monthly};
}
function folds(trades){return[[0,10],[10,20],[20,30]].map(([a,b])=>metrics(trades,monthStart(signalRaw.months[a]),monthStart(signalRaw.months[b])));}
function audit(cell){
  const base=cellTrades(cell.condition,cell.side,cell.holdHours),stress=cellTrades(cell.condition,cell.side,cell.holdHours,STRESS_FRICTION),adverse=cellTrades(cell.condition,cell.side,cell.holdHours,FRICTION,SLIPPAGE*2);
  const d=metrics(base,fromMs,discoveryEnd),v=metrics(base,discoveryEnd,validationEnd),e=metrics(base,validationEnd,toMs),ds=metrics(stress,fromMs,discoveryEnd),da=metrics(adverse,fromMs,discoveryEnd),fs=folds(base);
  const discoveryQualified=d.trades>=120&&d.totalNetReturn>0&&d.profitFactor>=1.08&&d.activeMonths>=18&&d.positiveMonths>=Math.ceil(d.activeMonths*0.55)&&fs.filter(x=>x.totalNetReturn>0).length>=2&&fs.at(-1).totalNetReturn>0&&ds.totalNetReturn>0&&ds.profitFactor>=1&&da.totalNetReturn>0&&da.profitFactor>=1;
  const validationPass=discoveryQualified&&v.trades>=30&&v.totalNetReturn>0&&v.profitFactor>=1.03;
  const evaluationPass=validationPass&&e.trades>=15&&e.totalNetReturn>0&&e.profitFactor>=1.03;
  return {cell,discovery:d,discoveryStress:ds,discoveryAdverse:da,discoveryFolds:fs,discoveryQualified,validation:v,evaluation:e,validationPass,evaluationPass};
}
const audits=[];
for(const condition of Object.keys(CONDITIONS))for(const side of SIDES)for(const holdHours of HORIZONS)audits.push(audit({id:`${condition}_${side}_${holdHours}H`,condition,side,holdHours}));
const accepted=audits.filter(a=>a.evaluationPass);
const discoveryShortlist=audits.filter(a=>a.discoveryQualified).sort((a,b)=>b.discovery.profitFactor-a.discovery.profitFactor).slice(0,6).map(a=>a.cell.id);
const decision=accepted.length?'EXTERNAL_HOLDOUT_REQUIRED':'NO_RELEASE';
const result={research:'market-confirmed-first-break',premise:'select the most cross-sectionally unusual coin, wait for its first relative break, and reverse only when the overall market turns in the proposed trade direction',canonical:{signalSha256:signalRaw.sha256,executionSha256:executionRaw.sha256,months:signalRaw.months.length,symbols:signalRaw.symbols},special:SPECIAL,eventCount:events.length,conditions:Object.keys(CONDITIONS),horizons:HORIZONS,sides:SIDES,audits,discoveryShortlist,accepted:accepted.map(a=>a.cell.id),decision,protocolNote:'This is hypothesis-generation after earlier anomaly studies, so the final six core months are not pristine blind. Any surviving core cell must still pass an external-symbol holdout before production consideration. Research-only; no PAPER/LIVE/production mutation.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,eventCount:events.length,discoveryShortlist,accepted:result.accepted,topDiscovery:audits.slice().sort((a,b)=>b.discovery.profitFactor-a.discovery.profitFactor).slice(0,12).map(a=>({id:a.cell.id,qualified:a.discoveryQualified,d:a.discovery,v:a.validation,e:a.evaluation,validationPass:a.validationPass,evaluationPass:a.evaluationPass}))},null,2));