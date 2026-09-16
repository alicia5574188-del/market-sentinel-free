import { writeFileSync } from 'node:fs';

const SYMBOLS=['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','BNB_USDT','DOGE_USDT','ADA_USDT','LINK_USDT','LTC_USDT','AVAX_USDT','BCH_USDT'];
const STEP=300, DAY=86400, FETCH_DAYS=170, WARM_DAYS=8, CHUNK=3*DAY;
const END=Math.floor(Date.now()/1000/STEP)*STEP;
const START=END-FETCH_DAYS*DAY;
const FETCH_START=START-WARM_DAYS*DAY;
const EVAL_START=START+28*DAY;
const BASE_COST=.00165, STRESS_COST=.00270;
const ENTRY_FRAC=.10, ENTRY_BUDGET=2.5, MAX_GROSS=1.5;
const WINDOWS=[7,14,21], HORIZONS=[3,6,12,24], QS=[.50,.70,.85,.93], MAX_STEPS=[1,2,3];
const RIDGE=.08, MIN_Z_HIST=576, Z_LOOKBACK=7*24*12;
const SEL_LOOKBACK_DAYS=7, THRESH_LOOKBACK_DAYS=3;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const num=x=>{const v=Number(x);return Number.isFinite(v)?v:null;};
const dayKey=t=>new Date(t*1000).toISOString().slice(0,10);
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const quantile=(a,q)=>{if(!a.length)return Infinity;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f;};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

async function getJson(url,tries=7){
  for(let a=0;a<tries;a++){
    try{
      const r=await fetch(url,{headers:{Accept:'application/json'}});
      if(r.ok)return await r.json();
      if(r.status!==429&&r.status<500)throw new Error(`${r.status} ${url}`);
    }catch(e){if(a===tries-1)throw e;}
    await sleep(250*(a+1));
  }
}
function normStats(x){
  const time=num(x.time),mark=num(x.mark_price),oi=num(x.open_interest_usd??x.open_interest);
  if(!(time>0)||!(mark>0)||!(oi>0))return null;
  return {time,mark,oi,takerLong:Math.max(0,num(x.long_taker_size)??0),takerShort:Math.max(0,num(x.short_taker_size)??0),longLiq:Math.max(0,num(x.long_liq_usd_new??x.long_liq_usd)??0),shortLiq:Math.max(0,num(x.short_liq_usd_new??x.short_liq_usd)??0),acct:num(x.lsr_account),top:num(x.top_lsr_size),longUsers:Math.max(0,num(x.long_users)??0),shortUsers:Math.max(0,num(x.short_users)??0),funding:num(x.last_funding_rate)??0};
}
function normCandle(x){
  const t=num(x.t??x[0]),o=num(x.o??x[5]),h=num(x.h??x[3]),l=num(x.l??x[4]),c=num(x.c??x[2]),v=num(x.v??x[1]??0);
  if(!(t>0)||!(o>0)||!(h>0)||!(l>0)||!(c>0))return null;
  return {t,o,h,l,c,v:Math.max(0,v??0)};
}
async function fetchStats(symbol){
  const out=[];
  for(let from=FETCH_START;from<END;from+=CHUNK){
    const to=Math.min(END-1,from+CHUNK-1);
    const url=`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(symbol)}&from=${from}&to=${to}&interval=5m&limit=1000`;
    const a=await getJson(url); if(Array.isArray(a))out.push(...a.map(normStats).filter(Boolean));
  }
  return [...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time);
}
async function fetchCandles(symbol){
  const out=[];
  for(let from=FETCH_START;from<END;from+=CHUNK){
    const to=Math.min(END-1,from+CHUNK-1);
    const url=`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&from=${from}&to=${to}&interval=5m`;
    const a=await getJson(url); if(Array.isArray(a))out.push(...a.map(normCandle).filter(Boolean));
  }
  return [...new Map(out.map(r=>[r.t,r])).values()].sort((a,b)=>a.t-b.t);
}

