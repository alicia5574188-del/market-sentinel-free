import { readFileSync, writeFileSync } from 'node:fs';

const DATASET = process.env.RESEARCH_DATASET ?? '/tmp/gate-history-intrahour-anomaly-44m-5m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/intrahour-anomaly-resolver-44m.json';
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const STRESS_FRICTION = Number(process.env.RESEARCH_STRESS_FRICTION ?? 0.0022);
const SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);

const raw = JSON.parse(readFileSync(DATASET, 'utf8'));
if (raw.interval !== '5m' || raw.months.length !== 44 || raw.symbols.length !== 11) throw new Error('Requires frozen 44m / 11-symbol canonical 5m dataset');

const sum = (xs) => xs.reduce((a,b)=>a+b,0);
const mean = (xs) => xs.length ? sum(xs)/xs.length : 0;
const median = (xs) => { if(!xs.length)return 0; const ys=[...xs].sort((a,b)=>a-b); const m=Math.floor(ys.length/2); return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2; };
const monthStart = (m) => Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=raw.from*1000,toMs=raw.now*1000;
const discoveryEnd=monthStart(raw.months[30]);
const validationEnd=monthStart(raw.months[38]);
const datasets=raw.datasets.map(d=>({symbol:d.symbol,rows:d.rows,pointer:0,gaps:null}));
const bySymbol=new Map(datasets.map(d=>[d.symbol,d.rows]));
function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+300));return p;}
for(const d of datasets)d.gaps=gapPrefix(d.rows);
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}
function validWindow(d,i,bars){return i>=bars&&d.gaps[i]===d.gaps[i-bars];}

const SPECIAL={minAbsRelative4:0.012,minRobustScore:1.8,minRunnerGap:0.002};
const TRIGGERS=[
  {id:'REV_REL',family:'REV',test:e=>e.relative5<=-0.0008&&e.anomalyDelta<=-0.0005},
  {id:'REV_MARKET_SAME',family:'REV',test:e=>e.absolute5<=-0.0008&&e.market5>=0&&e.relative5<=-0.0006&&e.anomalyDelta<=-0.0005},
  {id:'REV_STRICT',family:'REV',test:e=>e.absolute5<=-0.0012&&e.market5>=0.0001&&e.anomalyDelta<=-0.0008},
  {id:'CONT_REL',family:'CONT',test:e=>e.relative5>=0.0008&&e.anomalyDelta>=0.0005},
  {id:'CONT_MARKET_SAME',family:'CONT',test:e=>e.absolute5>=0.0008&&e.market5>=0&&e.relative5>=0.0006&&e.anomalyDelta>=0.0005},
  {id:'CONT_STRICT',family:'CONT',test:e=>e.absolute5>=0.0012&&e.market5>=0.0001&&e.anomalyDelta>=0.0008},
];
const HORIZONS=[6,12,24,48]; // 30m, 1h, 2h, 4h in 5m bars.
const prevRel4=new Map();
const prevRelTime=new Map();
const prevTriggerState=new Map();
const signals=[];
let synchronizedBars=0,specialCandidateBars=0;

