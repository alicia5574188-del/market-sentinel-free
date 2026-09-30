import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen universe missing');
const U=JSON.parse(mm[1]), MONTHS=Object.keys(U).sort();
const H=3600, GAP=0.019636820810880196;
const BASE=0.0014, STRESS=0.0022, SLIP=0.00025, ADV=0.00050;
const CACHE='/tmp/cap-state-5m'; mkdirSync(CACHE,{recursive:true});
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f};
const ms=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000, nx=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const exp=m=>(nx(m)-ms(m))/300;
const split=m=>m==='202507'?'july_holdout':m<'202603'?'discovery':m<'202606'?'validation':'evaluation';
const sleep=x=>new Promise(r=>setTimeout(r,x));
async function fetchBuf(url){for(let a=0;a<5;a++){try{const r=await fetch(url);if(r.ok)return Buffer.from(await r.arrayBuffer());if(r.status===404)return null;if(r.status===429||r.status>=500){await sleep(400*(a+1));continue}return null}catch{await sleep(400*(a+1))}}return null}
async function five(symbol,month){const p=`${CACHE}/${encodeURIComponent(symbol)}-${month}.gz`;let b=existsSync(p)?readFileSync(p):null;if(!b){b=await fetchBuf(`https://download.gatedata.org/futures_usdt/candlesticks_5m/${month}/${encodeURIComponent(symbol)}-${month}.csv.gz`);if(!b)return [];writeFileSync(p,b)}try{const rows=gunzipSync(b).toString('utf8').trim().split('\n').flatMap(line=>{const [time,volume,close,high,low,open]=line.split(',').map(Number);return time>0&&open>0&&low>0&&high>=low?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time);return rows.length>=exp(month)*.5?rows:[]}catch{return []}}
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
    const hour=new Date(t*1000).getUTCHours(); if(hour<16||hour>23) continue;
    const obs=[];
    for(const symbol of syms){
      const p=maps.get(symbol),c=p.get(t),p1=p.get(t-H),p2=p.get(t-2*H),p4=p.get(t-4*H);
      if(!c||!p1||!p2||!p4)continue;
      obs.push({symbol,r1:c.close/p1.close-1,prev1:p1.close/p2.close-1,r4:c.close/p4.close-1});
    }
    if(obs.length<Math.max(12,Math.ceil(syms.length*.6)))continue;
    const marketR1=median(obs.map(x=>x.r1)), marketPrev1=median(obs.map(x=>x.prev1)), marketR4=median(obs.map(x=>x.r4));
    const breadthDown1=obs.filter(x=>x.r1<0).length/obs.length, breadthDown4=obs.filter(x=>x.r4<0).length/obs.length;
    const mad4=median(obs.map(x=>Math.abs(x.r4-marketR4)))||1e-9, scale=1.4826*mad4;
    for(const x of obs){x.rel4=x.r4-marketR4;x.z4=x.rel4/scale}
    const srt=[...obs].sort((a,b)=>a.rel4-b.rel4),x=srt[0],second=srt[1];
    const z=-x.z4,gap=second.rel4-x.rel4,q75=quantile(obs.map(o=>-o.r1),.75),persistence=(-x.r1)>0&&(-x.r1)>=q75;
    if(z<2||gap<GAP||!persistence)continue;
    candidates.push({month,split:split(month),t,hour,symbol:x.symbol,z4:z,gap4:gap,gapSigma:gap/scale,r1:x.r1,prev1:x.prev1,marketR1,marketPrev1,marketR4,breadthDown1,breadthDown4,dispersion4:scale});
  }
}
candidates.sort((a,b)=>a.t-b.t);const last=new Map(),events=[];
for(const e of candidates){const lastT=last.get(e.symbol)??-Infinity;if(e.t-lastT<4*H)continue;last.set(e.symbol,e.t);events.push(e)}

const STATES={
  ALL:e=>true,
  NOT_BROAD_ACCEL:e=>!(e.breadthDown1>=2/3&&e.marketR1<0&&e.marketR1<e.marketPrev1),
  IDIO_CALM:e=>e.breadthDown1<2/3&&e.marketR1>-0.005,
  IDIO_GAP:e=>e.gapSigma>=1,
  MARKET_DECEL:e=>e.marketR1<0&&e.marketR1>e.marketPrev1,
  MARKET_NONNEG:e=>e.marketR1>=0,
  BREADTH_MIXED:e=>e.breadthDown1<2/3,
  MARKET_RECOVERING:e=>e.marketR1>e.marketPrev1,
  BROAD_ACCEL:e=>e.breadthDown1>=2/3&&e.marketR1<0&&e.marketR1<e.marketPrev1,
  BROAD_DOWN:e=>e.breadthDown1>=2/3
};
const SELECTABLE=['NOT_BROAD_ACCEL','IDIO_CALM','IDIO_GAP','MARKET_DECEL','MARKET_NONNEG','BREADTH_MIXED','MARKET_RECOVERING'];

