import { readFileSync, writeFileSync } from 'node:fs';

const SIGNAL_DATASET = process.env.RESEARCH_SIGNAL_DATASET ?? '/tmp/gate-history-anomaly-44m-1h.json';
const EXECUTION_DATASET = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-anomaly-44m-5m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/cross-market-anomaly-policy-v2-44m.json';
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const STRESS_FRICTION = Number(process.env.RESEARCH_STRESS_FRICTION ?? 0.0022);
const SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);

const signalRaw = JSON.parse(readFileSync(SIGNAL_DATASET, 'utf8'));
const executionRaw = JSON.parse(readFileSync(EXECUTION_DATASET, 'utf8'));
if (signalRaw.interval !== '1h' || executionRaw.interval !== '5m' || signalRaw.months.join() !== executionRaw.months.join()) throw new Error('Requires matching canonical 1h + 5m datasets');
if (signalRaw.months.length !== 44 || signalRaw.symbols.length !== 11) throw new Error('Requires frozen 44m / 11-symbol core universe');

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => xs.length ? sum(xs) / xs.length : 0;
const median = (xs) => { if (!xs.length) return 0; const ys = [...xs].sort((a,b)=>a-b); const m = Math.floor(ys.length/2); return ys.length % 2 ? ys[m] : (ys[m-1]+ys[m])/2; };
const monthStart = (m) => Date.UTC(Number(m.slice(0,4)), Number(m.slice(4,6))-1, 1);
const fromMs = signalRaw.from * 1000;
const toMs = signalRaw.now * 1000;
const discoveryEnd = monthStart(signalRaw.months[30]);
const validationEnd = monthStart(signalRaw.months[38]);
const executionBySymbol = new Map(executionRaw.datasets.map((d)=>[d.symbol,d.rows]));
const ret = (rows,i,h) => rows[i].close / rows[i-h].close - 1;
function gapPrefix(rows){ const p=[0]; for(let i=1;i<rows.length;i+=1)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+3600)); return p; }
function lowerBound(rows,time){ let lo=0,hi=rows.length; while(lo<hi){ const mid=Math.floor((lo+hi)/2); if(rows[mid].time<time)lo=mid+1; else hi=mid; } return lo; }

// Same causal event definition as V1. This audit changes only the policy-selection protocol and exit model.
const byTime = new Map();
for (const {symbol,rows} of signalRaw.datasets) {
  const gaps = gapPrefix(rows);
  for (let i=168;i<rows.length-9;i+=1) {
    if (gaps[i] !== gaps[i-168] || rows[i+1].time !== rows[i].time+3600) continue;
    const f={symbol,rows,index:i,current:rows[i],r1:ret(rows,i,1),r4:ret(rows,i,4),prev1:rows[i-1].close/rows[i-2].close-1,prev4:rows[i-1].close/rows[i-5].close-1};
    const arr=byTime.get(rows[i].time)??[]; arr.push(f); byTime.set(rows[i].time,arr);
  }
}
const contexts=[];
for (const [time,rows] of byTime) {
  if (rows.length<9) continue;
  const c={median1:median(rows.map(r=>r.r1)),median4:median(rows.map(r=>r.r4)),medianPrev1:median(rows.map(r=>r.prev1)),medianPrev4:median(rows.map(r=>r.prev4))};
  const enriched=rows.map(f=>({...f,relative1:f.r1-c.median1,relative4:f.r4-c.median4,relative1Prev:f.prev1-c.medianPrev1,relative4Prev:f.prev4-c.medianPrev4,context:c}));
  const robustScale4=Math.max(0.001,median(enriched.map(f=>Math.abs(f.relative4))));
  contexts.push({time,rows:enriched,robustScale4});
}
contexts.sort((a,b)=>a.time-b.time);

function classifyState(e){
  const p=e.direction*e.f.relative1, pp=e.direction*e.f.relative1Prev;
  const anomalyDelta=e.direction*(e.f.relative4-e.f.relative4Prev);
  const marketNow=e.direction*e.f.context.median1;
  if (p<=-0.001){ if(marketNow>=0.0005)return 'DIVERGENCE_REV'; if(marketNow<=-0.0005)return 'MARKET_TURN_REV'; return 'RELATIVE_FAIL'; }
  if (pp<=0 && p>=0.0015 && anomalyDelta>=0.001) return 'REACCEL';
  if (p>=0.0015 && anomalyDelta>=0.001) return 'EXPANDING';
  if (pp>=0.002 && p<=pp*0.5 && anomalyDelta<=0.0005) return 'DECELERATING';
  return 'NEUTRAL';
}
const events=[];
for (const state of contexts) {
  for (const direction of [1,-1]) {
    const ranked=state.rows.filter(f=>direction*f.relative4>0).sort((a,b)=>direction*(b.relative4-a.relative4));
    if (!ranked.length) continue;
    const f=ranked[0], magnitude=direction*f.relative4, runnerMagnitude=ranked[1]?direction*ranked[1].relative4:0;
    const e={time:state.time,f,direction,magnitude,runnerGap:Math.max(0,magnitude-runnerMagnitude),robustScore:magnitude/state.robustScale4,relativePressure:direction*f.relative1,previousPressure:direction*f.relative1Prev,anomalyDelta:direction*(f.relative4-f.relative4Prev),marketPressure:direction*f.context.median1};
    e.state=classifyState(e); events.push(e);
  }
}
const SPECIAL={minAbsRelative4:0.012,minRobustScore:1.8,minRunnerGap:0.002};
const specialPass=(e)=>e.magnitude>=SPECIAL.minAbsRelative4&&e.robustScore>=SPECIAL.minRobustScore&&e.runnerGap>=SPECIAL.minRunnerGap;
const STATES=['EXPANDING','REACCEL','DECELERATING','DIVERGENCE_REV','MARKET_TURN_REV','RELATIVE_FAIL','NEUTRAL'];
const MODES=['CONTINUE','REVERSE'];
const HORIZONS=[2,4,8];

