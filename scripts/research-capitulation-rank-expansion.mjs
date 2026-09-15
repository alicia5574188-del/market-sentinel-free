import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen universe missing');
const U=JSON.parse(mm[1]), MONTHS=Object.keys(U).sort();
const H=3600, GAP=0.019636820810880196, BASE=0.0014, STRESS=0.0022, SLIP=0.00025, ADV=0.00050;
const CACHE='/tmp/cap-rank-5m'; mkdirSync(CACHE,{recursive:true});
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f};
const ms=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000, nx=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const exp=m=>(nx(m)-ms(m))/300, split=m=>m==='202507'?'july_holdout':m<'202603'?'discovery':m<'202606'?'validation':'evaluation';
const sleep=x=>new Promise(r=>setTimeout(r,x));
async function fetchBuf(url){for(let a=0;a<5;a++){try{const r=await fetch(url);if(r.ok)return Buffer.from(await r.arrayBuffer());if(r.status===404)return null;if(r.status===429||r.status>=500){await sleep(400*(a+1));continue}return null}catch{await sleep(400*(a+1))}}return null}
async function five(symbol,month){
  const p=`${CACHE}/${encodeURIComponent(symbol)}-${month}.gz`;let b=existsSync(p)?readFileSync(p):null;
  if(!b){b=await fetchBuf(`https://download.gatedata.org/futures_usdt/candlesticks_5m/${month}/${encodeURIComponent(symbol)}-${month}.csv.gz`);if(!b)return [];writeFileSync(p,b)}
  try{const rows=gunzipSync(b).toString('utf8').trim().split('\n').flatMap(line=>{const [time,volume,close,high,low,open]=line.split(',').map(Number);return time>0&&open>0&&low>0&&high>=low?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time);return rows.length>=exp(month)*.5?rows:[]}catch{return []}
}
function hourly(rows){const out=[];let b=null;for(const r of rows){const t=Math.floor(r.time/H)*H;if(!b||b.time!==t){if(b?.samples>=10)out.push(b);b={time:t,open:r.open,high:r.high,low:r.low,close:r.close,samples:1}}else{b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;b.samples++}}if(b?.samples>=10)out.push(b);return out}
function lb(rows,t){let l=0,h=rows.length;while(l<h){const q=(l+h)>>1;if(rows[q].time<t)l=q+1;else h=q}return l}

const todo=[];for(const month of MONTHS)for(const symbol of U[month])todo.push({month,symbol});
let cursor=0;const raw=new Map();async function worker(){while(cursor<todo.length){const x=todo[cursor++];raw.set(`${x.month}|${x.symbol}`,await five(x.symbol,x.month))}}
await Promise.all(Array.from({length:16},worker));
const hr=new Map();for(const [k,v] of raw)if(v.length)hr.set(k,hourly(v));

const candidates=[];
for(const month of MONTHS){
  const syms=U[month].filter(s=>hr.has(`${month}|${s}`));
  const maps=new Map(syms.map(s=>[s,new Map(hr.get(`${month}|${s}`).map(r=>[r.time,r]))]));
  for(let t=ms(month)+4*H;t<nx(month)-3*H;t+=H){
    const hour=new Date(t*1000).getUTCHours();if(hour<16||hour>23)continue;
    const obs=[];
    for(const symbol of syms){const p=maps.get(symbol),c=p.get(t),p1=p.get(t-H),p4=p.get(t-4*H);if(!c||!p1||!p4)continue;obs.push({symbol,r1:c.close/p1.close-1,r4:c.close/p4.close-1})}
    if(obs.length<Math.max(12,Math.ceil(syms.length*.6)))continue;
    const med4=median(obs.map(x=>x.r4)),mad=median(obs.map(x=>Math.abs(x.r4-med4)))||1e-9,scale=1.4826*mad;
    for(const x of obs){x.rel4=x.r4-med4;x.z4=x.rel4/scale}
    const srt=[...obs].sort((a,b)=>a.rel4-b.rel4),q75=quantile(obs.map(o=>-o.r1),.75);
    for(let rank=1;rank<=3;rank++){
      const x=srt[rank-1],next=srt[rank];if(!x||!next)continue;
      const z=-x.z4,gap=next.rel4-x.rel4,persistence=(-x.r1)>0&&(-x.r1)>=q75;
      if(z>=2&&gap>=GAP&&persistence)candidates.push({month,split:split(month),t,hour,rank,symbol:x.symbol,z4:z,gap4:gap,r1:x.r1});
    }
  }
}
candidates.sort((a,b)=>a.t-b.t||a.rank-b.rank);const last=new Map(),events=[];
for(const e of candidates){const key=`${e.rank}|${e.symbol}`,lastT=last.get(key)??-Infinity;if(e.t-lastT<4*H)continue;last.set(key,e.t);events.push(e)}

function makeTrade(e,friction,slip){const rows=raw.get(`${e.month}|${e.symbol}`)||[],entryTime=e.t+H,bi=lb(rows,entryTime),xi=bi+23;if(rows[bi]?.time!==entryTime||!rows[xi])return null;for(let i=bi+1;i<=xi;i++)if(rows[i].time!==rows[i-1].time+300)return null;const entry=rows[bi].open*(1+slip),exit=rows[xi].close,gross=(exit-entry)/entry;return {...e,entryTime,exitTime:rows[xi].time+300,gross,net:gross-friction}}
const trades=[];for(const e of events)for(const scenario of ['base','stress','adverse']){const friction=scenario==='stress'?STRESS:BASE,slip=scenario==='adverse'?ADV:SLIP,xx=makeTrade(e,friction,slip);if(xx)trades.push({...xx,scenario})}
function metrics(a){if(!a.length)return {trades:0};const gains=a.filter(x=>x.net>0).reduce((s,x)=>s+x.net,0),loss=-a.filter(x=>x.net<=0).reduce((s,x)=>s+x.net,0);const sym={};for(const x of a)sym[x.symbol]=(sym[x.symbol]||0)+x.net;const pos=Object.values(sym).filter(x=>x>0).sort((a,b)=>b-a),sum=a.reduce((s,x)=>s+x.net,0),vals=a.map(x=>x.net).sort((x,y)=>x-y),lo=quantile(vals,.05),hi=quantile(vals,.95),wins=vals.map(x=>Math.max(lo,Math.min(hi,x)));return {trades:a.length,meanNet:sum/a.length,medianNet:median(vals),hit:a.filter(x=>x.net>0).length/a.length,pf:loss?gains/loss:null,sumNet:sum,winsor5Mean:wins.reduce((s,x)=>s+x,0)/wins.length,symbols:Object.keys(sym).length,topPositiveSymbolShare:sum>0&&pos.length?pos[0]/sum:null}}
const days=MONTHS.reduce((s,m)=>s+(nx(m)-ms(m))/86400,0);
const report={decision:'PENDING',rule:'UTC16-23; rank-specific bottom1/2/3; z>=2; adjacent gap>=frozen 1.963682%; still in cross-sectional worst 25% over last 1h; next 5m open; hold 2h',days,events:events.length,byRank:{},aggregate:{}};
for(const rank of [1,2,3]){report.byRank[rank]={};for(const sc of ['base','stress','adverse']){report.byRank[rank][sc]={};for(const sp of ['discovery','validation','evaluation','july_holdout','all'])report.byRank[rank][sc][sp]=metrics(trades.filter(x=>x.rank===rank&&x.scenario===sc&&(sp==='all'||x.split===sp)))}}
for(const k of [1,2,3]){report.aggregate[`bottom${k}`]={};for(const sc of ['base','stress','adverse']){report.aggregate[`bottom${k}`][sc]={};for(const sp of ['discovery','validation','evaluation','july_holdout','all']){const a=trades.filter(x=>x.rank<=k&&x.scenario===sc&&(sp==='all'||x.split===sp));report.aggregate[`bottom${k}`][sc][sp]={...metrics(a),tradesPerDay:a.length/days}}}}
function rankPass(rank){const x=report.byRank[rank],core=['discovery','validation','evaluation'];return {rank,coreBase:core.every(s=>(x.base[s].meanNet??-1)>0),coreStress:core.every(s=>(x.stress[s].meanNet??-1)>0),julyN:x.base.july_holdout.trades,julyBase:x.base.july_holdout.meanNet??null,julyPass:x.base.july_holdout.trades<5?null:x.base.july_holdout.meanNet>0}}
report.rankGates=[1,2,3].map(rankPass);report.decision=report.rankGates[1].coreBase&&report.rankGates[1].coreStress?'RANK2_GENERALIZES':report.rankGates[0].coreBase&&report.rankGates[0].coreStress?'TOP1_ONLY':'NO_RANK_GENERALIZATION';
writeFileSync('/tmp/capitulation-rank-expansion.json',JSON.stringify(report,null,2));writeFileSync('/tmp/capitulation-rank-expansion-trades.json',JSON.stringify(trades));
console.log(JSON.stringify({decision:report.decision,events:report.events,rankGates:report.rankGates,aggregate:Object.fromEntries(Object.entries(report.aggregate).map(([k,v])=>[k,{base:v.base.all,stress:v.stress.all,splits:{discovery:v.base.discovery,validation:v.base.validation,evaluation:v.base.evaluation,july:v.base.july_holdout}}]))},null,2));