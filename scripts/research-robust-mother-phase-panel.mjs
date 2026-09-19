import { readFileSync, writeFileSync } from 'node:fs';

const EXEC_PATH = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-44m-5m.json';
const SIGNAL_1H_PATH = process.env.RESEARCH_SIGNAL_1H_DATASET ?? '/tmp/gate-history-44m-from5m-1h.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/robust-mother-phase-panel.json';
const BASE_FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const ENTRY_SLIPPAGE = 0.00025;
const INITIAL_EQUITY = 1000;
const HOUR = 3600;
const DAY_MS = 86_400_000;
const EXPECTED_EXEC_SHA = '9e5fd7d06eeee420d60318bee72de3b16e7e877247102a2b505453ab0b8a4522';
const EXPECTED_SIGNAL_SHA = '185bd97b968f96373bef6a174c8258d8ad5606a0d1ed824eaa2cc1ace1efa053';

const execRaw = JSON.parse(readFileSync(EXEC_PATH, 'utf8'));
const signal1hRaw = JSON.parse(readFileSync(SIGNAL_1H_PATH, 'utf8'));
if (execRaw.interval !== '5m' || signal1hRaw.interval !== '1h') throw new Error('expected exact Gate 5m + 1h data');
if (execRaw.sha256 !== EXPECTED_EXEC_SHA || signal1hRaw.sha256 !== EXPECTED_SIGNAL_SHA) throw new Error('dataset hash mismatch');
if (execRaw.months.length !== 44 || execRaw.months.join() !== signal1hRaw.months.join()) throw new Error('month mismatch');
if (execRaw.symbols.join() !== signal1hRaw.symbols.join()) throw new Error('symbol mismatch');

const sum = (xs) => xs.reduce((a,b)=>a+b,0);
const sign = (x) => x>0?1:x<0?-1:0;
const median = (xs) => { if(!xs.length)return 0; const a=[...xs].sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; };
const monthStart=(m)=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=execRaw.from*1000;
const discoveryEnd=monthStart(execRaw.months[30]);
const validationEnd=monthStart(execRaw.months[38]);
const toMs=execRaw.now*1000;
const executionBySymbol=new Map(execRaw.datasets.map((d)=>[d.symbol,d.rows]));

const MOTHERS=[
  {id:'DR5', sourceId:'directional_trend-defensive_relative-5', system:'DIRECTIONAL_TREND', tactic:'DEFENSIVE_RELATIVE', stopFloor:.03, stopAtr:5, rewardRisk:2.2, maxHoldHours:72,
    expected:{discovery:{trades:405,netPnl:51.32916758231005,profitFactor:1.0272665070296876},validation:{trades:110,netPnl:63.98045967877867,profitFactor:1.0966418747416167},evaluation:{trades:45,netPnl:238.7399157602952,profitFactor:2.771265720593711}}},
  {id:'SHR8', sourceId:'balanced_rotation-short_horizon_reversal-8', system:'BALANCED_ROTATION', tactic:'SHORT_HORIZON_REVERSAL', stopFloor:.03, stopAtr:5, rewardRisk:1.5, maxHoldHours:72,
    expected:{discovery:{trades:96,netPnl:125.44030079278497,profitFactor:1.3454375715596738},validation:{trades:18,netPnl:244.31456841766166,profitFactor:6.329673368372372},evaluation:{trades:10,netPnl:50.52467135712024,profitFactor:2.290954555578011}}},
  {id:'FR3', sourceId:'compression-false_release-3', system:'COMPRESSION', tactic:'FALSE_RELEASE', stopFloor:.05, stopAtr:5, rewardRisk:2.2, maxHoldHours:48,
    expected:{discovery:{trades:75,netPnl:61.067537132469575,profitFactor:1.219757302847089},validation:{trades:14,netPnl:55.459290005916216,profitFactor:1.9728781492528091},evaluation:{trades:14,netPnl:27.486938299285917,profitFactor:1.999317007803039}}},
  {id:'BC9', sourceId:'non_trend_expansion-breadth_continuation-9', system:'NON_TREND_EXPANSION', tactic:'BREADTH_CONTINUATION', stopFloor:.03, stopAtr:5, rewardRisk:2.2, maxHoldHours:72,
    expected:{discovery:{trades:138,netPnl:35.61338735734694,profitFactor:1.0568203060982349},validation:{trades:26,netPnl:108.52652817247035,profitFactor:1.9139448408022188},evaluation:{trades:22,netPnl:6.676826240381935,profitFactor:1.0515842071751142}}},
];
const PHASES=[0,15,30,45].map((minutes)=>({minutes,offsetSeconds:minutes*60,id:`P${String(minutes).padStart(2,'0')}`}));

