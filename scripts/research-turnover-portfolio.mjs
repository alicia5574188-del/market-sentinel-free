import { writeFileSync } from 'node:fs';

const BASE='https://api.gateio.ws/api/v4';
const H=3600;
const DAY=86400;
const DAYS=120;
const WARMUP_HOURS=72;
const SYMBOL_LIMIT=30;
const ENTRY_BUDGET=2.5; // one-way entry notional / equity; ~5x two-way turnover after exits
const MAX_EXPOSURE=1.5;
const BASE_COST=0.00165;   // 14bp friction + 2.5bp adverse entry slippage equivalent
const STRESS_COST=0.00270; // 22bp friction + 5bp adverse entry slippage equivalent
const SCORE_FLOORS=[0.55,0.75,0.95,1.15];
const MIN_FAMILIES=[1,2];
const HORIZONS=[1,2,4];
const NOTIONALS=[0.10,0.125,0.15,0.20];
const MAX_PER_HOUR=[2,3];
const CRYPTO_TYPES=new Set(['','crypto','cryptocurrency','digital_asset','digital_assets']);
const now=Math.floor(Date.now()/1000/H)*H;
const dataFrom=now-DAYS*DAY;
const effectiveStart=dataFrom+WARMUP_HOURS*H;
const usable=now-effectiveStart;
const span=Math.floor(usable/3/H)*H;
const split1=effectiveStart+span;
const split2=split1+span;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function gate(path,attempts=6){
  let last;
  for(let a=0;a<attempts;a++){
    try{
      const r=await fetch(`${BASE}${path}`,{headers:{Accept:'application/json','X-Gate-Size-Decimal':'1'}});
      if(r.ok)return await r.json();
      last=new Error(`Gate ${r.status}: ${path}`);
      if(r.status!==429&&r.status<500)break;
    }catch(e){last=e;}
    await sleep(350*(a+1));
  }
  throw last??new Error(`Gate request failed: ${path}`);
}
const n=x=>{const v=Number(x);return Number.isFinite(v)?v:null;};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sign=x=>x>0?1:x<0?-1:0;
const median=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2;};
const madScale=a=>{if(a.length<3)return 1e-9;const m=median(a),mad=median(a.map(x=>Math.abs(x-m)));return Math.max(1.4826*mad,1e-9);};
const stdev=a=>{if(a.length<2)return 0;const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
const utcDay=t=>new Date(t*1000).toISOString().slice(0,10);
const iso=t=>new Date(t*1000).toISOString();

async function universe(){
  const [tickers,contracts]=await Promise.all([gate('/futures/usdt/tickers'),gate('/futures/usdt/contracts')]);
  const active=new Set((Array.isArray(contracts)?contracts:[]).filter(x=>!x.in_delisting&&(!x.status||x.status==='trading')
    &&CRYPTO_TYPES.has(String(x.contract_type??'').trim().toLowerCase().replace(/[\s-]+/g,'_'))).map(x=>x.name));
  return (Array.isArray(tickers)?tickers:[]).filter(x=>active.has(x.contract)&&String(x.contract).endsWith('_USDT')&&(n(x.last)??0)>0)
    .sort((a,b)=>(n(b.volume_24h_usd??b.volume_24h_settle)??0)-(n(a.volume_24h_usd??a.volume_24h_settle)??0))
    .slice(0,SYMBOL_LIMIT).map(x=>x.contract);
}
async function candles(symbol){
  const out=[];
  const chunk=700*H;
  for(let from=dataFrom;from<now;from+=chunk){
    const to=Math.min(now-1,from+chunk-1);
    const a=await gate(`/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=1h&from=${from}&to=${to}`);
    if(!Array.isArray(a))continue;
    for(const x of a){
      const row={time:n(x.t??x[0]),volume:n(x.v??x[1])??0,close:n(x.c??x[2]),high:n(x.h??x[3]),low:n(x.l??x[4]),open:n(x.o??x[5])};
      if(row.time>0&&row.open>0&&row.close>0&&row.high>=row.low&&row.low>0)out.push(row);
    }
  }
  return [...new Map(out.map(r=>[r.time,r])).values()].filter(r=>r.time>=dataFrom&&r.time<now).sort((a,b)=>a.time-b.time);
}

const symbols=await universe();
const raw=new Map();let cursor=0;
async function worker(){while(cursor<symbols.length){const s=symbols[cursor++];try{raw.set(s,await candles(s));}catch(e){console.error('FETCH_FAIL',s,String(e));raw.set(s,[]);}}}
await Promise.all(Array.from({length:6},worker));
const activeSymbols=[...raw].filter(([,r])=>r.length>WARMUP_HOURS+48).map(([s])=>s);

const featuresByTime=new Map();
const priceMaps=new Map();
for(const symbol of activeSymbols){
  const rows=raw.get(symbol);
  priceMaps.set(symbol,new Map(rows.map(r=>[r.time,r])));
  const rets=[];
  for(let i=1;i<rows.length;i++)rets.push(rows[i].close/rows[i-1].close-1);
  for(let i=WARMUP_HOURS;i<rows.length;i++){
    if(rows[i].time-rows[i-24].time!==24*H||rows[i].time-rows[i-72].time!==72*H)continue;
    const r=rows[i];
    const r1=r.close/rows[i-1].close-1,r3=r.close/rows[i-3].close-1,r6=r.close/rows[i-6].close-1,r12=r.close/rows[i-12].close-1,r24=r.close/rows[i-24].close-1;
    const last6=rets.slice(i-6,i),last24=rets.slice(i-24,i);
    const vol6=stdev(last6),vol24=stdev(last24);
    let travel=0;for(let j=i-11;j<=i;j++)travel+=Math.abs(rows[j].close-rows[j-1].close);
    const eff12=Math.abs(r.close-rows[i-12].close)/Math.max(travel,r.close*1e-9);
    const w24=rows.slice(i-23,i+1),lo24=Math.min(...w24.map(x=>x.low)),hi24=Math.max(...w24.map(x=>x.high));
    const pos24=(r.close-lo24)/Math.max(hi24-lo24,r.close*1e-9);
    const prevLogVol=rows.slice(i-72,i).map(x=>Math.log1p(Math.max(0,x.volume)));
    const lv=Math.log1p(Math.max(0,r.volume)),zVol=(lv-median(prevLogVol))/madScale(prevLogVol);
    const candleRange=Math.max(r.high-r.low,r.close*1e-9),body=(r.close-r.open)/candleRange;
    const persistence=last6.length?Math.max(last6.filter(x=>x>0).length,last6.filter(x=>x<0).length)/last6.length:0;
    const f={symbol,time:r.time,r1,r3,r6,r12,r24,vol6,vol24,volRatio:vol24>0?vol6/vol24:1,eff12,pos24,zVol,body,persistence};
    const arr=featuresByTime.get(r.time)??[];arr.push(f);featuresByTime.set(r.time,arr);
  }
}

const candidates=[];
for(const [t,obs] of [...featuresByTime].sort((a,b)=>a[0]-b[0])){
  if(t<effectiveStart||obs.length<Math.max(15,Math.ceil(activeSymbols.length*.60)))continue;
  const med1=median(obs.map(x=>x.r1)),med6=median(obs.map(x=>x.r6)),med24=median(obs.map(x=>x.r24));
  const s1=madScale(obs.map(x=>x.r1)),s6=madScale(obs.map(x=>x.r6)),s24=madScale(obs.map(x=>x.r24));
  const marketZ=clamp(med6/s6,-2.5,2.5),breadth1=obs.filter(x=>x.r1>0).length/obs.length,breadth6=obs.filter(x=>x.r6>0).length/obs.length;
  const neutral=1-clamp(Math.abs(marketZ)/1.5,0,1);
  for(const x of obs){
    const z1=(x.r1-med1)/s1,z6=(x.r6-med6)/s6,z24=(x.r24-med24)/s24;
    const volBoost=clamp(x.zVol,0,2.5),quiet=clamp((0.9-x.volRatio)/0.5,0,1),trendDir=sign(.65*z24+.35*z6);
    const fs=[];
    const trend=.45*z24+.25*z6+.15*marketZ+.15*sign(z24||z6)*x.eff12;
    fs.push(['TREND',trend]);
    const breakout=.42*z6+.25*z1+.15*marketZ+.12*sign(z1||z6)*volBoost+.06*x.body*2;
    fs.push(['BREAKOUT',breakout]);
    if(trendDir&&sign(z1)===-trendDir&&Math.abs(z24)>=.45&&Math.abs(z1)<=2.5){
      const pb=trendDir*(.46*Math.abs(z24)+.18*Math.abs(z6)+.16*Math.abs(z1)+.10*x.eff12+.10*volBoost);
      fs.push(['PULLBACK',pb]);
    }
    if(Math.abs(z6)>=.75&&sign(z1)===-sign(z6)){
      const d=-sign(z6),rv=d*(.46*Math.abs(z6)+.22*Math.abs(z1)+.14*neutral+.10*(1-x.eff12)+.08*volBoost);
      fs.push(['REVERSAL',rv]);
    }
    if(quiet>.15&&trendDir&&x.eff12>=.20){
      const q=trendDir*(.38*Math.abs(z24)+.22*Math.abs(z6)+.18*x.eff12+.14*quiet+.08*Math.abs(marketZ));
      fs.push(['QUIET_DRIFT',q]);
    }
    if(neutral>.35&&(x.pos24<=.28||x.pos24>=.72)){
      const d=x.pos24<=.28?1:-1,edge=Math.abs(x.pos24-.5)*2;
      const rg=d*(.32*Math.abs(z6)+.24*edge+.18*neutral+.14*Math.max(0,d*x.body)+.12*volBoost);
      fs.push(['RANGE_EDGE',rg]);
    }
    const marketDir=sign(marketZ);
    if(marketDir&&Math.abs(marketZ)>=.45&&sign(z6)===-marketDir&&Math.abs(z6)>=.35&&Math.abs(z24)<=1.75){
      const ct=marketDir*(.38*Math.abs(marketZ)+.27*Math.abs(z6)+.15*Math.max(0,marketDir*z24)+.10*x.eff12+.10*volBoost);
      fs.push(['MARKET_CATCHUP',ct]);
    }
    const meaningful=fs.filter(([,v])=>Math.abs(v)>=.25);
    if(!meaningful.length)continue;
    const support=meaningful.reduce((s,[,v])=>s+v,0),d=sign(support);if(!d)continue;
    const aligned=meaningful.filter(([,v])=>sign(v)===d).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
    const opposed=meaningful.filter(([,v])=>sign(v)===-d);
    const top=Math.abs(aligned[0]?.[1]??0),second=Math.abs(aligned[1]?.[1]??0),agreement=aligned.length/meaningful.length;
    const conflict=opposed.reduce((s,[,v])=>s+Math.abs(v),0)/Math.max(aligned.reduce((s,[,v])=>s+Math.abs(v),0),1e-9);
    const ensembleScore=.58*top+.22*second+.20*agreement*1.5-.12*clamp(conflict,0,1.5);
    if(ensembleScore<=0)continue;
    candidates.push({t,symbol:x.symbol,side:d,family:aligned[0][0],families:aligned.length,ensembleScore,agreement,
      marketZ,breadth1,breadth6,z1,z6,z24,zVol:x.zVol,eff12:x.eff12,pos24:x.pos24});
  }
}

function grossFor(c,horizon){
  const m=priceMaps.get(c.symbol),entryRow=m?.get(c.t+H),exitRow=m?.get(c.t+horizon*H);
  if(!entryRow||!exitRow)return null;
  const gross=c.side*(exitRow.close/entryRow.open-1);
  return {entryTime:c.t+H,exitTime:exitRow.time+H,gross};
}
const horizonCache=new Map();
for(const h of HORIZONS){
  const a=[];for(const c of candidates){const g=grossFor(c,h);if(g)a.push({...c,...g,horizon:h});}horizonCache.set(h,a);
}

function periodDays(start,end){return Math.max(1,Math.round((end-start)/DAY));}
function simulate(config,start,end,cost){
  const events=(horizonCache.get(config.horizon)??[]).filter(x=>x.t>=start&&x.exitTime<=end&&x.ensembleScore>=config.scoreFloor&&x.families>=config.minFamilies)
    .sort((a,b)=>a.entryTime-b.entryTime||b.ensembleScore-a.ensembleScore);
  const grouped=new Map();for(const e of events){const a=grouped.get(e.entryTime)??[];a.push(e);grouped.set(e.entryTime,a);}
  let equity=1,peak=1,maxDD=0,maxConcurrent=0;
  const active=[];const busy=new Map();const entryUsed=new Map();const dailyTurn=new Map();const dailyEntries=new Map(),dailyPnl=new Map();
  const trades=[];const fam={};
  function release(until){
    active.sort((a,b)=>a.exitTime-b.exitTime);
    while(active.length&&active[0].exitTime<=until){
      const p=active.shift(),pnl=p.notional*p.netRate;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));
      const d=utcDay(p.exitTime);dailyTurn.set(d,(dailyTurn.get(d)??0)+p.fraction);dailyPnl.set(d,(dailyPnl.get(d)??0)+pnl);
    }
  }
  for(const [time,arr] of [...grouped].sort((a,b)=>a[0]-b[0])){
    release(time);
    const day=utcDay(time),used=entryUsed.get(day)??0;
    if(used>=ENTRY_BUDGET-1e-9)continue;
    const bySymbol=new Map();
    for(const e of arr){const p=bySymbol.get(e.symbol);if(!p||e.ensembleScore>p.ensembleScore)bySymbol.set(e.symbol,e);}
    const choices=[...bySymbol.values()].sort((a,b)=>b.ensembleScore-a.ensembleScore).slice(0,config.maxPerHour);
    let localUsed=used;
    for(const e of choices){
      if((busy.get(e.symbol)??0)>time)continue;
      if(localUsed+config.notional>ENTRY_BUDGET+1e-9)continue;
      const exposure=active.reduce((s,p)=>s+p.fraction,0);if(exposure+config.notional>MAX_EXPOSURE+1e-9)continue;
      const netRate=e.gross-cost,notional=equity*config.notional;
      active.push({exitTime:e.exitTime,netRate,notional,fraction:config.notional});busy.set(e.symbol,e.exitTime);localUsed+=config.notional;
      dailyTurn.set(day,(dailyTurn.get(day)??0)+config.notional);dailyEntries.set(day,(dailyEntries.get(day)??0)+1);
      fam[e.family]=(fam[e.family]??0)+1;trades.push({...e,netRate,fraction:config.notional});maxConcurrent=Math.max(maxConcurrent,active.length);
    }
    entryUsed.set(day,localUsed);
  }
  release(end+10*H);
  const days=periodDays(start,end),dayKeys=[];for(let t=Math.floor(start/DAY)*DAY;t<end;t+=DAY)dayKeys.push(utcDay(t));
  const turns=dayKeys.map(d=>dailyTurn.get(d)??0),entries=dayKeys.map(d=>dailyEntries.get(d)??0),pnls=dayKeys.map(d=>dailyPnl.get(d)??0);
  const gain=trades.filter(x=>x.netRate>0).reduce((s,x)=>s+x.netRate,0),loss=-trades.filter(x=>x.netRate<=0).reduce((s,x)=>s+x.netRate,0);
  const totalReturn=equity-1,normalized30=equity>0?equity**(30/days)-1:-1;
  return {days,entries:trades.length,avgEntriesPerDay:trades.length/days,totalReturn,normalized30Return:normalized30,maxDD,
    avgDailyTurnover:turns.reduce((s,x)=>s+x,0)/turns.length,medianDailyTurnover:median(turns),
    turnoverCoverage45:turns.filter(x=>x>=4.5).length/turns.length,turnoverCoverage50:turns.filter(x=>x>=5.0).length/turns.length,
    zeroTradeDays:entries.filter(x=>x===0).length,positivePnlDays:pnls.filter(x=>x>0).length/Math.max(1,pnls.filter(x=>x!==0).length),
    winRate:trades.length?trades.filter(x=>x.netRate>0).length/trades.length:0,meanTradeNet:trades.length?trades.reduce((s,x)=>s+x.netRate,0)/trades.length:0,
    profitFactor:loss>0?gain/loss:gain>0?99:0,maxConcurrent,familyCounts:fam};
}

