import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath='scripts/research-5m-online-state-ranker.mjs';
let src=readFileSync(sourcePath,'utf8');

const oldFn=`async function fetchCandles(symbol){
  const out=[];
  for(let from=FETCH_START;from<END;from+=CHUNK){
    const to=Math.min(END-1,from+CHUNK-1);
    const url=\`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=\${encodeURIComponent(symbol)}&from=\${from}&to=\${to}&interval=5m\`;
    const a=await getJson(url); if(Array.isArray(a))out.push(...a.map(normCandle).filter(Boolean));
  }
  return [...new Map(out.map(r=>[r.t,r])).values()].sort((a,b)=>a.t-b.t);
}`;
const newFn=`async function fetchCandles(symbol){
  const rows=await fetchStats(symbol);
  return rows.map(r=>({t:r.time,o:r.mark,h:r.mark,l:r.mark,c:r.mark,v:r.takerLong+r.takerShort}));
}`;
if(!src.includes(oldFn))throw new Error('expected fetchCandles implementation missing');
src=src.replace(oldFn,newFn);

const histNeedle=`const policyHist=new Map();
const selectedDaily=[];const selectedTrades=[];`;
const histReplacement=`const policyHist=new Map(), policyTrades=new Map();
const selectedDaily=[];const selectedTrades=[];`;
if(!src.includes(histNeedle))throw new Error('policyHist anchor missing');
src=src.replace(histNeedle,histReplacement);

const recNeedle=`const a=policyHist.get(key)??[];a.push(rec);policyHist.set(key,a);`;
const recReplacement=`const a=policyHist.get(key)??[];a.push(rec);policyHist.set(key,a);const pt=policyTrades.get(key)??[];pt.push(...trades.map(t=>({...t,selectionDay:d,selectionKey:key})));policyTrades.set(key,pt);`;
if(!src.includes(recNeedle))throw new Error('policy history record anchor missing');
src=src.replace(recNeedle,recReplacement);