const stats=new Map(),candles=new Map();
const tasks=SYMBOLS.flatMap(symbol=>[{symbol,type:'stats'},{symbol,type:'candles'}]);
let taskCursor=0;
async function worker(){
  while(taskCursor<tasks.length){
    const {symbol,type}=tasks[taskCursor++];
    try{if(type==='stats')stats.set(symbol,await fetchStats(symbol));else candles.set(symbol,await fetchCandles(symbol));}
    catch(e){console.error('FETCH_FAIL',type,symbol,String(e));if(type==='stats')stats.set(symbol,[]);else candles.set(symbol,[]);}
  }
}
await Promise.all(Array.from({length:10},worker));

class RollZ{
  constructor(max){this.max=max;this.q=[];this.head=0;this.sum=0;this.sq=0;}
  push(v){if(!Number.isFinite(v))return;this.q.push(v);this.sum+=v;this.sq+=v*v;while(this.q.length-this.head>this.max){const x=this.q[this.head++];this.sum-=x;this.sq-=x*x;}if(this.head>4096&&this.head*2>this.q.length){this.q=this.q.slice(this.head);this.head=0;}}
  z(v){const n=this.q.length-this.head;if(!Number.isFinite(v)||n<MIN_Z_HIST)return null;const m=this.sum/n,vr=Math.max(0,this.sq/n-m*m);if(vr<1e-14)return 0;return clamp((v-m)/Math.sqrt(vr),-6,6);}
}
function sd(a){if(a.length<2)return 1;const m=mean(a),v=a.reduce((s,x)=>s+(x-m)**2,0)/a.length;return Math.sqrt(Math.max(v,1e-9));}

const baseRowsByTime=new Map(), priceMaps=new Map();
for(const symbol of SYMBOLS){
  const sr=stats.get(symbol)??[], cr=candles.get(symbol)??[];
  const sm=new Map(sr.map(r=>[r.time,r])), cm=new Map(cr.map(r=>[r.t,r]));
  priceMaps.set(symbol,sm);
  const times=sr.map(r=>r.time).filter(t=>cm.has(t)).sort((a,b)=>a-b);
  const rz={r1:new RollZ(Z_LOOKBACK),r3:new RollZ(Z_LOOKBACK),r12:new RollZ(Z_LOOKBACK),range:new RollZ(Z_LOOKBACK),vol:new RollZ(Z_LOOKBACK),oi3:new RollZ(Z_LOOKBACK),oi12:new RollZ(Z_LOOKBACK),taker:new RollZ(Z_LOOKBACK),takerDelta:new RollZ(Z_LOOKBACK),liq:new RollZ(Z_LOOKBACK),div:new RollZ(Z_LOOKBACK),user:new RollZ(Z_LOOKBACK)};
  let prevTaker=null;
  for(let i=0;i<times.length;i++){
    const t=times[i],s=sm.get(t),c=cm.get(t);
    const t1=times[i-1]===t-STEP?times[i-1]:null;
    const p1=t1?sm.get(t1):null,p3=sm.get(t-3*STEP),p12=sm.get(t-12*STEP);
    const r1=p1?Math.log(s.mark/p1.mark):null,r3=p3?Math.log(s.mark/p3.mark):null,r12=p12?Math.log(s.mark/p12.mark):null;
    const range=Math.log(c.h/c.l),vol=Math.log1p(c.v),oi3=p3?Math.log(s.oi/p3.oi):null,oi12=p12?Math.log(s.oi/p12.oi):null;
    const taker=Math.log((s.takerLong+1)/(s.takerShort+1)),takerDelta=Number.isFinite(prevTaker)?taker-prevTaker:null;
    const liqTot=s.longLiq+s.shortLiq,liq=Math.log1p((liqTot/Math.max(s.oi,1))*1e6),liqSkew=(s.shortLiq-s.longLiq)/(liqTot+1);
    const acct=s.acct>0?Math.log(s.acct):null,top=s.top>0?Math.log(s.top):null,div=Number.isFinite(acct)&&Number.isFinite(top)?acct-top:null,user=Math.log((s.longUsers+1)/(s.shortUsers+1));
    const z={r1:rz.r1.z(r1),r3:rz.r3.z(r3),r12:rz.r12.z(r12),range:rz.range.z(range),vol:rz.vol.z(vol),oi3:rz.oi3.z(oi3),oi12:rz.oi12.z(oi12),taker:rz.taker.z(taker),takerDelta:rz.takerDelta.z(takerDelta),liq:rz.liq.z(liq),div:rz.div.z(div),user:rz.user.z(user)};
    if(t>=START&&Object.values(z).every(Number.isFinite)){
      const row={symbol,t,mark:s.mark,z,liqSkew:clamp(liqSkew,-1,1)};
      const a=baseRowsByTime.get(t)??[];a.push(row);baseRowsByTime.set(t,a);
    }
    for(const [k,v] of Object.entries({r1,r3,r12,range,vol,oi3,oi12,taker,takerDelta,liq,div,user}))if(Number.isFinite(v))rz[k].push(v);
    prevTaker=taker;
  }
}

