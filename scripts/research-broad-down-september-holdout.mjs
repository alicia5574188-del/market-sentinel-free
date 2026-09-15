import { readFileSync, writeFileSync } from 'node:fs';

const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen universe missing');
const U=JSON.parse(mm[1]);
const SYMBOLS=U['202608'];
if(!Array.isArray(SYMBOLS)||SYMBOLS.length<15) throw new Error('August frozen universe unavailable');

const H=3600, STEP=300, GAP=0.019636820810880196;
const BASE=0.0014, STRESS=0.0022, SLIP=0.00025, ADV=0.00050;
const START=Date.UTC(2026,8,1,0,0,0)/1000;
const END=Date.UTC(2026,8,16,0,0,0)/1000;
const DATA_FROM=START-5*H;
const CHUNK=2*86400;
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchJson(url,attempts=6){for(let a=0;a<attempts;a++){try{const r=await fetch(url);if(r.ok)return await r.json();if(r.status===429||r.status>=500){await sleep(500*(a+1));continue}throw new Error(`${r.status} ${url}`)}catch(e){if(a===attempts-1)throw e;await sleep(500*(a+1))}}}
function parseRows(a){if(!Array.isArray(a))return [];return a.flatMap(x=>{const time=Number(x.t??x[0]),open=Number(x.o??x[5]),high=Number(x.h??x[3]),low=Number(x.l??x[4]),close=Number(x.c??x[2]),volume=Number(x.v??x[1]??0);return time>0&&open>0&&low>0&&high>=low&&[open,high,low,close].every(Number.isFinite)?[{time,open,high,low,close,volume}]:[]}).sort((a,b)=>a.time-b.time)}
async function fetch5m(symbol){const out=[];for(let from=DATA_FROM;from<END;from+=CHUNK){const to=Math.min(END-1,from+CHUNK-1),url=`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&from=${from}&to=${to}&interval=5m`;try{out.push(...parseRows(await fetchJson(url)))}catch(e){console.error('fetch failed',symbol,from,to,String(e));return []}}const dedup=new Map(out.map(r=>[r.time,r]));return [...dedup.values()].sort((a,b)=>a.time-b.time)}
function aggregate(rows){const out=[];let b=null;for(const r of rows){const t=Math.floor(r.time/H)*H;if(!b||b.time!==t){if(b?.samples>=10)out.push(b);b={time:t,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume,samples:1}}else{b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;b.volume+=r.volume;b.samples++}}if(b?.samples>=10)out.push(b);return out}
function lb(rows,t){let l=0,h=rows.length;while(l<h){const q=(l+h)>>1;if(rows[q].time<t)l=q+1;else h=q}return l}

const raw=new Map();let cursor=0;async function worker(){while(cursor<SYMBOLS.length){const s=SYMBOLS[cursor++];raw.set(s,await fetch5m(s))}}
await Promise.all(Array.from({length:6},worker));
const hourly=new Map();for(const [s,rows] of raw)if(rows.length)hourly.set(s,aggregate(rows));
const active=[...hourly.keys()];
const maps=new Map(active.map(s=>[s,new Map(hourly.get(s).map(r=>[r.time,r]))]));

const candidates=[];
for(let t=START+4*H;t<END-3*H;t+=H){
  const hour=new Date(t*1000).getUTCHours();if(hour<16||hour>23)continue;
  const obs=[];
  for(const symbol of active){const p=maps.get(symbol),c=p.get(t),p1=p.get(t-H),p4=p.get(t-4*H);if(!c||!p1||!p4)continue;obs.push({symbol,r1:c.close/p1.close-1,r4:c.close/p4.close-1})}
  if(obs.length<Math.max(12,Math.ceil(active.length*.6)))continue;
  const marketR1=median(obs.map(x=>x.r1)),marketR4=median(obs.map(x=>x.r4)),breadthDown1=obs.filter(x=>x.r1<0).length/obs.length;
  const mad=median(obs.map(x=>Math.abs(x.r4-marketR4)))||1e-9,scale=1.4826*mad;
  for(const x of obs){x.rel4=x.r4-marketR4;x.z4=x.rel4/scale}
  const srt=[...obs].sort((a,b)=>a.rel4-b.rel4),q75=quantile(obs.map(o=>-o.r1),.75);
  for(let rank=1;rank<=3;rank++){
    const x=srt[rank-1],next=srt[rank];if(!x||!next)continue;
    const z=-x.z4,gap=next.rel4-x.rel4,persistence=(-x.r1)>0&&(-x.r1)>=q75;
    if(z<2||gap<GAP||!persistence)continue;
    candidates.push({t,hour,rank,symbol:x.symbol,z4:z,gap4:gap,r1:x.r1,marketR1,marketR4,breadthDown1,broadDown:breadthDown1>=2/3});
  }
}

