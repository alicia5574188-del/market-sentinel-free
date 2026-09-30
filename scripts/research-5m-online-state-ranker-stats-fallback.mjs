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
  // Gate 5m candlesticks reject older ranges that 5m contract_stats still serves.
  // Preserve the full 170d causal sample: mark price supplies the price path and
  // aggregate taker size is used only as an activity proxy. No future data is used.
  const rows=await fetchStats(symbol);
  return rows.map(r=>({t:r.time,o:r.mark,h:r.mark,l:r.mark,c:r.mark,v:r.takerLong+r.takerShort}));
}`;
if(!src.includes(oldFn))throw new Error('expected fetchCandles implementation missing; refusing unsafe patch');
src=src.replace(oldFn,newFn);
const runtime='/tmp/research-5m-online-state-ranker-stats-runtime.mjs';
writeFileSync(runtime,src);
if(process.env.PATCH_ONLY==='1')console.log(runtime);
else await import(`${pathToFileURL(runtime).href}?run=${Date.now()}`);
