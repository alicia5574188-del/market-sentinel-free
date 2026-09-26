import { readFileSync, writeFileSync } from 'node:fs';

const EXEC_PATH = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-44m-5m.json';
const SIGNAL_1H_PATH = process.env.RESEARCH_SIGNAL_1H_DATASET ?? '/tmp/gate-history-44m-from5m-1h.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/robust-mother-phase-stagger.json';
const BASE_FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const ENTRY_SLIPPAGE = 0.00025;
const INITIAL_EQUITY = 1000;
const DAY_MS = 86400000;

const execRaw = JSON.parse(readFileSync(EXEC_PATH, 'utf8'));
const signal1hRaw = JSON.parse(readFileSync(SIGNAL_1H_PATH, 'utf8'));
if (execRaw.interval !== '5m' || signal1hRaw.interval !== '1h') throw new Error('expected 5m execution + 1h signal data');
if (execRaw.sha256 !== '9e5fd7d06eeee420d60318bee72de3b16e7e877247102a2b505453ab0b8a4522') throw new Error('execution hash mismatch');
if (signal1hRaw.sha256 !== '185bd97b968f96373bef6a174c8258d8ad5606a0d1ed824eaa2cc1ace1efa053') throw new Error('signal hash mismatch');

const sum = xs => xs.reduce((a,b)=>a+b,0);
const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;
const median = xs => { if (!xs.length) return 0; const a=[...xs].sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; };
const monthStart = m => Date.UTC(+m.slice(0,4), +m.slice(4,6)-1, 1);
const fromMs = execRaw.from*1000, discoveryEnd = monthStart(execRaw.months[30]), validationEnd = monthStart(execRaw.months[38]), toMs = execRaw.now*1000;
const executionBySymbol = new Map(execRaw.datasets.map(d=>[d.symbol,d.rows]));

function aggregateOffset(rows, offsetSeconds) {
  const out=[]; let b=null;
  for (const row of rows) {
    const time=Math.floor((Number(row.time)-offsetSeconds)/3600)*3600+offsetSeconds;
    if (!b || b.time!==time) {
      if (b?.samples>=10) out.push(b);
      b={time,open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume),samples:1};
    } else {
      b.high=Math.max(b.high,Number(row.high)); b.low=Math.min(b.low,Number(row.low)); b.close=Number(row.close); b.volume+=Number(row.volume); b.samples++;
    }
  }
  if (b?.samples>=10) out.push(b);
  const filled=[];
  for (const row of out) {
    const p=filled.at(-1); const missing=p?(row.time-p.time)/3600-1:0;
    if (p && missing>0 && missing<=3) for(let k=1;k<=missing;k++) filled.push({time:p.time+k*3600,open:p.close,high:p.close,low:p.close,close:p.close,volume:0,samples:0,synthetic:true});
    filled.push(row);
  }
  return filled;
}

const phaseData = new Map();
phaseData.set(0, signal1hRaw.datasets.map(d=>({symbol:d.symbol,rows:d.rows})));
for (const off of [900,1800,2700]) phaseData.set(off, execRaw.datasets.map(d=>({symbol:d.symbol,rows:aggregateOffset(d.rows,off)})));

function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+3600));return p;}
const ret=(rows,i,h)=>rows[i].close/rows[i-h].close-1;
const rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12);
function classify(c){const aligned=Math.max(c.breadth24,1-c.breadth24);if(Math.abs(c.median24)>=.04||(Math.abs(c.median24)>=.02&&aligned>=.82))return'SHOCK_TRANSITION';if(c.compression<=.68&&Math.abs(c.median24)<.025)return'COMPRESSION';if((c.median30>=.08&&c.median7>=.015&&c.breadth30>=.60)||(c.median30<=-.08&&c.median7<=-.015&&c.breadth30<=.40))return'DIRECTIONAL_TREND';if(Math.abs(c.median24)>=.018||aligned>=.75)return'NON_TREND_EXPANSION';return'BALANCED_ROTATION';}

