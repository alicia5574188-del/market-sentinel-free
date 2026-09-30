import { readFileSync, writeFileSync } from 'node:fs';

const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen monthly universe missing');
const U=JSON.parse(mm[1]);
const TEST=['202601','202602','202603','202604','202605','202606','202607','202608','202609'];
const ALL=[...Object.keys(U).sort(),'202609'];
const H=3600,DAY=86400,WARM=96*H,ENTRY_BUDGET=2.5,PAIR_GROSS=.125,MAX_GROSS=1.5;
const BASE_COST=.00165,STRESS_COST=.00270;
const FEATURES=['R4','R12','R24','COMBO'];
const DIRECTIONS=[1,-1];
const HOLDS=[1,2,4];
const KS=[1,2,3];
const SPREADS=[0,.75,1.25];
const now=Math.floor(Date.now()/1000/H)*H;
const monthStart=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000;
const nextMonth=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const prior2=m=>{const i=ALL.indexOf(m);return ALL.slice(Math.max(0,i-2),i);};
const universe=m=>[...new Set((m==='202609'?U['202608']:U[m])??[])].filter(s=>s!=='ZEC_USDT');
const n=x=>{const v=Number(x);return Number.isFinite(v)?v:null;};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const med=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),i=Math.floor(b.length/2);return b.length%2?b[i]:(b[i-1]+b[i])/2;};
const mad=a=>{if(a.length<3)return 1e-9;const m=med(a);return Math.max(1.4826*med(a.map(x=>Math.abs(x-m))),1e-9);};
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const sd=a=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
const utcDay=t=>new Date(t*1000).toISOString().slice(0,10);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url,attempts=6){for(let a=0;a<attempts;a++){try{const r=await fetch(url);if(r.ok)return await r.json();if(r.status!==429&&r.status<500)throw new Error(`${r.status} ${url}`);}catch(e){if(a===attempts-1)throw e;}await sleep(350*(a+1));}}
function parse(a){if(!Array.isArray(a))return[];return a.flatMap(x=>{const t=n(x.t??x[0]),o=n(x.o??x[5]),h=n(x.h??x[3]),l=n(x.l??x[4]),c=n(x.c??x[2]),v=n(x.v??x[1])??0;return t>0&&o>0&&c>0&&h>=l&&l>0?[{t,o,h,l,c,v}]:[]}).sort((a,b)=>a.t-b.t);}

