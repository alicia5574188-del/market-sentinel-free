import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// Research-only market-neutral pair study. Each UTC day selects pair relations
// using only the PREVIOUS 7 days of completed 1h returns. Signals are 4h
// beta-neutral residual extremes; execution is on both legs at the next 5m open.
const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen causal universe missing');
const U=JSON.parse(mm[1]);
const HIST=Object.keys(U).filter(m=>m>='202508'&&m<='202608').sort();
const SEPT='202609', SEPT_SYMBOLS=U['202608'];
const H=3600, STEP=300, LOOKBACK=168;
const BASE=0.0014, STRESS=0.0022, SLIP=0.00025, ADV=0.00050;
const SEPT_START=Date.UTC(2026,8,1)/1000, SEPT_END=Date.UTC(2026,8,16)/1000;
const CACHE='/tmp/dynamic-pair-divergence';mkdirSync(CACHE,{recursive:true});
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f};
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const ms=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000;
const nx=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const exp=m=>(nx(m)-ms(m))/STEP;
const prevMonth=m=>{const d=new Date(Date.UTC(+m.slice(0,4),+m.slice(4,6)-2,1));return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`};
const nextMonth=m=>{const d=new Date(Date.UTC(+m.slice(0,4),+m.slice(4,6),1));return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`};
const split=m=>m<'202603'?'discovery':m<'202606'?'validation':'evaluation';
const sleep=x=>new Promise(r=>setTimeout(r,x));
async function fetchBuf(url){for(let a=0;a<5;a++){try{const r=await fetch(url);if(r.ok)return Buffer.from(await r.arrayBuffer());if(r.status===404)return null;if(r.status===429||r.status>=500){await sleep(350*(a+1));continue}return null}catch{await sleep(350*(a+1))}}return null}
async function archive5m(symbol,month){const p=`${CACHE}/${encodeURIComponent(symbol)}-${month}.gz`;let b=existsSync(p)?readFileSync(p):null;if(!b){b=await fetchBuf(`https://download.gatedata.org/futures_usdt/candlesticks_5m/${month}/${encodeURIComponent(symbol)}-${month}.csv.gz`);if(!b)return [];writeFileSync(p,b)}try{const rows=gunzipSync(b).toString('utf8').trim().split('\n').flatMap(line=>{const [time,volume,close,high,low,open]=line.split(',').map(Number);return time>0&&open>0&&low>0&&high>=low&&[open,high,low,close].every(Number.isFinite)?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time);return rows.length>=exp(month)*.45?rows:[]}catch{return []}}
async function fetchJson(url){for(let a=0;a<6;a++){try{const r=await fetch(url);if(r.ok)return await r.json();if(r.status===429||r.status>=500){await sleep(450*(a+1));continue}return []}catch{if(a===5)return [];await sleep(450*(a+1))}}return []}
function parseRest(a){if(!Array.isArray(a))return [];return a.flatMap(x=>{const time=Number(x.t??x[0]),open=Number(x.o??x[5]),high=Number(x.h??x[3]),low=Number(x.l??x[4]),close=Number(x.c??x[2]),volume=Number(x.v??x[1]??0);return time>0&&open>0&&low>0&&high>=low&&[open,high,low,close].every(Number.isFinite)?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time)}
async function sept5m(symbol){const out=[],chunk=2*86400,from0=SEPT_START-8*86400;for(let from=from0;from<SEPT_END;from+=chunk){const to=Math.min(SEPT_END-1,from+chunk-1),url=`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&from=${from}&to=${to}&interval=5m`;out.push(...parseRest(await fetchJson(url)))}return [...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time)}
function hourly(rows){const out=[];let b=null;for(const r of rows){const t=Math.floor(r.time/H)*H;if(!b||b.time!==t){if(b?.samples>=10)out.push(b);b={time:t,open:r.open,high:r.high,low:r.low,close:r.close,samples:1}}else{b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;b.samples++}}if(b?.samples>=10)out.push(b);return out}
function lb(rows,t){let l=0,h=rows.length;while(l<h){const q=(l+h)>>1;if(rows[q].time<t)l=q+1;else h=q}return l}
function corrBeta(x,y){if(x.length<150||y.length!==x.length)return null;const mx=mean(x),my=mean(y);let cov=0,vx=0,vy=0;for(let i=0;i<x.length;i++){const a=x[i]-mx,b=y[i]-my;cov+=a*b;vx+=a*a;vy+=b*b}if(vx<=0||vy<=0)return null;const corr=cov/Math.sqrt(vx*vy),beta=cov/vy;if(!Number.isFinite(corr)||!Number.isFinite(beta)||beta<0.25||beta>4)return null;const res=x.map((v,i)=>v-beta*y[i]),mr=mean(res),sd=Math.sqrt(res.reduce((s,v)=>s+(v-mr)**2,0)/Math.max(1,res.length-1));if(!Number.isFinite(sd)||sd<=1e-6)return null;return {corr,beta,sigma:sd}}

// Pre-fetch previous/current/next archive months needed for causal 7d context and cross-month exits.
const tasks=new Map();
for(const m of HIST)for(const s of U[m])for(const q of [prevMonth(m),m,nextMonth(m)])if(q<SEPT)tasks.set(`${q}|${s}`,{month:q,symbol:s});
const archiveRaw=new Map(),taskList=[...tasks.values()];let cursor=0;async function worker(){while(cursor<taskList.length){const x=taskList[cursor++];archiveRaw.set(`${x.month}|${x.symbol}`,await archive5m(x.symbol,x.month))}}
await Promise.all(Array.from({length:20},worker));
const septRaw=new Map();let sc=0;async function sw(){while(sc<SEPT_SYMBOLS.length){const s=SEPT_SYMBOLS[sc++];septRaw.set(s,await sept5m(s))}}await Promise.all(Array.from({length:6},sw));

function fiveSeries(month,symbol){if(month===SEPT){const aug=archiveRaw.get(`202608|${symbol}`)||[],sep=septRaw.get(symbol)||[];return [...aug,...sep].sort((a,b)=>a.time-b.time)}const a=archiveRaw.get(`${prevMonth(month)}|${symbol}`)||[],b=archiveRaw.get(`${month}|${symbol}`)||[],nm=nextMonth(month),c=nm===SEPT?(septRaw.get(symbol)||[]):(archiveRaw.get(`${nm}|${symbol}`)||[]);return [...a,...b,...c].sort((x,y)=>x.time-y.time)}
const hseries=new Map(),hmaps=new Map();
for(const m of HIST)for(const s of U[m]){const f=fiveSeries(m,s);if(f.length){const h=hourly(f);hseries.set(`${m}|${s}`,h);hmaps.set(`${m}|${s}`,new Map(h.map(r=>[r.time,r])))}}
for(const s of SEPT_SYMBOLS){const f=fiveSeries(SEPT,s);if(f.length){const h=hourly(f);hseries.set(`${SEPT}|${s}`,h);hmaps.set(`${SEPT}|${s}`,new Map(h.map(r=>[r.time,r])))}}
function retAt(map,t){const a=map.get(t),b=map.get(t-H);return a&&b?a.close/b.close-1:null}

function modelForDay(month,syms,dayStart){
  const active=syms.filter(s=>hmaps.has(`${month}|${s}`)),series={};
  for(const s of active){const p=hmaps.get(`${month}|${s}`),arr=[];for(let t=dayStart-LOOKBACK*H;t<=dayStart-H;t+=H){const r=retAt(p,t);arr.push(r)}series[s]=arr}
  const pairStats=new Map(),top=new Map();
  for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++){
    const a=active[i],b=active[j],xa=[],yb=[];for(let k=0;k<LOOKBACK;k++){const x=series[a][k],y=series[b][k];if(x!=null&&y!=null){xa.push(x);yb.push(y)}}
    const st=corrBeta(xa,yb);if(!st||st.corr<0.75)continue;const key=`${a}|${b}`;pairStats.set(key,{i:a,j:b,...st});
    for(const [s,o] of [[a,b],[b,a]]){const cur=top.get(s);if(!cur||st.corr>cur.corr)top.set(s,{other:o,corr:st.corr,key})}
  }
  const union=new Set([...top.values()].map(x=>x.key)),mutual=new Set();
  for(const [s,x] of top){const back=top.get(x.other);if(back?.other===s)mutual.add(x.key)}
  return {pairStats,union,mutual};
}
function pairResidual4(month,model,t){const pi=hmaps.get(`${month}|${model.i}`),pj=hmaps.get(`${month}|${model.j}`);if(!pi||!pj)return null;let sum=0;for(let k=0;k<4;k++){const ri=retAt(pi,t-k*H),rj=retAt(pj,t-k*H);if(ri==null||rj==null)return null;sum+=ri-model.beta*rj}return sum/(model.sigma*2)}

function buildCandidates(month,syms,start,end,sp,isSept=false){
  const out=[];
  for(let day=start;day<end;day+=86400){const model=modelForDay(month,syms,day);const e=Math.min(end,day+86400);for(let t=day;t<e-(isSept?5*H:0);t+=H){for(const key of model.union){const st=model.pairStats.get(key),z=pairResidual4(month,st,t);if(z==null)continue;out.push({month,split:sp,t,pair:key,i:st.i,j:st.j,corr:st.corr,beta:st.beta,sigma:st.sigma,z4:z,mutual:model.mutual.has(key)})}}}
  return out;
}
let histCand=[];for(const m of HIST)histCand.push(...buildCandidates(m,U[m],ms(m),nx(m),split(m),false));
const septCand=buildCandidates(SEPT,SEPT_SYMBOLS,SEPT_START,SEPT_END,'september_holdout',true);

function dedup(a){const out=[],last=new Map();for(const e of [...a].sort((x,y)=>x.t-y.t||x.pair.localeCompare(y.pair))){const p=last.get(e.pair)??-Infinity;if(e.t-p<4*H)continue;last.set(e.pair,e.t);out.push(e)}return out}
function tradePair(e,family,hold,scenario){
  const si=fiveSeries(e.month,e.i),sj=fiveSeries(e.month,e.j),entryTime=e.t+H,ii=lb(si,entryTime),ij=lb(sj,entryTime),xi=ii+hold*12-1,xj=ij+hold*12-1;if(si[ii]?.time!==entryTime||sj[ij]?.time!==entryTime||!si[xi]||!sj[xj])return null;
  for(let k=ii+1;k<=xi;k++)if(si[k].time!==si[k-1].time+STEP)return null;for(let k=ij+1;k<=xj;k++)if(sj[k].time!==sj[k-1].time+STEP)return null;
  const sign=Math.sign(e.z4);if(!sign)return null;const rev=family==='REV',di=rev?-sign:sign,dj=-di,friction=scenario==='stress'?STRESS:BASE,slip=scenario==='adverse'?ADV:SLIP;
  const ei=si[ii].open*(1+di*slip),ej=sj[ij].open*(1+dj*slip),ri=di*(si[xi].close-ei)/ei,rj=dj*(sj[xj].close-ej)/ej,ab=Math.abs(e.beta),wi=1/(1+ab),wj=ab/(1+ab),gross=wi*ri+wj*rj;
  return {...e,family,hold,scenario,di,dj,wi,wj,entryTime,exitTime:Math.max(si[xi].time,sj[xj].time)+STEP,net:gross-friction};
}
function metrics(a){if(!a.length)return {trades:0};const vals=a.map(x=>x.net).sort((x,y)=>x-y),sum=vals.reduce((s,x)=>s+x,0),g=vals.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-vals.filter(x=>x<=0).reduce((s,x)=>s+x,0),lo=quantile(vals,.05),hi=quantile(vals,.95),wins=vals.map(x=>Math.max(lo,Math.min(hi,x))),pairs={},symbols={};for(const x of a){pairs[x.pair]=(pairs[x.pair]||0)+x.net;symbols[x.i]=(symbols[x.i]||0)+x.net*x.wi;symbols[x.j]=(symbols[x.j]||0)+x.net*x.wj}const pos=Object.values(pairs).filter(x=>x>0).sort((a,b)=>b-a),months=[...new Set(a.map(x=>x.month))];return {trades:a.length,meanNet:sum/a.length,medianNet:median(vals),hit:a.filter(x=>x.net>0).length/a.length,pf:l?g/l:null,sumNet:sum,winsor5Mean:wins.reduce((s,x)=>s+x,0)/wins.length,activeMonths:months.length,positiveMonths:months.filter(m=>a.filter(x=>x.month===m).reduce((s,x)=>s+x.net,0)>0).length,pairs:Object.keys(pairs).length,symbols:Object.keys(symbols).length,topPositivePairShare:sum>0&&pos.length?pos[0]/sum:null}}
const histDays=HIST.reduce((s,m)=>s+(nx(m)-ms(m))/86400,0),septDays=(SEPT_END-SEPT_START)/86400;
const report={decision:'PENDING',rule:'daily causal 7d top-correlation pair graph; 4h beta-neutral residual z; next 5m two-leg execution',model:{lookbackHours:168,minCorrelation:0.75,betaRange:[0.25,4]},thresholds:[2,2.5],policies:['UNION','MUTUAL'],families:['REV','CONT'],holds:[2,4],costs:{base:BASE,stress:STRESS,slippage:SLIP,adverseSlippage:ADV},candidateCounts:{historical:histCand.length,september:septCand.length},grid:{},selection:{},accepted:[]};
const allCand=[...histCand,...septCand],trades=[];
for(const policy of ['UNION','MUTUAL'])for(const thr of [2,2.5])for(const family of ['REV','CONT'])for(const hold of [2,4]){
  const cfg=`${policy}_Z${thr}_${family}_${hold}H`,selected=dedup(allCand.filter(e=>(policy==='UNION'||e.mutual)&&Math.abs(e.z4)>=thr));
  for(const e of selected)for(const scn of ['base','stress','adverse']){const x=tradePair(e,family,hold,scn);if(x)trades.push({...x,cfg,policy,thr})}
  report.grid[cfg]={};for(const scn of ['base','stress','adverse'])for(const sp of ['discovery','validation','evaluation','september_holdout','all']){const a=trades.filter(x=>x.cfg===cfg&&x.scenario===scn&&(sp==='all'?x.split!=='september_holdout':x.split===sp));report.grid[cfg][scn]??={};const days=sp==='september_holdout'?septDays:sp==='all'?histDays:HIST.filter(m=>split(m)===sp).reduce((s,m)=>s+(nx(m)-ms(m))/86400,0);report.grid[cfg][scn][sp]={...metrics(a),tradesPerDay:a.length/days}}
}
function dq(x){const b=x.base.discovery,s=x.stress.discovery;return b.trades>=120&&b.meanNet>0&&s.meanNet>0&&b.medianNet>0&&b.winsor5Mean>0&&(s.pf??0)>1.08&&b.positiveMonths>=Math.max(4,Math.ceil(b.activeMonths*.55))&&(!b.topPositivePairShare||b.topPositivePairShare<=0.40)}
function core(x){for(const sp of ['validation','evaluation']){const b=x.base[sp],s=x.stress[sp];if(b.trades<40||b.meanNet<=0||s.meanNet<=0||b.winsor5Mean<=0||(s.pf??0)<=1)return false}return true}
function sept(x){const b=x.base.september_holdout,s=x.stress.september_holdout;return b.trades>=10&&b.meanNet>0&&s.meanNet>0&&b.winsor5Mean>0&&(s.pf??0)>1}
for(const family of ['REV','CONT']){const eligible=Object.keys(report.grid).filter(k=>k.includes(`_${family}_`)&&dq(report.grid[k])).sort((a,b)=>report.grid[b].stress.discovery.sumNet-report.grid[a].stress.discovery.sumNet||(report.grid[b].stress.discovery.pf??0)-(report.grid[a].stress.discovery.pf??0)),selected=eligible[0]??null;report.selection[family]={eligible,selected};if(selected){const x=report.grid[selected],cp=core(x),sp=sept(x);report.selection[family].corePass=cp;report.selection[family].septemberPass=sp;report.selection[family].validation=x.base.validation;report.selection[family].evaluation=x.base.evaluation;report.selection[family].september=x.base.september_holdout;if(cp&&sp)report.accepted.push({family,config:selected})}}
const acceptedBase=[];for(const a of report.accepted)acceptedBase.push(...trades.filter(x=>x.cfg===a.config&&x.scenario==='base'));
report.combined={historical:metrics(acceptedBase.filter(x=>x.split!=='september_holdout')),september:metrics(acceptedBase.filter(x=>x.split==='september_holdout'))};
report.decision=report.accepted.length?'DYNAMIC_PAIR_EDGE_FOUND':'NO_STABLE_DYNAMIC_PAIR_EDGE';
writeFileSync('/tmp/dynamic-pair-divergence.json',JSON.stringify(report,null,2));writeFileSync('/tmp/dynamic-pair-divergence-candidates.json',JSON.stringify(allCand));writeFileSync('/tmp/dynamic-pair-divergence-trades.json',JSON.stringify(trades));console.log(JSON.stringify({decision:report.decision,candidateCounts:report.candidateCounts,selection:report.selection,accepted:report.accepted,combined:report.combined},null,2));