import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// Research-only causal audit: detect cross-sectional extremes, then WAIT for the
// post-event 5m path to resolve into either failed extension (reversal) or a
// second push (continuation). No production/PAPER/LIVE logic is imported.
const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen causal universe missing');
const U=JSON.parse(mm[1]);
const HIST_MONTHS=Object.keys(U).filter(m=>m>='202508'&&m<='202608').sort();
const SEPT_MONTH='202609';
const SEPT_SYMBOLS=U['202608'];
if(!Array.isArray(SEPT_SYMBOLS)||SEPT_SYMBOLS.length<15) throw new Error('frozen 202608 universe missing');

const H=3600, STEP=300;
// Frozen from the prior discovery event study; not re-fit here.
const LEADER_GAP=0.010290943890619353;
const LOSER_GAP=0.008475427527992796;
const BASE=0.0014, STRESS=0.0022, SLIP=0.00025, ADV=0.00050;
const SEPT_START=Date.UTC(2026,8,1,0,0,0)/1000;
const SEPT_END=Date.UTC(2026,8,16,0,0,0)/1000;
const CACHE='/tmp/extreme-reaction-path';mkdirSync(CACHE,{recursive:true});

const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f};
const ms=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000;
const nx=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const exp=m=>(nx(m)-ms(m))/STEP;
const nextMonth=m=>{const y=+m.slice(0,4),mo=+m.slice(4,6)-1,d=new Date(Date.UTC(y,mo+1,1));return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`};
const split=m=>m<'202603'?'discovery':m<'202606'?'validation':'evaluation';
const sleep=x=>new Promise(r=>setTimeout(r,x));

async function fetchBuf(url){for(let a=0;a<5;a++){try{const r=await fetch(url);if(r.ok)return Buffer.from(await r.arrayBuffer());if(r.status===404)return null;if(r.status===429||r.status>=500){await sleep(350*(a+1));continue}return null}catch{await sleep(350*(a+1))}}return null}
async function archive5m(symbol,month){
  const p=`${CACHE}/${encodeURIComponent(symbol)}-${month}.gz`;let b=existsSync(p)?readFileSync(p):null;
  if(!b){b=await fetchBuf(`https://download.gatedata.org/futures_usdt/candlesticks_5m/${month}/${encodeURIComponent(symbol)}-${month}.csv.gz`);if(!b)return [];writeFileSync(p,b)}
  try{const rows=gunzipSync(b).toString('utf8').trim().split('\n').flatMap(line=>{const [time,volume,close,high,low,open]=line.split(',').map(Number);return time>0&&open>0&&low>0&&high>=low&&[open,high,low,close].every(Number.isFinite)?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time);return rows.length>=exp(month)*.5?rows:[]}catch{return []}
}
async function fetchJson(url){for(let a=0;a<6;a++){try{const r=await fetch(url);if(r.ok)return await r.json();if(r.status===429||r.status>=500){await sleep(450*(a+1));continue}return []}catch{if(a===5)return [];await sleep(450*(a+1))}}return []}
function parseRest(a){if(!Array.isArray(a))return [];return a.flatMap(x=>{const time=Number(x.t??x[0]),open=Number(x.o??x[5]),high=Number(x.h??x[3]),low=Number(x.l??x[4]),close=Number(x.c??x[2]),volume=Number(x.v??x[1]??0);return time>0&&open>0&&low>0&&high>=low&&[open,high,low,close].every(Number.isFinite)?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time)}
async function sept5m(symbol){
  const out=[],from0=SEPT_START-5*H,chunk=2*86400;
  for(let from=from0;from<SEPT_END;from+=chunk){const to=Math.min(SEPT_END-1,from+chunk-1);const url=`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&from=${from}&to=${to}&interval=5m`;out.push(...parseRest(await fetchJson(url)))}
  return [...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time);
}
function hourly(rows){const out=[];let b=null;for(const r of rows){const t=Math.floor(r.time/H)*H;if(!b||b.time!==t){if(b?.samples>=10)out.push(b);b={time:t,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume||0,samples:1}}else{b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;b.volume+=(r.volume||0);b.samples++}}if(b?.samples>=10)out.push(b);return out}
function lb(rows,t){let l=0,h=rows.length;while(l<h){const q=(l+h)>>1;if(rows[q].time<t)l=q+1;else h=q}return l}

// Fetch each historical month plus the following month for the event-month universe.
// That avoids the month-end censoring bug found in the previous audit.
const archiveTasks=new Map();
for(const month of HIST_MONTHS)for(const symbol of U[month]){
  archiveTasks.set(`${month}|${symbol}`,{month,symbol});
  const nm=nextMonth(month);if(nm<= '202608')archiveTasks.set(`${nm}|${symbol}`,{month:nm,symbol});
}
const archiveRaw=new Map();const taskList=[...archiveTasks.values()];let cursor=0;
async function archiveWorker(){while(cursor<taskList.length){const x=taskList[cursor++];archiveRaw.set(`${x.month}|${x.symbol}`,await archive5m(x.symbol,x.month))}}
await Promise.all(Array.from({length:20},archiveWorker));
const septRaw=new Map();let sc=0;async function septWorker(){while(sc<SEPT_SYMBOLS.length){const s=SEPT_SYMBOLS[sc++];septRaw.set(s,await sept5m(s))}}
await Promise.all(Array.from({length:6},septWorker));

function seriesFor(month,symbol){
  if(month===SEPT_MONTH)return septRaw.get(symbol)||[];
  const a=archiveRaw.get(`${month}|${symbol}`)||[],nm=nextMonth(month);
  const b=nm===SEPT_MONTH?(septRaw.get(symbol)||[]):(archiveRaw.get(`${nm}|${symbol}`)||[]);
  return [...a,...b].sort((x,y)=>x.time-y.time);
}

const hourlyByMonth=new Map();
for(const month of HIST_MONTHS){for(const symbol of U[month]){const rows=archiveRaw.get(`${month}|${symbol}`)||[];if(rows.length)hourlyByMonth.set(`${month}|${symbol}`,hourly(rows))}}
for(const symbol of SEPT_SYMBOLS){const rows=septRaw.get(symbol)||[];if(rows.length)hourlyByMonth.set(`${SEPT_MONTH}|${symbol}`,hourly(rows))}

function detectMonth(month,syms,start,end,sp,isSept=false){
  const active=syms.filter(s=>hourlyByMonth.has(`${month}|${s}`)),maps=new Map(active.map(s=>[s,new Map(hourlyByMonth.get(`${month}|${s}`).map(r=>[r.time,r]))]));
  const out=[];const hardEnd=isSept?end-6*H:end;
  for(let t=start+4*H;t<hardEnd;t+=H){
    const obs=[];
    for(const symbol of active){const p=maps.get(symbol),c=p.get(t),p1=p.get(t-H),p4=p.get(t-4*H);if(!c||!p1||!p4)continue;obs.push({symbol,c,r1:c.close/p1.close-1,r4:c.close/p4.close-1})}
    if(obs.length<Math.max(12,Math.ceil(active.length*.60)))continue;
    const med4=median(obs.map(x=>x.r4)),mad=median(obs.map(x=>Math.abs(x.r4-med4)))||1e-9,scale=1.4826*mad;
    for(const x of obs){x.rel4=x.r4-med4;x.z4=x.rel4/scale}
    const sorted=[...obs].sort((a,b)=>b.rel4-a.rel4);
    for(const side of ['leader','loser']){
      const x=side==='leader'?sorted[0]:sorted.at(-1),second=side==='leader'?sorted[1]:sorted.at(-2),dir=side==='leader'?1:-1;
      const z=dir*x.z4,gap=side==='leader'?x.rel4-second.rel4:second.rel4-x.rel4,gapMin=side==='leader'?LEADER_GAP:LOSER_GAP;
      if(z<2||gap<gapMin)continue;
      out.push({month,split:sp,t,side,dir,symbol:x.symbol,z4:z,gap4:gap,r1:x.r1,r4:x.r4,eventOpen:x.c.open,eventHigh:x.c.high,eventLow:x.c.low,eventClose:x.c.close,eventMid:(x.c.high+x.c.low)/2});
    }
  }
  return out;
}
let histEvents=[];for(const m of HIST_MONTHS)histEvents.push(...detectMonth(m,U[m],ms(m),nx(m),split(m),false));
let septEvents=detectMonth(SEPT_MONTH,SEPT_SYMBOLS,SEPT_START,SEPT_END,'september_holdout',true);
function dedupEvents(a){const out=[],last=new Map();for(const e of [...a].sort((x,y)=>x.t-y.t)){const p=last.get(e.symbol)??-Infinity;if(e.t-p<4*H)continue;last.set(e.symbol,e.t);out.push(e)}return out}
histEvents=dedupEvents(histEvents);septEvents=dedupEvents(septEvents);

// Mutually exclusive path router for a given maximum confirmation window.
// 1) Price must first extend beyond the completed extreme-hour high/low.
// 2a) Failed extension: it then closes through the event-hour midpoint => reversal.
// 2b) If no midpoint reclaim, after >=15m it closes beyond the first break bar's
//     own extreme => second-push continuation.
function routeEvent(e,windowMinutes){
  const rows=seriesFor(e.month,e.symbol),signalEnd=e.t+H,base=lb(rows,signalEnd),bars=windowMinutes/5;
  if(rows[base]?.time!==signalEnd)return null;
  let first=-1,firstLevel=null;
  for(let j=base;j<=Math.min(base+bars-1,rows.length-2);j++){
    const r=rows[j];
    if(first<0){const broke=e.dir>0?r.high>e.eventHigh:r.low<e.eventLow;if(!broke)continue;first=j;firstLevel=e.dir>0?r.high:r.low}
    const reclaimed=e.dir>0?r.close<e.eventMid:r.close>e.eventMid;
    if(reclaimed){return buildSignal(e,rows,j+1,'REV',-e.dir,windowMinutes,(rows[j].time+STEP-signalEnd)/60)}
    if(j>=first+3){const second=e.dir>0?r.close>firstLevel:r.close<firstLevel;if(second)return buildSignal(e,rows,j+1,'CONT',e.dir,windowMinutes,(rows[j].time+STEP-signalEnd)/60)}
  }
  return null;
}
function buildSignal(e,rows,entryIdx,family,tradeDir,windowMinutes,delay){if(!rows[entryIdx])return null;return {...e,family,tradeDir,windowMinutes,confirmDelayMinutes:delay,entryIdx,entryTime:rows[entryIdx].time}}
function makeTrade(sig,holdHours,scenario){
  const rows=seriesFor(sig.month,sig.symbol),entryIdx=lb(rows,sig.entryTime),exitIdx=entryIdx+holdHours*12-1;if(rows[entryIdx]?.time!==sig.entryTime||!rows[exitIdx])return null;
  for(let i=entryIdx+1;i<=exitIdx;i++)if(rows[i].time!==rows[i-1].time+STEP)return null;
  const friction=scenario==='stress'?STRESS:BASE,slip=scenario==='adverse'?ADV:SLIP,entry=rows[entryIdx].open*(1+sig.tradeDir*slip),exit=rows[exitIdx].close,gross=sig.tradeDir*(exit-entry)/entry;
  return {...sig,holdHours,scenario,entry,exit,exitTime:rows[exitIdx].time+STEP,net:gross-friction};
}

const allSignals=[];
for(const e of [...histEvents,...septEvents])for(const w of [30,60]){const s=routeEvent(e,w);if(s)allSignals.push(s)}
const trades=[];for(const s of allSignals)for(const h of [1,2,4])for(const scenario of ['base','stress','adverse']){const x=makeTrade(s,h,scenario);if(x)trades.push(x)}

function metrics(a){if(!a.length)return {trades:0};const vals=a.map(x=>x.net).sort((x,y)=>x-y),sum=vals.reduce((s,x)=>s+x,0),g=vals.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-vals.filter(x=>x<=0).reduce((s,x)=>s+x,0),lo=quantile(vals,.05),hi=quantile(vals,.95),wins=vals.map(x=>Math.max(lo,Math.min(hi,x))),sym={};for(const x of a)sym[x.symbol]=(sym[x.symbol]||0)+x.net;const pos=Object.values(sym).filter(x=>x>0).sort((a,b)=>b-a),months=[...new Set(a.map(x=>x.month))];return {trades:a.length,meanNet:sum/a.length,medianNet:median(vals),hit:a.filter(x=>x.net>0).length/a.length,pf:l?g/l:null,sumNet:sum,winsor5Mean:wins.reduce((s,x)=>s+x,0)/wins.length,activeMonths:months.length,positiveMonths:months.filter(m=>a.filter(x=>x.month===m).reduce((s,x)=>s+x.net,0)>0).length,symbols:Object.keys(sym).length,topPositiveSymbolShare:sum>0&&pos.length?pos[0]/sum:null,meanConfirmDelayMinutes:a.reduce((s,x)=>s+x.confirmDelayMinutes,0)/a.length}}
const histDays=HIST_MONTHS.reduce((s,m)=>s+(nx(m)-ms(m))/86400,0),septDays=(SEPT_END-SEPT_START)/86400;
const report={decision:'PENDING',rule:'rank1 4h relative extreme -> wait for 5m response path; failed extension through event midpoint routes reversal; unreclaimed second push after >=15m routes continuation',thresholds:{z:2,leaderGap:LEADER_GAP,loserGap:LOSER_GAP},windows:[30,60],holds:[1,2,4],costs:{base:BASE,stress:STRESS,slippage:SLIP,adverseSlippage:ADV},eventCounts:{historical:histEvents.length,september:septEvents.length},signalCounts:{historical:allSignals.filter(x=>x.split!=='september_holdout').length,september:allSignals.filter(x=>x.split==='september_holdout').length},grid:{},selection:{},accepted:[]};
for(const side of ['leader','loser'])for(const family of ['REV','CONT'])for(const w of [30,60])for(const h of [1,2,4]){
  const key=`${side}_${family}_${w}M_${h}H`;report.grid[key]={};
  for(const scenario of ['base','stress','adverse'])for(const sp of ['discovery','validation','evaluation','september_holdout','all']){
    const a=trades.filter(x=>x.side===side&&x.family===family&&x.windowMinutes===w&&x.holdHours===h&&x.scenario===scenario&&(sp==='all'?x.split!=='september_holdout':x.split===sp));
    report.grid[key][scenario]??={};report.grid[key][scenario][sp]={...metrics(a),tradesPerDay:a.length/(sp==='september_holdout'?septDays:sp==='all'?histDays:HIST_MONTHS.filter(m=>split(m)===sp).reduce((s,m)=>s+(nx(m)-ms(m))/86400,0))};
  }
}
function discoveryQual(x){const d=x.base.discovery,s=x.stress.discovery;return d.trades>=60&&d.meanNet>0&&s.meanNet>0&&d.medianNet>0&&d.winsor5Mean>0&&(s.pf??0)>1.08&&d.positiveMonths>=Math.max(4,Math.ceil(d.activeMonths*.55))&&(!d.topPositiveSymbolShare||d.topPositiveSymbolShare<=0.65)}
function corePass(x){for(const sp of ['validation','evaluation']){const b=x.base[sp],s=x.stress[sp];if(b.trades<20||b.meanNet<=0||s.meanNet<=0||b.winsor5Mean<=0||(s.pf??0)<=1)return false}return true}
function septPass(x){const b=x.base.september_holdout,s=x.stress.september_holdout;return b.trades>=5&&b.meanNet>0&&s.meanNet>0&&b.winsor5Mean>0&&(s.pf??0)>1}
for(const side of ['leader','loser'])for(const family of ['REV','CONT']){
  const prefix=`${side}_${family}_`,eligible=Object.keys(report.grid).filter(k=>k.startsWith(prefix)&&discoveryQual(report.grid[k])).sort((a,b)=>report.grid[b].stress.discovery.sumNet-report.grid[a].stress.discovery.sumNet||(report.grid[b].stress.discovery.pf??0)-(report.grid[a].stress.discovery.pf??0));
  const selected=eligible[0]??null,key=`${side}_${family}`;report.selection[key]={eligible,selected};
  if(selected){const x=report.grid[selected],cp=corePass(x),sp=septPass(x);report.selection[key].corePass=cp;report.selection[key].septemberPass=sp;report.selection[key].validation=x.base.validation;report.selection[key].evaluation=x.base.evaluation;report.selection[key].september=x.base.september_holdout;if(cp&&sp)report.accepted.push({side,family,config:selected})}
}
const acceptedTrades=[];for(const a of report.accepted){const cfg=report.grid[a.config],m=a.config.match(/_(30|60)M_(1|2|4)H$/),w=+m[1],h=+m[2];acceptedTrades.push(...trades.filter(x=>x.side===a.side&&x.family===a.family&&x.windowMinutes===w&&x.holdHours===h&&x.scenario==='base'))}
report.combined={historical:metrics(acceptedTrades.filter(x=>x.split!=='september_holdout')),september:metrics(acceptedTrades.filter(x=>x.split==='september_holdout'))};
report.decision=report.accepted.length?'REACTION_PATH_EDGE_FOUND':'NO_STABLE_REACTION_PATH_EDGE';
writeFileSync('/tmp/extreme-reaction-path.json',JSON.stringify(report,null,2));
writeFileSync('/tmp/extreme-reaction-path-signals.json',JSON.stringify(allSignals));
writeFileSync('/tmp/extreme-reaction-path-trades.json',JSON.stringify(trades));
console.log(JSON.stringify({decision:report.decision,eventCounts:report.eventCounts,signalCounts:report.signalCounts,selection:report.selection,accepted:report.accepted,combined:report.combined},null,2));