function makeTrade(e,friction,slip){const rows=raw.get(`${e.month}|${e.symbol}`)||[],entryTime=e.t+H,bi=lb(rows,entryTime),xi=bi+23;if(rows[bi]?.time!==entryTime||!rows[xi])return null;for(let i=bi+1;i<=xi;i++)if(rows[i].time!==rows[i-1].time+300)return null;const entry=rows[bi].open*(1+slip),exit=rows[xi].close,gross=(exit-entry)/entry;return {...e,entryTime,exitTime:rows[xi].time+300,gross,net:gross-friction}}
const trades=[];for(const e of events)for(const scenario of ['base','stress','adverse']){const friction=scenario==='stress'?STRESS:BASE,slip=scenario==='adverse'?ADV:SLIP,xx=makeTrade(e,friction,slip);if(xx)trades.push({...xx,scenario})}
function metrics(a){if(!a.length)return {trades:0};const vals=a.map(x=>x.net).sort((x,y)=>x-y),sum=vals.reduce((s,x)=>s+x,0),g=vals.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-vals.filter(x=>x<=0).reduce((s,x)=>s+x,0),lo=quantile(vals,.05),hi=quantile(vals,.95),win=vals.map(x=>Math.max(lo,Math.min(hi,x))),months=[...new Set(a.map(x=>x.month))].sort();const monthly=Object.fromEntries(months.map(m=>{const z=a.filter(x=>x.month===m),v=z.reduce((s,x)=>s+x.net,0);return [m,{trades:z.length,mean:v/z.length,sum:v}]}));return {trades:a.length,meanNet:sum/a.length,medianNet:median(vals),hit:a.filter(x=>x.net>0).length/a.length,pf:l?g/l:null,sumNet:sum,winsor5Mean:win.reduce((s,x)=>s+x,0)/win.length,activeMonths:months.length,positiveMonths:Object.values(monthly).filter(x=>x.sum>0).length,monthly}}
const days=MONTHS.reduce((s,m)=>s+(nx(m)-ms(m))/86400,0);
const report={decision:'PENDING',rule:'bottom1 capitulation, UTC16-23, z>=2, frozen adjacent gap>=1.963682%, current 1h decline in worst quartile, next 5m open, hold 2h',events:events.length,days,stateDefinitions:Object.keys(STATES),states:{}};
for(const [state,fn] of Object.entries(STATES)){report.states[state]={};for(const sc of ['base','stress','adverse']){report.states[state][sc]={};for(const sp of ['discovery','validation','evaluation','july_holdout','all']){const a=trades.filter(x=>x.scenario===sc&&(sp==='all'||x.split===sp)&&fn(x));report.states[state][sc][sp]={...metrics(a),tradesPerDay:a.length/days}}}}
function discoveryQualified(state){const x=report.states[state];return x.base.discovery.trades>=80&&x.base.discovery.meanNet>0&&x.stress.discovery.meanNet>0&&x.base.discovery.medianNet>0&&x.base.discovery.winsor5Mean>0&&x.base.discovery.positiveMonths>=Math.max(4,Math.ceil(x.base.discovery.activeMonths*.6));}
const shortlist=SELECTABLE.filter(discoveryQualified).sort((a,b)=>(report.states[b].stress.discovery.pf??0)-(report.states[a].stress.discovery.pf??0)||report.states[b].stress.discovery.winsor5Mean-report.states[a].stress.discovery.winsor5Mean).slice(0,2);
report.discoveryShortlist=shortlist;
report.gates=shortlist.map(state=>{const x=report.states[state];const val=x.base.validation.trades>=30&&x.base.validation.meanNet>0&&x.stress.validation.meanNet>0&&x.base.validation.winsor5Mean>0;const eva=x.base.evaluation.trades>=30&&x.base.evaluation.meanNet>0&&x.stress.evaluation.meanNet>0&&x.base.evaluation.winsor5Mean>0;const j=x.base.july_holdout.trades<5?null:x.base.july_holdout.meanNet>0;return {state,validationPass:val,evaluationPass:eva,julyPass:j,validation:x.base.validation,evaluation:x.base.evaluation,july:x.base.july_holdout};});
report.accepted=report.gates.filter(x=>x.validationPass&&x.evaluationPass&&x.julyPass!==false).map(x=>x.state);
report.decision=report.accepted.length?'MARKET_STATE_ROUTER_FOUND':'NO_STABLE_MARKET_STATE_ROUTER';
writeFileSync('/tmp/capitulation-market-state-router.json',JSON.stringify(report,null,2));
writeFileSync('/tmp/capitulation-market-state-events.json',JSON.stringify(events));
writeFileSync('/tmp/capitulation-market-state-trades.json',JSON.stringify(trades));
console.log(JSON.stringify({decision:report.decision,events:report.events,discoveryShortlist:report.discoveryShortlist,accepted:report.accepted,gates:report.gates,baseline:{base:report.states.ALL.base,stress:report.states.ALL.stress},negativeControls:{BROAD_ACCEL:report.states.BROAD_ACCEL.base,BROAD_DOWN:report.states.BROAD_DOWN.base}},null,2));