const featureRows=[];
const sortedTimes=[...baseRowsByTime.keys()].sort((a,b)=>a-b);
for(const t of sortedTimes){
  const rows=baseRowsByTime.get(t); if(rows.length<7)continue;
  const r3s=rows.map(r=>r.z.r3),r12s=rows.map(r=>r.z.r12),m3=mean(r3s),m12=mean(r12s),s3=sd(r3s),s12=sd(r12s),disp=clamp(sd(r3s),0,6);
  const btc=rows.find(r=>r.symbol==='BTC_USDT'),eth=rows.find(r=>r.symbol==='ETH_USDT'); if(!btc||!eth)continue;
  const d=new Date(t*1000),hour=d.getUTCHours()+d.getUTCMinutes()/60,ang=2*Math.PI*hour/24,weekend=(d.getUTCDay()===0||d.getUTCDay()===6)?1:0;
  for(const r of rows){
    const x=[
      r.z.r1,r.z.r3,r.z.r12,clamp(r.z.r3-r.z.r12,-6,6),r.z.range,r.z.vol,
      r.z.oi3,r.z.oi12,clamp(r.z.oi3-r.z.oi12,-6,6),r.z.taker,r.z.takerDelta,r.z.liq,r.liqSkew,
      r.z.div,r.z.user,clamp((r.z.r3-m3)/s3,-6,6),clamp((r.z.r12-m12)/s12,-6,6),
      btc.z.r3,btc.z.r12,eth.z.r3,m3,disp,Math.sin(ang),Math.cos(ang),weekend
    ];
    if(x.every(Number.isFinite))featureRows.push({symbol:r.symbol,t,x});
  }
}

const FEATURE_COUNT=25, DIM=FEATURE_COUNT+1;
if(!featureRows.length||featureRows[0].x.length!==FEATURE_COUNT)throw new Error(`feature shape mismatch ${featureRows[0]?.x.length}`);
const rowsByDay=new Map();
for(const r of featureRows){const d=dayKey(r.t),a=rowsByDay.get(d)??[];a.push(r);rowsByDay.set(d,a);}
const allDays=[...rowsByDay.keys()].sort();

const grossLabel=(r,h)=>{const pm=priceMaps.get(r.symbol),en=pm?.get(r.t+STEP),ex=pm?.get(r.t+(h+1)*STEP);return en&&ex?ex.mark/en.mark-1:null;};
for(const r of featureRows){r.y={};let ok=true;for(const h of HORIZONS){const y=grossLabel(r,h);if(!Number.isFinite(y)){ok=false;break;}r.y[h]=clamp(y,-.20,.20);}r.hasAllLabels=ok;}

