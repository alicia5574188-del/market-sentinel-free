import { gunzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const OUT=process.env.RESEARCH_OUTPUT??'/tmp/derivatives-archive-probe.json';
const symbols=(process.env.RESEARCH_SYMBOLS??'BTC_USDT,ETH_USDT,SOL_USDT,ADA_USDT,LINK_USDT,AAVE_USDT').split(',').filter(Boolean);
const months=(process.env.RESEARCH_MONTHS??'202409,202509,202608').split(',').filter(Boolean);
const types=['mark_prices','funding_applies','funding_updates'];
async function fetchText(url){for(let n=0;n<4;n++){const r=await fetch(url,{headers:{Accept:'application/octet-stream'}});if(r.ok){const b=Buffer.from(await r.arrayBuffer());return gunzipSync(b).toString('utf8');}if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,500*(n+1)));continue;}return{error:`HTTP ${r.status}`};}return{error:'retry exhausted'};}
const rows=[];
for(const symbol of symbols)for(const month of months)for(const type of types){const url=`https://download.gatedata.org/futures_usdt/${type}/${month}/${symbol}-${month}.csv.gz`,res=await fetchText(url);if(typeof res!=='string'){rows.push({symbol,month,type,error:res.error,count:0});continue;}const lines=res.trim().split('\n').filter(Boolean);rows.push({symbol,month,type,error:null,count:lines.length,first:lines[0]??null,second:lines[1]??null,last:lines.at(-1)??null});}
const report={queriedAt:new Date().toISOString(),rows,note:'Gate official futures_usdt monthly archive probe for mark_prices, funding_applies and funding_updates. No authentication/trading.'};
writeFileSync(OUT,JSON.stringify(report,null,2)+'\n');console.log('DERIVATIVES_ARCHIVE_PROBE='+JSON.stringify(report));
