import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen causal universe missing');
const U=JSON.parse(mm[1]);
const MONTHS=Object.keys(U).filter(m=>m>='202508'&&m<='202608').sort();
const STEP=300, LOOK=576, RET_BARS=6, HOLD_BARS=12, COOLDOWN=3600;
const SHOCK_MULT=3, VOL_MULT=2, MIN_ABS_MOVE=0.006;
const BASE=0.0014, STRESS=0.0022, SLIP=0.00025, ADV=0.00050;
const CACHE='/tmp/volume-shock-5m'; mkdirSync(CACHE,{recursive:true});
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f};
const ms=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000, nx=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const expected=m=>(nx(m)-ms(m))/STEP, split=m=>m<'202603'?'discovery':m<'202606'?'validation':'evaluation';
const sleep=x=>new Promise(r=>setTimeout(r,x));
async function fetchBuf(url){for(let a=0;a<5;a++){try{const r=await fetch(url);if(r.ok)return Buffer.from(await r.arrayBuffer());if(r.status===404)return null;if(r.status===429||r.status>=500){await sleep(400*(a+1));continue}return null}catch{await sleep(400*(a+1))}}return null}
async function five(symbol,month){
  const p=`${CACHE}/${encodeURIComponent(symbol)}-${month}.gz`;let b=existsSync(p)?readFileSync(p):null;
  if(!b){b=await fetchBuf(`https://download.gatedata.org/futures_usdt/candlesticks_5m/${month}/${encodeURIComponent(symbol)}-${month}.csv.gz`);if(!b)return [];writeFileSync(p,b)}
  try{const rows=gunzipSync(b).toString('utf8').trim().split('\n').flatMap(line=>{const [time,volume,close,high,low,open]=line.split(',').map(Number);return time>0&&open>0&&low>0&&high>=low&&close>0&&Number.isFinite(volume)?[{time,volume,close,high,low,open}]:[]}).sort((a,b)=>a.time-b.time);return rows.length>=expected(month)*.5?rows:[]}catch{return []}
}

const todo=[];for(const month of MONTHS)for(const symbol of U[month])todo.push({month,symbol});
let cursor=0;const raw=new Map();async function worker(){while(cursor<todo.length){const x=todo[cursor++];raw.set(`${x.month}|${x.symbol}`,await five(x.symbol,x.month))}}
await Promise.all(Array.from({length:16},worker));

const rawEvents=[];
for(const month of MONTHS){
  for(const symbol of U[month]){
    const rows=raw.get(`${month}|${symbol}`)||[];if(rows.length<LOOK+RET_BARS+HOLD_BARS+2)continue;
    const n=rows.length,r30=Array(n).fill(null),v30=Array(n).fill(null),absPref=Array(n+1).fill(0),absCnt=Array(n+1).fill(0),volPref=Array(n+1).fill(0),volCnt=Array(n+1).fill(0);
    let vol6=0;
    for(let i=0;i<n;i++){
      vol6+=rows[i].volume;if(i>=RET_BARS)vol6-=rows[i-RET_BARS].volume;
      if(i>=RET_BARS-1&&rows[i].time-rows[i-(RET_BARS-1)].time===(RET_BARS-1)*STEP)v30[i]=vol6;
      if(i>=RET_BARS&&rows[i].time-rows[i-RET_BARS].time===RET_BARS*STEP)r30[i]=rows[i].close/rows[i-RET_BARS].close-1;
      absPref[i+1]=absPref[i]+(r30[i]==null?0:Math.abs(r30[i]));absCnt[i+1]=absCnt[i]+(r30[i]==null?0:1);
      volPref[i+1]=volPref[i]+(v30[i]==null?0:v30[i]);volCnt[i+1]=volCnt[i]+(v30[i]==null?0:1);
    }
    for(let i=LOOK+RET_BARS;i<n-HOLD_BARS-1;i++){
      if(rows[i].time-rows[i-LOOK].time!==LOOK*STEP||r30[i]==null||v30[i]==null)continue;
      const a=i-LOOK,b=i,ac=absCnt[b]-absCnt[a],vc=volCnt[b]-volCnt[a];if(ac<LOOK*.95||vc<LOOK*.95)continue;
      const baseAbs=(absPref[b]-absPref[a])/ac,baseVol=(volPref[b]-volPref[a])/vc;if(!(baseAbs>0&&baseVol>0))continue;
      const ret=r30[i],absMove=Math.abs(ret),shock=absMove/baseAbs,volRatio=v30[i]/baseVol;if(absMove<MIN_ABS_MOVE||shock<SHOCK_MULT||volRatio<VOL_MULT)continue;
      const dir=ret>0?1:-1,window=rows.slice(i-(RET_BARS-1),i+1),hi=Math.max(...window.map(x=>x.high)),lo=Math.min(...window.map(x=>x.low)),range=hi-lo;if(!(range>0))continue;
      const loc=(rows[i].close-lo)/range,strongLoc=dir>0?loc:1-loc,last5=rows[i].close/rows[i].open-1,last5Dir=dir*last5;
      let anatomy=null,tradeDir=null;
      if(strongLoc>=0.80&&last5Dir>0){anatomy='DRIVE';tradeDir=dir}
      else if(strongLoc<=0.40&&last5Dir<0){anatomy='REJECT';tradeDir=-dir}
      else continue;
      const entryIdx=i+1,exitIdx=entryIdx+HOLD_BARS-1;if(!rows[exitIdx]||rows[entryIdx].time!==rows[i].time+STEP)continue;
      let ok=true;for(let j=entryIdx+1;j<=exitIdx;j++)if(rows[j].time!==rows[j-1].time+STEP){ok=false;break}if(!ok)continue;
      const entryBase=rows[entryIdx].open*(1+tradeDir*SLIP),entryAdv=rows[entryIdx].open*(1+tradeDir*ADV),exit=rows[exitIdx].close,grossBase=tradeDir*(exit-entryBase)/entryBase,grossAdv=tradeDir*(exit-entryAdv)/entryAdv;
      rawEvents.push({month,split:split(month),symbol,signalTime:rows[i].time,entryTime:rows[entryIdx].time,exitTime:rows[exitIdx].time+STEP,shock,volRatio,absMove,strongLoc,last5Dir,shockDir:dir>0?'UP':'DOWN',anatomy,tradeDir,baseNet:grossBase-BASE,stressNet:grossBase-STRESS,adverseNet:grossAdv-BASE});
    }
  }
}