function aggregateOffset(rows,offsetSeconds){
  const complete=[]; let bucket=null;
  for(const row of rows){
    const time=Math.floor((Number(row.time)-offsetSeconds)/HOUR)*HOUR+offsetSeconds;
    if(!bucket||bucket.time!==time){
      if(bucket?.samples>=10)complete.push(bucket);
      bucket={time,open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume),samples:1};
    }else{
      bucket.high=Math.max(bucket.high,Number(row.high)); bucket.low=Math.min(bucket.low,Number(row.low)); bucket.close=Number(row.close); bucket.volume+=Number(row.volume); bucket.samples+=1;
    }
  }
  if(bucket?.samples>=10)complete.push(bucket);
  const filled=[];
  for(const row of complete){
    const prev=filled.at(-1); const missing=prev?(row.time-prev.time)/HOUR-1:0;
    if(prev&&missing>0&&missing<=3)for(let k=1;k<=missing;k+=1)filled.push({time:prev.time+k*HOUR,open:prev.close,high:prev.close,low:prev.close,close:prev.close,volume:0,samples:0,synthetic:true});
    filled.push(row);
  }
  return filled;
}

const signalByPhase=new Map();
signalByPhase.set(0,signal1hRaw.datasets.map((d)=>({symbol:d.symbol,rows:d.rows})));
for(const phase of PHASES.filter((p)=>p.minutes))signalByPhase.set(phase.minutes,execRaw.datasets.map((d)=>({symbol:d.symbol,rows:aggregateOffset(d.rows,phase.offsetSeconds)})));

function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i+=1)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+HOUR));return p;}
const ret=(rows,i,bars)=>rows[i].close/rows[i-bars].close-1;
const rangeRate=(row)=>(row.high-row.low)/Math.max(row.close,1e-12);
function classify(c){
  const aligned24=Math.max(c.breadth24,1-c.breadth24);
  if(Math.abs(c.median24)>=.04||(Math.abs(c.median24)>=.02&&aligned24>=.82))return 'SHOCK_TRANSITION';
  if(c.compression<=.68&&Math.abs(c.median24)<.025)return 'COMPRESSION';
  if((c.median30>=.08&&c.median7>=.015&&c.breadth30>=.60)||(c.median30<=-.08&&c.median7<=-.015&&c.breadth30<=.40))return 'DIRECTIONAL_TREND';
  if(Math.abs(c.median24)>=.018||aligned24>=.75)return 'NON_TREND_EXPANSION';
  return 'BALANCED_ROTATION';
}
const obsCache=new Map();
function observations(phaseMinutes){
  if(obsCache.has(phaseMinutes))return obsCache.get(phaseMinutes);
  const byTime=new Map();
  for(const {symbol,rows} of signalByPhase.get(phaseMinutes)){
    const gaps=gapPrefix(rows);
    for(let index=720;index<rows.length-1;index+=1){
      const current=rows[index];
      if(gaps[index]!==gaps[index-720]||rows[index+1].time!==current.time+HOUR)continue;
      const previous24=rows.slice(index-24,index), currentRanges=rows.slice(index-5,index+1).map(rangeRate), baselineRanges=rows.slice(index-168,index-6).map(rangeRate);
      const recentVolume=sum(rows.slice(index-5,index+1).map((r)=>r.volume))/6;
      const baselineVolume=sum(rows.slice(index-48,index-6).map((r)=>r.volume))/42;
      const f={symbol,rows,index,current,r1:ret(rows,index,1),r6:ret(rows,index,6),r24:ret(rows,index,24),r7d:ret(rows,index,168),r30d:ret(rows,index,720),
        atr6:median(currentRanges),compression:median(currentRanges)/Math.max(median(baselineRanges),1e-9),volumeBurst:recentVolume/Math.max(baselineVolume,1e-9),
        high24:Math.max(...previous24.map((r)=>r.high)),low24:Math.min(...previous24.map((r)=>r.low))};
      const a=byTime.get(current.time)??[];a.push(f);byTime.set(current.time,a);
    }
  }
  const out=[];
  for(const [time,rows] of byTime){
    if(rows.length<Math.max(8,execRaw.symbols.length-2))continue;
    const vals=(k)=>rows.map((r)=>r[k]);
    const context={median24:median(vals('r24')),median7:median(vals('r7d')),median30:median(vals('r30d')),
      breadth24:rows.filter((r)=>r.r24>0).length/rows.length,breadth7:rows.filter((r)=>r.r7d>0).length/rows.length,breadth30:rows.filter((r)=>r.r30d>0).length/rows.length,
      compression:median(vals('compression')),markets:rows.length};
    const system=classify(context);
    for(const f of rows)out.push({...f,time,context,system,relative7:f.r7d-context.median7,relative24:f.r24-context.median24});
  }
  obsCache.set(phaseMinutes,out);return out;
}

