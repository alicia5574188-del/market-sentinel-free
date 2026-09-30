import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const SYMBOLS=['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','DOGE_USDT','ADA_USDT','BNB_USDT','SUI_USDT','AVAX_USDT','LINK_USDT','LTC_USDT','BCH_USDT','AAVE_USDT','UNI_USDT','ARB_USDT','FIL_USDT','PEPE_USDT','ENA_USDT'];
const H=3600,DAY=86400;
const START=Date.UTC(2024,0,1)/1000, MODEL_START=Date.UTC(2024,6,1)/1000, SIGNAL_START=Date.UTC(2025,0,1)/1000, END=Date.UTC(2026,8,1)/1000;
const BASE_COST=.00165,STRESS_COST=.00270,MAX_GROSS=1.5,DAILY_ENTRY_BUDGET=3.0;
const TRAIN_DAYS=180,TRAIN_STEP_HOURS=3,RIDGE_RATIO=.10;
const META_WINDOWS=[30,60,90],META_SHRINK=1000;
const HORIZONS=[12,24,48];
const PRED_FLOORS=[0,.001,.002,.003,.004,.006];
const FRACS=[.05,.075,.10],MAX_PER_HOUR=[1,2,3];
const CAL_MONTHS=['2025-01','2025-02','2025-03','2025-04','2025-05','2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12'];
const BLIND_MONTHS=['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];
const ARCHIVE_BASE='https://download.gatedata.org/futures_usdt/candlesticks_1h';
const FEATURE_NAMES=['z1','z6','z24','z72','z168','range72','logVolRatio','volumeTrend','effTrend','rel24','rel72','market24','market72','momMarket','relMarket'];
const P=FEATURE_NAMES.length+1;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const n=x=>{const v=Number(x);return Number.isFinite(v)?v:null;};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sign=x=>x>0?1:x<0?-1:0;
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const stdev=a=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(Math.max(0,a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)));};
const median=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2;};
const madScale=a=>{if(a.length<3)return 1e-9;const m=median(a),mad=median(a.map(x=>Math.abs(x-m)));return Math.max(1.4826*mad,1e-9);};
const dayKey=t=>new Date(t*1000).toISOString().slice(0,10);
const monthKey=t=>dayKey(t).slice(0,7);
const dayTs=k=>Date.parse(`${k}T00:00:00Z`)/1000;
const daysInMonth=m=>new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),0)).getUTCDate();
const addDays=(k,d)=>new Date((dayTs(k)+d*DAY)*1000).toISOString().slice(0,10);

function parseCandle(x){
  const time=n(x.t??x[0]),volume=n(x.v??x[1])??0,close=n(x.c??x[2]),high=n(x.h??x[3]),low=n(x.l??x[4]),open=n(x.o??x[5]);
  return time>0&&open>0&&close>0&&high>=low&&low>0?{time,volume,open,high,low,close}:null;
}
function archiveMonths(){
  const out=[];let d=new Date(START*1000);d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));
  while(d.getTime()/1000<END){out.push(d.toISOString().slice(0,7).replace('-',''));d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));}
  return out;
}
function archiveMonthBounds(ym){const y=+ym.slice(0,4),m=+ym.slice(4,6)-1;return [Date.UTC(y,m,1)/1000,Date.UTC(y,m+1,1)/1000];}
async function archiveMonth(symbol,ym,tries=5){
  const url=`${ARCHIVE_BASE}/${ym}/${symbol}-${ym}.csv.gz`;let last;
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(url);
      if(r.status===404)return {url,status:404,rows:[],bytes:0};
      const buf=Buffer.from(await r.arrayBuffer());
      if(r.ok){
        const text=gunzipSync(buf).toString('utf8');
        const rows=text.split(/\r?\n/).filter(Boolean).map(line=>parseCandle(line.split(','))).filter(Boolean);
        return {url,status:r.status,rows,bytes:buf.length};
      }
      last=new Error(`${r.status} ${url} ${buf.toString('utf8').slice(0,160)}`);
      if(r.status!==429&&r.status<500)break;
    }catch(e){last=e;}
    await sleep(300*(i+1));
  }
  throw last??new Error(url);
}
const archiveDiagnostics={};
async function candles(symbol){
  const out=[],missing=[],invalid=[],errors=[],months=[];
  for(const ym of archiveMonths()){
    try{
      const got=await archiveMonth(symbol,ym);
      if(got.status===404){missing.push(ym);months.push({ym,status:404,rows:0});continue;}
      const [lo,hi]=archiveMonthBounds(ym);
      const valid=got.rows.filter(r=>r.time>=lo&&r.time<hi&&r.time>=START&&r.time<END);
      if(valid.length!==got.rows.length)invalid.push({ym,total:got.rows.length,valid:valid.length});
      out.push(...valid);
      months.push({ym,status:got.status,rows:valid.length,bytes:got.bytes,first:valid[0]?.time??null,last:valid.at(-1)?.time??null});
    }catch(e){errors.push({ym,error:String(e)});months.push({ym,status:null,rows:0,error:String(e)});}
  }
  const rows=[...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time);
  archiveDiagnostics[symbol]={rows:rows.length,first:rows[0]?.time??null,last:rows.at(-1)?.time??null,missing,invalid,errors,months};
  return rows;
}

