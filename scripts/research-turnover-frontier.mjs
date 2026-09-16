import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const source=readFileSync('scripts/research-turnover-adaptive-router.mjs','utf8');
const budgets=[0.5,1.0,1.5,2.0,2.5];
const rows=[];

function summarize(walk,key){
  const full=walk.filter(x=>x.test!=='202609').map(x=>x[key]);
  const partial=walk.find(x=>x.test==='202609')?.[key]??null;
  const returns=full.map(x=>x.normalized30Return);
  const turnovers=full.map(x=>x.avgDailyTurnover);
  const entries=full.map(x=>x.avgEntriesPerDay);
  const mean=a=>a.reduce((s,x)=>s+x,0)/Math.max(1,a.length);
  const sorted=[...returns].sort((a,b)=>a-b);
  const median=sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
  return {
    fullMonths:full.length,
    avgMonthlyNet:mean(returns),medianMonthlyNet:median,worstMonthlyNet:Math.min(...returns),bestMonthlyNet:Math.max(...returns),
    positiveMonths:returns.filter(x=>x>0).length,monthsAtLeast5pct:returns.filter(x=>x>=0.05).length,
    avgTwoWayTurnover:mean(turnovers),avgEntriesPerDay:mean(entries),
    avgMaxDD:mean(full.map(x=>x.maxDD)),avgProfitFactor:mean(full.map(x=>x.pf)),avgMeanTradeNet:mean(full.map(x=>x.meanTradeNet)),
    septemberPartial:partial?{normalized30Return:partial.normalized30Return,avgTwoWayTurnover:partial.avgDailyTurnover,avgEntriesPerDay:partial.avgEntriesPerDay,maxDD:partial.maxDD,pf:partial.pf,meanTradeNet:partial.meanTradeNet}:null
  };
}

for(const budget of budgets){
  const tmp=`/tmp/adaptive-frontier-${String(budget).replace('.','_')}.mjs`;
  const patched=source.replace('ENTRY_BUDGET=2.5,MAX_EXPOSURE=1.5',`ENTRY_BUDGET=${budget},MAX_EXPOSURE=1.5`);
  if(patched===source)throw new Error('ENTRY_BUDGET patch failed');
  writeFileSync(tmp,patched);
  execFileSync(process.execPath,['--max-old-space-size=4096',tmp],{cwd:process.cwd(),stdio:['ignore','pipe','inherit'],maxBuffer:64*1024*1024});
  const report=JSON.parse(readFileSync('/tmp/turnover-adaptive-router-report.json','utf8'));
  rows.push({
    oneWayEntryBudget:budget,targetTwoWayTurnover:budget*2,
    static:summarize(report.walkForward,'staticBase'),
    adaptive:summarize(report.walkForward,'adaptiveBase')
  });
}

function verdict(rows,key){
  const anyRobust=rows.some(r=>r[key].positiveMonths>=6&&r[key].monthsAtLeast5pct>=4&&r[key].worstMonthlyNet>-0.05);
  const byTarget=Object.fromEntries(rows.map(r=>[`${r.targetTwoWayTurnover}x`,{avgMonthlyNet:r[key].avgMonthlyNet,medianMonthlyNet:r[key].medianMonthlyNet,worstMonthlyNet:r[key].worstMonthlyNet,positiveMonths:r[key].positiveMonths,monthsAtLeast5pct:r[key].monthsAtLeast5pct,avgMeanTradeNet:r[key].avgMeanTradeNet}]));
  return {anyRobust,byTarget};
}
const staticVerdict=verdict(rows,'static'),adaptiveVerdict=verdict(rows,'adaptive');
const report={
  decision:staticVerdict.anyRobust||adaptiveVerdict.anyRobust?'CURRENT_POOL_HAS_USABLE_TURNOVER_ZONE':'CURRENT_POOL_EDGE_INSUFFICIENT_ACROSS_FRONTIER',
  authority:'RESEARCH_ONLY_NO_DEPLOYMENT',
  question:'At what daily two-way turnover does the current multi-factor opportunity pool lose net edge?',
  interpretation:'Each point re-runs the same causal monthly universes, multi-factor candidate pool, costs and walk-forward logic; only the daily entry budget changes. Static is original structural direction/4h hold. Adaptive is the causal recent-history direction+horizon router already shown unstable.',
  cost:{baseRoundTripEquivalent:0.00165,stressRoundTripEquivalent:0.00270},
  frontier:rows,staticVerdict,adaptiveVerdict
};
writeFileSync('/tmp/turnover-frontier-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
