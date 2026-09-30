import { readFileSync, writeFileSync } from 'node:fs';

const src=readFileSync('scripts/research-special-coin-relation-router.mjs','utf8');
const mm=src.match(/const SELECTED_BY_MONTH = (\{.*?\});\nconst MONTHS=/s);
if(!mm) throw new Error('frozen monthly universe missing');
const U=JSON.parse(mm[1]);
const TEST=['202601','202602','202603','202604','202605','202606','202607','202608','202609'];
const ALL=[...Object.keys(U).sort(),'202609'];
const H=3600,DAY=86400,WARM=168*H,ENTRY_BUDGET=2.5,PAIR_GROSS=.125,MAX_GROSS=1.5;
const BASE_COST=.00165,STRESS_COST=.00270;
const LOOKBACKS=[72,120],CORRS=[.40,.55,.70],ZTH=[.75,1,1.25,1.5],HOLDS=[1,2,4,8],MAXPH=[1,2,3];
const now=Math.floor(Date.now()/1000/H)*H;
const monthStart=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000;
const nextMonth=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const prior2=m=>{const i=ALL.indexOf(m);return ALL.slice(Math.max(0,i-2),i);};
const universe=m=>[...new Set((m==='202609'?U['202608']:U[m])??[])].filter(s=>s!=='ZEC_USDT');
const n=x=>{const v=Number(x);return Number.isFinite(v)?v:null;};
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const med=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),i=Math.floor(b.length/2);return b.length%2?b[i]:(b[i-1]+b[i])/2;};
const sd=a=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
const corr=(a,b)=>{if(a.length<20||a.length!==b.length)return 0;const ma=mean(a),mb=mean(b);let co=0,va=0,vb=0;for(let i=0;i<a.length;i++){const x=a[i]-ma,y=b[i]-mb;co+=x*y;va+=x*x;vb+=y*y;}return va>1e-12&&vb>1e-12?co/Math.sqrt(va*vb):0;};
const utcDay=t=>new Date(t*1000).toISOString().slice(0,10);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url,attempts=6){for(let a=0;a<attempts;a++){try{const r=await fetch(url);if(r.ok)return await r.json();if(r.status!==429&&r.status<500)throw new Error(`${r.status} ${url}`);}catch(e){if(a===attempts-1)throw e;}await sleep(350*(a+1));}}
function parse(a){if(!Array.isArray(a))return[];return a.flatMap(x=>{const t=n(x.t??x[0]),o=n(x.o??x[5]),h=n(x.h??x[3]),l=n(x.l??x[4]),c=n(x.c??x[2]),v=n(x.v??x[1])??0;return t>0&&o>0&&c>0&&h>=l&&l>0?[{t,o,h,l,c,v}]:[]}).sort((a,b)=>a.t-b.t);}

