import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const ROUTER_SOURCE=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const m=ROUTER_SOURCE.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!m)throw new Error('Cannot extract frozen selected universe');
const SELECTED_BY_MONTH=JSON.parse(m[1]);
const MONTHS=Object.keys(SELECTED_BY_MONTH).sort();
const H=3600;
const CACHE='/tmp/special-coin-5m'; mkdirSync(CACHE,{recursive:true});
const BASE_FRICTION=0.0014, STRESS_FRICTION=0.0022, ENTRY_SLIPPAGE=0.00025;
const LEADER_GAP_Q50=0.010290943890619353;
const LEADER_GAP_Q75=0.02504859161691536;
const LOSER_GAP_Q50=0.008475427527992796;
const LOSER_GAP_Q75=0.019636820810880196;
const monthStartSec=x=>Date.UTC(+x.slice(0,4),+x.slice(4,6)-1,1)/1000;
const nextMonthSec=x=>Date.UTC(+x.slice(0,4),+x.slice(4,6),1)/1000;
const expected5m=x=>(nextMonthSec(x)-monthStartSec(x))/300;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2;};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f;};

async function fetchBuffer(url,attempts=5){for(let a=0;a<attempts;a++){try{const r=await fetch(url);if(r.ok)return Buffer.from(await r.arrayBuffer());if(r.status===404)return null;if(r.status===429||r.status>=500){await sleep(500*(a+1));continue;}return null;}catch{await sleep(500*(a+1));}}return null;}
async function get5m(symbol,month){
  const p=`${CACHE}/${encodeURIComponent(symbol)}-${month}.gz`;let b;
  if(existsSync(p))b=readFileSync(p);else{b=await fetchBuffer(`https://download.gatedata.org/futures_usdt/candlesticks_5m/${month}/${encodeURIComponent(symbol)}-${month}.csv.gz`);if(!b)return null;writeFileSync(p,b);}
  try{const text=gunzipSync(b).toString('utf8').trim();const rows=text.split('\n').flatMap(line=>{const [time,volume,close,high,low,open]=line.split(',').map(Number);return time>0&&open>0&&low>0&&high>=low&&[volume,close,high,low,open].every(Number.isFinite)?[{time,volume,close,high,low,open}]:[];}).sort((a,b)=>a.time-b.time);return rows.length>=expected5m(month)*0.50?rows:null;}catch{return null;}
}
function aggregate(rows){
  const out=[];let b=null;
  for(const r of rows){const t=Math.floor(r.time/H)*H;if(!b||b.time!==t){if(b?.samples>=10)out.push(b);b={time:t,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume,samples:1};}else{b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;b.volume+=r.volume;b.samples++;}}
  if(b?.samples>=10)out.push(b);
  const filled=[];for(const r of out){const p=filled.at(-1),missing=p?(r.time-p.time)/H-1:0;if(p&&missing>0&&missing<=3)for(let i=1;i<=missing;i++)filled.push({time:p.time+i*H,open:p.close,high:p.close,low:p.close,close:p.close,volume:0,samples:0,synthetic:true});filled.push(r);}return filled;
}
function split(month){if(month==='202507')return 'july_holdout';if(month<'202603')return 'discovery';if(month<'202606')return 'validation';return 'evaluation';}
function lowerBound(rows,time){let l=0,h=rows.length;while(l<h){const q=(l+h)>>1;if(rows[q].time<time)l=q+1;else h=q;}return l;}

const tasks=[];for(const month of MONTHS)for(const symbol of SELECTED_BY_MONTH[month])tasks.push({month,symbol});
let cursor=0;const rawByKey=new Map();
async function worker(){while(cursor<tasks.length){const {month,symbol}=tasks[cursor++];const rows=await get5m(symbol,month);rawByKey.set(`${month}|${symbol}`,rows??[]);}}
await Promise.all(Array.from({length:16},worker));

const hourlyByKey=new Map(),activeByMonth={};
for(const month of MONTHS){let n=0;for(const symbol of SELECTED_BY_MONTH[month]){const raw=rawByKey.get(`${month}|${symbol}`)||[];if(raw.length){n++;hourlyByKey.set(`${month}|${symbol}`,aggregate(raw));}}activeByMonth[month]=n;}