const configs=[];
for(const scoreFloor of SCORE_FLOORS)for(const minFamilies of MIN_FAMILIES)for(const horizon of HORIZONS)for(const notional of NOTIONALS)for(const maxPerHour of MAX_PER_HOUR)
  configs.push({scoreFloor,minFamilies,horizon,notional,maxPerHour});
const discovery=[];
for(const config of configs){const m=simulate(config,effectiveStart,split1,BASE_COST);discovery.push({config,m});}
const feasibleDiscovery=discovery.filter(x=>x.m.avgDailyTurnover>=4.35&&x.m.avgDailyTurnover<=5.35&&x.m.normalized30Return>0&&x.m.avgEntriesPerDay>=8);
const discoveryRank=(feasibleDiscovery.length?feasibleDiscovery:discovery).sort((a,b)=>{
  const af=Math.min(a.m.avgDailyTurnover,5)/5,bf=Math.min(b.m.avgDailyTurnover,5)/5;
  const as=a.m.normalized30Return+.01*af+.0004*a.m.avgEntriesPerDay-.15*a.m.maxDD;
  const bs=b.m.normalized30Return+.01*bf+.0004*b.m.avgEntriesPerDay-.15*b.m.maxDD;
  return bs-as;
}).slice(0,24);
const validated=discoveryRank.map(x=>({...x,validation:simulate(x.config,split1,split2,BASE_COST)}));
const passValidation=validated.filter(x=>x.validation.avgDailyTurnover>=4.30&&x.validation.normalized30Return>0&&x.validation.avgEntriesPerDay>=8);
const ranked=(passValidation.length?passValidation:validated).sort((a,b)=>{
  const amin=Math.min(a.m.normalized30Return,a.validation.normalized30Return),bmin=Math.min(b.m.normalized30Return,b.validation.normalized30Return);
  if(bmin!==amin)return bmin-amin;
  return b.validation.avgEntriesPerDay-a.validation.avgEntriesPerDay;
});
const selected=ranked[0];
const evaluationBase=selected?simulate(selected.config,split2,now,BASE_COST):null;
const evaluationStress=selected?simulate(selected.config,split2,now,STRESS_COST):null;
const evalMid=split2+Math.floor((now-split2)/2/H)*H;
const evaluationHalves=selected?[simulate(selected.config,split2,evalMid,BASE_COST),simulate(selected.config,evalMid,now,BASE_COST)]:[];
const accepted=!!(selected&&evaluationBase.normalized30Return>=.05&&evaluationBase.avgDailyTurnover>=4.5&&evaluationBase.avgEntriesPerDay>=8
  &&evaluationHalves.every(x=>x.totalReturn>0));
