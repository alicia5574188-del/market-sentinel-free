import { readFileSync, writeFileSync } from 'node:fs';

const baseSource=readFileSync(new URL('./research-specialness-core-overlay.mjs',import.meta.url),'utf8')
  .replace("import { readFileSync, writeFileSync } from 'node:fs';\n",'')
  .split('const base=analyze()')[0];

const extension=String.raw`
// Build the frozen PRICE1 selector at every completed 5m bar. A selector state stamped at t
// becomes tradable only at the next 5m open t+300, preserving causality.
function gap5(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+300));return p;}
const five=executionRaw.datasets.map(d=>({symbol:d.symbol,rows:d.rows,pointer:0,gaps:gap5(d.rows)}));
const specialByTime=new Map();
const master5=five.find(d=>d.symbol==='BTC_USDT')??five[0];
for(let mi=12;mi<master5.rows.length-2;mi++){
  const time=master5.rows[mi].time,ctx=[];
  for(const d of five){while(d.pointer<d.rows.length&&d.rows[d.pointer].time<time)d.pointer++;const i=d.pointer;if(i>=d.rows.length||d.rows[i].time!==time||i<12||d.gaps[i]!==d.gaps[i-12])continue;ctx.push({symbol:d.symbol,r1:d.rows[i].close/d.rows[i-12].close-1});}
  if(ctx.length<9)continue;const m=median(ctx.map(x=>x.r1)),es=ctx.map(x=>({...x,rel1:x.r1-m})),scale=Math.max(.001,median(es.map(x=>Math.abs(x.rel1)))),top=[...es].sort((a,b)=>Math.abs(b.rel1)-Math.abs(a.rel1))[0],score=Math.abs(top.rel1)/scale;
  if(Math.abs(top.rel1)>=.006&&score>=1.8)specialByTime.set(time,{symbol:top.symbol,direction:sign(top.rel1),score});
}
function confirmation(f,direction,waitBars){
  const originalEntry=f.rows[f.index+1].time;
  for(let step=0;step<waitBars;step++){
    const completedBarTime=originalEntry-300+step*300,s=specialByTime.get(completedBarTime);
    if(s&&s.symbol===f.symbol&&s.direction===direction)return{specialTime:completedBarTime,entryTime:completedBarTime+300,score:s.score,delayBars:step};
  }
  return null;
}
function delayedResolve(c,f,s,confirm,friction=FRICTION,slippage=SLIPPAGE){
  const rows=executionBySymbol.get(f.symbol),idx=lowerBound(rows,confirm.entryTime);if(rows[idx]?.time!==confirm.entryTime)return null;
  const d=s.direction,entry=rows[idx].open*(1+d*slippage),stopRate=Math.min(c.stopCap,Math.max(c.stopFloor,c.stopAtr*f.atr6)),trail=c.exitModel==='TRAIL',targetRate=trail?null:Math.max(stopRate*c.rewardRisk,friction*2.2),origStop=entry*(1-d*stopRate),target=trail?null:entry*(1+d*targetRate);
  let activeStop=origStop,extreme=entry,exit=entry,closedAt=rows[idx].time*1000,outcome='DATA_GAP';
  for(let o=0;o<c.maxHoldHours*12&&idx+o<rows.length;o++){
    const bar=rows[idx+o];if(o&&bar.time!==rows[idx+o-1].time+300){exit=rows[idx+o-1].close;closedAt=rows[idx+o-1].time*1000;break;}
    const stopped=d>0?bar.low<=activeStop:bar.high>=activeStop,targeted=!trail&&(d>0?bar.high>=target:bar.low<=target);
    if(stopped||targeted){exit=stopped?activeStop:target;closedAt=bar.time*1000;outcome=stopped?(activeStop===origStop?'STOP':'TRAIL'):'TARGET';break;}
    if(trail){extreme=d>0?Math.max(extreme,bar.high):Math.min(extreme,bar.low);const cand=extreme*(1-d*stopRate*c.trailScale);activeStop=d>0?Math.max(activeStop,cand):Math.min(activeStop,cand);}
    exit=bar.close;closedAt=bar.time*1000;outcome=o===c.maxHoldHours*12-1?'TIMEOUT':outcome;
  }
  const gross=d*(exit-entry)/entry;
  return{strategyId:c.id,system:c.system,kind:c.kind,symbol:f.symbol,side:d>0?'LONG':'SHORT',direction:d,openedAt:rows[idx].time*1000,closedAt,stopRate,strength:s.strength+confirm.score*.01,friction,netReturnRate:gross-friction,specialTop1:true,specialAligned:true,specialCounter:false,delayBars:confirm.delayBars,confirmScore:confirm.score};
}
const delayedCache=new Map();
function delayedTrades(c,waitBars,friction=FRICTION,slippage=SLIPPAGE){const key=c.id+':'+waitBars+':'+friction+':'+slippage;if(delayedCache.has(key))return delayedCache.get(key);const out=[];for(const f of observations){const s=signal(c,f);if(!s)continue;const cf=confirmation(f,s.direction,waitBars);if(!cf)continue;const t=delayedResolve(c,f,s,cf,friction,slippage);if(t)out.push(t);}out.sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength);delayedCache.set(key,out);return out;}
function runVariant(waitBars,friction=FRICTION,slippage=SLIPPAGE,delayed=true){
  const accounts={},combined=[];
  for(const sys of SYSTEMS){const ts=C.filter(c=>c.system===sys).flatMap(c=>delayed?delayedTrades(c,waitBars,friction,slippage):rawTrades(c,friction,slippage)).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength),acc=portfolio(ts,'ALL');accounts[sys]={full:{trades:acc.trades.length,endEquity:acc.endEquity,maxDrawdown:acc.maxDrawdown},periods:Object.fromEntries(Object.entries(SPLITS).map(([k,[s,e]])=>[k,metrics(acc.trades,s,e,'netPnl')]))};combined.push(...acc.trades);}
  return{accounts,combined:Object.fromEntries(Object.entries(SPLITS).map(([k,[s,e]])=>[k,metrics(combined,s,e,'netPnl')]))};
}
const baseline=runVariant(0,FRICTION,SLIPPAGE,false);
const expected={discovery:{trades:1311,sum:1559.562},validation:{trades:355,sum:1019.751},evaluation:{trades:155,sum:283.585}};
const parity=Object.fromEntries(Object.entries(expected).map(([k,x])=>[k,{trades:baseline.combined[k].trades,netPnl:baseline.combined[k].sum,pass:baseline.combined[k].trades===x.trades&&Math.abs(baseline.combined[k].sum-x.sum)<.25}]));
if(!Object.values(parity).every(x=>x.pass))throw new Error('Frozen core parity failed: '+JSON.stringify(parity));
const waits=[6,12,24],audits=waits.map(waitBars=>({waitBars,minutes:waitBars*5,base:runVariant(waitBars),stress:runVariant(waitBars,STRESS_FRICTION,SLIPPAGE),adverse:runVariant(waitBars,FRICTION,SLIPPAGE*2)}));
const discoveryQualified=audits.filter(a=>{const d=a.base.combined.discovery,ds=a.stress.combined.discovery,da=a.adverse.combined.discovery;return d.trades>=120&&d.sum>0&&d.profitFactor>=1.05&&ds.sum>0&&ds.profitFactor>=1&&da.sum>0&&da.profitFactor>=1;});
discoveryQualified.sort((a,b)=>(b.base.combined.discovery.profitFactor*Math.sqrt(b.base.combined.discovery.trades))-(a.base.combined.discovery.profitFactor*Math.sqrt(a.base.combined.discovery.trades)));
const selected=discoveryQualified[0]??null;
let heldOut=null,decision='NO_DISCOVERY_CONFIRMATION';
if(selected){const pass=(v,min)=>v.base.combined[v.split].trades>=min&&v.base.combined[v.split].sum>0&&v.base.combined[v.split].profitFactor>=1.03&&v.stress.combined[v.split].sum>0&&v.stress.combined[v.split].profitFactor>=1&&v.adverse.combined[v.split].sum>0&&v.adverse.combined[v.split].profitFactor>=1;const validation={base:selected.base,stress:selected.stress,adverse:selected.adverse,split:'validation'},evaluation={base:selected.base,stress:selected.stress,adverse:selected.adverse,split:'evaluation'},validationPass=pass(validation,30),evaluationPass=pass(evaluation,20);heldOut={waitMinutes:selected.minutes,validationPass,evaluationPass,validation:{base:selected.base.combined.validation,stress:selected.stress.combined.validation,adverse:selected.adverse.combined.validation},evaluation:{base:selected.base.combined.evaluation,stress:selected.stress.combined.evaluation,adverse:selected.adverse.combined.evaluation}};decision=validationPass&&evaluationPass?'TIMING_CONFIRMATION_FOUND':'NO_RELEASE';}
const timingResult={research:'specialness-timing-confirmation',premise:'the frozen five-regime core chooses direction first; entry is delayed until the same coin becomes the causal 5m PRICE1 top special in that same direction within 30/60/120 minutes',canonical:{signalSha256:signalRaw.sha256,executionSha256:executionRaw.sha256},selector:{minAbsRelative1h:.006,minRobustScore:1.8},baselineParity:parity,audits:audits.map(a=>({minutes:a.minutes,base:a.base.combined,stress:a.stress.combined,adverse:a.adverse.combined,accounts:a.base.accounts})),selectedWaitMinutes:selected?.minutes??null,heldOut,decision,protocolNote:'Wait window is selected on discovery only. Direction and lifecycle remain frozen. No production/PAPER/LIVE mutation.'};
writeFileSync(process.env.RESEARCH_TIMING_OUTPUT??'/tmp/specialness-timing-confirmation-44m.json',JSON.stringify(timingResult,null,2));
console.log(JSON.stringify({decision,baselineParity:parity,selectedWaitMinutes:timingResult.selectedWaitMinutes,heldOut,audits:timingResult.audits.map(a=>({minutes:a.minutes,base:a.base,stress:a.stress,adverse:a.adverse}))},null,2));
`;

// Direct eval keeps the copied core definitions and the extension in the same lexical scope.
eval(baseSource+'\n'+extension);