const CONFIGS=['DRIVE_UP','DRIVE_DOWN','REJECT_UP','REJECT_DOWN'];
function configOf(e){return `${e.anatomy}_${e.shockDir}`}
function dedup(a){const out=[],last=new Map();for(const e of [...a].sort((x,y)=>x.signalTime-y.signalTime)){const p=last.get(e.symbol)??-Infinity;if(e.signalTime-p<COOLDOWN)continue;last.set(e.symbol,e.signalTime);out.push(e)}return out}
function metrics(a,field){if(!a.length)return {trades:0};const vals=a.map(x=>x[field]).sort((x,y)=>x-y),sum=vals.reduce((s,x)=>s+x,0),g=vals.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-vals.filter(x=>x<=0).reduce((s,x)=>s+x,0),lo=quantile(vals,.05),hi=quantile(vals,.95),wins=vals.map(x=>Math.max(lo,Math.min(hi,x))),months=[...new Set(a.map(x=>x.month))].sort(),monthly=Object.fromEntries(months.map(m=>{const z=a.filter(x=>x.month===m),v=z.reduce((s,x)=>s+x[field],0);return [m,{trades:z.length,mean:v/z.length,sum:v}]}));return {trades:a.length,meanNet:sum/a.length,medianNet:median(vals),hit:a.filter(x=>x[field]>0).length/a.length,pf:l?g/l:null,sumNet:sum,winsor5Mean:wins.reduce((s,x)=>s+x,0)/wins.length,activeMonths:months.length,positiveMonths:Object.values(monthly).filter(x=>x.sum>0).length,monthly,meanShock:a.reduce((s,x)=>s+x.shock,0)/a.length,meanVolRatio:a.reduce((s,x)=>s+x.volRatio,0)/a.length}}
const days={discovery:212,validation:92,evaluation:92,all:396};
const report={decision:'PENDING',rule:{lookbackHours:48,returnWindowMinutes:30,minAbsMove:MIN_ABS_MOVE,shockMultiple:SHOCK_MULT,volumeMultiple:VOL_MULT,driveCloseLocation:0.80,rejectCloseLocation:0.40,holdMinutes:60,cooldownMinutes:60},costs:{base:BASE,stress:STRESS,entrySlippage:SLIP,adverseEntrySlippage:ADV},rawEvents:rawEvents.length,configs:{},accepted:[],combined:null};
for(const cfg of CONFIGS){report.configs[cfg]={};for(const sp of ['discovery','validation','evaluation','all']){const a=dedup(rawEvents.filter(e=>configOf(e)===cfg&&(sp==='all'||e.split===sp)));report.configs[cfg][sp]={base:metrics(a,'baseNet'),stress:metrics(a,'stressNet'),adverse:metrics(a,'adverseNet'),tradesPerDay:a.length/days[sp]}}}
function discoveryPass(x){const q=x.discovery;return q.base.trades>=120&&q.stress.meanNet>0&&q.stress.medianNet>0&&q.stress.winsor5Mean>0&&(q.stress.pf??0)>1.10&&q.stress.positiveMonths>=5;}
function holdoutPass(x){for(const sp of ['validation','evaluation']){const q=x[sp];if(q.base.trades<40||q.stress.meanNet<=0||q.stress.winsor5Mean<=0||(q.stress.pf??0)<=1.03||q.base.positiveMonths<2)return false}return true;}
for(const cfg of CONFIGS){report.configs[cfg].discoveryQualified=discoveryPass(report.configs[cfg]);report.configs[cfg].holdoutPass=report.configs[cfg].discoveryQualified&&holdoutPass(report.configs[cfg]);if(report.configs[cfg].holdoutPass)report.accepted.push(cfg)}
const selected=dedup(rawEvents.filter(e=>report.accepted.includes(configOf(e))));report.combined={};for(const sp of ['discovery','validation','evaluation','all']){const a=selected.filter(e=>sp==='all'||e.split===sp);report.combined[sp]={base:metrics(a,'baseNet'),stress:metrics(a,'stressNet'),adverse:metrics(a,'adverseNet'),tradesPerDay:a.length/days[sp]}}
report.decision=report.accepted.length?'VOLUME_SHOCK_EDGE_FOUND':'NO_STABLE_VOLUME_SHOCK_EDGE';
writeFileSync('/tmp/volume-shock-anatomy.json',JSON.stringify(report,null,2));writeFileSync('/tmp/volume-shock-events.json',JSON.stringify(rawEvents));console.log(JSON.stringify({decision:report.decision,rawEvents:report.rawEvents,accepted:report.accepted,configs:Object.fromEntries(CONFIGS.map(c=>[c,{qualified:report.configs[c].discoveryQualified,holdout:report.configs[c].holdoutPass,discovery:report.configs[c].discovery,validation:report.configs[c].validation,evaluation:report.configs[c].evaluation}])),combined:report.combined},null,2));