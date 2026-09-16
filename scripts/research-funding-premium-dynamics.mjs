import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// Research-only mechanism audit using Gate official funding_updates archives.
// This studies perpetual-specific crowding dynamics, not production strategy logic.
// Signal data: indicative next funding + mark/index premium + impact bid/ask diffs.
// Entry proxy: completed 5m mark snapshot; PnL includes any actually-applied funding
// crossed during the 30m/1h/2h holding window. A separate 5m execution audit is
// required if and only if a mechanism survives all time splits.
const CORE=['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','BNB_USDT','DOGE_USDT','ADA_USDT','LINK_USDT','LTC_USDT','AVAX_USDT','BCH_USDT'];
const MONTHS=['202508','202509','202510','202511','202512','202601','202602','202603','202604','202605','202606','202607','202608'];
const STEP=300, BASE=0.0014, STRESS=0.0022, ADVERSE=0.00025, COOLDOWN=3600;
const CACHE='/tmp/funding-premium-dynamics';mkdirSync(CACHE,{recursive:true});
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f};
const ms=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000;
const nx=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const split=m=>m<='202601'?'discovery':m<='202604'?'validation':m<='202607'?'evaluation':'holdout';
const splitDays=sp=>MONTHS.filter(m=>split(m)===sp).reduce((s,m)=>s+(nx(m)-ms(m))/86400,0);
const sleep=x=>new Promise(r=>setTimeout(r,x));
async function fetchBuf(url){for(let a=0;a<5;a++){try{const r=await fetch(url);if(r.ok)return Buffer.from(await r.arrayBuffer());if(r.status===404)return null;if(r.status===429||r.status>=500){await sleep(300*(a+1));continue}return null}catch{await sleep(300*(a+1))}}return null}
async function gz(symbol,month,type){const p=`${CACHE}/${type}-${encodeURIComponent(symbol)}-${month}.gz`;let b=existsSync(p)?readFileSync(p):null;if(!b){b=await fetchBuf(`https://download.gatedata.org/futures_usdt/${type}/${month}/${encodeURIComponent(symbol)}-${month}.csv.gz`);if(!b)return null;writeFileSync(p,b)}return b}
function parseUpdates(b){if(!b)return [];try{return gunzipSync(b).toString('utf8').trim().split('\n').flatMap(line=>{const v=line.split(',').map(Number);if(v.length<8)return [];const [time,funding,interest,bidDiff,askDiff,mark,index,updateCount]=v;if(!(time>0&&mark>0&&index>0&&[funding,bidDiff,askDiff,mark,index].every(Number.isFinite)))return [];return [{time,funding,interest,bidDiff,askDiff,mark,index,updateCount,premium:(mark-index)/index,impact:(Math.abs(bidDiff)+Math.abs(askDiff))/index}]}).sort((a,b)=>a.time-b.time)}catch{return []}}
function parseApplies(b){if(!b)return [];try{return gunzipSync(b).toString('utf8').trim().split('\n').flatMap(line=>{const [time,rate]=line.split(',').map(Number);return time>0&&Number.isFinite(rate)?[{time,rate}]:[]}).sort((a,b)=>a.time-b.time)}catch{return []}}
function fiveSnapshots(rows){const map=new Map();for(const r of rows){const end=Math.floor(r.time/STEP)*STEP+STEP;const cur=map.get(end);if(!cur||r.time>cur.time)map.set(end,r)}return map}
function appliedFunding(applies,entry,exit,dir){let pnl=0;for(const x of applies)if(x.time>entry&&x.time<=exit)pnl+=-dir*x.rate;return pnl}