const report={
  decision:accepted?'TURNOVER_5X_AND_MONTHLY_5PCT_SUPPORTED':'TARGET_NOT_YET_PROVEN',
  authority:'RESEARCH_ONLY_NO_PAPER_OR_LIVE_DEPLOYMENT',
  target:{dailyTwoWayTurnover:5,entryBudgetEquivalent:ENTRY_BUDGET,monthlyNetReturn:0.05,priority:'maximize trade count subject to turnover and positive net return'},
  costModel:{baseRoundTripEquivalent:BASE_COST,stressRoundTripEquivalent:STRESS_COST,note:'includes existing 14bp/22bp friction assumptions plus adverse-entry allowance'},
  data:{days:DAYS,warmupHours:WARMUP_HOURS,universePolicy:'current Gate top30 active crypto-classified USDT perpetuals; first-pass feasibility only',symbols,activeSymbols,
    from:iso(dataFrom),effectiveStart:iso(effectiveStart),discovery:[iso(effectiveStart),iso(split1)],validation:[iso(split1),iso(split2)],evaluation:[iso(split2),iso(now)]},
  mechanism:'one ensemble candidate per symbol/hour from trend, breakout, pullback, reversal, quiet-drift, range-edge and market-catchup multi-factor scores; completed hourly bars only; execute next hour open; same-symbol lock while holding; max 1.5x concurrent gross exposure; daily one-way entry budget 2.5x so expected round-trip turnover is about 5x',
  candidateCount:candidates.length,configCount:configs.length,discoveryFeasibleCount:feasibleDiscovery.length,validationPassCount:passValidation.length,
  selected:selected?{config:selected.config,discovery:selected.m,validation:selected.validation,evaluationBase,evaluationStress,evaluationHalves}:null,
  accepted,
  topDiscovery:discoveryRank.slice(0,10),
  topValidated:ranked.slice(0,10).map(x=>({config:x.config,discovery:x.m,validation:x.validation}))
};
writeFileSync('/tmp/turnover-portfolio-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({decision:report.decision,target:report.target,candidateCount:report.candidateCount,configCount:report.configCount,
  discoveryFeasibleCount:report.discoveryFeasibleCount,validationPassCount:report.validationPassCount,selected:report.selected,accepted:report.accepted},null,2));