const needed=[...new Set(TEST.flatMap(m=>[m,...prior2(m)]))].sort();
const tasks=[];for(const m of needed)for(const s of universe(m))tasks.push({m,s});
const raw=new Map();let cursor=0;
async function worker(){while(cursor<tasks.length){const {m,s}=tasks[cursor++],from=monthStart(m)-WARM,to=Math.min(nextMonth(m)+10*H,now);try{const a=await get(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(s)}&from=${from}&to=${to-1}&interval=1h`);raw.set(`${m}|${s}`,[...new Map(parse(a).map(r=>[r.t,r])).values()]);}catch(e){console.error('FETCH_FAIL',m,s,String(e));raw.set(`${m}|${s}`,[]);}}}
await Promise.all(Array.from({length:10},worker));

function regression(x,y){const mx=mean(x),my=mean(y);let cov=0,v=0;for(let i=0;i<x.length;i++){cov+=(x[i]-mx)*(y[i]-my);v+=(x[i]-mx)**2;}if(v<=1e-12)return null;const b=cov/v;if(!(b>.15&&b<4))return null;return {a:my-b*mx,b};}
function buildMonth(m){
  const syms=universe(m),start=monthStart(m),end=Math.min(nextMonth(m),now),maps=new Map();
  for(const s of syms){const rows=raw.get(`${m}|${s}`)??[];if(rows.length>=160)maps.set(s,new Map(rows.map(r=>[r.t,r])));}
  const active=[...maps.keys()],events=new Map(LOOKBACKS.map(L=>[L,[]]));
  for(let t=start;t<end-8*H;t+=H){
    for(const L of LOOKBACKS){const cand=[];
      for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++){
        const xS=active[i],yS=active[j],xm=maps.get(xS),ym=maps.get(yS),xs=[],ys=[],xr=[],yr=[];let ok=true;
        for(let q=L-1;q>=0;q--){const tt=t-q*H,x=xm.get(tt),y=ym.get(tt),xp=xm.get(tt-H),yp=ym.get(tt-H);if(!x||!y||!xp||!yp){ok=false;break;}xs.push(Math.log(x.c));ys.push(Math.log(y.c));xr.push(x.c/xp.c-1);yr.push(y.c/yp.c-1);}if(!ok)continue;
        const c=corr(xr,yr);if(c<.30)continue;const rg=regression(xs,ys);if(!rg)continue;const residuals=xs.map((x,k)=>ys[k]-rg.a-rg.b*x),rs=sd(residuals);if(rs<1e-5)continue;const z=residuals.at(-1)/rs;const az=Math.abs(z);if(az<.5)continue;const score=az*Math.max(c,0);cand.push({t,x:xS,y:yS,beta:rg.b,corr:c,z,score});
      }
      cand.sort((a,b)=>b.score-a.score);events.get(L).push({t,candidates:cand.slice(0,18)});
    }
  }
  return {m,start,end,syms,active,maps,events};
}
const months=new Map(needed.map(m=>[m,buildMonth(m)]));
const configs=[];for(const lookback of LOOKBACKS)for(const minCorr of CORRS)for(const minZ of ZTH)for(const hold of HOLDS)for(const maxPerHour of MAXPH)configs.push({lookback,minCorr,minZ,hold,maxPerHour});
function pairWeights(beta){const b=Math.max(.15,Math.min(4,beta)),wy=PAIR_GROSS/(1+b),wx=PAIR_GROSS-wy;return {wx,wy};}
function simulate(month,cfg,cost){
  const {start,end,maps}=month,snaps=month.events.get(cfg.lookback)??[];let equity=1,peak=1,maxDD=0;const active=[],busy=new Map(),used=new Map(),turn=new Map(),entries=new Map(),pnlDay=new Map(),trades=[];
  function release(t){active.sort((a,b)=>a.exitTime-b.exitTime);while(active.length&&active[0].exitTime<=t){const p=active.shift(),pnl=p.entryEquity*p.rate;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));const d=utcDay(p.exitTime);turn.set(d,(turn.get(d)??0)+PAIR_GROSS);pnlDay.set(d,(pnlDay.get(d)??0)+pnl);}}
  for(const snap of snaps){const entryTime=snap.t+H;release(entryTime);const d=utcDay(entryTime),u=used.get(d)??0;if(u>=ENTRY_BUDGET-PAIR_GROSS/2)continue;const options=snap.candidates.filter(c=>c.corr>=cfg.minCorr&&Math.abs(c.z)>=cfg.minZ).slice(0,cfg.maxPerHour);let local=u;
    for(const c of options){if(local+PAIR_GROSS>ENTRY_BUDGET+1e-9)break;if(active.length*PAIR_GROSS+PAIR_GROSS>MAX_GROSS+1e-9)break;if((busy.get(c.x)??0)>entryTime||(busy.get(c.y)??0)>entryTime)continue;const xm=maps.get(c.x),ym=maps.get(c.y),xe=xm?.get(entryTime),ye=ym?.get(entryTime),xx=xm?.get(snap.t+cfg.hold*H),yx=ym?.get(snap.t+cfg.hold*H);if(!xe||!ye||!xx||!yx)continue;const {wx,wy}=pairWeights(c.beta);let rX,rY,longSymbol,shortSymbol;if(c.z>0){rY=-(yx.c/ye.o-1);rX=xx.c/xe.o-1;longSymbol=c.x;shortSymbol=c.y;}else{rY=yx.c/ye.o-1;rX=-(xx.c/xe.o-1);longSymbol=c.y;shortSymbol=c.x;}const rate=wx*rX+wy*rY-PAIR_GROSS*cost,exitTime=snap.t+(cfg.hold+1)*H;active.push({exitTime,entryEquity:equity,rate});busy.set(c.x,exitTime);busy.set(c.y,exitTime);local+=PAIR_GROSS;turn.set(d,(turn.get(d)??0)+PAIR_GROSS);entries.set(d,(entries.get(d)??0)+1);trades.push({entryTime,exitTime,x:c.x,y:c.y,longSymbol,shortSymbol,corr:c.corr,z:c.z,beta:c.beta,wx,wy,rate});}
    used.set(d,local);
  }
  release(end+12*H);
  const days=(end-start)/DAY,dayKeys=[];for(let t=Math.floor(start/DAY)*DAY;t<end;t+=DAY)dayKeys.push(utcDay(t));const turns=dayKeys.map(d=>turn.get(d)??0),ents=dayKeys.map(d=>entries.get(d)??0),pd=dayKeys.map(d=>pnlDay.get(d)??0),rates=trades.map(x=>x.rate/PAIR_GROSS),g=rates.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-rates.filter(x=>x<=0).reduce((s,x)=>s+x,0),norm=equity>0?equity**(30/days)-1:-1;
  return {days,pairs:trades.length,avgPairsPerDay:trades.length/days,totalReturn:equity-1,normalized30Return:norm,maxDD,avgDailyTurnover:mean(turns),medianDailyTurnover:med(turns),coverage20:turns.filter(x=>x>=2).length/turns.length,coverage40:turns.filter(x=>x>=4).length/turns.length,zeroTradeDays:ents.filter(x=>x===0).length,positivePnlDays:pd.filter(x=>x>0).length/Math.max(1,pd.filter(x=>x!==0).length),pairWinRate:rates.length?rates.filter(x=>x>0).length/rates.length:0,meanPairNet:mean(rates),pf:l?g/l:g?99:0};
}

const walk=[];
for(const test of TEST){const trainNames=prior2(test),train=trainNames.map(m=>months.get(m)).filter(Boolean),ranked=[];for(const c of configs){const ms=train.map(m=>simulate(m,c,BASE_COST));if(ms.length<2)continue;const enough=ms.every(x=>x.avgPairsPerDay>=2),positive=ms.every(x=>x.normalized30Return>0&&x.meanPairNet>0),worst=Math.min(...ms.map(x=>x.normalized30Return)),avg=mean(ms.map(x=>x.normalized30Return)),dd=Math.max(...ms.map(x=>x.maxDD)),freq=mean(ms.map(x=>x.avgPairsPerDay)),edge=mean(ms.map(x=>x.meanPairNet));ranked.push({c,ms,enough,positive,worst,score:worst+.35*avg-.12*dd+.08*edge+.0005*freq});}const good=ranked.filter(x=>x.enough&&x.positive),enough=ranked.filter(x=>x.enough),pool=good.length?good:enough.length?enough:ranked;pool.sort((a,b)=>b.score-a.score);const pick=pool[0],tm=months.get(test),base=simulate(tm,pick.c,BASE_COST),stress=simulate(tm,pick.c,STRESS_COST);walk.push({test,train:trainNames,selectionTier:good.length?'TRAIN_BOTH_POSITIVE':enough.length?'FREQUENCY_ONLY':'FALLBACK',config:pick.c,trainMetrics:pick.ms,testBase:base,testStress:stress,candidateCounts:{positive:good.length,enough:enough.length,total:ranked.length}});}
const full=walk.filter(x=>x.test!=='202609'),partial=walk.find(x=>x.test==='202609'),avgRet=mean(full.map(x=>x.testBase.normalized30Return)),medRet=med(full.map(x=>x.testBase.normalized30Return)),worst=Math.min(...full.map(x=>x.testBase.normalized30Return)),positive=full.filter(x=>x.testBase.normalized30Return>0).length,ge5=full.filter(x=>x.testBase.normalized30Return>=.05).length,stressPositive=full.filter(x=>x.testStress.normalized30Return>0).length,avgTurn=mean(full.map(x=>x.testBase.avgDailyTurnover)),avgPairs=mean(full.map(x=>x.testBase.avgPairsPerDay)),avgEdge=mean(full.map(x=>x.testBase.meanPairNet));const usable=positive>=6&&avgRet>0&&avgEdge>0&&stressPositive>=4&&worst>-.08;
const report={decision:usable?'RESIDUAL_PAIR_SLEEVE_USABLE':'RESIDUAL_PAIR_SLEEVE_NOT_STABLE',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',goal:'independent residual mean-reversion sleeve; contribution to 5x portfolio rather than forced standalone 5x',target:{portfolioDailyTwoWayTurnover:5,portfolioMonthlyNet:.05},method:'causal rolling log-price regression on highly correlated pairs; residual z-score mean reversion; next-hour-open two-leg entry; beta-ratio hedge; fixed hold selected only from prior two months',cost:{base:BASE_COST,stress:STRESS_COST},universePolicy:'causal frozen monthly crypto universes; September uses August frozen universe; ZEC excluded',configCount:configs.length,summary:{fullMonths:full.length,avgMonthlyNet:avgRet,medianMonthlyNet:medRet,worstMonthlyNet:worst,positiveMonths:positive,monthsAtLeast5pct:ge5,stressPositiveMonths:stressPositive,avgTwoWayTurnoverContribution:avgTurn,avgPairsPerDay:avgPairs,avgMeanPairNet:avgEdge,septemberPartial:partial?.testBase??null},walkForward:walk,usable};
writeFileSync('/tmp/pair-residual-meanrevert-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({decision:report.decision,configCount:report.configCount,summary:report.summary,walkForward:walk,usable},null,2));