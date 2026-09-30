import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen causal universe missing');
const U=JSON.parse(mm[1]);
const MONTHS=Object.keys(U).filter(m=>m>='202508'&&m<='202608').sort();
const H=3600, STEP=300;
const LEADER_GAP=0.010290943890619353;
const LOSER_GAP=0.008475427527992796;
const BASE=0.0014, STRESS=0.0022, SLIP=0.00025, ADV=0.00050;
const CACHE='/tmp/extreme-router-5m'; mkdirSync(CACHE,{recursive:true});
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f};
const ms=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000, nx=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const exp=m=>(nx(m)-ms(m))/STEP;
const split=m=>m<'202603'?'discovery':m<'202606'?'validation':'evaluation';
const sleep=x=>new Promise(r=>setTimeout(r,x));
async function fetchBuf(url){for(let a=0;a<5;a++){try{const r=await fetch(url);if(r.ok)return Buffer.from(await r.arrayBuffer());if(r.status===404)return null;if(r.status===429||r.status>=500){await sleep(400*(a+1));continue}return null}catch{await sleep(400*(a+1))}}return null}
async function five(symbol,month){
  const p=`${CACHE}/${encodeURIComponent(symbol)}-${month}.gz`;let b=existsSync(p)?readFileSync(p):null;
  if(!b){b=await fetchBuf(`https://download.gatedata.org/futures_usdt/candlesticks_5m/${month}/${encodeURIComponent(symbol)}-${month}.csv.gz`);if(!b)return [];writeFileSync(p,b)}
  try{const rows=gunzipSync(b).toString('utf8').trim().split('\n').flatMap(line=>{const [time,volume,close,high,low,open]=line.split(',').map(Number);return time>0&&open>0&&low>0&&high>=low&&[close,high,low].every(Number.isFinite)?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time);return rows.length>=exp(month)*.5?rows:[]}catch{return []}
}
function hourly(rows){const out=[];let b=null;for(const r of rows){const t=Math.floor(r.time/H)*H;if(!b||b.time!==t){if(b?.samples>=10)out.push(b);b={time:t,open:r.open,high:r.high,low:r.low,close:r.close,samples:1}}else{b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;b.samples++}}if(b?.samples>=10)out.push(b);return out}
function lb(rows,t){let l=0,h=rows.length;while(l<h){const q=(l+h)>>1;if(rows[q].time<t)l=q+1;else h=q}return l}

const todo=[];for(const month of MONTHS)for(const symbol of U[month])todo.push({month,symbol});
let cursor=0;const raw=new Map();async function worker(){while(cursor<todo.length){const x=todo[cursor++];raw.set(`${x.month}|${x.symbol}`,await five(x.symbol,x.month))}}
await Promise.all(Array.from({length:16},worker));
const hr=new Map();for(const [k,v] of raw)if(v.length)hr.set(k,hourly(v));

function confirmBreak(month,symbol,t,dir){
  const rows=raw.get(`${month}|${symbol}`)||[],signalEnd=t+H,base=lb(rows,signalEnd);
  if(rows[base]?.time!==signalEnd||base<6)return null;
  const pre=rows.slice(base-6,base),preHigh=Math.max(...pre.map(x=>x.high)),preLow=Math.min(...pre.map(x=>x.low));
  for(let j=base;j<=Math.min(base+5,rows.length-2);j++){
    const cont=dir>0?rows[j].close>preHigh:rows[j].close<preLow;
    const rev=dir>0?rows[j].close<preLow:rows[j].close>preHigh;
    if(!cont&&!rev)continue;
    const family=cont?'CONT':'REV',tradeDir=cont?dir:-dir,entryIdx=j+1,exitIdx=entryIdx+23;
    if(!rows[exitIdx])return null;
    for(let i=entryIdx;i<=exitIdx;i++)if(i>entryIdx&&rows[i].time!==rows[i-1].time+STEP)return null;
    return {family,tradeDir,confirmTime:rows[j].time+STEP,entryTime:rows[entryIdx].time,exitTime:rows[exitIdx].time+STEP,entryOpen:rows[entryIdx].open,exitClose:rows[exitIdx].close,confirmDelayMinutes:(rows[entryIdx].time-signalEnd)/60};
  }
  return null;
}

const confirmed=[];
for(const month of MONTHS){
  const syms=U[month].filter(s=>hr.has(`${month}|${s}`));
  const maps=new Map(syms.map(s=>[s,new Map(hr.get(`${month}|${s}`).map(r=>[r.time,r]))]));
  for(let t=ms(month)+5*H;t<nx(month)-4*H;t+=H){
    const obs=[];
    for(const symbol of syms){const p=maps.get(symbol),c=p.get(t),p1=p.get(t-H),p2=p.get(t-2*H),p4=p.get(t-4*H);if(!c||!p1||!p2||!p4)continue;obs.push({symbol,r1:c.close/p1.close-1,prev1:p1.close/p2.close-1,r4:c.close/p4.close-1})}
    if(obs.length<Math.max(12,Math.ceil(syms.length*.60)))continue;
    const med4=median(obs.map(x=>x.r4)),med1=median(obs.map(x=>x.r1)),medPrev1=median(obs.map(x=>x.prev1));
    const mad4=median(obs.map(x=>Math.abs(x.r4-med4)))||1e-9,scale=1.4826*mad4;
    for(const x of obs){x.rel4=x.r4-med4;x.z4=x.rel4/scale}
    const sorted=[...obs].sort((a,b)=>b.rel4-a.rel4);
    for(const side of ['leader','loser']){
      const x=side==='leader'?sorted[0]:sorted.at(-1),second=side==='leader'?sorted[1]:sorted.at(-2),dir=side==='leader'?1:-1;
      const z=dir*x.z4,gap=side==='leader'?x.rel4-second.rel4:second.rel4-x.rel4,gapMin=side==='leader'?LEADER_GAP:LOSER_GAP;
      if(z<2||gap<gapMin)continue;
      const d1=dir*x.r1,dPrev1=dir*x.prev1,ownAccel=d1>0&&d1>dPrev1,ownDecel=d1<dPrev1;
      const breadthAligned=obs.filter(o=>dir*o.r1>0).length/obs.length,marketAccel=dir*med1>dir*medPrev1;
      const q75=quantile(obs.map(o=>dir*o.r1),.75),ownTopQuartile=d1>=q75;
      const conf=confirmBreak(month,x.symbol,t,dir);if(!conf)continue;
      const entryBase=conf.entryOpen*(1+conf.tradeDir*SLIP),entryAdv=conf.entryOpen*(1+conf.tradeDir*ADV),exit=conf.exitClose;
      const grossBase=conf.tradeDir*(exit-entryBase)/entryBase,grossAdv=conf.tradeDir*(exit-entryAdv)/entryAdv;
      confirmed.push({month,split:split(month),t,side,dir,symbol:x.symbol,z4:z,gap4:gap,r1:x.r1,prev1:x.prev1,marketR1:med1,marketPrev1:medPrev1,breadthAligned,marketAccel,ownAccel,ownDecel,ownTopQuartile,...conf,baseNet:grossBase-BASE,stressNet:grossBase-STRESS,adverseNet:grossAdv-BASE});
    }
  }
}

const GATES={
  CONT_BASE:e=>e.family==='CONT',
  CONT_SYNC:e=>e.family==='CONT'&&e.breadthAligned>=2/3,
  CONT_ACCEL:e=>e.family==='CONT'&&e.ownAccel,
  CONT_SYNC_ACCEL:e=>e.family==='CONT'&&e.breadthAligned>=2/3&&e.ownAccel,
  REV_BASE:e=>e.family==='REV',
  REV_DECEL:e=>e.family==='REV'&&e.ownDecel,
  REV_DIVERGENT:e=>e.family==='REV'&&e.breadthAligned<0.5,
  REV_SYNC_FAIL:e=>e.family==='REV'&&e.breadthAligned>=2/3
};
const CONT_GATES=['CONT_BASE','CONT_SYNC','CONT_ACCEL','CONT_SYNC_ACCEL'];
const REV_GATES=['REV_BASE','REV_DECEL','REV_DIVERGENT','REV_SYNC_FAIL'];
function dedup(a){const out=[],last=new Map();for(const e of [...a].sort((x,y)=>x.t-y.t)){const k=e.symbol,p=last.get(k)??-Infinity;if(e.t-p<4*H)continue;last.set(k,e.t);out.push(e)}return out}
function metrics(a,field){if(!a.length)return {trades:0};const vals=a.map(x=>x[field]).sort((x,y)=>x-y),sum=vals.reduce((s,x)=>s+x,0),g=vals.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-vals.filter(x=>x<=0).reduce((s,x)=>s+x,0),lo=quantile(vals,.05),hi=quantile(vals,.95),wins=vals.map(x=>Math.max(lo,Math.min(hi,x))),months=[...new Set(a.map(x=>x.month))].sort(),monthly=Object.fromEntries(months.map(m=>{const z=a.filter(x=>x.month===m),v=z.reduce((s,x)=>s+x[field],0);return [m,{trades:z.length,mean:v/z.length,sum:v}]}));return {trades:a.length,meanNet:sum/a.length,medianNet:median(vals),hit:a.filter(x=>x[field]>0).length/a.length,pf:l?g/l:null,sumNet:sum,winsor5Mean:wins.reduce((s,x)=>s+x,0)/wins.length,activeMonths:months.length,positiveMonths:Object.values(monthly).filter(x=>x.sum>0).length,monthly,meanConfirmDelayMinutes:a.reduce((s,x)=>s+x.confirmDelayMinutes,0)/a.length}}
const daysBySplit={};for(const sp of ['discovery','validation','evaluation'])daysBySplit[sp]=MONTHS.filter(m=>split(m)===sp).reduce((s,m)=>s+(nx(m)-ms(m))/86400,0);
const report={decision:'PENDING',months:MONTHS,thresholds:{z:2,leaderGap:LEADER_GAP,loserGap:LOSER_GAP},costs:{base:BASE,stress:STRESS,entrySlippage:SLIP,adverseEntrySlippage:ADV},candidateConfirmed:confirmed.length,gates:{},selection:{},accepted:[],combined:null};
for(const side of ['leader','loser']){
  report.gates[side]={};
  for(const [name,fn] of Object.entries(GATES)){
    report.gates[side][name]={};
    for(const sp of ['discovery','validation','evaluation','all']){
      const a=dedup(confirmed.filter(e=>e.side===side&&(sp==='all'||e.split===sp)&&fn(e)));
      report.gates[side][name][sp]={base:metrics(a,'baseNet'),stress:metrics(a,'stressNet'),adverse:metrics(a,'adverseNet'),tradesPerDay:sp==='all'?a.length/Object.values(daysBySplit).reduce((x,y)=>x+y,0):a.length/daysBySplit[sp]};
    }
  }
}
function qualify(x){const d=x.discovery;return d.base.trades>=60&&d.base.meanNet>0&&d.stress.meanNet>0&&d.base.medianNet>0&&d.base.winsor5Mean>0&&(d.stress.pf??0)>1.10&&d.base.positiveMonths>=Math.max(4,Math.ceil(d.base.activeMonths*.55));}
function select(side,names){const eligible=names.filter(n=>qualify(report.gates[side][n])).sort((a,b)=>report.gates[side][b].discovery.stress.sumNet-report.gates[side][a].discovery.stress.sumNet||(report.gates[side][b].discovery.stress.pf??0)-(report.gates[side][a].discovery.stress.pf??0));return {eligible,selected:eligible[0]??null};}
function holdoutPass(x){for(const sp of ['validation','evaluation']){const q=x[sp];if(q.base.trades<20||q.base.meanNet<=0||q.stress.meanNet<=0||q.base.winsor5Mean<=0||(q.stress.pf??0)<=1)return false;}return true;}
for(const side of ['leader','loser']){
  report.selection[side]={continuation:select(side,CONT_GATES),reversal:select(side,REV_GATES)};
  for(const family of ['continuation','reversal']){
    const name=report.selection[side][family].selected;if(!name)continue;const x=report.gates[side][name],pass=holdoutPass(x);report.selection[side][family].holdoutPass=pass;report.selection[side][family].validation=x.validation;report.selection[side][family].evaluation=x.evaluation;if(pass)report.accepted.push({side,family,gate:name});
  }
}
const selectedEvents=[];
for(const a of report.accepted){const fn=GATES[a.gate];for(const e of confirmed)if(e.side===a.side&&fn(e))selectedEvents.push({...e,acceptedGate:a.gate})}
const comb=dedup(selectedEvents);
report.combined={};for(const sp of ['discovery','validation','evaluation','all']){const a=comb.filter(e=>sp==='all'||e.split===sp);report.combined[sp]={base:metrics(a,'baseNet'),stress:metrics(a,'stressNet'),adverse:metrics(a,'adverseNet'),tradesPerDay:sp==='all'?a.length/Object.values(daysBySplit).reduce((x,y)=>x+y,0):a.length/daysBySplit[sp]};}
report.decision=report.accepted.length?'EXTREME_ROUTER_EDGE_FOUND':'NO_STABLE_EXTREME_ROUTER';
writeFileSync('/tmp/extreme-persistence-reversal-router.json',JSON.stringify(report,null,2));
writeFileSync('/tmp/extreme-persistence-reversal-events.json',JSON.stringify(confirmed));
console.log(JSON.stringify({decision:report.decision,candidateConfirmed:report.candidateConfirmed,selection:report.selection,accepted:report.accepted,combined:report.combined},null,2));