const allTrades=[],availability={};
for(const month of MONTHS){
  const raw=new Map(),apps=new Map();let c=0;const tasks=CORE.map(symbol=>({symbol}));
  async function worker(){while(c<tasks.length){const {symbol}=tasks[c++];const [u,a]=await Promise.all([gz(symbol,month,'funding_updates'),gz(symbol,month,'funding_applies')]);raw.set(symbol,fiveSnapshots(parseUpdates(u)));apps.set(symbol,parseApplies(a))}}
  await Promise.all(Array.from({length:11},worker));
  const active=CORE.filter(s=>(raw.get(s)?.size||0)>1000),start=ms(month)+1800,end=nx(month)-7200,sp=split(month);
  availability[month]={activeSymbols:active.length,snapshots:Object.fromEntries(active.map(s=>[s,raw.get(s).size])),applies:Object.fromEntries(active.map(s=>[s,apps.get(s).length]))};
  const candidates=[];
  for(let t=start;t<end;t+=STEP){
    const obs=[];
    for(const symbol of active){const now=raw.get(symbol).get(t),prev=raw.get(symbol).get(t-1800);if(!now||!prev)continue;obs.push({symbol,now,prev,premium:now.premium,funding:now.funding,dp:now.premium-prev.premium,df:now.funding-prev.funding,impact:now.impact})}
    if(obs.length<7)continue;
    const medP=median(obs.map(x=>x.premium)),madP=median(obs.map(x=>Math.abs(x.premium-medP)))||1e-12,scaleP=1.4826*madP,impact75=quantile(obs.map(x=>x.impact),.75);
    for(const x of obs){const z=(x.premium-medP)/scaleP,dir=Math.sign(z);if(!dir||Math.abs(z)<2)continue;const align=Math.sign(x.funding)===dir,accel=dir*x.dp>0&&dir*x.df>=0,decel=dir*x.dp<0&&dir*x.df<=0,stress=x.impact>=impact75;if(!align)continue;
      const states=['BASE'];if(accel)states.push('ACCEL');if(decel)states.push('DECEL');if(accel&&stress)states.push('ACCEL_STRESS');if(decel&&stress)states.push('DECEL_STRESS');
      for(const state of states)candidates.push({month,split:sp,t,symbol,state,dir,zPremium:z,premium:x.premium,funding:x.funding,deltaPremium30:x.dp,deltaFunding30:x.df,impact:x.impact,impact75,mark:x.now.mark,index:x.now.index});
    }
  }
  const familyFor={BASE:['CONT','REV'],ACCEL:['CONT'],DECEL:['REV'],ACCEL_STRESS:['CONT'],DECEL_STRESS:['REV']};
  for(const state of Object.keys(familyFor))for(const family of familyFor[state])for(const holdMin of [30,60,120]){
    const selected=[];const last=new Map();for(const e of candidates.filter(x=>x.state===state).sort((a,b)=>a.t-b.t)){const p=last.get(e.symbol)??-Infinity;if(e.t-p<COOLDOWN)continue;last.set(e.symbol,e.t);selected.push(e)}
    for(const e of selected){const exitT=e.t+holdMin*60,exit=raw.get(e.symbol).get(exitT);if(!exit)continue;const tradeDir=family==='CONT'?e.dir:-e.dir,priceGross=tradeDir*(exit.mark-e.mark)/e.mark,fundPnl=appliedFunding(apps.get(e.symbol),e.t,exitT,tradeDir),gross=priceGross+fundPnl;
      for(const scenario of ['base','stress','adverse']){const cost=scenario==='stress'?STRESS:BASE,extra=scenario==='adverse'?ADVERSE:0;allTrades.push({...e,family,holdMin,scenario,tradeDir,exitT,exitMark:exit.mark,priceGross,fundingPnl:fundPnl,gross,net:gross-cost-extra})}
    }
  }
}
function metrics(a){if(!a.length)return {trades:0};const vals=a.map(x=>x.net).sort((x,y)=>x-y),sum=vals.reduce((s,x)=>s+x,0),g=vals.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-vals.filter(x=>x<=0).reduce((s,x)=>s+x,0),lo=quantile(vals,.05),hi=quantile(vals,.95),wins=vals.map(x=>Math.max(lo,Math.min(hi,x))),sym={};for(const x of a)sym[x.symbol]=(sym[x.symbol]||0)+x.net;const pos=Object.values(sym).filter(x=>x>0).sort((a,b)=>b-a),months=[...new Set(a.map(x=>x.month))];return {trades:a.length,meanNet:sum/a.length,medianNet:median(vals),hit:a.filter(x=>x.net>0).length/a.length,pf:l?g/l:null,sumNet:sum,winsor5Mean:wins.reduce((s,x)=>s+x,0)/wins.length,meanPriceGross:a.reduce((s,x)=>s+x.priceGross,0)/a.length,meanFundingPnl:a.reduce((s,x)=>s+x.fundingPnl,0)/a.length,activeMonths:months.length,positiveMonths:months.filter(m=>a.filter(x=>x.month===m).reduce((s,x)=>s+x.net,0)>0).length,symbols:Object.keys(sym).length,topPositiveSymbolShare:sum>0&&pos.length?pos[0]/sum:null}}
const configs=[];for(const state of ['BASE','ACCEL','DECEL','ACCEL_STRESS','DECEL_STRESS'])for(const family of ({BASE:['CONT','REV'],ACCEL:['CONT'],DECEL:['REV'],ACCEL_STRESS:['CONT'],DECEL_STRESS:['REV']})[state])for(const holdMin of [30,60,120])configs.push(`${state}_${family}_${holdMin}M`);
const report={decision:'PENDING',dataSource:'Gate official futures_usdt funding_updates + funding_applies monthly archives',core:CORE,availability,rule:'completed 5m funding-update snapshot; premium robust-z >=2 and funding sign aligned; 30m premium/funding acceleration routes continuation, deceleration routes reversal; 1h same-symbol dedup; mark-to-mark event study plus actually applied funding',costs:{base:BASE,stress:STRESS,adverseExtra:ADVERSE},splits:{discovery:'202508-202601',validation:'202602-202604',evaluation:'202605-202607',holdout:'202608'},grid:{},selection:{CONT:{},REV:{}},accepted:[]};
for(const cfg of configs){const [state,family,holdRaw]=cfg.split('_').length===3?cfg.split('_'):[cfg.split('_').slice(0,-2).join('_'),cfg.split('_').at(-2),cfg.split('_').at(-1)];const holdMin=+holdRaw.replace('M','');report.grid[cfg]={};for(const scenario of ['base','stress','adverse'])for(const sp of ['discovery','validation','evaluation','holdout','all']){const a=allTrades.filter(x=>x.state===state&&x.family===family&&x.holdMin===holdMin&&x.scenario===scenario&&(sp==='all'?x.split!=='holdout':x.split===sp));report.grid[cfg][scenario]??={};const days=sp==='all'?MONTHS.filter(m=>split(m)!=='holdout').reduce((s,m)=>s+(nx(m)-ms(m))/86400,0):splitDays(sp);report.grid[cfg][scenario][sp]={...metrics(a),tradesPerDay:days?a.length/days:0}}}
function dq(x){const b=x.base.discovery,s=x.stress.discovery;return b.trades>=120&&b.meanNet>0&&s.meanNet>0&&b.medianNet>0&&b.winsor5Mean>0&&(s.pf??0)>1.05&&b.positiveMonths>=4&&(!b.topPositiveSymbolShare||b.topPositiveSymbolShare<=0.55)}
function corePass(x){for(const sp of ['validation','evaluation']){const b=x.base[sp],s=x.stress[sp];if(b.trades<40||b.meanNet<=0||s.meanNet<=0||b.winsor5Mean<=0||(s.pf??0)<=1)return false}return true}
function holdPass(x){const b=x.base.holdout,s=x.stress.holdout;return b.trades>=15&&b.meanNet>0&&s.meanNet>0&&b.winsor5Mean>0&&(s.pf??0)>1}
for(const family of ['CONT','REV']){const eligible=configs.filter(k=>k.includes(`_${family}_`)&&dq(report.grid[k])).sort((a,b)=>report.grid[b].stress.discovery.sumNet-report.grid[a].stress.discovery.sumNet||(report.grid[b].stress.discovery.pf??0)-(report.grid[a].stress.discovery.pf??0)),selected=eligible[0]??null;report.selection[family]={eligible,selected};if(selected){const x=report.grid[selected],cp=corePass(x),hp=holdPass(x);report.selection[family].corePass=cp;report.selection[family].holdoutPass=hp;report.selection[family].validation=x.base.validation;report.selection[family].evaluation=x.base.evaluation;report.selection[family].holdout=x.base.holdout;if(cp&&hp)report.accepted.push({family,config:selected})}}
report.decision=report.accepted.length?'FUNDING_PREMIUM_DYNAMICS_FOUND':'NO_STABLE_FUNDING_PREMIUM_DYNAMICS';
writeFileSync('/tmp/funding-premium-dynamics.json',JSON.stringify(report,null,2));writeFileSync('/tmp/funding-premium-dynamics-trades.json',JSON.stringify(allTrades));console.log(JSON.stringify({decision:report.decision,availability:report.availability,selection:report.selection,accepted:report.accepted},null,2));