import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// Research-only audit of perpetual-specific funding information.
// Signal is formed only AFTER a realized funding record at t. Entry waits until
// the next 5m open; position is held through the NEXT funding timestamp and exits
// at the following 5m open, so next funding cashflow is included causally in PnL.
const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen causal universe missing');
const U=JSON.parse(mm[1]);
const HIST=Object.keys(U).filter(m=>m>='202508'&&m<='202608').sort();
const SEPT='202609', SEPT_SYMBOLS=U['202608'];
const STEP=300, BASE=0.0014, STRESS=0.0022, SLIP=0.00025, ADV=0.00050;
const SEPT_START=Date.UTC(2026,8,1)/1000, SEPT_END=Date.UTC(2026,8,16)/1000;
const CACHE='/tmp/funding-crowding-carry';mkdirSync(CACHE,{recursive:true});
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f};
const ms=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000;
const nx=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const nextMonth=m=>{const d=new Date(Date.UTC(+m.slice(0,4),+m.slice(4,6),1));return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`};
const exp=m=>(nx(m)-ms(m))/STEP;
const split=m=>m<'202603'?'discovery':m<'202606'?'validation':'evaluation';
const sleep=x=>new Promise(r=>setTimeout(r,x));
async function fetchJson(url){for(let a=0;a<6;a++){try{const r=await fetch(url,{headers:{Accept:'application/json'}});if(r.ok)return await r.json();if(r.status===404)return [];if(r.status===429||r.status>=500){await sleep(400*(a+1));continue}return []}catch{if(a===5)return [];await sleep(400*(a+1))}}return []}
async function funding(symbol,from,to){const url=`https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=${encodeURIComponent(symbol)}&from=${from}&to=${to}&limit=1000`;const a=await fetchJson(url);return Array.isArray(a)?a.flatMap(x=>{const t=Number(x.t),r=Number(x.r);return t>0&&Number.isFinite(r)?[{t,r}]:[]}).sort((x,y)=>x.t-y.t):[]}
async function fetchBuf(url){for(let a=0;a<5;a++){try{const r=await fetch(url);if(r.ok)return Buffer.from(await r.arrayBuffer());if(r.status===404)return null;if(r.status===429||r.status>=500){await sleep(350*(a+1));continue}return null}catch{await sleep(350*(a+1))}}return null}
async function archive5m(symbol,month){const p=`${CACHE}/${encodeURIComponent(symbol)}-${month}.gz`;let b=existsSync(p)?readFileSync(p):null;if(!b){b=await fetchBuf(`https://download.gatedata.org/futures_usdt/candlesticks_5m/${month}/${encodeURIComponent(symbol)}-${month}.csv.gz`);if(!b)return [];writeFileSync(p,b)}try{const rows=gunzipSync(b).toString('utf8').trim().split('\n').flatMap(line=>{const [time,volume,close,high,low,open]=line.split(',').map(Number);return time>0&&open>0&&low>0&&high>=low&&[open,high,low,close].every(Number.isFinite)?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time);return rows.length>=exp(month)*.45?rows:[]}catch{return []}}
function parseRest(a){if(!Array.isArray(a))return [];return a.flatMap(x=>{const time=Number(x.t??x[0]),open=Number(x.o??x[5]),high=Number(x.h??x[3]),low=Number(x.l??x[4]),close=Number(x.c??x[2]),volume=Number(x.v??x[1]??0);return time>0&&open>0&&low>0&&high>=low&&[open,high,low,close].every(Number.isFinite)?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time)}
async function sept5m(symbol){const out=[],chunk=2*86400,from0=SEPT_START;for(let from=from0;from<SEPT_END;from+=chunk){const to=Math.min(SEPT_END-1,from+chunk-1),url=`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&from=${from}&to=${to}&interval=5m`;out.push(...parseRest(await fetchJson(url)))}return [...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time)}
function lb(rows,t){let l=0,h=rows.length;while(l<h){const q=(l+h)>>1;if(rows[q].time<t)l=q+1;else h=q}return l}

// Funding is cheap to fetch. Query each event month plus one day so the next
// settlement record exists for month-end signals.
const fraw=new Map(),ftasks=[];for(const m of HIST)for(const s of U[m])ftasks.push({m,s,from:ms(m),to:nx(m)+86400});for(const s of SEPT_SYMBOLS)ftasks.push({m:SEPT,s,from:SEPT_START,to:SEPT_END});
let fc=0;async function fw(){while(fc<ftasks.length){const x=ftasks[fc++];fraw.set(`${x.m}|${x.s}`,await funding(x.s,x.from,x.to))}}await Promise.all(Array.from({length:16},fw));

function makeMonthEvents(month,syms,start,end,sp){
  const at=new Map();
  for(const symbol of syms){const a=fraw.get(`${month}|${symbol}`)||[];for(let i=0;i<a.length-1;i++){const x=a[i],n=a[i+1];if(x.t<start||x.t>=end||n.t<=x.t||n.t>end+86400)continue;const prev=i? a[i-1].r:null;const arr=at.get(x.t)||[];arr.push({month,split:sp,t:x.t,symbol,r:x.r,prevR:prev,nextT:n.t,nextR:n.r});at.set(x.t,arr)}}
  const out=[];
  for(const [t,a] of at){const cover=a.length/syms.length,vals=a.map(x=>x.r),med=median(vals),mad=median(vals.map(x=>Math.abs(x-med)))||1e-12,scale=1.4826*mad;for(const x of a)x.z=(x.r-med)/scale;
    const pos=[...a].filter(x=>x.r>0).sort((x,y)=>y.r-x.r),neg=[...a].filter(x=>x.r<0).sort((x,y)=>x.r-y.r);
    for(const x of a){const policies=[];if(Math.abs(x.r)>=0.0005)policies.push('ABS50');if(Math.abs(x.r)>=0.001)policies.push('ABS100');if(cover>=0.60&&Math.abs(x.z)>=2&&Math.sign(x.z)===Math.sign(x.r))policies.push('Z2');if(cover>=0.60&&pos.slice(0,1).some(q=>q.symbol===x.symbol)||cover>=0.60&&neg.slice(0,1).some(q=>q.symbol===x.symbol))policies.push('RANK1');if(cover>=0.60&&pos.slice(0,2).some(q=>q.symbol===x.symbol)||cover>=0.60&&neg.slice(0,2).some(q=>q.symbol===x.symbol))policies.push('RANK2');
      for(const policy of [...new Set(policies)])out.push({...x,policy,coverage:cover,medianFunding:med});
    }
  }
  return out;
}
let events=[];for(const m of HIST)events.push(...makeMonthEvents(m,U[m],ms(m),nx(m),split(m)));events.push(...makeMonthEvents(SEPT,SEPT_SYMBOLS,SEPT_START,SEPT_END,'september_holdout'));

// Fetch only price series for symbols that actually produced at least one signal.
const needed=new Map();for(const e of events){if(e.month===SEPT)continue;needed.set(`${e.month}|${e.symbol}`,{m:e.month,s:e.symbol});const nm=nextMonth(e.month);if(nm<SEPT)needed.set(`${nm}|${e.symbol}`,{m:nm,s:e.symbol})}
const praw=new Map(),ptasks=[...needed.values()];let pc=0;async function pw(){while(pc<ptasks.length){const x=ptasks[pc++];praw.set(`${x.m}|${x.s}`,await archive5m(x.s,x.m))}}await Promise.all(Array.from({length:20},pw));
const sraw=new Map();let sc=0;async function sw(){while(sc<SEPT_SYMBOLS.length){const s=SEPT_SYMBOLS[sc++];sraw.set(s,await sept5m(s))}}await Promise.all(Array.from({length:6},sw));
function series(month,symbol){if(month===SEPT)return sraw.get(symbol)||[];const a=praw.get(`${month}|${symbol}`)||[],nm=nextMonth(month),b=nm===SEPT?(sraw.get(symbol)||[]):(praw.get(`${nm}|${symbol}`)||[]);return [...a,...b].sort((x,y)=>x.time-y.time)}

function trade(e,family,scenario){const rows=series(e.month,e.symbol),entryTime=e.t+STEP,exitTime=e.nextT+STEP,ei=lb(rows,entryTime),xi=lb(rows,exitTime);if(rows[ei]?.time!==entryTime||rows[xi]?.time!==exitTime)return null;for(let i=ei+1;i<=xi;i++)if(rows[i].time!==rows[i-1].time+STEP)return null;const carryDir=e.r>0?-1:1,dir=family==='CARRY'?carryDir:-carryDir,friction=scenario==='stress'?STRESS:BASE,slip=scenario==='adverse'?ADV:SLIP,entry=rows[ei].open*(1+dir*slip),exit=rows[xi].open,priceGross=dir*(exit-entry)/entry,fundingPnl=-dir*e.nextR,net=priceGross+fundingPnl-friction;return {...e,family,scenario,dir,entryTime,exitTime,entry,exit,priceGross,fundingPnl,net}}
const trades=[];for(const e of events)for(const family of ['CARRY','MOM'])for(const scenario of ['base','stress','adverse']){const x=trade(e,family,scenario);if(x)trades.push(x)}
function metrics(a){if(!a.length)return {trades:0};const vals=a.map(x=>x.net).sort((x,y)=>x-y),sum=vals.reduce((s,x)=>s+x,0),g=vals.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-vals.filter(x=>x<=0).reduce((s,x)=>s+x,0),lo=quantile(vals,.05),hi=quantile(vals,.95),wins=vals.map(x=>Math.max(lo,Math.min(hi,x))),sym={};for(const x of a)sym[x.symbol]=(sym[x.symbol]||0)+x.net;const pos=Object.values(sym).filter(x=>x>0).sort((a,b)=>b-a),months=[...new Set(a.map(x=>x.month))],price=a.reduce((s,x)=>s+x.priceGross,0)/a.length,fund=a.reduce((s,x)=>s+x.fundingPnl,0)/a.length;return {trades:a.length,meanNet:sum/a.length,medianNet:median(vals),hit:a.filter(x=>x.net>0).length/a.length,pf:l?g/l:null,sumNet:sum,winsor5Mean:wins.reduce((s,x)=>s+x,0)/wins.length,meanPriceGross:price,meanFundingPnl:fund,meanGrossBeforeCost:price+fund,activeMonths:months.length,positiveMonths:months.filter(m=>a.filter(x=>x.month===m).reduce((s,x)=>s+x.net,0)>0).length,symbols:Object.keys(sym).length,topPositiveSymbolShare:sum>0&&pos.length?pos[0]/sum:null}}
const histDays=HIST.reduce((s,m)=>s+(nx(m)-ms(m))/86400,0),septDays=(SEPT_END-SEPT_START)/86400;
const policies=['RANK1','RANK2','Z2','ABS50','ABS100'];
const report={decision:'PENDING',rule:'observe realized funding at t; select crowded/carry candidates; enter t+5m; hold through next funding; exit next funding+5m; include actual next funding cashflow',policies,families:['CARRY','MOM'],costs:{base:BASE,stress:STRESS,slippage:SLIP,adverseSlippage:ADV},eventCount:events.length,grid:{},selection:{},accepted:[]};
for(const p of policies)for(const family of ['CARRY','MOM']){const cfg=`${p}_${family}`;report.grid[cfg]={};for(const scenario of ['base','stress','adverse'])for(const sp of ['discovery','validation','evaluation','september_holdout','all']){const a=trades.filter(x=>x.policy===p&&x.family===family&&x.scenario===scenario&&(sp==='all'?x.split!=='september_holdout':x.split===sp));report.grid[cfg][scenario]??={};const days=sp==='september_holdout'?septDays:sp==='all'?histDays:HIST.filter(m=>split(m)===sp).reduce((s,m)=>s+(nx(m)-ms(m))/86400,0);report.grid[cfg][scenario][sp]={...metrics(a),tradesPerDay:a.length/days}}}
function dq(x){const b=x.base.discovery,s=x.stress.discovery;return b.trades>=120&&b.meanNet>0&&s.meanNet>0&&b.medianNet>0&&b.winsor5Mean>0&&(s.pf??0)>1.05&&b.positiveMonths>=Math.max(4,Math.ceil(b.activeMonths*.55))&&(!b.topPositiveSymbolShare||b.topPositiveSymbolShare<=0.45)}
function core(x){for(const sp of ['validation','evaluation']){const b=x.base[sp],s=x.stress[sp];if(b.trades<30||b.meanNet<=0||s.meanNet<=0||b.winsor5Mean<=0||(s.pf??0)<=1)return false}return true}
function sept(x){const b=x.base.september_holdout,s=x.stress.september_holdout;return b.trades>=10&&b.meanNet>0&&s.meanNet>0&&b.winsor5Mean>0&&(s.pf??0)>1}
for(const family of ['CARRY','MOM']){const eligible=policies.map(p=>`${p}_${family}`).filter(k=>dq(report.grid[k])).sort((a,b)=>report.grid[b].stress.discovery.sumNet-report.grid[a].stress.discovery.sumNet||(report.grid[b].stress.discovery.pf??0)-(report.grid[a].stress.discovery.pf??0)),selected=eligible[0]??null;report.selection[family]={eligible,selected};if(selected){const x=report.grid[selected],cp=core(x),sp=sept(x);report.selection[family].corePass=cp;report.selection[family].septemberPass=sp;report.selection[family].validation=x.base.validation;report.selection[family].evaluation=x.base.evaluation;report.selection[family].september=x.base.september_holdout;if(cp&&sp)report.accepted.push({family,config:selected})}}
const accepted=[];for(const a of report.accepted)accepted.push(...trades.filter(x=>`${x.policy}_${x.family}`===a.config&&x.scenario==='base'));
report.combined={historical:metrics(accepted.filter(x=>x.split!=='september_holdout')),september:metrics(accepted.filter(x=>x.split==='september_holdout'))};report.decision=report.accepted.length?'FUNDING_EDGE_FOUND':'NO_STABLE_FUNDING_EDGE';
writeFileSync('/tmp/funding-crowding-carry.json',JSON.stringify(report,null,2));writeFileSync('/tmp/funding-crowding-events.json',JSON.stringify(events));writeFileSync('/tmp/funding-crowding-trades.json',JSON.stringify(trades));console.log(JSON.stringify({decision:report.decision,eventCount:report.eventCount,selection:report.selection,accepted:report.accepted,combined:report.combined},null,2));