function observationsFor(offset){
  const byTime=new Map();
  for(const {symbol,rows} of phaseData.get(offset)){
    const gaps=gapPrefix(rows);
    for(let i=720;i<rows.length-1;i++){
      const cur=rows[i]; if(gaps[i]!==gaps[i-720]||rows[i+1].time!==cur.time+3600)continue;
      const currentRanges=rows.slice(i-5,i+1).map(rangeRate), baselineRanges=rows.slice(i-168,i-6).map(rangeRate);
      const f={symbol,rows,index:i,current:cur,r6:ret(rows,i,6),r24:ret(rows,i,24),r7d:ret(rows,i,168),r30d:ret(rows,i,720),atr6:median(currentRanges),compression:median(currentRanges)/Math.max(median(baselineRanges),1e-9)};
      const a=byTime.get(cur.time)??[];a.push(f);byTime.set(cur.time,a);
    }
  }
  const out=[];
  for(const [time,rows] of byTime){
    if(rows.length<Math.max(8,execRaw.symbols.length-2))continue;
    const vals=k=>rows.map(r=>r[k]);
    const c={median24:median(vals('r24')),median7:median(vals('r7d')),median30:median(vals('r30d')),breadth24:rows.filter(r=>r.r24>0).length/rows.length,breadth7:rows.filter(r=>r.r7d>0).length/rows.length,breadth30:rows.filter(r=>r.r30d>0).length/rows.length,compression:median(vals('compression'))};
    const system=classify(c);
    for(const f of rows)out.push({...f,time,context:c,system,relative7:f.r7d-c.median7});
  }
  return out;
}
const observations = new Map([0,900,1800,2700].map(o=>[o,observationsFor(o)]));

function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const m=(lo+hi)>>1;if(rows[m].time<time)lo=m+1;else hi=m;}return lo;}
function rawTrades(offset,friction,slip){
  const id=`PHASE_${offset/60}M`; const trades=[];
  for(const f of observations.get(offset)){
    if(f.system!=='DIRECTIONAL_TREND'||f.time*1000>=toMs)continue;
    const md=sign(f.context.median30), direction=-md;
    if(!direction||direction*f.relative7<.03||direction*f.r6<.004)continue;
    const strength=direction*f.relative7+direction*f.r6;
    const erows=executionBySymbol.get(f.symbol), entryTime=f.rows[f.index+1].time, idx=lowerBound(erows,entryTime);
    if(erows[idx]?.time!==entryTime)continue;
    const entry=erows[idx].open*(1+direction*slip), stopRate=Math.min(.20,Math.max(.03,5*f.atr6)), targetRate=Math.max(stopRate*2.2,friction*2.2), stop=entry*(1-direction*stopRate), target=entry*(1+direction*targetRate);
    let exit=entry,closedAt=erows[idx].time*1000,outcome='DATA_GAP';
    for(let k=0;k<72*12&&idx+k<erows.length;k++){
      const c=erows[idx+k]; if(k&&c.time!==erows[idx+k-1].time+300){exit=erows[idx+k-1].close;closedAt=erows[idx+k-1].time*1000;break;}
      const stopped=direction>0?c.low<=stop:c.high>=stop, targeted=direction>0?c.high>=target:c.low<=target;
      if(stopped||targeted){exit=stopped?stop:target;closedAt=c.time*1000;outcome=stopped?'STOP':'TARGET';break;}
      exit=c.close;closedAt=c.time*1000;outcome=k===72*12-1?'TIMEOUT':outcome;
    }
    const gross=direction*(exit-entry)/entry;
    trades.push({strategyId:id,phaseOffsetSeconds:offset,symbol:f.symbol,side:direction>0?'LONG':'SHORT',openedAt:erows[idx].time*1000,closedAt,stopRate,friction,strength,outcome,netReturnRate:gross-friction});
  }
  return trades.sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength);
}

