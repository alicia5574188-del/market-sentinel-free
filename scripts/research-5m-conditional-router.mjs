import { writeFileSync } from 'node:fs';

const SYMBOLS=['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','BNB_USDT','DOGE_USDT','ADA_USDT','LINK_USDT','LTC_USDT','AVAX_USDT','BCH_USDT'];
const STEP=300,DAY=86400,FETCH_DAYS=170,WARM_DAYS=7,CHUNK=3*DAY;
const END=Math.floor(Date.now()/1000/STEP)*STEP;
const START=END-FETCH_DAYS*DAY,FETCH_START=START-WARM_DAYS*DAY,EVAL_START=START+30*DAY;
const BASE_COST=.00165,STRESS_COST=.00270,ENTRY_FRAC=.10,ENTRY_BUDGET=2.5,MAX_GROSS=1.5;
const WINDOWS=[14,28],HORIZONS=[3,6,12,24],QS=[.90,.97,.99,.995,.998,.999],MAX_STEPS=[1,2,3];
const FAMILIES=['MOMENTUM','ACCEL','LIQUIDATION','CROWDING','RELATIVE','MARKET_STATE'];
const Z_LOOKBACK=7*24*12,MIN_Z_HIST=288,SHRINK=80,MIN_CELL=20,THRESH_LOOKBACK_DAYS=3;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const num=x=>{const v=Number(x);return Number.isFinite(v)?v:null;};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const dayKey=t=>new Date(t*1000).toISOString().slice(0,10);
const quantile=(a,q)=>{if(!a.length)return Infinity;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f;};
const sd=a=>{if(a.length<2)return 1;const m=mean(a),v=a.reduce((s,x)=>s+(x-m)**2,0)/a.length;return Math.sqrt(Math.max(v,1e-9));};

async function getJson(url,tries=7){
  for(let a=0;a<tries;a++){
    try{const r=await fetch(url,{headers:{Accept:'application/json'}});if(r.ok)return await r.json();if(r.status!==429&&r.status<500)throw new Error(`${r.status} ${url}`);}catch(e){if(a===tries-1)throw e;}
    await sleep(250*(a+1));
  }
}
function normStats(x){
  const time=num(x.time),mark=num(x.mark_price),oi=num(x.open_interest_usd??x.open_interest);
  if(!(time>0)||!(mark>0)||!(oi>0))return null;
  return {time,mark,oi,takerLong:Math.max(0,num(x.long_taker_size)??0),takerShort:Math.max(0,num(x.short_taker_size)??0),longLiq:Math.max(0,num(x.long_liq_usd_new??x.long_liq_usd)??0),shortLiq:Math.max(0,num(x.short_liq_usd_new??x.short_liq_usd)??0),acct:num(x.lsr_account),top:num(x.top_lsr_size),longUsers:Math.max(0,num(x.long_users)??0),shortUsers:Math.max(0,num(x.short_users)??0),funding:num(x.last_funding_rate)??0};
}
async function fetchStats(symbol){
  const out=[];
  for(let from=FETCH_START;from<END;from+=CHUNK){
    const to=Math.min(END-1,from+CHUNK-1),url=`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(symbol)}&from=${from}&to=${to}&interval=5m&limit=1000`;
    const a=await getJson(url);if(Array.isArray(a))out.push(...a.map(normStats).filter(Boolean));
  }
  return [...new Map(out.map(r=>[r.time,r])).values()].filter(r=>r.time>=FETCH_START&&r.time<END).sort((a,b)=>a.time-b.time);
}

const raw=new Map();let cursor=0;
async function worker(){while(cursor<SYMBOLS.length){const s=SYMBOLS[cursor++];try{raw.set(s,await fetchStats(s));}catch(e){console.error('FETCH_FAIL',s,String(e));raw.set(s,[]);}}}
await Promise.all(Array.from({length:8},worker));

class RollZ{
  constructor(max){this.max=max;this.q=[];this.head=0;this.sum=0;this.sq=0;}
  push(v){if(!Number.isFinite(v))return;this.q.push(v);this.sum+=v;this.sq+=v*v;while(this.q.length-this.head>this.max){const x=this.q[this.head++];this.sum-=x;this.sq-=x*x;}if(this.head>4096&&this.head*2>this.q.length){this.q=this.q.slice(this.head);this.head=0;}}
  z(v){const n=this.q.length-this.head;if(!Number.isFinite(v)||n<MIN_Z_HIST)return null;const m=this.sum/n,vr=Math.max(0,this.sq/n-m*m);if(vr<1e-14)return 0;return clamp((v-m)/Math.sqrt(vr),-6,6);}
}