// Use BTC's near-complete 5m series as the master clock and advance all other series monotonically.
const master=datasets.find(d=>d.symbol==='BTC_USDT')??datasets[0];
for(let mi=288;mi<master.rows.length-50;mi++){
  const time=master.rows[mi].time;
  const rows=[];
  for(const d of datasets){
    while(d.pointer<d.rows.length&&d.rows[d.pointer].time<time)d.pointer++;
    const i=d.pointer;
    if(i>=d.rows.length||d.rows[i].time!==time||!validWindow(d,i,48))continue;
    const r=d.rows[i],p=d.rows[i-1],h4=d.rows[i-48];
    rows.push({symbol:d.symbol,rows:d.rows,index:i,r5:r.close/p.close-1,r4:r.close/h4.close-1});
  }
  if(rows.length<9)continue;
  synchronizedBars++;
  const median5=median(rows.map(x=>x.r5)),median4=median(rows.map(x=>x.r4));
  const enriched=rows.map(x=>({...x,relative5:x.r5-median5,relative4:x.r4-median4}));
  const scale4=Math.max(0.001,median(enriched.map(x=>Math.abs(x.relative4))));
  const currentByDirection=new Map();
  for(const direction of [1,-1]){
    const ranked=enriched.filter(x=>direction*x.relative4>0).sort((a,b)=>direction*(b.relative4-a.relative4));
    if(!ranked.length){currentByDirection.set(direction,null);continue;}
    const f=ranked[0],runner=ranked[1];
    const magnitude=direction*f.relative4,runnerMagnitude=runner?direction*runner.relative4:0,runnerGap=Math.max(0,magnitude-runnerMagnitude),robustScore=magnitude/scale4;
    const prevTime=prevRelTime.get(f.symbol),previous=prevTime===time-300?prevRel4.get(f.symbol):null;
    const anomalyDelta=Number.isFinite(previous)?direction*(f.relative4-previous):NaN;
    const pass=magnitude>=SPECIAL.minAbsRelative4&&robustScore>=SPECIAL.minRobustScore&&runnerGap>=SPECIAL.minRunnerGap;
    const e=pass?{time,symbol:f.symbol,direction,magnitude,runnerGap,robustScore,relative5:direction*f.relative5,absolute5:direction*f.r5,market5:direction*median5,anomalyDelta}:null;
    if(e)specialCandidateBars++;
    currentByDirection.set(direction,e);
  }

  // Emit only the first 5m bar of a trigger episode. If the condition clears and later reappears,
  // it may form a new signal. This prevents repeated entries merely because one coin stays unusual.
  for(const direction of [1,-1]){
    const e=currentByDirection.get(direction);
    for(const trigger of TRIGGERS){
      const key=`${trigger.id}:${direction}`;
      const truth=Boolean(e&&Number.isFinite(e.anomalyDelta)&&trigger.test(e));
      const prev=prevTriggerState.get(key);
      const continuing=truth&&prev?.truth&&prev.symbol===e.symbol&&prev.time===time-300;
      if(truth&&!continuing)signals.push({...e,triggerId:trigger.id,family:trigger.family,tradeDirection:trigger.family==='REV'?-direction:direction,signalTime:time,entryTime:time+300});
      prevTriggerState.set(key,{truth,symbol:e?.symbol??null,time});
    }
  }
  for(const f of enriched){prevRel4.set(f.symbol,f.relative4);prevRelTime.set(f.symbol,time);}
}