function portfolio(trades){
  let equity=INITIAL_EQUITY,peak=equity,maxDrawdown=0;const open=[],accepted=[],cooldown=new Map();
  const settle=time=>{for(const t of open.filter(x=>x.closedAt<=time).sort((a,b)=>a.closedAt-b.closedAt)){equity+=t.netPnl;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/Math.max(peak,1e-12));open.splice(open.indexOf(t),1);cooldown.set(`${t.strategyId}:${t.symbol}`,t.closedAt+24*3600000);}};
  for(let i=0;i<trades.length;){const at=trades[i].openedAt;settle(at);const simultaneous=[];while(i<trades.length&&trades[i].openedAt===at)simultaneous.push(trades[i++]);for(const t of simultaneous.sort((a,b)=>b.strength-a.strength||a.strategyId.localeCompare(b.strategyId))){if(equity<=100||open.some(x=>x.symbol===t.symbol)||(cooldown.get(`${t.strategyId}:${t.symbol}`)??0)>t.openedAt)continue;const same=open.filter(x=>x.side===t.side),multiple=Math.min(.5,.015/Math.max(t.stopRate+t.friction,1e-9));if(multiple<.05)continue;const notional=equity*multiple,plannedRisk=notional*(t.stopRate+t.friction);if(sum(open.map(x=>x.plannedRisk))+plannedRisk>equity*.10||sum(same.map(x=>x.plannedRisk))+plannedRisk>equity*.065)continue;const a={...t,equityAtOpen:equity,notional,plannedRisk,netPnl:notional*t.netReturnRate};open.push(a);accepted.push(a);}}
  settle(Infinity);return{trades:accepted,endEquity:equity,maxDrawdown};
}
function metrics(account,start,end){const rows=account.trades.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netPnl>0),l=rows.filter(t=>t.netPnl<=0);let eq=INITIAL_EQUITY,peak=eq,dd=0;for(const t of [...rows].sort((a,b)=>a.closedAt-b.closedAt)){eq+=t.netPnl;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/Math.max(peak,1e-12));}return{trades:rows.length,netPnl:sum(rows.map(t=>t.netPnl)),profitFactor:l.length?sum(g.map(t=>t.netPnl))/Math.abs(sum(l.map(t=>t.netPnl))):g.length?99:0,maxDrawdown:dd};}
function exposure(account,start,end){const grouped=new Map();for(const t of account.trades){const f=t.notional/Math.max(t.equityAtOpen,1e-12),d=t.side==='LONG'?1:-1;for(const [time,delta] of [[t.openedAt,d*f],[t.closedAt,-d*f]])if(time>=start&&time<end){const key=`${time}|${t.symbol}`;grouped.set(key,(grouped.get(key)??0)+delta);}}const days=(end-start)/DAY_MS;return{turnoverPerDay:sum([...grouped.values()].map(Math.abs))/days,entriesPerDay:account.trades.filter(t=>t.openedAt>=start&&t.openedAt<end).length/days};}
const periods={discovery:[fromMs,discoveryEnd],validation:[discoveryEnd,validationEnd],evaluation:[validationEnd,toMs],full:[fromMs,toMs]};
function summarize(account){return Object.fromEntries(Object.entries(periods).map(([k,[a,b]])=>[k,{...metrics(account,a,b),...exposure(account,a,b)}]));}
function evaluatePhase(offset){const paths={};for(const [name,cost,slip] of [['base',BASE_FRICTION,ENTRY_SLIPPAGE],['stress',STRESS_FRICTION,ENTRY_SLIPPAGE],['adverse',BASE_FRICTION,ENTRY_SLIPPAGE*2]]){const account=portfolio(rawTrades(offset,cost,slip));paths[name]={endEquity:account.endEquity,maxDrawdown:account.maxDrawdown,periods:summarize(account)};}const s=paths.stress.periods,a=paths.adverse.periods;const preQualified=s.discovery.trades>=40&&s.validation.trades>=20&&s.discovery.netPnl>0&&s.validation.netPnl>0&&s.discovery.profitFactor>=1&&s.validation.profitFactor>=1&&a.discovery.netPnl>0&&a.validation.netPnl>0;const evaluationSurvivor=preQualified&&s.evaluation.netPnl>0&&s.evaluation.profitFactor>=1&&a.evaluation.netPnl>0;return{offsetSeconds:offset,id:`PHASE_${offset/60}M`,preQualified,evaluationSurvivor,paths};}

const phases=[0,900,1800,2700].map(evaluatePhase);
const base=phases[0],expected={discovery:{trades:405,netPnl:51.32916758231005,profitFactor:1.0272665070296876},validation:{trades:110,netPnl:63.98045967877867,profitFactor:1.0966418747416167},evaluation:{trades:45,netPnl:238.7399157602952,profitFactor:2.771265720593711}};
const close=(a,b,t=1e-6)=>Math.abs(a-b)<=t;const parity=Object.fromEntries(Object.keys(expected).map(k=>[k,{trades:base.paths.stress.periods[k].trades===expected[k].trades,netPnl:close(base.paths.stress.periods[k].netPnl,expected[k].netPnl,1e-5),profitFactor:close(base.paths.stress.periods[k].profitFactor,expected[k].profitFactor,1e-8)}]));if(!Object.values(parity).every(x=>x.trades&&x.netPnl&&x.profitFactor))throw new Error(`baseline parity failed ${JSON.stringify(parity)}`);