const baseRowsByTime=new Map(),priceMaps=new Map();
for(const symbol of SYMBOLS){
  const rows=raw.get(symbol)??[],pm=new Map(rows.map(r=>[r.time,r]));priceMaps.set(symbol,pm);
  const rz={r1:new RollZ(Z_LOOKBACK),r3:new RollZ(Z_LOOKBACK),r12:new RollZ(Z_LOOKBACK),r36:new RollZ(Z_LOOKBACK),oi3:new RollZ(Z_LOOKBACK),oi12:new RollZ(Z_LOOKBACK),taker:new RollZ(Z_LOOKBACK),takerDelta:new RollZ(Z_LOOKBACK),activity:new RollZ(Z_LOOKBACK),liq:new RollZ(Z_LOOKBACK),div:new RollZ(Z_LOOKBACK),user:new RollZ(Z_LOOKBACK),fund:new RollZ(Z_LOOKBACK)};
  let prevTaker=null;
  for(const r of rows){
    const p1=pm.get(r.time-STEP),p3=pm.get(r.time-3*STEP),p12=pm.get(r.time-12*STEP),p36=pm.get(r.time-36*STEP);
    const r1=p1?Math.log(r.mark/p1.mark):null,r3=p3?Math.log(r.mark/p3.mark):null,r12=p12?Math.log(r.mark/p12.mark):null,r36=p36?Math.log(r.mark/p36.mark):null;
    const oi3=p3?Math.log(r.oi/p3.oi):null,oi12=p12?Math.log(r.oi/p12.oi):null;
    const taker=Math.log((r.takerLong+1)/(r.takerShort+1)),takerDelta=Number.isFinite(prevTaker)?taker-prevTaker:null,activity=Math.log1p(r.takerLong+r.takerShort);
    const liqTot=r.longLiq+r.shortLiq,liq=Math.log1p((liqTot/Math.max(r.oi,1))*1e6),liqSkew=(r.shortLiq-r.longLiq)/(liqTot+1);
    const acct=r.acct>0?Math.log(r.acct):null,top=r.top>0?Math.log(r.top):null,div=Number.isFinite(acct)&&Number.isFinite(top)?acct-top:null,user=Math.log((r.longUsers+1)/(r.shortUsers+1)),fund=r.funding;
    const vals={r1,r3,r12,r36,oi3,oi12,taker,takerDelta,activity,liq,div,user,fund};
    const z=Object.fromEntries(Object.entries(vals).map(([k,v])=>[k,rz[k].z(v)]));
    if(r.time>=START&&Object.values(z).every(Number.isFinite)){
      const row={symbol,t:r.time,mark:r.mark,z,liqSkew:clamp(liqSkew,-1,1)};const a=baseRowsByTime.get(r.time)??[];a.push(row);baseRowsByTime.set(r.time,a);
    }
    for(const [k,v] of Object.entries(vals))if(Number.isFinite(v))rz[k].push(v);
    prevTaker=taker;
  }
}

const tri=(x,c=.75)=>x>c?1:x<-c?-1:0;
const triSkew=x=>x>.25?1:x<-.25?-1:0;
const cellKey=a=>a.join(',');
const featureRows=[];
for(const t of [...baseRowsByTime.keys()].sort((a,b)=>a-b)){
  const rows=baseRowsByTime.get(t);if(rows.length<7)continue;
  const r3s=rows.map(r=>r.z.r3),r12s=rows.map(r=>r.z.r12),m3=mean(r3s),m12=mean(r12s),s3=sd(r3s),s12=sd(r12s),disp=clamp(sd(r3s),0,6);
  const btc=rows.find(r=>r.symbol==='BTC_USDT'),eth=rows.find(r=>r.symbol==='ETH_USDT');if(!btc||!eth)continue;
  for(const r of rows){
    const rel3=clamp((r.z.r3-m3)/s3,-6,6),rel12=clamp((r.z.r12-m12)/s12,-6,6),accel=clamp(r.z.r3-r.z.r12,-6,6),oiAccel=clamp(r.z.oi3-r.z.oi12,-6,6);
    const cells={
      MOMENTUM:cellKey([tri(r.z.r3),tri(r.z.r12),tri(r.z.oi3),tri(r.z.taker)]),
      ACCEL:cellKey([tri(r.z.r1),tri(accel),tri(r.z.takerDelta),tri(oiAccel)]),
      LIQUIDATION:cellKey([tri(r.z.r3),tri(r.z.liq),triSkew(r.liqSkew),tri(r.z.oi3)]),
      CROWDING:cellKey([tri(r.z.r12),tri(r.z.div),tri(r.z.user),tri(r.z.taker)]),
      RELATIVE:cellKey([tri(rel3),tri(rel12),tri(btc.z.r3),tri(btc.z.r12)]),
      MARKET_STATE:cellKey([tri(r.z.r3),tri(rel3),tri(disp),tri(r.z.activity)])
    };
    featureRows.push({symbol:r.symbol,t:r.t,cells,context:{rel3,rel12,btc3:btc.z.r3,btc12:btc.z.r12,eth3:eth.z.r3,disp}});
  }
}