function zeroMatrix(){return Array.from({length:DIM},()=>new Float64Array(DIM));}
function zeroVec(){return new Float64Array(DIM);}
const dayStats=new Map();
for(const d of allDays){
  const A=zeroMatrix(), b=Object.fromEntries(HORIZONS.map(h=>[h,zeroVec()])); let count=0;
  for(const r of rowsByDay.get(d)){if(!r.hasAllLabels)continue;const v=[1,...r.x];count++;
    for(let i=0;i<DIM;i++){const vi=v[i];for(let j=i;j<DIM;j++)A[i][j]+=vi*v[j];for(const h of HORIZONS)b[h][i]+=vi*r.y[h];}
  }
  for(let i=0;i<DIM;i++)for(let j=0;j<i;j++)A[i][j]=A[j][i];
  dayStats.set(d,{A,b,count});
}
function addMat(dst,src,scale=1){for(let i=0;i<DIM;i++)for(let j=0;j<DIM;j++)dst[i][j]+=scale*src[i][j];}
function addVec(dst,src,scale=1){for(let i=0;i<DIM;i++)dst[i]+=scale*src[i];}
function solve(A,b,lambda=RIDGE){
  const n=A.length,M=Array.from({length:n},(_,i)=>{const row=new Float64Array(n+1);for(let j=0;j<n;j++)row[j]=A[i][j];row[n]=b[i];return row;});
  for(let i=1;i<n;i++)M[i][i]+=lambda;
  for(let col=0;col<n;col++){
    let piv=col;for(let r=col+1;r<n;r++)if(Math.abs(M[r][col])>Math.abs(M[piv][col]))piv=r;
    if(Math.abs(M[piv][col])<1e-10)continue;
    if(piv!==col){const tmp=M[col];M[col]=M[piv];M[piv]=tmp;}
    const den=M[col][col];for(let j=col;j<=n;j++)M[col][j]/=den;
    for(let r=0;r<n;r++){if(r===col)continue;const f=M[r][col];if(Math.abs(f)<1e-14)continue;for(let j=col;j<=n;j++)M[r][j]-=f*M[col][j];}
  }
  return new Float64Array(M.map(row=>row[n]));
}
function fitWindow(evalDay,windowDays,h){
  const dayStart=Date.parse(`${evalDay}T00:00:00Z`)/1000, trainEnd=dayStart-DAY, trainStart=trainEnd-windowDays*DAY;
  const A=zeroMatrix(),b=zeroVec();let count=0;
  for(let t=trainStart;t<trainEnd;t+=DAY){const d=dayKey(t),s=dayStats.get(d);if(!s?.count)continue;addMat(A,s.A);addVec(b,s.b[h]);count+=s.count;}
  if(count<2000)return null;for(let i=0;i<DIM;i++){for(let j=0;j<DIM;j++)A[i][j]/=count;b[i]/=count;}return {w:solve(A,b),count};
}
function dot(w,x){let s=w[0];for(let i=0;i<x.length;i++)s+=w[i+1]*x[i];return clamp(s,-.08,.08);}
function tradeMetrics(trades,cost){
  if(!trades.length)return {trades:0,sum:0,mean:0,pf:0,hit:0,turnover:0};
  const nets=trades.map(t=>t.dir*t.gross-cost),sum=nets.reduce((s,x)=>s+ENTRY_FRAC*x,0),g=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0);
  return {trades:trades.length,sum,mean:mean(nets),pf:l?g/l:g?99:0,hit:nets.filter(x=>x>0).length/nets.length,turnover:trades.length*ENTRY_FRAC*2};
}
function makeDayTrades(preds,threshold,maxPerStep){
  const byTime=new Map();for(const p of preds){if(Math.abs(p.pred)<threshold||!Number.isFinite(p.gross))continue;const a=byTime.get(p.entryTime)??[];a.push({...p,dir:p.pred>=0?1:-1});byTime.set(p.entryTime,a);}
  const busy=new Map(),out=[];let entryUsed=0;
  for(const [t,a] of [...byTime].sort((x,y)=>x[0]-y[0])){
    for(const p of a.sort((x,y)=>Math.abs(y.pred)-Math.abs(x.pred)).slice(0,maxPerStep)){
      if(entryUsed+ENTRY_FRAC>ENTRY_BUDGET+1e-9)break;if((busy.get(p.symbol)??0)>t)continue;
      busy.set(p.symbol,p.exitTime);entryUsed+=ENTRY_FRAC;out.push(p);
    }
    if(entryUsed>=ENTRY_BUDGET-1e-9)break;
  }
  return out;
}

const evalDays=allDays.filter(d=>Date.parse(`${d}T00:00:00Z`)/1000>=EVAL_START&&Date.parse(`${d}T00:00:00Z`)/1000<END);
const expertIds=[];for(const w of WINDOWS)for(const h of HORIZONS)expertIds.push(`${w}d_${h}b`);
const predHist=new Map(expertIds.map(id=>[id,[]]));
const policyHist=new Map();
const selectedDaily=[];const selectedTrades=[];