function resolvedTrade(e,mode,holdHours,friction=FRICTION,slippage=SLIPPAGE){
  if(!specialPass(e))return null;
  const rows=executionBySymbol.get(e.f.symbol), entryTime=e.f.rows[e.f.index+1].time, exitTime=entryTime+holdHours*3600;
  const ei=lowerBound(rows,entryTime), xi=lowerBound(rows,exitTime);
  if(rows[ei]?.time!==entryTime||rows[xi]?.time!==exitTime)return null;
  const d=mode==='CONTINUE'?e.direction:-e.direction;
  const entry=rows[ei].open*(1+d*slippage), exit=rows[xi].open*(1-d*slippage);
  const gross=d*(exit/entry-1), net=gross-friction;
  return {state:e.state,mode,holdHours,symbol:e.f.symbol,side:d>0?'LONG':'SHORT',openedAt:entryTime*1000,closedAt:exitTime*1000,grossReturn:gross,netReturn:net,strength:e.robustScore+e.runnerGap*100+Math.abs(e.relativePressure)*50};
}
function rawPolicyTrades(policy,friction=FRICTION,slippage=SLIPPAGE){
  const rows=events.filter(e=>e.state===policy.state).flatMap(e=>{const t=resolvedTrade(e,policy.mode,policy.holdHours,friction,slippage);return t?[t]:[];}).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength);
  const accepted=[],busyUntil=new Map();
  for(const t of rows){ if((busyUntil.get(t.symbol)??0)>t.openedAt)continue; accepted.push(t); busyUntil.set(t.symbol,t.closedAt); }
  return accepted;
}
function monthRows(trades,start,end,valueKey='netReturn'){
  return signalRaw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1); if(s<start||e>end)return[]; const xs=trades.filter(t=>t.openedAt>=s&&t.openedAt<e); return [{month:m,trades:xs.length,value:sum(xs.map(t=>t[valueKey]))}];});
}
function returnMetrics(trades,start,end){
  const rows=trades.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netReturn>0),l=rows.filter(t=>t.netReturn<=0),monthly=monthRows(rows,start,end);
  return {trades:rows.length,tradesPerDay:rows.length/Math.max(1,(end-start)/86400000),totalNetReturn:sum(rows.map(t=>t.netReturn)),meanNetReturn:mean(rows.map(t=>t.netReturn)),profitFactor:l.length?sum(g.map(t=>t.netReturn))/Math.abs(sum(l.map(t=>t.netReturn))):g.length?99:0,winRate:rows.length?g.length/rows.length:0,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.value>0).length};
}
const discoveryFolds=(trades)=>[[0,10],[10,20],[20,30]].map(([a,b])=>returnMetrics(trades,monthStart(signalRaw.months[a]),monthStart(signalRaw.months[b])));
function policyAudit(policy){
  const base=rawPolicyTrades(policy),stress=rawPolicyTrades(policy,STRESS_FRICTION),adverse=rawPolicyTrades(policy,FRICTION,SLIPPAGE*2);
  const d=returnMetrics(base,fromMs,discoveryEnd),v=returnMetrics(base,discoveryEnd,validationEnd),e=returnMetrics(base,validationEnd,toMs),fs=discoveryFolds(base);
  const ds=returnMetrics(stress,fromMs,discoveryEnd),da=returnMetrics(adverse,fromMs,discoveryEnd);
  const q=d.trades>=180&&d.totalNetReturn>0&&d.profitFactor>=1.06&&d.activeMonths>=18&&d.positiveMonths>=Math.ceil(d.activeMonths*0.53)&&fs.filter(x=>x.totalNetReturn>0).length>=2&&fs.at(-1).totalNetReturn>0&&ds.totalNetReturn>0&&ds.profitFactor>=1&&da.totalNetReturn>0&&da.profitFactor>=1;
  const score=q?Math.log(Math.max(d.profitFactor,1))*Math.sqrt(d.trades):null;
  return {policy,discovery:d,discoveryStress:ds,discoveryAdverse:da,discoveryFolds:fs,discoveryQualified:q,score,validation:v,evaluation:e};
}
const policyAudits=[];
for(const state of STATES)for(const mode of MODES)for(const holdHours of HORIZONS)policyAudits.push(policyAudit({id:`${state}_${mode}_${holdHours}H`,state,mode,holdHours}));
const selectedPolicies=[];
for(const state of STATES){
  const qs=policyAudits.filter(a=>a.policy.state===state&&a.discoveryQualified).sort((a,b)=>(b.score??-Infinity)-(a.score??-Infinity));
  if(qs.length)selectedPolicies.push(qs[0].policy);
}