const grossLabel=(r,h)=>{const pm=priceMaps.get(r.symbol),en=pm?.get(r.t+STEP),ex=pm?.get(r.t+(h+1)*STEP);return en&&ex?ex.mark/en.mark-1:null;};
for(const r of featureRows){r.y={};let ok=true;for(const h of HORIZONS){const y=grossLabel(r,h);if(!Number.isFinite(y)){ok=false;break;}r.y[h]=clamp(y,-.20,.20);}r.hasAllLabels=ok;}
const rowsByDay=new Map();for(const r of featureRows){const d=dayKey(r.t),a=rowsByDay.get(d)??[];a.push(r);rowsByDay.set(d,a);}
const allDays=[...rowsByDay.keys()].sort();

function emptyStat(){return {n:0,sum:0,sq:0};}
function addStat(dst,y){dst.n++;dst.sum+=y;dst.sq+=y*y;}
const dayAgg=new Map();
for(const d of allDays){
  const agg={global:Object.fromEntries(HORIZONS.map(h=>[h,emptyStat()])),cells:Object.fromEntries(FAMILIES.map(f=>[f,Object.fromEntries(HORIZONS.map(h=>[h,new Map()]))]))};
  for(const r of rowsByDay.get(d)){if(!r.hasAllLabels)continue;for(const h of HORIZONS){const y=r.y[h];addStat(agg.global[h],y);for(const f of FAMILIES){const k=r.cells[f],m=agg.cells[f][h],s=m.get(k)??emptyStat();addStat(s,y);m.set(k,s);}}}
  dayAgg.set(d,agg);
}
function mergeStat(dst,s){dst.n+=s.n;dst.sum+=s.sum;dst.sq+=s.sq;}
function fitModel(evalDay,windowDays,f,h){
  const dayStart=Date.parse(`${evalDay}T00:00:00Z`)/1000,trainEnd=dayStart-DAY,trainStart=trainEnd-windowDays*DAY;
  const global=emptyStat(),cells=new Map();
  for(let t=trainStart;t<trainEnd;t+=DAY){const a=dayAgg.get(dayKey(t));if(!a)continue;mergeStat(global,a.global[h]);for(const [k,s] of a.cells[f][h]){const z=cells.get(k)??emptyStat();mergeStat(z,s);cells.set(k,z);}}
  if(global.n<5000)return null;const gm=global.sum/global.n;
  return {globalMean:gm,cells};
}
function estimate(model,key){
  if(!model)return null;const s=model.cells.get(key);if(!s||s.n<MIN_CELL)return null;const pred=(s.sum+SHRINK*model.globalMean)/(s.n+SHRINK),reliability=Math.sqrt(s.n/(s.n+SHRINK)),score=Math.abs(pred)*reliability;return {pred,score,n:s.n};
}