function resolve(sig,holdBars,friction=FRICTION,slippage=SLIPPAGE){
  const rows=bySymbol.get(sig.symbol),ei=lowerBound(rows,sig.entryTime),exitTime=sig.entryTime+holdBars*300,xi=lowerBound(rows,exitTime);
  if(rows[ei]?.time!==sig.entryTime||rows[xi]?.time!==exitTime)return null;
  if(xi<=ei)return null;
  // Require continuous execution bars between entry and exit.
  for(let i=ei+1;i<=xi;i++)if(rows[i].time!==rows[i-1].time+300)return null;
  const d=sig.tradeDirection,entry=rows[ei].open*(1+d*slippage),exit=rows[xi].open*(1-d*slippage),gross=d*(exit/entry-1),net=gross-friction;
  return {...sig,holdBars,openedAt:sig.entryTime*1000,closedAt:exitTime*1000,grossReturn:gross,netReturn:net};
}
function policySignals(policy){return signals.filter(s=>s.triggerId===policy.triggerId&&(policy.side==='UP'?s.direction>0:s.direction<0));}
const tradeCache=new Map();
function rawTrades(policy,friction=FRICTION,slippage=SLIPPAGE){
  const key=`${policy.id}:${friction}:${slippage}`;if(tradeCache.has(key))return tradeCache.get(key);
  const rows=policySignals(policy).flatMap(s=>{const t=resolve(s,policy.holdBars,friction,slippage);return t?[t]:[];}).sort((a,b)=>a.openedAt-b.openedAt||b.robustScore-a.robustScore);
  const accepted=[],busy=new Map();for(const t of rows){if((busy.get(t.symbol)??0)>t.openedAt)continue;accepted.push(t);busy.set(t.symbol,t.closedAt);}tradeCache.set(key,accepted);return accepted;
}
function monthRows(trades,start,end){return raw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1);if(s<start||e>end)return[];const xs=trades.filter(t=>t.openedAt>=s&&t.openedAt<e);return[{month:m,trades:xs.length,value:sum(xs.map(t=>t.netReturn))}];});}
function metrics(trades,start,end){
  const rows=trades.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netReturn>0),l=rows.filter(t=>t.netReturn<=0),monthly=monthRows(rows,start,end);
  return{trades:rows.length,tradesPerDay:rows.length/Math.max(1,(end-start)/86400000),totalNetReturn:sum(rows.map(t=>t.netReturn)),meanNetReturn:mean(rows.map(t=>t.netReturn)),profitFactor:l.length?sum(g.map(t=>t.netReturn))/Math.abs(sum(l.map(t=>t.netReturn))):g.length?99:0,winRate:rows.length?g.length/rows.length:0,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.value>0).length,monthly};
}
const foldBounds=[[0,10],[10,20],[20,30]];
function audit(policy){
  const base=rawTrades(policy),stress=rawTrades(policy,STRESS_FRICTION),adverse=rawTrades(policy,FRICTION,SLIPPAGE*2);
  const d=metrics(base,fromMs,discoveryEnd),ds=metrics(stress,fromMs,discoveryEnd),da=metrics(adverse,fromMs,discoveryEnd),v=metrics(base,discoveryEnd,validationEnd),e=metrics(base,validationEnd,toMs);
  const folds=foldBounds.map(([a,b])=>metrics(base,monthStart(raw.months[a]),monthStart(raw.months[b])));
  const qualified=d.trades>=200&&d.totalNetReturn>0&&d.profitFactor>=1.06&&d.activeMonths>=20&&d.positiveMonths>=Math.ceil(d.activeMonths*0.53)&&folds.filter(x=>x.totalNetReturn>0).length>=2&&folds.at(-1).totalNetReturn>0&&ds.totalNetReturn>0&&ds.profitFactor>=1&&da.totalNetReturn>0&&da.profitFactor>=1;
  const score=qualified?Math.log(Math.max(d.profitFactor,1))*Math.sqrt(d.trades):null;
  return{policy,discovery:d,discoveryStress:ds,discoveryAdverse:da,discoveryFolds:folds,discoveryQualified:qualified,score,validation:v,evaluation:e};
}
const policies=[];
for(const trigger of TRIGGERS)for(const side of ['UP','DOWN'])for(const holdBars of HORIZONS)policies.push({id:`${trigger.id}_${side}_${holdBars*5}M`,triggerId:trigger.id,family:trigger.family,side,holdBars});
const audits=policies.map(audit);

// Discovery may nominate at most one policy per {REV/CONT} x {UP/DOWN}; held-out periods never choose policy geometry.
const selected=[];
for(const family of ['REV','CONT'])for(const side of ['UP','DOWN']){
  const qs=audits.filter(a=>a.policy.family===family&&a.policy.side===side&&a.discoveryQualified).sort((a,b)=>(b.score??-Infinity)-(a.score??-Infinity));
  if(qs.length)selected.push(qs[0].policy);
}
function heldOutPolicy(policy){
  const a=audits.find(x=>x.policy.id===policy.id);
  const stress=rawTrades(policy,STRESS_FRICTION),adverse=rawTrades(policy,FRICTION,SLIPPAGE*2);
  const validation={base:a.validation,stress:metrics(stress,discoveryEnd,validationEnd),adverse:metrics(adverse,discoveryEnd,validationEnd)};
  const evaluation={base:a.evaluation,stress:metrics(stress,validationEnd,toMs),adverse:metrics(adverse,validationEnd,toMs)};
  const pass=(x,min)=>x.base.trades>=min&&x.base.totalNetReturn>0&&x.base.profitFactor>=1.03&&x.stress.totalNetReturn>0&&x.stress.profitFactor>=1&&x.adverse.totalNetReturn>0&&x.adverse.profitFactor>=1;
  return{policy,validation,evaluation,validationPass:pass(validation,50),evaluationPass:pass(evaluation,30)};
}
const heldOutChecks=selected.map(heldOutPolicy);
const accepted=heldOutChecks.filter(x=>x.validationPass&&x.evaluationPass).map(x=>x.policy.id);