const candidateEvents=[];
for(const month of MONTHS){
  const syms=SELECTED_BY_MONTH[month].filter(s=>(hourlyByKey.get(`${month}|${s}`)||[]).length);
  const maps=new Map(syms.map(s=>[s,new Map(hourlyByKey.get(`${month}|${s}`).map(r=>[r.time,r]))]));
  for(let t=monthStartSec(month)+4*H;t<nextMonthSec(month)-5*H;t+=H){
    const obs=[];
    for(const symbol of syms){const mp=maps.get(symbol),cur=mp.get(t),p1=mp.get(t-H),p2=mp.get(t-2*H),p4=mp.get(t-4*H);if(!cur||!p1||!p2||!p4)continue;const r1=cur.close/p1.close-1,prev1=p1.close/p2.close-1,r4=cur.close/p4.close-1;obs.push({symbol,r1,prev1,r4,cur});}
    if(obs.length<Math.max(12,Math.ceil(syms.length*.60)))continue;
    const med4=median(obs.map(x=>x.r4)),mad4=median(obs.map(x=>Math.abs(x.r4-med4)))||1e-9,scale=1.4826*mad4;
    for(const x of obs)x.rel4=x.r4-med4,x.z4=x.rel4/scale;
    const sorted=[...obs].sort((a,b)=>b.rel4-a.rel4),hour=new Date(t*1000).getUTCHours();
    for(const side of ['leader','loser']){
      const x=side==='leader'?sorted[0]:sorted.at(-1),second=side==='leader'?sorted[1]:sorted.at(-2),dir=side==='leader'?1:-1,z=dir*x.z4;
      if(z<1.5)continue;
      const gap=side==='leader'?x.rel4-second.rel4:second.rel4-x.rel4;
      const q75=quantile(obs.map(o=>dir*o.r1),.75),persistence=dir*x.r1>0&&dir*x.r1>=q75;
      candidateEvents.push({month,split:split(month),t,hour,side,symbol:x.symbol,z4:z,gap4:gap,persistence});
    }
  }
}

candidateEvents.sort((a,b)=>a.t-b.t||a.side.localeCompare(b.side));
const lastSeen=new Map(),events=[];
for(const e of candidateEvents){const key=`${e.side}|${e.symbol}`,last=lastSeen.get(key)??-Infinity;if(e.t-last<4*H)continue;lastSeen.set(key,e.t);events.push(e);}

function family(e){
  if(e.side==='leader'&&e.hour>=8&&e.hour<=15&&e.z4>=2&&e.gap4>=LEADER_GAP_Q50&&e.persistence)return 'A_MIDDAY_LEADER_CONT';
  if(e.side==='leader'&&e.hour>=16&&e.hour<=23&&e.z4>=6&&e.gap4>=LEADER_GAP_Q75)return 'B_LATE_LEADER_REV';
  if(e.side==='loser'&&e.hour>=16&&e.hour<=23&&e.z4>=2&&e.gap4>=LOSER_GAP_Q75)return 'C_LATE_LOSER_REV';
  return null;
}
function executeFixed(e,direction,hours,friction,slippage){
  const rows=rawByKey.get(`${e.month}|${e.symbol}`)||[],entryTime=e.t+H,idx=lowerBound(rows,entryTime);if(rows[idx]?.time!==entryTime)return null;
  const exitIdx=idx+hours*12-1;if(!rows[exitIdx])return null;
  for(let i=idx+1;i<=exitIdx;i++)if(rows[i].time!==rows[i-1].time+300)return null;
  const entry=rows[idx].open*(1+direction*slippage),exit=rows[exitIdx].close,gross=direction*(exit-entry)/entry;
  return {entryTime:rows[idx].time,exitTime:rows[exitIdx].time+300,entry,exit,gross,net:gross-friction};
}
function executeStructureShort(e,friction,slippage){
  const rows=rawByKey.get(`${e.month}|${e.symbol}`)||[],baseTime=e.t+H,base=lowerBound(rows,baseTime);if(rows[base]?.time!==baseTime)return null;
  const fixedExit=base+47;if(!rows[fixedExit])return null;
  for(let i=base+1;i<=fixedExit;i++)if(rows[i].time!==rows[i-1].time+300)return null;
  let entryIdx=null;
  for(let j=base+6;j<=Math.min(base+23,fixedExit-1);j++){
    const priorLow=Math.min(...rows.slice(j-6,j).map(r=>r.low));
    if(rows[j].close<priorLow){entryIdx=j+1;break;}
  }
  if(entryIdx==null||entryIdx>fixedExit)return null;
  const direction=-1,entry=rows[entryIdx].open*(1+direction*slippage),exit=rows[fixedExit].close,gross=direction*(exit-entry)/entry;
  return {entryTime:rows[entryIdx].time,exitTime:rows[fixedExit].time+300,entry,exit,gross,net:gross-friction,confirmDelayMinutes:(rows[entryIdx].time-baseTime)/60};
}

const trades=[];
for(const e of events){const f=family(e);if(!f)continue;
  const variants=f==='B_LATE_LEADER_REV'?['IMMEDIATE_4H','STRUCTURE_4H']:['FIXED_4H'];
  for(const variant of variants){
    for(const scenario of ['base','stress','adverse']){
      const friction=scenario==='stress'?STRESS_FRICTION:BASE_FRICTION,slippage=scenario==='adverse'?ENTRY_SLIPPAGE*2:ENTRY_SLIPPAGE;
      let ex;if(f==='A_MIDDAY_LEADER_CONT')ex=executeFixed(e,1,4,friction,slippage);else if(f==='C_LATE_LOSER_REV')ex=executeFixed(e,1,4,friction,slippage);else ex=variant==='STRUCTURE_4H'?executeStructureShort(e,friction,slippage):executeFixed(e,-1,4,friction,slippage);
      if(ex)trades.push({...e,family:f,variant,scenario,...ex});
    }
  }
}