const raw=new Map();let cursor=0;
async function worker(){while(cursor<SYMBOLS.length){const s=SYMBOLS[cursor++];try{raw.set(s,await candles(s));}catch(e){console.error('FETCH_FAIL',s,String(e));raw.set(s,[]);}}}
await Promise.all(Array.from({length:6},worker));
const activeSymbols=[...raw].filter(([,rows])=>rows.length>7000&&(rows.at(-1)?.time??0)>=Date.UTC(2026,7,31,23)/1000).map(([s])=>s);
const maps=new Map(activeSymbols.map(s=>[s,new Map(raw.get(s).map(r=>[r.time,r]))]));
if(!activeSymbols.includes('BTC_USDT')||!activeSymbols.includes('ETH_USDT'))throw new Error('BTC/ETH historical coverage is required for market features.');

const featuresByTime=new Map();
for(const symbol of activeSymbols){
  const rows=raw.get(symbol),rets=Array(rows.length).fill(0);
  for(let i=1;i<rows.length;i++)rets[i]=rows[i].close/rows[i-1].close-1;
  for(let i=168;i<rows.length;i++){
    const r=rows[i];
    if(r.time-rows[i-168].time!==168*H)continue;
    const r1=r.close/rows[i-1].close-1,r6=r.close/rows[i-6].close-1,r24=r.close/rows[i-24].close-1,r72=r.close/rows[i-72].close-1,r168=r.close/rows[i-168].close-1;
    const vol24=stdev(rets.slice(i-23,i+1)),vol168=stdev(rets.slice(i-167,i+1));
    if(!(vol24>1e-8)||!(vol168>1e-8))continue;
    const z1=r1/vol24,z6=r6/(vol24*Math.sqrt(6)),z24=r24/(vol24*Math.sqrt(24)),z72=r72/(vol24*Math.sqrt(72)),z168=r168/(vol168*Math.sqrt(168));
    const prev72=rows.slice(i-72,i),hi72=Math.max(...prev72.map(x=>x.high)),lo72=Math.min(...prev72.map(x=>x.low));
    const pos72=(r.close-lo72)/Math.max(hi72-lo72,r.close*1e-9),range72=clamp(2*pos72-1,-1.5,1.5);
    const logVolRatio=clamp(Math.log(vol24/vol168),-2,2);
    const lv=Math.log1p(Math.max(0,r.volume)),prevLv=rows.slice(i-168,i).map(x=>Math.log1p(Math.max(0,x.volume))),zVol=(lv-median(prevLv))/madScale(prevLv);
    const volumeTrend=sign(r6)*clamp(Math.max(0,zVol),0,4);
    let travel=0;for(let j=i-23;j<=i;j++)travel+=Math.abs(rows[j].close-rows[j-1].close);
    const eff24=Math.abs(r.close-rows[i-24].close)/Math.max(travel,r.close*1e-9),effTrend=sign(r24)*clamp(eff24,0,1);
    const f={symbol,time:r.time,r1,r6,r24,r72,r168,z1,z6,z24,z72,z168,vol24,vol168,range72,logVolRatio,zVol,volumeTrend,effTrend};
    const a=featuresByTime.get(r.time)??[];a.push(f);featuresByTime.set(r.time,a);
  }
}