function policyKey(expertId,q,maxStep){return `${expertId}|q${q}|m${maxStep}`;}
function recentPolicyAggregate(key,dayStart){
  const a=(policyHist.get(key)??[]).filter(r=>r.dayStart<dayStart&&r.dayStart>=dayStart-SEL_LOOKBACK_DAYS*DAY);if(!a.length)return null;
  const trades=a.reduce((s,r)=>s+r.base.trades,0),baseSum=a.reduce((s,r)=>s+r.base.sum,0),stressSum=a.reduce((s,r)=>s+r.stress.sum,0),baseNets=a.flatMap(r=>r.baseNets),stressNets=a.flatMap(r=>r.stressNets);
  const gm=x=>{if(!x.length)return {mean:0,pf:0};const g=x.filter(v=>v>0).reduce((s,v)=>s+v,0),l=-x.filter(v=>v<=0).reduce((s,v)=>s+v,0);return {mean:mean(x),pf:l?g/l:g?99:0};};
  return {days:a.length,trades,baseSum,stressSum,base:gm(baseNets),stress:gm(stressNets),avgTurnover:mean(a.map(r=>r.base.turnover))};
}
function choosePolicy(dayStart){
  const ranked=[];
  for(const id of expertIds)for(const q of QS)for(const m of MAX_STEPS){const key=policyKey(id,q,m),r=recentPolicyAggregate(key,dayStart);if(!r||r.days<3||r.trades<30)continue;const eligible=r.baseSum>0&&r.base.pf>1&&r.stress.mean>-0.00025;const fallback=r.baseSum>0&&r.base.pf>1;const score=r.baseSum+.5*r.stressSum+.00005*Math.min(r.trades,500)+.0002*Math.min(r.avgTurnover,5);ranked.push({key,id,q,m,r,eligible,fallback,score});}
  let pool=ranked.filter(x=>x.eligible);let tier='RECENT_BASE_STRESS_POSITIVE';if(!pool.length){pool=ranked.filter(x=>x.fallback);tier='RECENT_BASE_POSITIVE';}if(!pool.length)return null;pool.sort((a,b)=>b.score-a.score);return {...pool[0],tier};
}

for(const d of evalDays){
  const dayStart=Date.parse(`${d}T00:00:00Z`)/1000,dayRows=(rowsByDay.get(d)??[]).filter(r=>r.hasAllLabels);
  const models=new Map();
  for(const w of WINDOWS)for(const h of HORIZONS){const id=`${w}d_${h}b`,fit=fitWindow(d,w,h);if(fit)models.set(id,{...fit,w,h});}
  const predsByExpert=new Map();
  for(const [id,m] of models){const arr=[];for(const r of dayRows){const pred=dot(m.w,r.x),gross=r.y[m.h];arr.push({symbol:r.symbol,t:r.t,entryTime:r.t+STEP,exitTime:r.t+(m.h+1)*STEP,pred,gross,h:m.h,expertId:id});}predsByExpert.set(id,arr);}
  const thresholds=new Map();
  for(const id of expertIds){const hist=(predHist.get(id)??[]).filter(p=>p.dayStart>=dayStart-THRESH_LOOKBACK_DAYS*DAY&&p.dayStart<dayStart),vals=hist.flatMap(p=>p.absPreds);if(vals.length<500)continue;vals.sort((a,b)=>a-b);thresholds.set(id,Object.fromEntries(QS.map(q=>[q,vals[Math.floor((vals.length-1)*q)]])));}
  const choice=choosePolicy(dayStart);
  let chosenTrades=[];
  if(choice&&predsByExpert.has(choice.id)&&thresholds.has(choice.id))chosenTrades=makeDayTrades(predsByExpert.get(choice.id),thresholds.get(choice.id)[choice.q],choice.m);
  selectedDaily.push({day:d,dayStart,choice:choice?{key:choice.key,tier:choice.tier,expert:choice.id,q:choice.q,maxPerStep:choice.m,recent:choice.r}:null,trades:chosenTrades.length,entryTurnover:chosenTrades.length*ENTRY_FRAC});
  selectedTrades.push(...chosenTrades.map(t=>({...t,selectionDay:d,selectionKey:choice?.key??null})));
  for(const [id,arr] of predsByExpert){
    const th=thresholds.get(id); if(th){
      for(const q of QS)for(const m of MAX_STEPS){const trades=makeDayTrades(arr,th[q],m),base=tradeMetrics(trades,BASE_COST),stress=tradeMetrics(trades,STRESS_COST),key=policyKey(id,q,m),rec={day:d,dayStart,base,stress,baseNets:trades.map(t=>t.dir*t.gross-BASE_COST),stressNets:trades.map(t=>t.dir*t.gross-STRESS_COST)};const a=policyHist.get(key)??[];a.push(rec);policyHist.set(key,a);}
    }
    const a=predHist.get(id)??[];a.push({dayStart,absPreds:arr.map(x=>Math.abs(x.pred))});while(a.length&&a[0].dayStart<dayStart-(THRESH_LOOKBACK_DAYS+1)*DAY)a.shift();predHist.set(id,a);
  }
}