function motherSignal(m,f){
  if(f.system!==m.system)return null;
  if(m.id==='DR5'){
    const direction=-sign(f.context.median30);
    if(!direction||direction*f.relative7<.03||direction*f.r6<.004)return null;
    return {direction,strength:direction*f.relative7+direction*f.r6};
  }
  if(m.id==='SHR8'){
    const original=sign(f.relative24),direction=-original;
    if(!original||Math.abs(f.relative24)<.05||direction*f.r6<.003)return null;
    return {direction,strength:Math.abs(f.relative24)+direction*f.r6};
  }
  if(m.id==='FR3'){
    if(f.volumeBurst<1.1)return null;
    const highFail=f.current.high>f.high24&&f.current.close<f.high24*(1-.002);
    const lowFail=f.current.low<f.low24&&f.current.close>f.low24*(1+.002);
    if(highFail===lowFail)return null;
    return {direction:highFail?-1:1,strength:f.volumeBurst+Math.abs(f.r1)};
  }
  if(m.id==='BC9'){
    const direction=sign(f.context.median24); const boundary=direction>0?f.high24:f.low24;
    if(!direction||sign(f.r24)!==direction||Math.abs(f.r24)<.05||direction*f.r6<.005||direction*(f.current.close/boundary-1)<0)return null;
    return {direction,strength:Math.abs(f.r24)+direction*f.r6};
  }
  return null;
}
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}
const rawCache=new Map();
function rawTrades(m,phase,friction,slippage){
  const strategyId=`${m.id}_${phase.id}`; const key=`${strategyId}|${friction}|${slippage}`; if(rawCache.has(key))return rawCache.get(key);
  const trades=[];
  for(const f of observations(phase.minutes)){
    if(f.time*1000>=toMs)continue; const found=motherSignal(m,f); if(!found)continue;
    const rows=executionBySymbol.get(f.symbol),entryTime=f.rows[f.index+1].time,index=lowerBound(rows,entryTime); if(rows[index]?.time!==entryTime)continue;
    const direction=found.direction,entry=rows[index].open*(1+direction*slippage),stopRate=Math.min(.20,Math.max(m.stopFloor,m.stopAtr*f.atr6));
    const targetRate=Math.max(stopRate*m.rewardRisk,friction*2.2),stop=entry*(1-direction*stopRate),target=entry*(1+direction*targetRate),maxBars=m.maxHoldHours*12;
    let exit=entry,closedAt=rows[index].time*1000,outcome='DATA_GAP';
    for(let offset=0;offset<maxBars&&index+offset<rows.length;offset+=1){
      const candle=rows[index+offset];
      if(offset&&candle.time!==rows[index+offset-1].time+300){exit=rows[index+offset-1].close;closedAt=rows[index+offset-1].time*1000;break;}
      const stopped=direction>0?candle.low<=stop:candle.high>=stop,targeted=direction>0?candle.high>=target:candle.low<=target;
      if(stopped||targeted){exit=stopped?stop:target;closedAt=candle.time*1000;outcome=stopped?'STOP':'TARGET';break;}
      exit=candle.close;closedAt=candle.time*1000;outcome=offset===maxBars-1?'TIMEOUT':outcome;
    }
    const grossReturnRate=direction*(exit-entry)/entry;
    trades.push({strategyId,motherId:m.id,phase:phase.minutes,symbol:f.symbol,side:direction>0?'LONG':'SHORT',openedAt:rows[index].time*1000,closedAt,stopRate,friction,strength:found.strength,outcome,grossReturnRate,netReturnRate:grossReturnRate-friction});
  }
  trades.sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength||a.strategyId.localeCompare(b.strategyId));rawCache.set(key,trades);return trades;
}
function portfolio(trades){
  let equity=INITIAL_EQUITY,peak=equity,maxDrawdown=0;const open=[],accepted=[],cooldown=new Map();
  const settle=(time)=>{for(const t of open.filter((x)=>x.closedAt<=time).sort((a,b)=>a.closedAt-b.closedAt)){equity+=t.netPnl;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/Math.max(peak,1e-12));open.splice(open.indexOf(t),1);cooldown.set(`${t.strategyId}|${t.symbol}`,t.closedAt+24*HOUR*1000);}};
  for(let i=0;i<trades.length;){const openedAt=trades[i].openedAt;settle(openedAt);const simultaneous=[];while(i<trades.length&&trades[i].openedAt===openedAt)simultaneous.push(trades[i++]);
    for(const t of simultaneous.sort((a,b)=>b.strength-a.strength||a.symbol.localeCompare(b.symbol))){
      if(equity<=100||open.some((x)=>x.symbol===t.symbol)||(cooldown.get(`${t.strategyId}|${t.symbol}`)??0)>t.openedAt)continue;
      const sameSide=open.filter((x)=>x.side===t.side),multiple=Math.min(.5,.015/Math.max(t.stopRate+t.friction,1e-9));if(multiple<.05)continue;
      const notional=equity*multiple,plannedRisk=notional*(t.stopRate+t.friction);
      if(sum(open.map((x)=>x.plannedRisk))+plannedRisk>equity*.10||sum(sameSide.map((x)=>x.plannedRisk))+plannedRisk>equity*.065)continue;
      const acceptedTrade={...t,equityAtOpen:equity,notional,plannedRisk,netPnl:notional*t.netReturnRate};open.push(acceptedTrade);accepted.push(acceptedTrade);
    }}
  settle(Infinity);return {trades:accepted,endEquity:equity,maxDrawdown};
}
function metrics(account,start,end){
  const rows=account.trades.filter((t)=>t.openedAt>=start&&t.openedAt<end),gains=rows.filter((t)=>t.netPnl>0),losses=rows.filter((t)=>t.netPnl<=0);
  let equity=INITIAL_EQUITY,peak=equity,dd=0;for(const t of [...rows].sort((a,b)=>a.closedAt-b.closedAt)){equity+=t.netPnl;peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/Math.max(peak,1e-12));}
  return {trades:rows.length,netPnl:sum(rows.map((t)=>t.netPnl)),profitFactor:losses.length?sum(gains.map((t)=>t.netPnl))/Math.abs(sum(losses.map((t)=>t.netPnl))):gains.length?99:0,maxDrawdown:dd};
}
function exposure(account,start,end){
  const changes=[];for(const t of account.trades){const f=t.notional/Math.max(t.equityAtOpen,1e-12),d=t.side==='LONG'?1:-1;if(t.openedAt>=start&&t.openedAt<end)changes.push({time:t.openedAt,symbol:t.symbol,delta:d*f});if(t.closedAt>=start&&t.closedAt<end)changes.push({time:t.closedAt,symbol:t.symbol,delta:-d*f});}
  const grouped=new Map();for(const x of changes){const k=`${x.time}|${x.symbol}`;grouped.set(k,(grouped.get(k)??0)+x.delta);}const days=(end-start)/DAY_MS;
  return {turnoverPerDay:sum([...grouped.values()].map(Math.abs))/days,entriesPerDay:account.trades.filter((t)=>t.openedAt>=start&&t.openedAt<end).length/days};
}
const periods={discovery:[fromMs,discoveryEnd],validation:[discoveryEnd,validationEnd],evaluation:[validationEnd,toMs],full:[fromMs,toMs]};
function summarize(account){return {endEquity:account.endEquity,maxDrawdown:account.maxDrawdown,periods:Object.fromEntries(Object.entries(periods).map(([k,[a,b]])=>[k,{...metrics(account,a,b),...exposure(account,a,b)}]))};}
function evaluate(m,phase){
  const paths={};for(const [name,friction,slippage] of [['base',BASE_FRICTION,ENTRY_SLIPPAGE],['stress',STRESS_FRICTION,ENTRY_SLIPPAGE],['adverse',BASE_FRICTION,ENTRY_SLIPPAGE*2]])paths[name]=summarize(portfolio(rawTrades(m,phase,friction,slippage)));
  const s=paths.stress.periods,a=paths.adverse.periods;
  const trainQualified=s.discovery.trades>=30&&s.validation.trades>=8&&s.discovery.netPnl>0&&s.validation.netPnl>0&&s.discovery.profitFactor>=1&&s.validation.profitFactor>=1&&a.discovery.netPnl>0&&a.validation.netPnl>0;
  const evaluationSurvivor=trainQualified&&s.evaluation.netPnl>0&&s.evaluation.profitFactor>=1&&a.evaluation.netPnl>0;
  return {motherId:m.id,sourceId:m.sourceId,phaseMinutes:phase.minutes,strategyId:`${m.id}_${phase.id}`,trainQualified,evaluationSurvivor,paths};
}
const evaluated=MOTHERS.flatMap((m)=>PHASES.map((p)=>evaluate(m,p)));
const close=(a,b,t=1e-6)=>Math.abs(a-b)<=t;
const parity={};
for(const m of MOTHERS){const base=evaluated.find((x)=>x.motherId===m.id&&x.phaseMinutes===0);parity[m.id]=Object.fromEntries(Object.entries(m.expected).map(([p,e])=>[p,{trades:base.paths.stress.periods[p].trades===e.trades,netPnl:close(base.paths.stress.periods[p].netPnl,e.netPnl,1e-5),profitFactor:close(base.paths.stress.periods[p].profitFactor,e.profitFactor,1e-8),actual:base.paths.stress.periods[p],expected:e}]));}
const parityValid=Object.values(parity).every((m)=>Object.values(m).every((x)=>x.trades&&x.netPnl&&x.profitFactor));if(!parityValid)throw new Error(`baseline parity failed ${JSON.stringify(parity)}`);
const selectedAddons=evaluated.filter((x)=>x.phaseMinutes!==0&&x.trainQualified);
const survivors=selectedAddons.filter((x)=>x.evaluationSurvivor);
function canonicalExposure(rows,pathName,start,end){
  const changes=[];let logical=0;
  for(const row of rows){const account=row.paths[pathName]._account; if(!account)continue; for(const t of account.trades){const f=t.notional/Math.max(t.equityAtOpen,1e-12),d=t.side==='LONG'?1:-1;
      if(t.openedAt>=start&&t.openedAt<end){changes.push({time:t.openedAt,symbol:t.symbol,delta:d*f});logical+=Math.abs(f);}if(t.closedAt>=start&&t.closedAt<end){changes.push({time:t.closedAt,symbol:t.symbol,delta:-d*f});logical+=Math.abs(f);}}}
  const grouped=new Map();for(const x of changes){const k=`${x.time}|${x.symbol}`;grouped.set(k,(grouped.get(k)??0)+x.delta);}const parsed=[...grouped.entries()].map(([k,delta])=>{const i=k.indexOf('|');return {time:Number(k.slice(0,i)),symbol:k.slice(i+1),delta};}).sort((a,b)=>a.time-b.time||a.symbol.localeCompare(b.symbol));
  const positions=new Map();let peakGross=0,i=0;while(i<parsed.length){const time=parsed[i].time;while(i<parsed.length&&parsed[i].time===time){const x=parsed[i++];positions.set(x.symbol,(positions.get(x.symbol)??0)+x.delta);}peakGross=Math.max(peakGross,sum([...positions.values()].map(Math.abs)));}
  const actual=sum(parsed.map((x)=>Math.abs(x.delta))),days=(end-start)/DAY_MS;return {turnoverPerDay:actual/days,logicalTurnoverPerDay:logical/days,nettingRetention:logical?actual/logical:1,peakNettedGross:peakGross,impliedMinLeverageAt70pctMargin:peakGross/.70};
}
for(const row of evaluated){const m=MOTHERS.find((x)=>x.id===row.motherId),p=PHASES.find((x)=>x.minutes===row.phaseMinutes);for(const [name,friction,slippage] of [['base',BASE_FRICTION,ENTRY_SLIPPAGE],['stress',STRESS_FRICTION,ENTRY_SLIPPAGE],['adverse',BASE_FRICTION,ENTRY_SLIPPAGE*2]])row.paths[name]._account=portfolio(rawTrades(m,p,friction,slippage));}
const addOnExposure=Object.fromEntries(Object.entries(periods).map(([k,[a,b]])=>[k,canonicalExposure(selectedAddons,'stress',a,b)]));
const systemRisk={selected:selectedAddons.length,evaluationSurvivors:survivors.length,worstFullStressDd:Math.max(0,...selectedAddons.map((x)=>x.paths.stress.maxDrawdown)),
  evalStressNetU:sum(selectedAddons.map((x)=>x.paths.stress.periods.evaluation.netPnl)),evalAdverseNetU:sum(selectedAddons.map((x)=>x.paths.adverse.periods.evaluation.netPnl)),
  evalStressPositiveSystems:selectedAddons.filter((x)=>x.paths.stress.periods.evaluation.netPnl>0).length,evalAdversePositiveSystems:selectedAddons.filter((x)=>x.paths.adverse.periods.evaluation.netPnl>0).length};