const obsByDay=new Map();
for(const [t,obs] of [...featuresByTime].sort((a,b)=>a[0]-b[0])){
  const btc=obs.find(x=>x.symbol==='BTC_USDT'),eth=obs.find(x=>x.symbol==='ETH_USDT');
  if(!btc||!eth)continue;
  const market24=.5*(btc.z24+eth.z24),market72=.5*(btc.z72+eth.z72);
  const rawMarket24=.5*(btc.r24+eth.r24),rawMarket72=.5*(btc.r72+eth.r72);
  const d=dayKey(t),bucket=obsByDay.get(d)??[];
  for(const x of obs){
    const rel24=(x.r24-rawMarket24)/Math.max(x.vol24*Math.sqrt(24),1e-9),rel72=(x.r72-rawMarket72)/Math.max(x.vol24*Math.sqrt(72),1e-9);
    const vec=[1,
      clamp(x.z1,-5,5),clamp(x.z6,-5,5),clamp(x.z24,-5,5),clamp(x.z72,-5,5),clamp(x.z168,-5,5),
      clamp(x.range72,-1.5,1.5),clamp(x.logVolRatio,-2,2),clamp(x.volumeTrend,-4,4),clamp(x.effTrend,-1,1),
      clamp(rel24,-5,5),clamp(rel72,-5,5),clamp(market24,-5,5),clamp(market72,-5,5),
      clamp(x.z24*market24/3,-5,5),clamp(rel24*market24/3,-5,5)
    ];
    if(vec.length!==P||vec.some(v=>!Number.isFinite(v)))continue;
    bucket.push({symbol:x.symbol,time:t,vec});
  }
  if(bucket.length)obsByDay.set(d,bucket);
}

function zeroStats(){return {n:0,xtx:Array.from({length:P},()=>Array(P).fill(0)),xty:Array(P).fill(0),sumY:0,sumY2:0};}
function addStats(a,b,scale=1){a.n+=scale*b.n;a.sumY+=scale*b.sumY;a.sumY2+=scale*b.sumY2;for(let i=0;i<P;i++){a.xty[i]+=scale*b.xty[i];for(let j=0;j<P;j++)a.xtx[i][j]+=scale*b.xtx[i][j];}return a;}
function updateStats(s,vec,y){s.n++;s.sumY+=y;s.sumY2+=y*y;for(let i=0;i<P;i++){s.xty[i]+=vec[i]*y;for(let j=0;j<P;j++)s.xtx[i][j]+=vec[i]*vec[j];}}
const dailyStats=new Map();
for(const [d,obs] of obsByDay){
  const byH=Object.fromEntries(HORIZONS.map(h=>[h,zeroStats()]));
  for(const o of obs){
    const hour=new Date(o.time*1000).getUTCHours();if(hour%TRAIN_STEP_HOURS!==0)continue;
    const pm=maps.get(o.symbol),entry=pm?.get(o.time+H);if(!entry)continue;
    for(const h of HORIZONS){const exit=pm?.get(o.time+h*H);if(!exit)continue;const y=exit.close/entry.open-1;if(Number.isFinite(y))updateStats(byH[h],o.vec,y);}
  }
  dailyStats.set(d,byH);
}

function solve(A,b){
  const n=A.length,m=A.map((row,i)=>[...row,b[i]]);
  for(let c=0;c<n;c++){
    let p=c;for(let r=c+1;r<n;r++)if(Math.abs(m[r][c])>Math.abs(m[p][c]))p=r;
    if(Math.abs(m[p][c])<1e-10)return null;
    if(p!==c)[m[p],m[c]]=[m[c],m[p]];
    const v=m[c][c];for(let j=c;j<=n;j++)m[c][j]/=v;
    for(let r=0;r<n;r++)if(r!==c){const f=m[r][c];if(Math.abs(f)<1e-16)continue;for(let j=c;j<=n;j++)m[r][j]-=f*m[c][j];}
  }
  return m.map(r=>r[n]);
}
function fitForDay(d,h){
  const lagDays=Math.ceil((23+h)/24),end=addDays(d,-lagDays),start=addDays(end,-TRAIN_DAYS+1),agg=zeroStats();
  for(let ts=dayTs(start),z=dayTs(end);ts<=z;ts+=DAY){const k=new Date(ts*1000).toISOString().slice(0,10),s=dailyStats.get(k)?.[h];if(s)addStats(agg,s);}
  if(agg.n<5000)return {beta:null,n:agg.n,start,end};
  const lambda=Math.max(10,RIDGE_RATIO*agg.n),A=agg.xtx.map(r=>[...r]);
  for(let i=0;i<P;i++)A[i][i]+=lambda*(i===0?.01:1);
  const beta=solve(A,agg.xty);
  return {beta,n:agg.n,start,end,lambda};
}
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);