const baseNeedle=`const base=simulatePortfolio(selectedTrades,BASE_COST),stress=simulatePortfolio(selectedTrades,STRESS_COST);`;
if(!src.includes(baseNeedle))throw new Error('frontier injection anchor missing');
const frontierCode=`
function simulateFrontierMonth(candidates,cost,month){
  const arr=candidates.filter(p=>p.selectionDay&&p.selectionDay.slice(0,7)===month).sort((a,b)=>a.entryTime-b.entryTime||Math.abs(b.pred)-Math.abs(a.pred));
  const active=[],busy=new Map(),entryUsed=new Map(),trades=[];let equity=1,peak=1,maxDD=0;
  function release(t){active.sort((a,b)=>a.exitTime-b.exitTime);while(active.length&&active[0].exitTime<=t){const p=active.shift(),net=p.dir*p.gross-cost,pnl=p.entryEq*ENTRY_FRAC*net;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));trades.push({...p,net,pnl});}}
  for(const p of arr){release(p.entryTime);const d=dayKey(p.entryTime),u=entryUsed.get(d)??0;if(u+ENTRY_FRAC>ENTRY_BUDGET+1e-9)continue;if((busy.get(p.symbol)??0)>p.entryTime)continue;if(active.length*ENTRY_FRAC+ENTRY_FRAC>MAX_GROSS+1e-9)continue;active.push({...p,entryEq:equity});busy.set(p.symbol,p.exitTime);entryUsed.set(d,u+ENTRY_FRAC);}
  release(END+2*DAY);
  const days=evalDays.filter(d=>d.slice(0,7)===month).length,g=trades.filter(x=>x.net>0).reduce((s,x)=>s+x.net,0),l=-trades.filter(x=>x.net<=0).reduce((s,x)=>s+x.net,0);
  return {month,days,totalReturn:equity-1,maxDD,trades:trades.length,avgTradesPerDay:trades.length/Math.max(1,days),avgDailyTwoWayTurnover:trades.length*ENTRY_FRAC*2/Math.max(1,days),meanTradeNet:mean(trades.map(x=>x.net)),pf:l?g/l:g?99:0};
}
function summarizeFrontier(candidates,cost,months){
  const monthly=months.map(m=>simulateFrontierMonth(candidates,cost,m)),all=candidates.filter(p=>p.selectionDay&&months.includes(p.selectionDay.slice(0,7))),nets=all.map(p=>(p.pred>=0?1:-1)*p.gross-cost),g=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0);
  return {months,monthly,avgMonthReturn:mean(monthly.map(x=>x.totalReturn)),minMonthReturn:Math.min(...monthly.map(x=>x.totalReturn)),positiveMonths:monthly.filter(x=>x.totalReturn>0).length,monthsAtLeast5pct:monthly.filter(x=>x.totalReturn>=.05).length,avgTradesPerDay:mean(monthly.map(x=>x.avgTradesPerDay)),avgDailyTwoWayTurnover:mean(monthly.map(x=>x.avgDailyTwoWayTurnover)),meanTradeNet:mean(nets),pf:l?g/l:g?99:0,trades:monthly.reduce((s,x)=>s+x.trades,0)};
}
const monthCounts={};for(const d of evalDays){const m=d.slice(0,7);monthCounts[m]=(monthCounts[m]??0)+1;}
const fullMonthKeys=Object.entries(monthCounts).filter(([,n])=>n>=28).map(([m])=>m).sort();
const calibrationMonths=fullMonthKeys.slice(0,2),blindMonths=fullMonthKeys.slice(2,4);
if(calibrationMonths.length<2||blindMonths.length<2)throw new Error('need two calibration and two blind full months');
const frontierRows=[];
for(const [key,trades] of policyTrades){const calibration=summarizeFrontier(trades,BASE_COST,calibrationMonths),calibrationStress=summarizeFrontier(trades,STRESS_COST,calibrationMonths),blind=summarizeFrontier(trades,BASE_COST,blindMonths),blindStress=summarizeFrontier(trades,STRESS_COST,blindMonths);frontierRows.push({key,calibration,calibrationStress,blind,blindStress});}
const feasible=frontierRows.filter(x=>x.calibration.avgMonthReturn>=.05&&x.calibration.minMonthReturn>0&&x.calibrationStress.avgMonthReturn>=0&&x.calibration.avgTradesPerDay>0).sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay||b.calibration.avgMonthReturn-a.calibration.avgMonthReturn);
const bestReturn=[...frontierRows].sort((a,b)=>b.calibration.avgMonthReturn-a.calibration.avgMonthReturn)[0]??null;
const bestPositiveFrequency=[...frontierRows].filter(x=>x.calibration.avgMonthReturn>0).sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay||b.calibration.avgMonthReturn-a.calibration.avgMonthReturn)[0]??null;
const pareto=frontierRows.filter((x,i,a)=>!a.some((y,j)=>j!==i&&y.calibration.avgTradesPerDay>=x.calibration.avgTradesPerDay&&y.calibration.avgMonthReturn>=x.calibration.avgMonthReturn&&(y.calibration.avgTradesPerDay>x.calibration.avgTradesPerDay||y.calibration.avgMonthReturn>x.calibration.avgMonthReturn))).sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay).slice(0,20);
const targetCandidate=feasible[0]??null,diagnosticCandidate=targetCandidate??bestReturn;
const blindMeets=!!targetCandidate&&targetCandidate.blind.avgMonthReturn>=.05&&targetCandidate.blind.minMonthReturn>0&&targetCandidate.blind.monthsAtLeast5pct===blindMonths.length&&targetCandidate.blindStress.avgMonthReturn>-0.02;
const frontierReport={decision:blindMeets?'FREQUENCY_FRONTIER_BLIND_MEETS_5PCT':targetCandidate?'FREQUENCY_FRONTIER_CALIBRATION_ONLY_FAILS_BLIND':'FREQUENCY_FRONTIER_NO_5PCT_POINT_IN_CALIBRATION',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',goal:'maximize daily trade count subject to at least 5% monthly net; no NO_TRADE gate',method:'same causal daily-refit 5m joint-state model and prior-3d thresholds as the online ranker; evaluate every fixed expert/threshold/max-step policy every day; May-June calibration only, then freeze the highest-frequency calibration policy meeting +5% monthly and test untouched July-August',cost:{base:BASE_COST,stress:STRESS_COST},fullMonthKeys,calibrationMonths,blindMonths,policyCount:frontierRows.length,feasibleAt5pctCount:feasible.length,maxTradesAt5pctCalibration:targetCandidate?.calibration.avgTradesPerDay??0,targetCandidate,diagnosticCandidate,bestReturn,bestPositiveFrequency,paretoFrontier:pareto};
writeFileSync('/tmp/5m-online-frequency-frontier-report.json',JSON.stringify(frontierReport,null,2));
console.log('FREQUENCY_FRONTIER_RESULT');
console.log(JSON.stringify(frontierReport,null,2));
`;
src=src.replace(baseNeedle,frontierCode+'\n'+baseNeedle);

const runtime='/tmp/research-5m-online-frequency-frontier-runtime.mjs';
writeFileSync(runtime,src);
if(process.env.PATCH_ONLY==='1')console.log(runtime);
else await import(pathToFileURL(runtime).href+'?run='+Date.now());