function metrics(rows){
  if(!rows.length)return {trades:0};const gains=rows.filter(x=>x.net>0).reduce((s,x)=>s+x.net,0),loss=-rows.filter(x=>x.net<=0).reduce((s,x)=>s+x.net,0),months=[...new Set(rows.map(x=>x.month))];
  const monthly=Object.fromEntries(months.sort().map(m=>{const a=rows.filter(x=>x.month===m);return [m,{trades:a.length,meanNet:a.reduce((s,x)=>s+x.net,0)/a.length,sumNet:a.reduce((s,x)=>s+x.net,0)}];}));
  const sorted=[...rows].sort((a,b)=>a.entryTime-b.entryTime);let eq=1,peak=1,dd=0;for(const x of sorted){eq+=x.net;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/Math.max(peak,1e-9));}
  return {trades:rows.length,meanNet:rows.reduce((s,x)=>s+x.net,0)/rows.length,medianNet:median(rows.map(x=>x.net)),hitRate:rows.filter(x=>x.net>0).length/rows.length,profitFactor:loss?gains/loss:null,sumNet:rows.reduce((s,x)=>s+x.net,0),positiveMonths:Object.values(monthly).filter(x=>x.sumNet>0).length,activeMonths:months.length,unitCurveMaxDrawdown:dd,meanConfirmDelayMinutes:rows.some(x=>x.confirmDelayMinutes!=null)?rows.filter(x=>x.confirmDelayMinutes!=null).reduce((s,x)=>s+x.confirmDelayMinutes,0)/rows.filter(x=>x.confirmDelayMinutes!=null).length:null,monthly};
}
const report={
  decision:'PENDING',
  thresholds:{leaderGapQ50:LEADER_GAP_Q50,leaderGapQ75:LEADER_GAP_Q75,loserGapQ50:LOSER_GAP_Q50,loserGapQ75:LOSER_GAP_Q75},
  costs:{baseFriction:BASE_FRICTION,stressFriction:STRESS_FRICTION,entrySlippage:ENTRY_SLIPPAGE,adverseEntrySlippage:ENTRY_SLIPPAGE*2},
  months:MONTHS,activeByMonth,candidateEvents:candidateEvents.length,dedupedEvents:events.length,
  families:{},
};
for(const f of ['A_MIDDAY_LEADER_CONT','B_LATE_LEADER_REV','C_LATE_LOSER_REV']){report.families[f]={};for(const variant of (f==='B_LATE_LEADER_REV'?['IMMEDIATE_4H','STRUCTURE_4H']:['FIXED_4H'])){report.families[f][variant]={};for(const scenario of ['base','stress','adverse']){report.families[f][variant][scenario]={};for(const sp of ['july_holdout','discovery','validation','evaluation','all']){const rows=trades.filter(x=>x.family===f&&x.variant===variant&&x.scenario===scenario&&(sp==='all'||x.split===sp));report.families[f][variant][scenario][sp]=metrics(rows);}}}}
const baseChecks=[];
for(const [f,variant] of [['A_MIDDAY_LEADER_CONT','FIXED_4H'],['B_LATE_LEADER_REV','STRUCTURE_4H'],['C_LATE_LOSER_REV','FIXED_4H']]){
  const x=report.families[f][variant];const core=['discovery','validation','evaluation'];baseChecks.push({family:f,variant,basePositive:core.every(s=>(x.base[s].meanNet??-1)>0),stressPositive:core.every(s=>(x.stress[s].meanNet??-1)>0),julyPositive:(x.base.july_holdout.meanNet??-1)>0,counts:Object.fromEntries(['july_holdout',...core].map(s=>[s,x.base[s].trades]))});
}
report.gates=baseChecks;report.decision=baseChecks.some(x=>x.basePositive&&x.stressPositive&&x.julyPositive)?'EXECUTION_EDGE_SURVIVES':'NO_FROZEN_EXECUTION_EDGE';
writeFileSync('/tmp/special-coin-execution.json',JSON.stringify(report,null,2));
writeFileSync('/tmp/special-coin-execution-trades.json',JSON.stringify(trades));
console.log(JSON.stringify({decision:report.decision,activeByMonth,events:events.length,gates:baseChecks,families:Object.fromEntries(Object.entries(report.families).map(([f,v])=>[f,Object.fromEntries(Object.entries(v).map(([vv,s])=>[vv,{base:s.base,stress:s.stress,adverse:s.adverse}]))]))},null,2));
