import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const label=process.env.SCENARIO_LABEL??'scenario';
const baseBp=Number(process.env.BASE_COST_BP??'16.5');
const stressBp=Number(process.env.STRESS_COST_BP??String(baseBp+4));
if(!(baseBp>=0&&stressBp>=baseBp))throw new Error('invalid cost scenario');
const sourcePath='scripts/research-5m-online-state-ranker.mjs';
let src=readFileSync(sourcePath,'utf8');

const oldCost='const BASE_COST=.00165, STRESS_COST=.00270;';
const newCost=`const BASE_COST=${(baseBp/10000).toPrecision(12)}, STRESS_COST=${(stressBp/10000).toPrecision(12)};`;
if(!src.includes(oldCost))throw new Error('cost anchor missing');
src=src.replace(oldCost,newCost);

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
if(!src.includes(oldFn))throw new Error('candle adapter anchor missing');
src=src.replace(oldFn,newFn);

const runtime=`/tmp/research-5m-online-cost-${label}.mjs`;
writeFileSync(runtime,src);
if(process.env.PATCH_ONLY==='1'){
  console.log(runtime);
}else{
  await import(`${pathToFileURL(runtime).href}?run=${Date.now()}`);
  const report='/tmp/5m-online-state-ranker-report.json';
  const target=`/tmp/5m-online-cost-${label}.json`;
  const parsed=JSON.parse(readFileSync(report,'utf8'));
  parsed.costScenario={label,baseBp,stressBp};
  writeFileSync(target,JSON.stringify(parsed,null,2));
  console.log(JSON.stringify({costScenario:parsed.costScenario,decision:parsed.decision,base:{totalReturn:parsed.base.totalReturn,maxDD:parsed.base.maxDD,trades:parsed.base.trades,avgTradesPerDay:parsed.base.avgTradesPerDay,avgDailyTwoWayTurnover:parsed.base.avgDailyTwoWayTurnover,daysAtLeast4_5x:parsed.base.daysAtLeast4_5x,zeroTradeDays:parsed.base.zeroTradeDays,meanTradeNet:parsed.base.meanTradeNet,pf:parsed.base.pf,fullMonths:parsed.base.fullMonths,avgFullMonthReturn:parsed.base.avgFullMonthReturn,monthsAtLeast5pct:parsed.base.monthsAtLeast5pct,positiveFullMonths:parsed.base.positiveFullMonths,monthly:parsed.base.monthly},stress:{totalReturn:parsed.stress.totalReturn,meanTradeNet:parsed.stress.meanTradeNet,pf:parsed.stress.pf,avgFullMonthReturn:parsed.stress.avgFullMonthReturn}},null,2));
}