function portfolio(splitStart,splitEnd,policies,friction=FRICTION,slippage=SLIPPAGE){
  const candidates=policies.flatMap(p=>rawPolicyTrades(p,friction,slippage).filter(t=>t.openedAt>=splitStart&&t.openedAt<splitEnd).map(t=>({...t,policyId:p.id}))).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength);
  let equity=1000,peak=1000,maxDrawdown=0; const open=[],accepted=[];
  const settle=(time)=>{ for(const t of open.filter(x=>x.closedAt<=time).sort((a,b)=>a.closedAt-b.closedAt)){equity+=t.pnl;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);open.splice(open.indexOf(t),1);} };
  for(let i=0;i<candidates.length;){const openedAt=candidates[i].openedAt;settle(openedAt);const same=[];while(i<candidates.length&&candidates[i].openedAt===openedAt)same.push(candidates[i++]);for(const t of same){if(equity<=100||open.length>=4||open.some(x=>x.symbol===t.symbol))continue;const notional=equity*0.25,at={...t,notional,pnl:notional*t.netReturn};open.push(at);accepted.push(at);}}
  settle(Infinity);
  const g=accepted.filter(t=>t.pnl>0),l=accepted.filter(t=>t.pnl<=0),monthly=signalRaw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1);if(s<splitStart||e>splitEnd)return[];const xs=accepted.filter(t=>t.openedAt>=s&&t.openedAt<e);return[{month:m,trades:xs.length,pnl:sum(xs.map(t=>t.pnl))}];});
  const byState=Object.fromEntries(STATES.map(s=>[s,{trades:accepted.filter(t=>t.state===s).length,pnl:sum(accepted.filter(t=>t.state===s).map(t=>t.pnl))}]));
  return {trades:accepted.length,tradesPerDay:accepted.length/Math.max(1,(splitEnd-splitStart)/86400000),netPnl:sum(accepted.map(t=>t.pnl)),endEquity:equity,profitFactor:l.length?sum(g.map(t=>t.pnl))/Math.abs(sum(l.map(t=>t.pnl))):g.length?99:0,maxDrawdown,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.pnl>0).length,byState};
}
function splitBundle(start,end){return{base:portfolio(start,end,selectedPolicies),stress:portfolio(start,end,selectedPolicies,STRESS_FRICTION),adverse:portfolio(start,end,selectedPolicies,FRICTION,SLIPPAGE*2)};}
const discoveryPortfolio=splitBundle(fromMs,discoveryEnd),validationPortfolio=splitBundle(discoveryEnd,validationEnd),evaluationPortfolio=splitBundle(validationEnd,toMs);
const laterPass=(x,min)=>x.base.trades>=min&&x.base.netPnl>0&&x.base.profitFactor>=1.03&&x.stress.netPnl>0&&x.stress.profitFactor>=1&&x.adverse.netPnl>0&&x.adverse.profitFactor>=1;
const validationPass=selectedPolicies.length>0&&laterPass(validationPortfolio,50),evaluationPass=selectedPolicies.length>0&&laterPass(evaluationPortfolio,30);
const decision=selectedPolicies.length&&validationPass&&evaluationPass?'FORWARD_CANDIDATE':'NO_RELEASE';

const result={research:'cross-market-anomaly-policy-v2',premise:'direction and holding horizon are learned only from discovery among coarse predeclared state/mode/horizon cells; held-out periods never choose the mapping',canonical:{signalSha256:signalRaw.sha256,executionSha256:executionRaw.sha256,months:signalRaw.months.length,symbols:signalRaw.symbols},special:SPECIAL,states:STATES,modes:MODES,horizons:HORIZONS,contextHours:contexts.length,candidateEvents:events.length,specialEvents:events.filter(specialPass).length,policyAudits,selectedPolicies,portfolios:{discovery:discoveryPortfolio,validation:validationPortfolio,evaluation:evaluationPortfolio},validationPass,evaluationPass,decision,protocolNote:'V2 removes intuitive direction labels and V1 trail/target exits. Discovery alone may select one fixed mode+horizon per state. Validation/evaluation are independent 1000U replays with fixed 25% notional, max four open positions, same-symbol non-overlap, stress cost, and doubled slippage. No production mutation.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,selectedPolicies,validationPass,evaluationPass,topDiscovery:STATES.map(s=>policyAudits.filter(a=>a.policy.state===s).sort((a,b)=>b.discovery.profitFactor-a.discovery.profitFactor)[0]),portfolios:result.portfolios},null,2));
