import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// Frozen universe comes from the prior causal rolling-universe study. This study does not use old production strategy logic.
const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen universe missing');
const U=JSON.parse(mm[1]);
const MONTHS=Object.keys(U).sort();
const H=3600, GAP=0.019636820810880196;
const BASE=0.0014, STRESS=0.0022, SLIP=0.00025, ADV=0.00050;
const CACHE='/tmp/cap-rebound-5m'; mkdirSync(CACHE,{recursive:true});
const median=a=>{const b=[...a].sort((x,y)=>x-y),n=b.length;return n? (n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2):null};
const quantile=(a,q)=>{const b=[...a].sort((x,y)=>x-y);if(!b.length)return null;const p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f};
const ms=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000, nx=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const exp=m=>(nx(m)-ms(m))/300, sleep=x=>new Promise(r=>setTimeout(r,x));
async function buf(url){for(let a=0;a<5;a++){try{const r=await fetch(url);if(r.ok)return Buffer.from(await r.arrayBuffer());if(r.status===404)return null;if(r.status===429||r.status>=500){await sleep(400*(a+1));continue}return null}catch{await sleep(400*(a+1))}}return null}
async function five(symbol,month){const p=`${CACHE}/${encodeURIComponent(symbol)}-${month}.gz`;let b=existsSync(p)?readFileSync(p):null;if(!b){b=await buf(`https://download.gatedata.org/futures_usdt/candlesticks_5m/${month}/${encodeURIComponent(symbol)}-${month}.csv.gz`);if(!b)return [];writeFileSync(p,b)}try{const rows=gunzipSync(b).toString('utf8').trim().split('\n').flatMap(line=>{const [time,volume,close,high,low,open]=line.split(',').map(Number);return time>0&&open>0&&high>=low&&low>0?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time);return rows.length>=exp(month)*.5?rows:[]}catch{return []}}
function hourly(rows){const out=[];let b=null;for(const r of rows){const t=Math.floor(r.time/H)*H;if(!b||b.time!==t){if(b?.samples>=10)out.push(b);b={time:t,open:r.open,high:r.high,low:r.low,close:r.close,samples:1}}else{b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;b.samples++}}if(b?.samples>=10)out.push(b);return out}
function lb(rows,t){let l=0,h=rows.length;while(l<h){const q=(l+h)>>1;if(rows[q].time<t)l=q+1;else h=q}return l}
const split=m=>m==='202507'?'july_holdout':m<'202603'?'discovery':m<'202606'?'validation':'evaluation';

const todo=[];for(const month of MONTHS)for(const symbol of U[month])todo.push({month,symbol});
let cur=0;const raw=new Map();async function worker(){while(cur<todo.length){const x=todo[cur++];raw.set(`${x.month}|${x.symbol}`,await five(x.symbol,x.month))}}await Promise.all(Array.from({length:16},worker));
const hr=new Map();for(const [k,v] of raw)if(v.length)hr.set(k,hourly(v));

const all=[];
for(const month of MONTHS){
  const syms=U[month].filter(s=>hr.has(`${month}|${s}`));
  const maps=new Map(syms.map(s=>[s,new Map(hr.get(`${month}|${s}`).map(r=>[r.time,r]))]));
  for(let t=ms(month)+4*H;t<nx(month)-9*H;t+=H){
    const hour=new Date(t*1000).getUTCHours();if(hour<16||hour>23)continue;
    const obs=[];
    for(const symbol of syms){
      const p=maps.get(symbol),c=p.get(t),p1=p.get(t-H),p2=p.get(t-2*H),p4=p.get(t-4*H);
      if(!c||!p1||!p2||!p4)continue;
      obs.push({symbol,r1:c.close/p1.close-1,prev1:p1.close/p2.close-1,r4:c.close/p4.close-1});
    }
    if(obs.length<Math.max(12,Math.ceil(syms.length*.6)))continue;
    const med4=median(obs.map(x=>x.r4)),mad=median(obs.map(x=>Math.abs(x.r4-med4)))||1e-9,scale=1.4826*mad,med1=median(obs.map(x=>x.r1));
    for(const x of obs){x.rel4=x.r4-med4;x.z4=x.rel4/scale}
    const srt=[...obs].sort((a,b)=>a.rel4-b.rel4),x=srt[0],second=srt[1],z=-x.z4,gap=second.rel4-x.rel4;
    if(z<2||gap<GAP)continue;
    const directional1=-x.r1,directionalPrev1=-x.prev1,q75=quantile(obs.map(o=>-o.r1),.75);
    const persistence=directional1>0&&directional1>=q75;
    const signFlip=directional1<0,decel=directional1<directionalPrev1,rankFade=x.r1>=med1,exhaustion=signFlip||(decel&&rankFade);
    all.push({month,split:split(month),t,hour,symbol:x.symbol,z4:z,gap4:gap,r1:x.r1,prev1:x.prev1,marketR1:med1,marketR4:med4,dispersion4:scale,persistence,exhaustion});
  }
}
all.sort((a,b)=>a.t-b.t);const last=new Map(),events=[];for(const e of all){const lastT=last.get(e.symbol)??-Infinity;if(e.t-lastT<4*H)continue;last.set(e.symbol,e.t);events.push(e)}

function trade(e,hours,friction,slip,confirm=false){const rows=raw.get(`${e.month}|${e.symbol}`)||[],base=e.t+H,bi=lb(rows,base);if(rows[bi]?.time!==base)return null;let ei=bi;if(confirm){ei=null;for(let j=bi+3;j<=Math.min(bi+23,rows.length-2);j++){const priorHigh=Math.max(...rows.slice(j-6,j).map(x=>x.high));if(rows[j].close>priorHigh){ei=j+1;break}}if(ei==null)return null}const xi=bi+hours*12-1;if(!rows[xi]||ei>xi)return null;for(let i=bi+1;i<=xi;i++)if(rows[i].time!==rows[i-1].time+300)return null;const entry=rows[ei].open*(1+slip),exit=rows[xi].close,gross=(exit-entry)/entry;return {...e,entryTime:rows[ei].time,exitTime:rows[xi].time+300,gross,net:gross-friction,confirmDelayMinutes:(rows[ei].time-base)/60}}
const rows=[];for(const e of events){for(const rule of ['BASELINE','CAPITULATION']){if(rule==='CAPITULATION'&&!e.persistence)continue;for(const variant of ['IMMEDIATE','BOUNCE_CONFIRM'])for(const hours of [2,4,8])for(const sc of ['base','stress','adverse']){const friction=sc==='stress'?STRESS:BASE,slip=sc==='adverse'?ADV:SLIP,xx=trade(e,hours,friction,slip,variant==='BOUNCE_CONFIRM');if(xx)rows.push({...xx,rule,variant,hours,scenario:sc})}}}
function metrics(a){if(!a.length)return {trades:0};const g=a.filter(x=>x.net>0).reduce((s,x)=>s+x.net,0),l=-a.filter(x=>x.net<=0).reduce((s,x)=>s+x.net,0);return {trades:a.length,meanNet:a.reduce((s,x)=>s+x.net,0)/a.length,medianNet:median(a.map(x=>x.net)),hit:a.filter(x=>x.net>0).length/a.length,pf:l?g/l:null,sumNet:a.reduce((s,x)=>s+x.net,0),meanDelay:a.reduce((s,x)=>s+x.confirmDelayMinutes,0)/a.length}}
const report={eventCount:events.length,capitulationCount:events.filter(x=>x.persistence).length,thresholds:{z:2,gap:GAP},grid:{}};
for(const rule of ['BASELINE','CAPITULATION'])for(const variant of ['IMMEDIATE','BOUNCE_CONFIRM'])for(const hours of [2,4,8]){const k=`${rule}_${variant}_${hours}H`;report.grid[k]={};for(const sc of ['base','stress','adverse']){report.grid[k][sc]={};for(const sp of ['discovery','validation','evaluation','july_holdout','all'])report.grid[k][sc][sp]=metrics(rows.filter(x=>x.rule===rule&&x.variant===variant&&x.hours===hours&&x.scenario===sc&&(sp==='all'||x.split===sp)))}}
// Selection uses discovery only. Require >=100 discovery trades, positive base+stress, then highest stress PF and mean.
const eligible=Object.entries(report.grid).filter(([k,v])=>v.base.discovery.trades>=100&&v.base.discovery.meanNet>0&&v.stress.discovery.meanNet>0).sort((a,b)=>(b[1].stress.discovery.pf??0)-(a[1].stress.discovery.pf??0)||b[1].stress.discovery.meanNet-a[1].stress.discovery.meanNet);
report.discoverySelected=eligible[0]?.[0]??null;const sel=report.discoverySelected?report.grid[report.discoverySelected]:null;report.decision=sel&&['validation','evaluation','july_holdout'].every(s=>(sel.base[s].meanNet??-1)>0)&&['validation','evaluation'].every(s=>(sel.stress[s].meanNet??-1)>0)?'CAPITULATION_REBOUND_SURVIVES':'NO_STABLE_CAPITULATION_REBOUND';
writeFileSync('/tmp/late-loser-capitulation-rebound.json',JSON.stringify(report,null,2));writeFileSync('/tmp/late-loser-capitulation-trades.json',JSON.stringify(rows));console.log(JSON.stringify({decision:report.decision,eventCount:report.eventCount,capitulationCount:report.capitulationCount,discoverySelected:report.discoverySelected,selected:sel},null,2));