function simulatePortfolio(candidates,cost){
  const arr=[...candidates].sort((a,b)=>a.entryTime-b.entryTime||Math.abs(b.pred)-Math.abs(a.pred)),active=[],busy=new Map(),entryUsed=new Map(),turn=new Map(),pnlDay=new Map(),trades=[];let equity=1,peak=1,maxDD=0;
  function release(t){active.sort((a,b)=>a.exitTime-b.exitTime);while(active.length&&active[0].exitTime<=t){const p=active.shift(),net=p.dir*p.gross-cost,pnl=p.entryEq*ENTRY_FRAC*net;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));const d=dayKey(p.exitTime);turn.set(d,(turn.get(d)??0)+ENTRY_FRAC);pnlDay.set(d,(pnlDay.get(d)??0)+pnl);trades.push({...p,net,pnl});}}
  for(const p of arr){release(p.entryTime);const d=dayKey(p.entryTime),u=entryUsed.get(d)??0;if(u+ENTRY_FRAC>ENTRY_BUDGET+1e-9)continue;if((busy.get(p.symbol)??0)>p.entryTime)continue;if(active.length*ENTRY_FRAC+ENTRY_FRAC>MAX_GROSS+1e-9)continue;active.push({...p,entryEq:equity});busy.set(p.symbol,p.exitTime);entryUsed.set(d,u+ENTRY_FRAC);turn.set(d,(turn.get(d)??0)+ENTRY_FRAC);}
  release(END+2*DAY);
  const startDay=Math.floor(EVAL_START/DAY)*DAY,days=[];for(let t=startDay;t<END;t+=DAY)days.push(dayKey(t));
  const daily=days.map(d=>({day:d,pnl:pnlDay.get(d)??0,turnover:turn.get(d)??0,trades:trades.filter(x=>dayKey(x.entryTime)===d).length}));
  let eq=1;const monthlyMap=new Map();
  for(const rec of daily){const m=rec.day.slice(0,7),x=monthlyMap.get(m)??{month:m,startEq:eq,endEq:eq,pnl:0,turnover:0,trades:0,days:0,positiveDays:0};x.days++;x.pnl+=rec.pnl;x.turnover+=rec.turnover;x.trades+=rec.trades;if(rec.pnl>0)x.positiveDays++;eq+=rec.pnl;x.endEq=eq;monthlyMap.set(m,x);}
  const monthly=[...monthlyMap.values()].map(x=>({...x,return:x.startEq>0?x.endEq/x.startEq-1:0,avgDailyTurnover:x.turnover/Math.max(1,x.days),avgTradesPerDay:x.trades/Math.max(1,x.days),positiveDayRatio:x.positiveDays/Math.max(1,x.days),fullMonth:x.days>=28}));
  const avgTurn=mean(daily.map(x=>x.turnover)),avgTrades=mean(daily.map(x=>x.trades)),full=monthly.filter(x=>x.fullMonth),fullAvg=mean(full.map(x=>x.return)),g=trades.filter(x=>x.net>0).reduce((s,x)=>s+x.net,0),l=-trades.filter(x=>x.net<=0).reduce((s,x)=>s+x.net,0);
  return {equity,totalReturn:equity-1,maxDD,trades:trades.length,avgTradesPerDay:avgTrades,avgDailyTwoWayTurnover:avgTurn,daysAtLeast4_5x:daily.filter(x=>x.turnover>=4.5).length/Math.max(1,daily.length),zeroTradeDays:daily.filter(x=>x.trades===0).length,meanTradeNet:mean(trades.map(x=>x.net)),pf:l?g/l:g?99:0,fullMonths:full.length,avgFullMonthReturn:fullAvg,monthsAtLeast5pct:full.filter(x=>x.return>=.05).length,positiveFullMonths:full.filter(x=>x.return>0).length,monthly,daily};
}
const base=simulatePortfolio(selectedTrades,BASE_COST),stress=simulatePortfolio(selectedTrades,STRESS_COST);
const meetsTarget=base.fullMonths>=2&&base.avgFullMonthReturn>=.05&&base.avgDailyTwoWayTurnover>=4.5&&base.positiveFullMonths>=Math.ceil(base.fullMonths*.75)&&stress.avgFullMonthReturn>-0.02;
const promising=!meetsTarget&&base.fullMonths>=2&&base.avgFullMonthReturn>0&&base.positiveFullMonths>=Math.ceil(base.fullMonths*.6)&&base.meanTradeNet>0&&stress.meanTradeNet>-0.00025;
const data=Object.fromEntries(SYMBOLS.map(s=>[s,{stats:(stats.get(s)??[]).length,candles:(candles.get(s)??[]).length}]));
const selectionCounts={};for(const x of selectedDaily){const k=x.choice?.key??'NO_TRADE';selectionCounts[k]=(selectionCounts[k]??0)+1;}
const report={decision:meetsTarget?'ONLINE_5M_RANKER_MEETS_5X_5PCT_TARGET':promising?'ONLINE_5M_RANKER_POSITIVE_BELOW_TARGET':'ONLINE_5M_RANKER_NOT_PROVEN',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',goal:'daily-refit short-memory 5m joint-state ranking toward 5x two-way turnover and >=5% monthly net',period:{fetchStart:new Date(FETCH_START*1000).toISOString(),start:new Date(START*1000).toISOString(),evalStart:new Date(EVAL_START*1000).toISOString(),end:new Date(END*1000).toISOString()},cost:{base:BASE_COST,stress:STRESS_COST},method:'causal 5m price+candle volume/range+OI+taker+liquidation+account/top/user structure; per-symbol 7d trailing normalization; 7/14/21d rolling ridge experts for 15/30/60/120m labels; training excludes the immediately prior UTC day to guarantee all labels known; weights frozen daily; thresholds from prior 3d predictions; policy selected only from prior 7d realized paper performance; enter next 5m bar; no same-symbol overlap; 2.5x daily entry budget = 5x two-way target',features:FEATURE_COUNT,experts:expertIds.length,policyCount:expertIds.length*QS.length*MAX_STEPS.length,data,featureRows:featureRows.length,evalDays:evalDays.length,selectionCounts,selectedDaily,base,stress,meetsTarget,promising};
writeFileSync('/tmp/5m-online-state-ranker-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({decision:report.decision,authority:report.authority,goal:report.goal,period:report.period,cost:report.cost,method:report.method,features:report.features,experts:report.experts,policyCount:report.policyCount,data:report.data,featureRows:report.featureRows,evalDays:report.evalDays,selectionCounts:report.selectionCounts,base:{totalReturn:base.totalReturn,maxDD:base.maxDD,trades:base.trades,avgTradesPerDay:base.avgTradesPerDay,avgDailyTwoWayTurnover:base.avgDailyTwoWayTurnover,daysAtLeast4_5x:base.daysAtLeast4_5x,zeroTradeDays:base.zeroTradeDays,meanTradeNet:base.meanTradeNet,pf:base.pf,fullMonths:base.fullMonths,avgFullMonthReturn:base.avgFullMonthReturn,monthsAtLeast5pct:base.monthsAtLeast5pct,positiveFullMonths:base.positiveFullMonths,monthly:base.monthly},stress:{totalReturn:stress.totalReturn,maxDD:stress.maxDD,trades:stress.trades,avgTradesPerDay:stress.avgTradesPerDay,avgDailyTwoWayTurnover:stress.avgDailyTwoWayTurnover,meanTradeNet:stress.meanTradeNet,pf:stress.pf,avgFullMonthReturn:stress.avgFullMonthReturn,monthly:stress.monthly},meetsTarget,promising},null,2));
