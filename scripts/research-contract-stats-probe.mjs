import { writeFileSync } from 'node:fs';

const OUT=process.env.RESEARCH_OUTPUT??'/tmp/contract-stats-probe.json';
const symbols=(process.env.RESEARCH_SYMBOLS??'BTC_USDT,ETH_USDT,SOL_USDT,ADA_USDT,LINK_USDT,AAVE_USDT').split(',').filter(Boolean);
const starts=['2024-09-01','2025-03-01','2025-09-01','2026-03-01'].map(s=>({label:s,ts:Math.floor(Date.parse(`${s}T00:00:00Z`)/1000)}));
const intervals=['1h','8h'];
const base='https://api.gateio.ws/api/v4/futures/usdt/contract_stats';
async function getJson(url){for(let n=0;n<5;n++){const r=await fetch(url,{headers:{Accept:'application/json'}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await new Promise(res=>setTimeout(res,750*(n+1)));continue;}throw new Error(`${r.status} ${await r.text()}`);}throw new Error(`failed ${url}`);}
const rows=[];
for(const symbol of symbols)for(const interval of intervals)for(const start of starts){const url=`${base}?contract=${encodeURIComponent(symbol)}&from=${start.ts}&interval=${interval}&limit=1000`;let data,err=null;try{data=await getJson(url);}catch(e){err=String(e?.message??e);data=[];}const x=Array.isArray(data)?data:[];rows.push({symbol,interval,start:start.label,count:x.length,first:x[0]?.time??null,last:x.at(-1)?.time??null,firstIso:x[0]?.time?new Date(Number(x[0].time)*1000).toISOString():null,lastIso:x.at(-1)?.time?new Date(Number(x.at(-1).time)*1000).toISOString():null,fields:x[0]?Object.keys(x[0]).sort():[],sample:x[0]??null,error:err});}
const report={queriedAt:new Date().toISOString(),rows,note:'Probe public Gate futures contract_stats using explicit historical from timestamps and 1h/8h intervals. No authentication or trading actions.'};
writeFileSync(OUT,JSON.stringify(report,null,2)+'\n');console.log('CONTRACT_STATS_PROBE='+JSON.stringify(report));
