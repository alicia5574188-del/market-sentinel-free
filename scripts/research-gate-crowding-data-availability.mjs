import { writeFileSync } from 'node:fs';

const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/gate-crowding-data-availability.json';
const SYMBOLS=(process.env.RESEARCH_SYMBOLS??'BTC_USDT,ETH_USDT,SOL_USDT,XRP_USDT,BNB_USDT,DOGE_USDT,ADA_USDT,LINK_USDT,LTC_USDT,AVAX_USDT,BCH_USDT').split(',');
const FROM=Number(process.env.RESEARCH_FROM??Math.floor(Date.UTC(2023,0,1)/1000));
const TO=Number(process.env.RESEARCH_TO??Math.floor(Date.UTC(2026,8,1)/1000));
const HOST='https://api.gateio.ws/api/v4';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(path){
  let last;
  for(let attempt=0;attempt<5;attempt++){
    try{
      const r=await fetch(HOST+path,{headers:{Accept:'application/json'}});
      if(r.ok)return await r.json();
      last=new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
      if(r.status!==429&&r.status<500)throw last;
    }catch(e){last=e;}
    await sleep(400*(attempt+1));
  }
  throw last;
}
const uniqBy=(rows,key)=>[...new Map(rows.map(x=>[x[key],x])).values()].sort((a,b)=>Number(a[key])-Number(b[key]));
function monthKey(sec){const d=new Date(sec*1000);return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
function monthsBetween(from,to){const out=[];let d=new Date(from*1000);d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));while(d.getTime()/1000<to){out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`);d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));}return out;}
const expectedMonths=monthsBetween(FROM,TO);

async function fetchFunding(symbol){
  const rows=[],windowSec=120*86400;
  for(let s=FROM;s<TO;s+=windowSec){const e=Math.min(TO,s+windowSec);const q=new URLSearchParams({contract:symbol,from:String(s),to:String(e),limit:'1000'});const x=await getJson(`/futures/usdt/funding_rate?${q}`);if(Array.isArray(x))rows.push(...x);await sleep(80);}
  return uniqBy(rows,'t').filter(x=>Number(x.t)>=FROM&&Number(x.t)<TO);
}
async function fetchStats(symbol){
  const rows=[];let cursor=FROM,pages=0;const step=4*3600;
  while(cursor<TO&&pages<40){const q=new URLSearchParams({contract:symbol,from:String(cursor),interval:'4h',limit:'1000'});const x=await getJson(`/futures/usdt/contract_stats?${q}`);pages++;if(!Array.isArray(x)||!x.length)break;const sorted=[...x].sort((a,b)=>Number(a.time)-Number(b.time)),usable=sorted.filter(r=>Number(r.time)>=cursor&&Number(r.time)<TO);rows.push(...usable);const last=Math.max(...sorted.map(r=>Number(r.time)));if(!Number.isFinite(last)||last<cursor)break;const next=last+step;if(next<=cursor)break;cursor=next;await sleep(100);}
  return{rows:uniqBy(rows,'time').filter(x=>Number(x.time)>=FROM&&Number(x.time)<TO),pages,cursor};
}
function fieldCoverage(rows,field){if(!rows.length)return 0;return rows.filter(r=>r[field]!==undefined&&r[field]!==null&&String(r[field])!==''&&Number.isFinite(Number(r[field]))).length/rows.length;}
function summarizeFunding(rows){const months=[...new Set(rows.map(r=>monthKey(Number(r.t))))];return{records:rows.length,first:rows[0]?.t??null,last:rows.at(-1)?.t??null,coveredMonths:months.length,monthCoverage:months.length/expectedMonths.length,rateNonZeroShare:rows.length?rows.filter(r=>Math.abs(Number(r.r))>0).length/rows.length:0};}
function summarizeStats(rows,pages){const months=[...new Set(rows.map(r=>monthKey(Number(r.time))))];const fields=['open_interest','open_interest_usd','lsr_taker','lsr_account','top_lsr_account','top_lsr_size','long_liq_usd','short_liq_usd','long_taker_size','short_taker_size','long_users','short_users'];return{records:rows.length,pages,first:rows[0]?.time??null,last:rows.at(-1)?.time??null,coveredMonths:months.length,monthCoverage:months.length/expectedMonths.length,fieldCoverage:Object.fromEntries(fields.map(f=>[f,fieldCoverage(rows,f)]))};}

const perSymbol={};
for(const symbol of SYMBOLS){
  console.log(`fetch ${symbol}`);
  let funding=[],stats={rows:[],pages:0},fundingError=null,statsError=null;
  try{funding=await fetchFunding(symbol);}catch(e){fundingError=String(e?.message??e);}
  try{stats=await fetchStats(symbol);}catch(e){statsError=String(e?.message??e);}
  perSymbol[symbol]={funding:summarizeFunding(funding),stats:summarizeStats(stats.rows,stats.pages),fundingError,statsError};
  console.log(JSON.stringify({symbol,...perSymbol[symbol]}));
}
const fundingFull=SYMBOLS.filter(s=>perSymbol[s].funding.monthCoverage>=0.95),statsFull=SYMBOLS.filter(s=>perSymbol[s].stats.monthCoverage>=0.95),oiUsable=SYMBOLS.filter(s=>perSymbol[s].stats.monthCoverage>=0.80&&perSymbol[s].stats.fieldCoverage.open_interest_usd>=0.95);
const decision=statsFull.length>=9?'FULL_CROWDING_44M':oiUsable.length>=9?'USABLE_CROWDING_PARTIAL':'INSUFFICIENT_STATS_HISTORY';
const result={research:'gate-crowding-data-availability',source:'Gate public REST API',range:{from:FROM,to:TO,expectedMonths:expectedMonths.length},symbols:SYMBOLS,perSymbol,summary:{fundingFull,statsFull,oiUsable},decision,note:'Public endpoints only. No credentials, private account data, order book, PAPER, LIVE, or production state used.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,range:result.range,summary:result.summary,perSymbol},null,2));