const eligibleOffsets=phases.filter(x=>x.offsetSeconds===0||x.preQualified).map(x=>x.offsetSeconds);
function combined(cost,slip){const all=eligibleOffsets.flatMap(o=>rawTrades(o,cost,slip));return portfolio(all.sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength||a.strategyId.localeCompare(b.strategyId)));}
const combinedPaths={};for(const [name,cost,slip] of [['base',BASE_FRICTION,ENTRY_SLIPPAGE],['stress',STRESS_FRICTION,ENTRY_SLIPPAGE],['adverse',BASE_FRICTION,ENTRY_SLIPPAGE*2]]){const a=combined(cost,slip);combinedPaths[name]={endEquity:a.endEquity,maxDrawdown:a.maxDrawdown,periods:summarize(a)};}
const cs=combinedPaths.stress.periods,ca=combinedPaths.adverse.periods;const combinedPre=cs.discovery.netPnl>0&&cs.validation.netPnl>0&&ca.discovery.netPnl>0&&ca.validation.netPnl>0;const combinedEval=combinedPre&&cs.evaluation.netPnl>0&&ca.evaluation.netPnl>0;
const decision=eligibleOffsets.length>1&&combinedEval?'PHASE_STAGGER_SURVIVOR':'PHASE_STAGGER_REJECTED';
const report={research:'robust-positive-mother-phase-stagger-v1',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',decision,hypothesis:'preserve the proven 1h economic horizon and thresholds, but repeat the same 1h geometry on 15m/30m/45m shifted candle boundaries to create more independent observations without faster market data',mother:{id:'directional_trend-defensive_relative-5',frozen:{relative7:.03,confirm6:.004,stopFloor:.03,stopAtr:5,rewardRisk:2.2,maxHoldHours:72,cooldownHours:24}},data:{months:execRaw.months,symbols:execRaw.symbols,executionSha256:execRaw.sha256,signalSha256:signal1hRaw.sha256},split:{discovery:execRaw.months.slice(0,30),validation:execRaw.months.slice(30,38),evaluation:execRaw.months.slice(38)},protocol:{phaseOffsetsMinutes:[0,15,30,45],barSize:'1h for every phase',features:'same 6h/24h/168h/720h bar counts and same percent thresholds; only bar boundary shifts',execution:'next shifted 1h open, exact 5m path, conservative stop before target tie',costs:{base:BASE_FRICTION,stress:STRESS_FRICTION,adverseEntryExtra:ENTRY_SLIPPAGE},sizing:'same frozen risk sizing; same-symbol concurrent positions forbidden; cooldown is per phase+symbol',selection:'shifted phase enters combined portfolio only if stress and adverse are positive in both discovery and validation; evaluation is not used to admit a phase',turnover:'signed entry/exit fractions netted by symbol+timestamp'},baselineParity:{valid:true,detail:parity},phases,eligibleOffsetsMinutes:eligibleOffsets.map(x=>x/60),combined:{preQualified:combinedPre,evaluationSurvivor:combinedEval,paths:combinedPaths},turnoverGainVsBase:combinedPaths.stress.periods.full.turnoverPerDay/Math.max(base.paths.stress.periods.full.turnoverPerDay,1e-12),nextStep:decision==='PHASE_STAGGER_SURVIVOR'?'combine exact phase sleeve with five-regime core and measure true netted turnover/risk; do not scale before that':'do not rescue phase staggering by choosing evaluation winners; move to another independent low-data mechanism'};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+'\n');
console.log('PHASE_STAGGER_JSON='+JSON.stringify({decision,eligibleOffsetsMinutes:report.eligibleOffsetsMinutes,turnoverGainVsBase:report.turnoverGainVsBase,phases:phases.map(x=>({id:x.id,pre:x.preQualified,survivor:x.evaluationSurvivor,stress:x.paths.stress.periods})),combined:report.combined}));