const evalDays=allDays.filter(d=>Date.parse(`${d}T00:00:00Z`)/1000>=EVAL_START).sort();
const routeByWindowDay=new Map(WINDOWS.map(w=>[w,new Map()]));
for(const d of evalDays){
  const models=new Map();
  for(const w of WINDOWS)for(const f of FAMILIES)for(const h of HORIZONS)models.set(`${w}|${f}|${h}`,fitModel(d,w,f,h));
  const rows=rowsByDay.get(d)??[];
  for(const w of WINDOWS){
    const out=[];
    for(const r of rows){
      let best=null;
      for(const f of FAMILIES)for(const h of HORIZONS){const e=estimate(models.get(`${w}|${f}|${h}`),r.cells[f]);if(!e)continue;if(!best||e.score>best.score)best={...e,family:f,h};}
      if(!best||best.pred===0)continue;const pm=priceMaps.get(r.symbol),en=pm?.get(r.t+STEP),ex=pm?.get(r.t+(best.h+1)*STEP);if(!en||!ex)continue;
      out.push({symbol:r.symbol,signalTime:r.t,entryTime:en.time,exitTime:ex.time,gross:ex.mark/en.mark-1,dir:best.pred>0?1:-1,pred:best.pred,score:best.score,family:best.family,h:best.h,window:w,day:d});
    }
    routeByWindowDay.get(w).set(d,out);
  }
}

const policyCandidates=new Map();
for(const w of WINDOWS){
  const hist=[];
  for(let di=0;di<evalDays.length;di++){
    const d=evalDays[di],today=routeByWindowDay.get(w).get(d)??[];
    const look=hist.slice(Math.max(0,hist.length-THRESH_LOOKBACK_DAYS));
    const priorScores=look.flatMap(x=>x.scores);
    for(const q of QS){const th=priorScores.length>=500?quantile(priorScores,q):Infinity;for(const m of MAX_STEPS){const key=`${w}d|q${q}|m${m}`,a=policyCandidates.get(key)??[];for(const p of today)if(p.score>=th)a.push({...p,policy:key,q,maxPerStep:m,threshold:th});policyCandidates.set(key,a);}}
    hist.push({day:d,scores:today.map(x=>x.score).filter(Number.isFinite)});
  }
}

function simulateMonth(candidates,cost,month,maxPerStep){
  const arr=candidates.filter(x=>x.day.slice(0,7)===month).sort((a,b)=>a.entryTime-b.entryTime||b.score-a.score),grouped=new Map();
  for(const p of arr){const a=grouped.get(p.entryTime)??[];a.push(p);grouped.set(p.entryTime,a);}
  let equity=1,peak=1,maxDD=0;const active=[],busy=new Map(),entryUsed=new Map(),trades=[];const families={},horizons={};
  function release(t){active.sort((a,b)=>a.exitTime-b.exitTime);while(active.length&&active[0].exitTime<=t){const p=active.shift(),net=p.dir*p.gross-cost,pnl=p.entryEq*ENTRY_FRAC*net;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));trades.push({...p,net,pnl});families[p.family]=(families[p.family]??0)+1;horizons[p.h]=(horizons[p.h]??0)+1;}}
  for(const [t,a] of [...grouped].sort((x,y)=>x[0]-y[0])){release(t);const d=dayKey(t);let used=entryUsed.get(d)??0,selected=0;for(const p of a.sort((x,y)=>y.score-x.score)){if(selected>=maxPerStep)break;if((busy.get(p.symbol)??0)>t)continue;if(used+ENTRY_FRAC>ENTRY_BUDGET+1e-9)break;if(active.length*ENTRY_FRAC+ENTRY_FRAC>MAX_GROSS+1e-9)break;active.push({...p,entryEq:equity});busy.set(p.symbol,p.exitTime);used+=ENTRY_FRAC;selected++;}entryUsed.set(d,used);}
  release(END+2*DAY);
  const days=evalDays.filter(d=>d.slice(0,7)===month).length,nets=trades.map(x=>x.net),g=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0);
  return {month,days,totalReturn:equity-1,maxDD,trades:trades.length,avgTradesPerDay:trades.length/Math.max(1,days),avgDailyTwoWayTurnover:trades.length*ENTRY_FRAC*2/Math.max(1,days),meanTradeNet:mean(nets),pf:l?g/l:g?99:0,hit:nets.length?nets.filter(x=>x>0).length/nets.length:0,families,horizons};
}
function summarize(key,candidates,cost,months){const maxPerStep=Number(key.match(/\|m(\d+)$/)?.[1]??1),monthly=months.map(m=>simulateMonth(candidates,cost,m,maxPerStep));return {months,monthly,avgMonthReturn:mean(monthly.map(x=>x.totalReturn)),minMonthReturn:Math.min(...monthly.map(x=>x.totalReturn)),positiveMonths:monthly.filter(x=>x.totalReturn>0).length,monthsAtLeast5pct:monthly.filter(x=>x.totalReturn>=.05).length,avgTradesPerDay:mean(monthly.map(x=>x.avgTradesPerDay)),avgDailyTwoWayTurnover:mean(monthly.map(x=>x.avgDailyTwoWayTurnover)),meanTradeNet:mean(monthly.map(x=>x.meanTradeNet)),pf:mean(monthly.map(x=>x.pf)),trades:monthly.reduce((s,x)=>s+x.trades,0)};}