const candidates=[],modelDays=[],metaDailyStats=new Map();
function zeroMeta(){return {n:0,pp:0,py:0};}
function updateMeta(s,pred,y){s.n++;s.pp+=pred*pred;s.py+=pred*y;}
function metaFactor(d,h){
  const lagDays=Math.ceil((23+h)/24),end=addDays(d,-lagDays),vals=[];
  for(const w of META_WINDOWS){
    const start=addDays(end,-w+1);let n=0,pp=0,py=0;
    for(let ts=dayTs(start),z=dayTs(end);ts<=z;ts+=DAY){const k=new Date(ts*1000).toISOString().slice(0,10),m=metaDailyStats.get(k)?.[h];if(m){n+=m.n;pp+=m.pp;py+=m.py;}}
    if(n>=500&&pp>1e-12){const slope=py/pp,shrink=n/(n+META_SHRINK);vals.push(clamp(slope*shrink,-3,3));}
  }
  return vals.length?median(vals):0;
}
for(const [d,obs] of [...obsByDay].sort((a,b)=>a[0].localeCompare(b[0]))){
  if(dayTs(d)<MODEL_START)continue;
  const models=Object.fromEntries(HORIZONS.map(h=>[h,fitForDay(d,h)]));
  if(HORIZONS.some(h=>!models[h].beta))continue;
  const factors=Object.fromEntries(HORIZONS.map(h=>[h,metaFactor(d,h)]));
  modelDays.push({day:d,factors,models:Object.fromEntries(HORIZONS.map(h=>[h,{n:models[h].n,start:models[h].start,end:models[h].end,lambda:models[h].lambda??null,ok:!!models[h].beta}]))});
  const dayMeta=Object.fromEntries(HORIZONS.map(h=>[h,zeroMeta()]));
  for(const o of obs){
    const pm=maps.get(o.symbol),entry=pm?.get(o.time+H);if(!entry)continue;
    const hour=new Date(o.time*1000).getUTCHours();let best=null;
    for(const h of HORIZONS){
      const exit=pm?.get(o.time+h*H);if(!exit)continue;
      const rawReturn=exit.close/entry.open-1,pred=clamp(dot(models[h].beta,o.vec),-.12,.12);
      if(hour%TRAIN_STEP_HOURS===0&&Number.isFinite(pred)&&Number.isFinite(rawReturn))updateMeta(dayMeta[h],pred,rawReturn);
      if(dayTs(d)<SIGNAL_START||!Number.isFinite(pred)||!Number.isFinite(rawReturn))continue;
      const factor=factors[h],calPred=clamp(pred*factor,-.12,.12),dir=sign(calPred);if(!dir)continue;
      const gross=dir*rawReturn,predAbs=Math.abs(calPred),edge=predAbs-BASE_COST;
      const c={symbol:o.symbol,signalTime:o.time,entryTime:o.time+H,exitTime:o.time+(h+1)*H,horizon:h,dir,basePred:pred,metaFactor:factor,pred:calPred,predAbs,edge,gross};
      if(!best||c.edge>best.edge||(c.edge===best.edge&&c.horizon<best.horizon))best=c;
    }
    if(best)candidates.push(best);
  }
  metaDailyStats.set(d,dayMeta);
}
candidates.sort((a,b)=>a.entryTime-b.entryTime||b.predAbs-a.predAbs);