const needed=[...new Set(TEST.flatMap(m=>[m,...prior2(m)]))].sort();
const tasks=[];for(const m of needed)for(const s of universe(m))tasks.push({m,s});
const raw=new Map();let cursor=0;
async function worker(){while(cursor<tasks.length){const {m,s}=tasks[cursor++],from=monthStart(m)-WARM,to=Math.min(nextMonth(m)+6*H,now);try{const a=await get(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(s)}&from=${from}&to=${to-1}&interval=1h`);raw.set(`${m}|${s}`,[...new Map(parse(a).map(r=>[r.t,r])).values()]);}catch(e){console.error('FETCH_FAIL',m,s,String(e));raw.set(`${m}|${s}`,[]);}}}
await Promise.all(Array.from({length:10},worker));

function beta(xs,ys){if(xs.length<36||ys.length!==xs.length)return 1;const mx=mean(xs),my=mean(ys);let cov=0,v=0;for(let i=0;i<xs.length;i++){cov+=(xs[i]-mx)*(ys[i]-my);v+=(ys[i]-my)**2;}return v>1e-12?clamp(cov/v,.15,3):1;}
function buildMonth(m){
  const syms=universe(m),start=monthStart(m),end=Math.min(nextMonth(m),now),maps=new Map(),retMaps=new Map(),times=new Set();
  for(const s of syms){const rows=raw.get(`${m}|${s}`)??[];if(rows.length<100)continue;const pm=new Map(rows.map(r=>[r.t,r]));maps.set(s,pm);const rm=new Map();for(const r of rows){const p=pm.get(r.t-H);if(p)rm.set(r.t,r.c/p.c-1);if(r.t>=start-WARM&&r.t<end)times.add(r.t);}retMaps.set(s,rm);}
  const active=[...maps.keys()],marketRet=new Map();
  for(const t of [...times].sort((a,b)=>a-b)){const rs=active.map(s=>retMaps.get(s)?.get(t)).filter(Number.isFinite);if(rs.length>=Math.max(10,Math.ceil(active.length*.45)))marketRet.set(t,med(rs));}
  const snapshots=[];
  for(let t=start;t<end-4*H;t+=H){
    const mh=[];for(let j=71;j>=0;j--){const r=marketRet.get(t-j*H);if(Number.isFinite(r))mh.push({t:t-j*H,r});}
    if(mh.length<60)continue;
    const items=[];
    for(const s of active){const pm=maps.get(s),rm=retMaps.get(s),cur=pm.get(t),p4=pm.get(t-4*H),p12=pm.get(t-12*H),p24=pm.get(t-24*H),entry=pm.get(t+H);if(!cur||!p4||!p12||!p24||!entry)continue;const xs=[],ys=[];for(const z of mh){const sr=rm.get(z.t);if(Number.isFinite(sr)){xs.push(sr);ys.push(z.r);}}if(xs.length<54)continue;const b=beta(xs,ys);const residualHist=xs.map((x,i)=>x-b*ys[i]),rv=Math.max(sd(residualHist.slice(-48)),1e-5);function res(p,L){let mr=0;for(let j=0;j<L;j++){const q=marketRet.get(t-j*H);if(Number.isFinite(q))mr+=Math.log1p(clamp(q,-.95,10));}return (Math.log(cur.c/p.c)-b*mr)/(rv*Math.sqrt(L));}const r4=res(p4,4),r12=res(p12,12),r24=res(p24,24);items.push({s,b,r4,r12,r24,combo:.45*r4+.55*r24});}
    if(items.length<Math.max(10,Math.ceil(active.length*.5)))continue;
    const rankings={};for(const f of FEATURES){const key=f==='R4'?'r4':f==='R12'?'r12':f==='R24'?'r24':'combo',vals=items.map(x=>x[key]),mm=med(vals),ss=mad(vals);rankings[f]=items.map(x=>({...x,z:(x[key]-mm)/ss})).sort((a,b)=>b.z-a.z);}
    snapshots.push({t,rankings});
  }
  return {m,start,end,syms,active,maps,snapshots};
}
const months=new Map(needed.map(m=>[m,buildMonth(m)]));

const configs=[];for(const feature of FEATURES)for(const direction of DIRECTIONS)for(const hold of HOLDS)for(const k of KS)for(const minSpread of SPREADS)configs.push({feature,direction,hold,k,minSpread});
function weights(betaLong,betaShort){const bl=clamp(betaLong,.25,3),bs=clamp(betaShort,.25,3),sum=bl+bs;let wl=PAIR_GROSS*bs/sum,ws=PAIR_GROSS*bl/sum;wl=clamp(wl,PAIR_GROSS*.25,PAIR_GROSS*.75);ws=PAIR_GROSS-wl;return {wl,ws,betaImbalance:Math.abs(wl*bl-ws*bs)};}
function simulate(month,cfg,cost){
  const {start,end,maps,snapshots}=month;let equity=1,peak=1,maxDD=0;const active=[],busy=new Map(),used=new Map(),turn=new Map(),entries=new Map(),pnlDay=new Map(),trades=[];let betaAbs=0;
  function release(t){active.sort((a,b)=>a.exitTime-b.exitTime);while(active.length&&active[0].exitTime<=t){const p=active.shift(),pnl=p.entryEquity*p.rate;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));const d=utcDay(p.exitTime);turn.set(d,(turn.get(d)??0)+PAIR_GROSS);pnlDay.set(d,(pnlDay.get(d)??0)+pnl);}}
  for(const snap of snapshots){const entryTime=snap.t+H;release(entryTime);const d=utcDay(entryTime),u=used.get(d)??0;if(u>=ENTRY_BUDGET-PAIR_GROSS/2)continue;const rank=snap.rankings[cfg.feature]??[];const options=[];for(let i=0;i<cfg.k;i++){const top=rank[i],bot=rank[rank.length-1-i];if(!top||!bot||top.s===bot.s)continue;const spread=top.z-bot.z;if(spread<cfg.minSpread)continue;const long=cfg.direction===1?top:bot,short=cfg.direction===1?bot:top;if((busy.get(long.s)??0)>entryTime||(busy.get(short.s)??0)>entryTime)continue;options.push({long,short,spread});}
    options.sort((a,b)=>b.spread-a.spread);let local=u;for(const o of options){if(local+PAIR_GROSS>ENTRY_BUDGET+1e-9)break;const exposure=active.length*PAIR_GROSS;if(exposure+PAIR_GROSS>MAX_GROSS+1e-9)break;const lp=maps.get(o.long.s),sp=maps.get(o.short.s),le=lp?.get(entryTime),se=sp?.get(entryTime),lx=lp?.get(snap.t+cfg.hold*H),sx=sp?.get(snap.t+cfg.hold*H);if(!le||!se||!lx||!sx)continue;const {wl,ws,betaImbalance}=weights(o.long.b,o.short.b),lr=lx.c/le.o-1,sr=-(sx.c/se.o-1),rate=wl*lr+ws*sr-PAIR_GROSS*cost,exitTime=snap.t+(cfg.hold+1)*H;active.push({exitTime,entryEquity:equity,rate});busy.set(o.long.s,exitTime);busy.set(o.short.s,exitTime);local+=PAIR_GROSS;turn.set(d,(turn.get(d)??0)+PAIR_GROSS);entries.set(d,(entries.get(d)??0)+1);betaAbs+=betaImbalance;trades.push({entryTime,exitTime,long:o.long.s,short:o.short.s,spread:o.spread,wl,ws,rate,betaImbalance});}used.set(d,local);}
  release(end+10*H);
  const days=(end-start)/DAY,dayKeys=[];for(let t=Math.floor(start/DAY)*DAY;t<end;t+=DAY)dayKeys.push(utcDay(t));const turns=dayKeys.map(d=>turn.get(d)??0),ents=dayKeys.map(d=>entries.get(d)??0),pd=dayKeys.map(d=>pnlDay.get(d)??0),rates=trades.map(x=>x.rate/PAIR_GROSS),g=rates.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-rates.filter(x=>x<=0).reduce((s,x)=>s+x,0),norm=equity>0?equity**(30/days)-1:-1;
  return {days,pairs:trades.length,avgPairsPerDay:trades.length/days,totalReturn:equity-1,normalized30Return:norm,maxDD,avgDailyTurnover:mean(turns),medianDailyTurnover:med(turns),coverage45:turns.filter(x=>x>=4.5).length/turns.length,coverage48:turns.filter(x=>x>=4.8).length/turns.length,zeroTradeDays:ents.filter(x=>x===0).length,positivePnlDays:pd.filter(x=>x>0).length/Math.max(1,pd.filter(x=>x!==0).length),pairWinRate:rates.length?rates.filter(x=>x>0).length/rates.length:0,meanPairNet:mean(rates),pf:l?g/l:g?99:0,avgBetaImbalance:trades.length?betaAbs/trades.length:0};
}

const walk=[];
for(const test of TEST){const trainNames=prior2(test),train=trainNames.map(m=>months.get(m)).filter(Boolean),ranked=[];for(const c of configs){const ms=train.map(m=>simulate(m,c,BASE_COST));if(ms.length<2)continue;const turnOk=ms.every(x=>x.avgDailyTurnover>=4.35),positive=ms.every(x=>x.normalized30Return>0),worst=Math.min(...ms.map(x=>x.normalized30Return)),avg=mean(ms.map(x=>x.normalized30Return)),dd=Math.max(...ms.map(x=>x.maxDD)),freq=mean(ms.map(x=>x.avgPairsPerDay)),betaI=mean(ms.map(x=>x.avgBetaImbalance));ranked.push({c,ms,turnOk,positive,worst,score:worst+.3*avg-.12*dd+.0003*freq-.5*betaI});}const good=ranked.filter(x=>x.turnOk&&x.positive),turn=ranked.filter(x=>x.turnOk),pool=good.length?good:turn.length?turn:ranked;pool.sort((a,b)=>b.score-a.score);const pick=pool[0];const tm=months.get(test),base=simulate(tm,pick.c,BASE_COST),stress=simulate(tm,pick.c,STRESS_COST);walk.push({test,train:trainNames,selectionTier:good.length?'TRAIN_BOTH_POSITIVE':turn.length?'TURNOVER_ONLY':'FALLBACK',config:pick.c,trainMetrics:pick.ms,testBase:base,testStress:stress,candidateCounts:{positive:good.length,turnover:turn.length,total:ranked.length}});}
const full=walk.filter(x=>x.test!=='202609'),partial=walk.find(x=>x.test==='202609'),avgRet=mean(full.map(x=>x.testBase.normalized30Return)),medRet=med(full.map(x=>x.testBase.normalized30Return)),positive=full.filter(x=>x.testBase.normalized30Return>0).length,ge5=full.filter(x=>x.testBase.normalized30Return>=.05).length,turnOk=full.filter(x=>x.testBase.avgDailyTurnover>=4.5).length,avgTurn=mean(full.map(x=>x.testBase.avgDailyTurnover)),avgPairs=mean(full.map(x=>x.testBase.avgPairsPerDay)),worst=Math.min(...full.map(x=>x.testBase.normalized30Return)),avgBeta=mean(full.map(x=>x.testBase.avgBetaImbalance));const usable=positive>=6&&avgRet>0&&turnOk>=7&&worst>-.08;
const report={decision:usable?'MARKET_NEUTRAL_SLEEVE_USABLE':'MARKET_NEUTRAL_SLEEVE_NOT_STABLE',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',goal:'independent relative-value sleeve that can contribute high turnover without relying on market direction',target:{portfolioDailyTwoWayTurnover:5,monthlyPortfolioNet:.05},method:'hourly cross-sectional residual momentum after 72h causal beta estimate versus cross-sectional median market return; beta-neutral long/short pair sizing; next-hour-open entry; 1/2/4h causal hold selected only from prior two months',cost:{base:BASE_COST,stress:STRESS_COST},universePolicy:'causal frozen monthly crypto universes; September uses August frozen universe; ZEC excluded',configCount:configs.length,summary:{fullMonths:full.length,avgMonthlyNet:avgRet,medianMonthlyNet:medRet,worstMonthlyNet:worst,positiveMonths:positive,monthsAtLeast5pct:ge5,monthsTurnoverAtLeast4_5:turnOk,avgTwoWayTurnover:avgTurn,avgPairsPerDay:avgPairs,avgBetaImbalance:avgBeta,septemberPartial:partial?.testBase??null},walkForward:walk,usable};
writeFileSync('/tmp/market-neutral-crosssection-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({decision:report.decision,configCount:report.configCount,summary:report.summary,walkForward:walk,usable},null,2));