const monthCounts={};for(const d of evalDays){const m=d.slice(0,7);monthCounts[m]=(monthCounts[m]??0)+1;}
const fullMonthKeys=Object.entries(monthCounts).filter(([,n])=>n>=28).map(([m])=>m).sort();
const calibrationMonths=fullMonthKeys.slice(0,2),blindMonths=fullMonthKeys.slice(2,4);
if(calibrationMonths.length<2||blindMonths.length<2)throw new Error(`need four evaluation months, got ${fullMonthKeys.join(',')}`);
const rows=[];
for(const [key,candidates] of policyCandidates){const calibration=summarize(key,candidates,BASE_COST,calibrationMonths),calibrationStress=summarize(key,candidates,STRESS_COST,calibrationMonths),blind=summarize(key,candidates,BASE_COST,blindMonths),blindStress=summarize(key,candidates,STRESS_COST,blindMonths);rows.push({key,calibration,calibrationStress,blind,blindStress});}
const feasible=rows.filter(x=>x.calibration.avgMonthReturn>=.05&&x.calibration.minMonthReturn>0&&x.calibrationStress.avgMonthReturn>=0&&x.calibration.avgTradesPerDay>0).sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay||b.calibration.avgMonthReturn-a.calibration.avgMonthReturn);
const targetCandidate=feasible[0]??null;
const bestReturn=[...rows].sort((a,b)=>b.calibration.avgMonthReturn-a.calibration.avgMonthReturn)[0]??null;
const bestPositiveFrequency=[...rows].filter(x=>x.calibration.avgMonthReturn>0).sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay||b.calibration.avgMonthReturn-a.calibration.avgMonthReturn)[0]??null;
const pareto=rows.filter((x,i,a)=>!a.some((y,j)=>j!==i&&y.calibration.avgTradesPerDay>=x.calibration.avgTradesPerDay&&y.calibration.avgMonthReturn>=x.calibration.avgMonthReturn&&(y.calibration.avgTradesPerDay>x.calibration.avgTradesPerDay||y.calibration.avgMonthReturn>x.calibration.avgMonthReturn))).sort((a,b)=>b.calibration.avgTradesPerDay-a.calibration.avgTradesPerDay).slice(0,20);
const blindMeets=!!targetCandidate&&targetCandidate.blind.avgMonthReturn>=.05&&targetCandidate.blind.minMonthReturn>0&&targetCandidate.blind.monthsAtLeast5pct===blindMonths.length&&targetCandidate.blindStress.avgMonthReturn>-0.02;
const report={decision:blindMeets?'CONDITIONAL_ROUTER_BLIND_MEETS_5PCT':targetCandidate?'CONDITIONAL_ROUTER_CALIBRATION_ONLY_FAILS_BLIND':'CONDITIONAL_ROUTER_NO_5PCT_POINT_IN_CALIBRATION',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',goal:'maximize daily trades subject to >=5% monthly net using nonlinear conditional state routing',method:'contract_stats-only 5m causal features; six coarse nonlinear interaction families; daily 14d/28d cell estimates with shrinkage; each opportunity routes to the strongest family and 15/30/60/120m horizon; prior-3d score thresholds; no NO_TRADE regime gate; first two full months calibrate frequency, next two are untouched blind',cost:{base:BASE_COST,stress:STRESS_COST},data:{symbols:SYMBOLS,availability:Object.fromEntries([...raw].map(([s,a])=>[s,{rows:a.length,first:a[0]?.time??null,last:a.at(-1)?.time??null}]))},featureRows:featureRows.length,evalDays:evalDays.length,families:FAMILIES,windows:WINDOWS,horizons:HORIZONS,quantiles:QS,maxSteps:MAX_STEPS,fullMonthKeys,calibrationMonths,blindMonths,policyCount:rows.length,feasibleAt5pctCount:feasible.length,maxTradesAt5pctCalibration:targetCandidate?.calibration.avgTradesPerDay??0,targetCandidate,bestReturn,bestPositiveFrequency,paretoFrontier:pareto};
writeFileSync('/tmp/5m-conditional-router-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));