for(const row of evaluated)for(const path of Object.values(row.paths))delete path._account;
const decision=selectedAddons.length>=2&&systemRisk.evalStressNetU>0&&systemRisk.evalAdverseNetU>0&&survivors.length>=Math.ceil(selectedAddons.length*.6)?'PHASE_PANEL_PORTABLE_ADDONS':'PHASE_PANEL_NO_PORTABLE_SET';
const report={research:'robust-mother-hourly-phase-panel-v1',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',decision,
  hypothesis:'test whether staggered true-1h observation phases generalize across structurally different 44m-robust mother mechanisms, with each surviving phase treated as an independent system sleeve rather than sharing a global same-symbol lock',
  data:{months:execRaw.months,symbols:execRaw.symbols,executionSha256:execRaw.sha256,signal1hSha256:signal1hRaw.sha256},
  split:{discovery:execRaw.months.slice(0,30),validation:execRaw.months.slice(30,38),evaluation:execRaw.months.slice(38),note:'historical gated evaluation, not project-wide pristine blind OOS'},
  protocol:{mothers:MOTHERS.map(({id,sourceId,system,tactic})=>({id,sourceId,system,tactic})),phasesMinutes:PHASES.map((p)=>p.minutes),
    selection:'each nonzero mother-phase sleeve is selected independently using discovery+validation stress and doubled-entry-adverse results only; evaluation never selects a sleeve',
    architecture:'selected phase sleeves remain independent 1000U trajectories, matching multi-system architecture; no cross-system same-symbol blocking',
    costs:{baseRoundTrip:BASE_FRICTION,stressRoundTrip:STRESS_FRICTION,adverseEntryExtra:ENTRY_SLIPPAGE},
    turnover:'for canonical copy capacity, each independent trade is normalized by its own equity-at-open, then signed changes are netted by symbol+timestamp before absolute turnover is counted'},
  baselineParity:{valid:parityValid,detail:parity},evaluated,selectedAddons:selectedAddons.map((x)=>x.strategyId),evaluationSurvivors:survivors.map((x)=>x.strategyId),addOnExposure,systemRisk,
  nextStep:decision==='PHASE_PANEL_PORTABLE_ADDONS'?'inject only the training-selected phase add-ons into the exact frozen five-regime core trade path and measure total canonical turnover, peak gross, per-system DD and evaluation economics without using evaluation to alter membership':'do not tune offsets; seek a different independent opportunity mechanism'};
writeFileSync(OUTPUT,`${JSON.stringify(report,null,2)}\n`);
console.log(`ROBUST_PHASE_PANEL=${JSON.stringify({decision,parityValid,selectedAddons:report.selectedAddons,evaluationSurvivors:report.evaluationSurvivors,addOnExposure,systemRisk,
  standalone:evaluated.map((x)=>({strategyId:x.strategyId,trainQualified:x.trainQualified,evaluationSurvivor:x.evaluationSurvivor,stress:x.paths.stress.periods,adverse:x.paths.adverse.periods}))})}`);