function rawSummary(months){
  const a=candidates.filter(c=>months.includes(monthKey(c.entryTime))),nets=a.map(c=>c.gross-BASE_COST),g=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0),h={};
  for(const c of a)h[c.horizon]=(h[c.horizon]??0)+1;
  return {count:a.length,meanPredAbs:mean(a.map(c=>c.predAbs)),meanGross:mean(a.map(c=>c.gross)),meanBaseNet:mean(nets),hit:nets.length?nets.filter(x=>x>0).length/nets.length:0,pf:l?g/l:g?99:0,horizons:h};
}
function simulateMonth(policy,cost,month){
  const monthCandidates=candidates.filter(c=>monthKey(c.entryTime)===month&&c.predAbs>=policy.floor),grouped=new Map();
  for(const c of monthCandidates){const a=grouped.get(c.entryTime)??[];a.push(c);grouped.set(c.entryTime,a);}
  let equity=1,peak=1,maxDD=0;const active=[],busy=new Map(),usedDay=new Map(),trades=[];
  function release(t){active.sort((a,b)=>a.exitTime-b.exitTime);while(active.length&&active[0].exitTime<=t){const p=active.shift(),net=p.gross-cost,pnl=p.entryEq*policy.frac*net;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));trades.push({...p,net,pnl});}}
  for(const [t,a] of [...grouped].sort((x,y)=>x[0]-y[0])){
    release(t);const d=dayKey(t);let used=usedDay.get(d)??0,nHour=0;
    for(const c of a.sort((x,y)=>y.predAbs-x.predAbs)){
      if(nHour>=policy.maxPer)break;if((busy.get(c.symbol)??0)>t)continue;if(used+policy.frac>DAILY_ENTRY_BUDGET+1e-9)break;if(active.length*policy.frac+policy.frac>MAX_GROSS+1e-9)break;
      active.push({...c,entryEq:equity});busy.set(c.symbol,c.exitTime);used+=policy.frac;nHour++;
    }
    usedDay.set(d,used);
  }
  release(Date.UTC(+month.slice(0,4),+month.slice(5,7),1)/1000+40*DAY);
  const nets=trades.map(x=>x.net),g=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0),h={};for(const x of trades)h[x.horizon]=(h[x.horizon]??0)+1;
  return {month,totalReturn:equity-1,maxDD,trades:trades.length,avgTradesPerDay:trades.length/daysInMonth(month),avgDailyTwoWayTurnover:trades.length*policy.frac*2/daysInMonth(month),meanTradeNet:mean(nets),pf:l?g/l:g?99:0,hit:nets.length?nets.filter(x=>x>0).length/nets.length:0,horizons:h};
}
function simulate(policy,cost,months){
  const monthly=months.map(m=>simulateMonth(policy,cost,m)),compound=monthly.reduce((e,x)=>e*(1+x.totalReturn),1)-1;
  return {months,monthly,totalCompounded:compound,maxDD:Math.max(...monthly.map(x=>x.maxDD)),avgMonthReturn:mean(monthly.map(x=>x.totalReturn)),medianMonthReturn:median(monthly.map(x=>x.totalReturn)),minMonthReturn:Math.min(...monthly.map(x=>x.totalReturn)),positiveMonths:monthly.filter(x=>x.totalReturn>0).length,monthsAtLeast5pct:monthly.filter(x=>x.totalReturn>=.05).length,avgTradesPerDay:mean(monthly.map(x=>x.avgTradesPerDay)),avgDailyTwoWayTurnover:mean(monthly.map(x=>x.avgDailyTwoWayTurnover)),trades:monthly.reduce((s,x)=>s+x.trades,0)};
}