function portfolio(start,end,policies,friction=FRICTION,slippage=SLIPPAGE){
  const candidates=policies.flatMap(p=>rawTrades(p,friction,slippage).filter(t=>t.openedAt>=start&&t.openedAt<end).map(t=>({...t,policyId:p.id}))).sort((a,b)=>a.openedAt-b.openedAt||b.robustScore-a.robustScore);
  let equity=1000,peak=1000,maxDrawdown=0;const open=[],taken=[];
  const settle=time=>{for(const t of open.filter(x=>x.closedAt<=time).sort((a,b)=>a.closedAt-b.closedAt)){equity+=t.pnl;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);open.splice(open.indexOf(t),1);}};
  for(let i=0;i<candidates.length;){const time=candidates[i].openedAt;settle(time);const same=[];while(i<candidates.length&&candidates[i].openedAt===time)same.push(candidates[i++]);for(const t of same){if(equity<=100||open.length>=4||open.some(x=>x.symbol===t.symbol))continue;const notional=equity*0.25,at={...t,notional,pnl:notional*t.netReturn};open.push(at);taken.push(at);}}
  settle(Infinity);const g=taken.filter(t=>t.pnl>0),l=taken.filter(t=>t.pnl<=0);
  return{trades:taken.length,tradesPerDay:taken.length/Math.max(1,(end-start)/86400000),netPnl:sum(taken.map(t=>t.pnl)),endEquity:equity,profitFactor:l.length?sum(g.map(t=>t.pnl))/Math.abs(sum(l.map(t=>t.pnl))):g.length?99:0,maxDrawdown};
}
const portfolios={
  discovery:{base:portfolio(fromMs,discoveryEnd,selected),stress:portfolio(fromMs,discoveryEnd,selected,STRESS_FRICTION),adverse:portfolio(fromMs,discoveryEnd,selected,FRICTION,SLIPPAGE*2)},
  validation:{base:portfolio(discoveryEnd,validationEnd,selected),stress:portfolio(discoveryEnd,validationEnd,selected,STRESS_FRICTION),adverse:portfolio(discoveryEnd,validationEnd,selected,FRICTION,SLIPPAGE*2)},
  evaluation:{base:portfolio(validationEnd,toMs,selected),stress:portfolio(validationEnd,toMs,selected,STRESS_FRICTION),adverse:portfolio(validationEnd,toMs,selected,FRICTION,SLIPPAGE*2)},
};
const decision=accepted.length?'FORWARD_CANDIDATE':'NO_RELEASE';
const result={research:'intrahour-anomaly-resolver',premise:'reselect the most cross-sectionally unusual coin every completed 5m bar; direction is resolved from whether its 4h anomaly is expanding or shrinking relative to the market, then enter only on the next 5m open',canonical:{executionSha256:raw.sha256,months:raw.months.length,symbols:raw.symbols},special:SPECIAL,triggers:TRIGGERS.map(({id,family})=>({id,family})),horizonsMinutes:HORIZONS.map(x=>x*5),synchronizedBars,specialCandidateBars,signalCounts:Object.fromEntries(TRIGGERS.map(t=>[t.id,{up:signals.filter(s=>s.triggerId===t.id&&s.direction>0).length,down:signals.filter(s=>s.triggerId===t.id&&s.direction<0).length}])),audits,selectedPolicies:selected,heldOutChecks,accepted,portfolios,decision,protocolNote:'All candidate selection and trigger fields are completed 5m data. Entry is next 5m open. Trigger geometry and horizons are predeclared; discovery alone may nominate one policy per family/side. Validation/evaluation only test frozen nominations. No recent-PnL switch, shadow promotion, or production mutation.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,synchronizedBars,specialCandidateBars,signalCounts:result.signalCounts,selectedPolicies:selected,heldOutChecks,portfolios,topDiscovery:audits.slice().sort((a,b)=>b.discovery.profitFactor-a.discovery.profitFactor).slice(0,12).map(x=>({policy:x.policy,qualified:x.discoveryQualified,discovery:x.discovery,stress:x.discoveryStress,adverse:x.discoveryAdverse,folds:x.discoveryFolds,validation:x.validation,evaluation:x.evaluation}))},null,2));