// Rank-specific cooldown preserves the primary rank-1 rule. Aggregate views are re-deduped later by symbol.
candidates.sort((a,b)=>a.t-b.t||a.rank-b.rank);const lastRank=new Map(),events=[];
for(const e of candidates){const k=`${e.rank}|${e.symbol}`,last=lastRank.get(k)??-Infinity;if(e.t-last<4*H)continue;lastRank.set(k,e.t);events.push(e)}
function makeTrade(e,friction,slip){const rows=raw.get(e.symbol)||[],entryTime=e.t+H,bi=lb(rows,entryTime),xi=bi+23;if(rows[bi]?.time!==entryTime||!rows[xi])return null;for(let i=bi+1;i<=xi;i++)if(rows[i].time!==rows[i-1].time+STEP)return null;const entry=rows[bi].open*(1+slip),exit=rows[xi].close,gross=(exit-entry)/entry;return {...e,entryTime,exitTime:rows[xi].time+STEP,gross,net:gross-friction}}
const trades=[];for(const e of events)for(const scenario of ['base','stress','adverse']){const friction=scenario==='stress'?STRESS:BASE,slip=scenario==='adverse'?ADV:SLIP,xx=makeTrade(e,friction,slip);if(xx)trades.push({...xx,scenario})}
function metrics(a){if(!a.length)return {trades:0};const vals=a.map(x=>x.net).sort((x,y)=>x-y),sum=vals.reduce((s,x)=>s+x,0),g=vals.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-vals.filter(x=>x<=0).reduce((s,x)=>s+x,0),lo=quantile(vals,.05),hi=quantile(vals,.95),wins=vals.map(x=>Math.max(lo,Math.min(hi,x)));return {trades:a.length,meanNet:sum/a.length,medianNet:median(vals),hit:a.filter(x=>x.net>0).length/a.length,pf:l?g/l:null,sumNet:sum,winsor5Mean:wins.reduce((s,x)=>s+x,0)/wins.length}}
function aggregateEvents(maxRank,broadOnly=true){const xs=events.filter(e=>e.rank<=maxRank&&(!broadOnly||e.broadDown)).sort((a,b)=>a.t-b.t||a.rank-b.rank),last=new Map(),out=[];for(const e of xs){const p=last.get(e.symbol)??-Infinity;if(e.t-p<4*H)continue;last.set(e.symbol,e.t);out.push(e)}return out}
function metricsForEventSet(es,scenario){const keys=new Set(es.map(e=>`${e.rank}|${e.symbol}|${e.t}`));return metrics(trades.filter(x=>x.scenario===scenario&&keys.has(`${x.rank}|${x.symbol}|${x.t}`)))}
const report={
  decision:'PENDING',period:{start:'2026-09-01T00:00:00Z',endExclusive:'2026-09-16T00:00:00Z'},
  universePolicy:'frozen 202608 crypto universe, determined before September outcomes',symbols:SYMBOLS,activeSymbols:active,
  primaryRule:'rank1 bottom 4h relative extreme; z>=2; adjacent gap>=1.963682%; current 1h decline in worst quartile; UTC16-23; breadthDown1>=2/3; next 5m open long; hold 2h; 4h same-symbol cooldown',
  primary:{},comparison:{},rankExpansion:{},candidateCount:candidates.length,eventCount:events.length
};
for(const sc of ['base','stress','adverse']){
  report.primary[sc]=metrics(trades.filter(x=>x.rank===1&&x.broadDown&&x.scenario===sc));
  report.comparison[sc]={allCapitulation:metrics(trades.filter(x=>x.rank===1&&x.scenario===sc)),notBroadDown:metrics(trades.filter(x=>x.rank===1&&!x.broadDown&&x.scenario===sc))};
  for(const k of [1,2,3])report.rankExpansion[`bottom${k}`]={...(report.rankExpansion[`bottom${k}`]||{}),[sc]:metricsForEventSet(aggregateEvents(k,true),sc)};
}
const p=report.primary;
report.decision=p.base.trades>=5&&p.base.meanNet>0&&p.stress.meanNet>0&&p.base.winsor5Mean>0&&(p.base.pf??0)>1?'SEPTEMBER_HOLDOUT_SUPPORT':'SEPTEMBER_HOLDOUT_FAIL';
writeFileSync('/tmp/broad-down-september-holdout.json',JSON.stringify(report,null,2));
writeFileSync('/tmp/broad-down-september-events.json',JSON.stringify(events));
writeFileSync('/tmp/broad-down-september-trades.json',JSON.stringify(trades));
console.log(JSON.stringify(report,null,2));