const policies=[];for(const floor of PRED_FLOORS)for(const frac of FRACS)for(const maxPer of MAX_PER_HOUR)policies.push({floor,frac,maxPer,key:`p${floor}|n${frac}|m${maxPer}`});
const evaluated=[];
for(const policy of policies){const calibration=simulate(policy,BASE_COST,CAL_MONTHS),calibrationStress=simulate(policy,STRESS_COST,CAL_MONTHS);evaluated.push({policy,calibration,calibrationStress});}
const feasible=evaluated.filter(x=>x.calibration.avgMonthReturn>=.05&&x.calibration.positiveMonths>=9&&x.calibration.minMonthReturn>-.05&&x.calibrationStress.avgMonthReturn>=0).sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay||b.calibration.avgMonthReturn-a.calibration.avgMonthReturn);
const target=feasible[0]??null;
const bestReturn=[...evaluated].sort((a,b)=>b.calibration.avgMonthReturn-a.calibration.avgMonthReturn)[0]??null;
const bestFrequencyPositive=[...evaluated].filter(x=>x.calibration.avgMonthReturn>0).sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay||b.calibration.avgMonthReturn-a.calibration.avgMonthReturn)[0]??null;
function enrich(x){if(!x)return null;return {...x,blind:simulate(x.policy,BASE_COST,BLIND_MONTHS),blindStress:simulate(x.policy,STRESS_COST,BLIND_MONTHS)};}
function pareto(rows){const out=[];for(const a of rows){if(rows.some(b=>b!==a&&b.calibration.avgTradesPerDay>=a.calibration.avgTradesPerDay&&b.calibration.avgMonthReturn>=a.calibration.avgMonthReturn&&(b.calibration.avgTradesPerDay>a.calibration.avgTradesPerDay||b.calibration.avgMonthReturn>a.calibration.avgMonthReturn)))continue;out.push(a);}return out.sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay).slice(0,24);}
const report={
  decision:target?'ADAPTIVE_ALPHA_CALIBRATION_TARGET_FOUND':'ADAPTIVE_ALPHA_NO_5PCT_CALIBRATION',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',
  goal:'maximize practical trade frequency while targeting >=5% monthly net after realistic costs at portfolio level',
  method:'Gate official 1h OHLCV. Causal 180-day ridge ensemble learns base direction from multi-timescale momentum, reversal, range, volume, volatility, market and relative-strength features. A second causal meta-calibration layer uses only previously settled 30d/60d/90d prediction-vs-outcome slopes to keep or invert direction and rescale conviction. Calibrated 12h/24h/48h horizons compete per opportunity. 2025 selects portfolio policy; 2026 Jan-Aug is fixed validation.',
  cost:{base:BASE_COST,stress:STRESS_COST},
  data:{start:new Date(START*1000).toISOString(),signalStart:new Date(SIGNAL_START*1000).toISOString(),end:new Date(END*1000).toISOString(),activeSymbols,source:{venue:'Gate',dataset:'official historical downloads',market:'futures_usdt',interval:'1h',urlPattern:`${ARCHIVE_BASE}/YYYYMM/SYMBOL-YYYYMM.csv.gz`},archiveDiagnostics},
  model:{featureNames:FEATURE_NAMES,rollingTrainDays:TRAIN_DAYS,trainSampleStepHours:TRAIN_STEP_HOURS,ridgeRatio:RIDGE_RATIO,horizons:HORIZONS,metaWindows:META_WINDOWS,metaShrink:META_SHRINK,modelDays:modelDays.length,metaFactorSummary:Object.fromEntries(HORIZONS.map(h=>{const a=modelDays.filter(x=>dayTs(x.day)>=SIGNAL_START).map(x=>x.factors[h]).filter(Number.isFinite);return [h,{mean:mean(a),median:median(a),positive:a.filter(x=>x>0).length,negative:a.filter(x=>x<0).length,zero:a.filter(x=>x===0).length}];}))},
  candidateCount:candidates.length,raw:{calibration:rawSummary(CAL_MONTHS),blind:rawSummary(BLIND_MONTHS)},
  calibrationMonths:CAL_MONTHS,blindMonths:BLIND_MONTHS,policyCount:policies.length,feasibleCount:feasible.length,
  target:enrich(target),bestReturn:enrich(bestReturn),bestFrequencyPositive:enrich(bestFrequencyPositive),paretoFrontier:pareto(evaluated)
};
writeFileSync('/tmp/adaptive-1h-alpha-ensemble-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({decision:report.decision,activeSymbols:activeSymbols.length,candidateCount:report.candidateCount,raw:report.raw,policyCount:report.policyCount,feasibleCount:report.feasibleCount,target:report.target,bestReturn:report.bestReturn,bestFrequencyPositive:report.bestFrequencyPositive,paretoFrontier:report.paretoFrontier},null,2));
