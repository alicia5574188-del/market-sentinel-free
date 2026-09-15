import { writeFileSync } from 'node:fs';

const OUT=process.env.RESEARCH_OUTPUT??'/tmp/premium-history-probe.json';
const symbols=(process.env.RESEARCH_SYMBOLS??'BTC_USDT,ETH_USDT,SOL_USDT').split(',').filter(Boolean);
const windows=[['2024-09-01','2024-10-01'],['2025-09-01','2025-10-01'],['2026-08-01','2026-09-01']];
const base='https://api.gateio.ws/api/v4/futures/usdt/candlesticks';
async function get(url){for(let n=0;n<5;n++){const r=await fetch(url,{headers:{Accept:'application/json'}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,500*(n+1)));continue;}return{__error:`${r.status} ${await r.text()}`};}return{__error:'retry exhausted'};}
const rows=[];
for(const symbol of symbols)for(const [a,b] of windows)for(const kind of ['last','mark','index']){const from=Math.floor(Date.parse(`${a}T00:00:00Z`)/1000),to=Math.floor(Date.parse(`${b}T00:00:00Z`)/1000),contract=kind==='last'?symbol:`${kind}_${symbol}`,url=`${base}?contract=${encodeURIComponent(contract)}&from=${from}&to=${to}&interval=1h`;const res=await get(url),arr=Array.isArray(res)?res:[];rows.push({symbol,kind,window:[a,b],count:arr.length,first:arr[0]??null,last:arr.at(-1)??null,error:res?.__error??null});}
const report={queriedAt:new Date().toISOString(),rows,note:'Probe Gate futures 1h last/mark/index candlesticks at old and recent dates. No auth/trading.'};
writeFileSync(OUT,JSON.stringify(report,null,2)+'\n');console.log('PREMIUM_HISTORY_PROBE='+JSON.stringify(report));
