import { readFileSync, writeFileSync } from "node:fs";

const PRICE_INPUT=process.env.PRICE_DATASET??"/tmp/gate-price-5m-202604-202608.json";
const FLOW_INPUT=process.env.FLOW_DATASET??"/tmp/gate-flow-5m-202604-202608.json";
const OUTPUT=process.env.FLOW_RESEARCH_OUTPUT??"/tmp/flow-event-alpha.json";
const FRICTION=.0014,STRESS_FRICTION=.0022,STRESS_DELTA=STRESS_FRICTION-FRICTION,DAY=86400;
const priceRaw=JSON.parse(readFileSync(PRICE_INPUT,"utf8")),flowRaw=JSON.parse(readFileSync(FLOW_INPUT,"utf8"));
if(priceRaw.interval!=="5m"||flowRaw.interval!=="5m")throw new Error("Requires 5m price and flow datasets");
const symbols=priceRaw.symbols.filter(s=>flowRaw.symbols.includes(s));if(symbols.length<15)throw new Error(`Only ${symbols.length} common symbols`);
const TRAIN_END=Date.UTC(2026,6,1)/1000,FROM=Math.max(priceRaw.from,flowRaw.from),TO=Math.min(priceRaw.now??priceRaw.to,flowRaw.to);
const sum=a=>a.reduce((x,y)=>x+y,0),median=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]??0;},days=(a,b)=>(b-a)/DAY;
const monthKey=t=>new Date(t*1000).toISOString().slice(0,7).replace("-","");
const priceBy=new Map(priceRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,new Map(d.rows.map(r=>[r.time,r]))]));
const flowMeta=new Map(flowRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,d]));
const flowBy=new Map(flowRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,new Map(d.rows.map(r=>[r[0],r]))]));
const fundingBy=new Map(flowRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,d.funding??[]]));
const flowRow=(s,t)=>flowBy.get(s)?.get(t)??null,priceRow=(s,t)=>priceBy.get(s)?.get(t)??null;
function lastFunding(symbol,time){const a=fundingBy.get(symbol)??[];let lo=0,hi=a.length-1,best=-1;while(lo<=hi){const m=(lo+hi)>>1;if(a[m][0]<=time){best=m;lo=m+1;}else hi=m-1;}return best>=0?Number(a[best][1]):0;}
const times=[...new Set((flowMeta.get(symbols[0])?.rows??[]).map(r=>r[0]).filter(t=>t>=FROM&&t<TO))].sort((a,b)=>a-b);

const observations=[];
for(let ti=12;ti<times.length-24;ti+=6){ // 30m event clock; underlying features/exits remain 5m
  const time=times[ti],snapshot=[];
  for(const symbol of symbols){const f0=flowRow(symbol,time),p0=priceRow(symbol,time);if(!f0||!p0)continue;
    const back=bars=>({f:flowRow(symbol,time-bars*300),p:priceRow(symbol,time-bars*300)}),b3=back(3),b6=back(6),b12=back(12);if(!b3.f||!b3.p||!b6.f||!b6.p||!b12.f||!b12.p)continue;
    const r=p=>p0.close/p.close-1,oi=f=>f0[2]>0&&f[2]>0?f0[2]/f[2]-1:0,oiUsd=f=>f0[1]>0&&f[1]>0?f0[1]/f[1]-1:0;
    const l=Number(f0[3]??0),s=Number(f0[4]??0),td=l+s,taker=td>0?(l-s)/td:0;
    const longLiq=Number(f0[5]??0),shortLiq=Number(f0[6]??0),liqTotal=longLiq+shortLiq;
    snapshot.push({symbol,time,price:p0.close,r15:r(b3.p),r30:r(b6.p),r60:r(b12.p),oi15:oi(b3.f),oi30:oi(b6.f),oi60:oi(b12.f),oiUsd30:oiUsd(b6.f),taker,
      liqRate:liqTotal/Math.max(Number(f0[1]??0),1),liqDir:liqTotal>0?(shortLiq-longLiq)/liqTotal:0,liqUsd:liqTotal,
      lsrTaker:Number(f0[7]??0),lsrAccount:Number(f0[8]??0),topLsrSize:Number(f0[9]??0),topLsrAccount:Number(f0[10]??0),funding:lastFunding(symbol,time)});}
  if(snapshot.length<Math.max(12,symbols.length-3))continue;
  const med={r30:median(snapshot.map(x=>x.r30)),oi30:median(snapshot.map(x=>x.oi30)),taker:median(snapshot.map(x=>x.taker))};
  for(const x of snapshot)observations.push({...x,resPrice:x.r30-med.r30,resOi:x.oi30-med.oi30,resTaker:x.taker-med.taker});
}

const configs=[],P=(...sets)=>sets.reduce((a,s)=>a.flatMap(x=>s.map(v=>[...x,v])),[[]]),add=(family,vs)=>vs.forEach((v,i)=>configs.push({family,id:`${family}-${i}`,...v}));
const horizons=[{priceField:"r15",oiField:"oi15"},{priceField:"r30",oiField:"oi30"}];
for(const h of horizons)add("OI_TAKER_CONT",P([.003,.007],[.003,.008],[.25,.45],[3,6]).map(([priceThr,oiThr,takerThr,hold])=>({...h,priceThr,oiThr,takerThr,hold})));
for(const h of horizons)add("OI_TAKER_FADE",P([.006,.012],[.005,.012],[.35,.55],[3,6]).map(([priceThr,oiThr,takerThr,hold])=>({...h,priceThr,oiThr,takerThr,hold})));
for(const h of horizons)add("OI_DROP_EXHAUSTION",P([.008,.015],[.005,.012],[.20,.40],[3,6]).map(([priceThr,oiDrop,takerThr,hold])=>({...h,priceThr,oiDrop,takerThr,hold})));
add("TAKER_ABSORPTION",P([.40,.60],[.002,.004],[3,6]).map(([takerThr,maxPrice,hold])=>({takerThr,maxPrice,hold})));
add("LIQ_CASCADE_CONT",P([5e-6,2e-5,1e-4],[.50,.75],[0,.20],[3,6]).map(([liqRate,liqDir,takerThr,hold])=>({liqRate,liqDir,takerThr,hold})));
add("LIQ_ABSORPTION_FADE",P([5e-6,2e-5,1e-4],[.50,.75],[.002,.004],[3,6]).map(([liqRate,liqDir,maxPrice,hold])=>({liqRate,liqDir,maxPrice,hold})));
add("CROWDING_FADE",P([1.5,2.0],[1.2,1.5],[0,.0002],[6,12]).map(([lsr,top,funding,hold])=>({lsr,top,funding,hold})));
add("FLOW_RESIDUAL_CONT",P([.25,.45],[.003,.007],[.003,.006],[3,6]).map(([takerRes,oiRes,priceRes,hold])=>({takerRes,oiRes,priceRes,hold})));
add("FLOW_RESIDUAL_FADE",P([.30,.50],[.003,.007],[.004,.008],[3,6]).map(([takerRes,oiRes,priceRes,hold])=>({takerRes,oiRes,priceRes,hold})));

function direction(c,o){
  if(c.family==="OI_TAKER_CONT"||c.family==="OI_TAKER_FADE"){const p=o[c.priceField],oi=o[c.oiField],d=Math.sign(p);if(!d||Math.abs(p)<c.priceThr||oi<c.oiThr||d*o.taker<c.takerThr)return 0;return c.family.endsWith("CONT")?d:-d;}
  if(c.family==="OI_DROP_EXHAUSTION"){const p=o[c.priceField],oi=o[c.oiField],d=Math.sign(p);if(!d||Math.abs(p)<c.priceThr||oi>-c.oiDrop||d*o.taker<c.takerThr)return 0;return-d;}
  if(c.family==="TAKER_ABSORPTION"){const d=Math.sign(o.taker);if(!d||Math.abs(o.taker)<c.takerThr||Math.abs(o.r15)>c.maxPrice||d*o.r15>c.maxPrice*.5)return 0;return-d;}
  if(c.family==="LIQ_CASCADE_CONT"){const d=Math.sign(o.liqDir);if(!d||o.liqRate<c.liqRate||Math.abs(o.liqDir)<c.liqDir||d*o.taker<c.takerThr)return 0;return d;}
  if(c.family==="LIQ_ABSORPTION_FADE"){const d=Math.sign(o.liqDir);if(!d||o.liqRate<c.liqRate||Math.abs(o.liqDir)<c.liqDir||Math.abs(o.r15)>c.maxPrice||d*o.r15>c.maxPrice*.5)return 0;return-d;}
  if(c.family==="CROWDING_FADE"){const long=o.lsrTaker>=c.lsr&&o.topLsrSize>=c.top&&o.funding>=c.funding,short=o.lsrTaker>0&&o.lsrTaker<=1/c.lsr&&o.topLsrSize>0&&o.topLsrSize<=1/c.top&&o.funding<=-c.funding;return long?-1:short?1:0;}
  if(c.family==="FLOW_RESIDUAL_CONT"||c.family==="FLOW_RESIDUAL_FADE"){const d=Math.sign(o.resTaker);if(!d||Math.abs(o.resTaker)<c.takerRes||d*o.resOi<c.oiRes||d*o.resPrice<c.priceRes)return 0;return c.family.endsWith("CONT")?d:-d;}
  return 0;
}
const futureReturn=(o,hold,d)=>{const p=priceRow(o.symbol,o.time+hold*300);return p?d*(p.close/o.price-1)-FRICTION:null;};
function makeTrades(c){const out=[],next=new Map();for(const o of observations){if(o.time<(next.get(o.symbol)??0))continue;const d=direction(c,o);if(!d)continue;const r=futureReturn(o,c.hold,d);if(r==null)continue;out.push({time:o.time,symbol:o.symbol,ret:r,dir:d,hold:c.hold,family:c.family,configId:c.id});next.set(o.symbol,o.time+c.hold*300);}return out;}
function metrics(t,a,b,delta=0){let n=0,g=0,l=0,net=0,w=0;const monthly=new Map();for(const x of t){if(x.time<a||x.time>=b)continue;n++;const r=x.ret-delta;net+=r;monthly.set(monthKey(x.time),(monthly.get(monthKey(x.time))??0)+r);if(r>0){g+=r;w++;}else l-=r;}return{trades:n,tradesPerDay:n/Math.max(days(a,b),1),net,pf:l?g/l:g>0?99:0,win:n?w/n:0,mean:n?net/n:0,positiveMonths:[...monthly.values()].filter(v=>v>0).length,activeMonths:monthly.size,monthly:Object.fromEntries(monthly)};}
const cache=new Map(),audit=[];
for(const c of configs){const t=makeTrades(c);cache.set(c.id,t);const train=metrics(t,FROM,TRAIN_END),test=metrics(t,TRAIN_END,TO),stressTrain=metrics(t,FROM,TRAIN_END,STRESS_DELTA);const stable=train.tradesPerDay>=.5&&train.trades>=45&&train.net>0&&train.pf>=1.10&&train.positiveMonths>=2&&stressTrain.net>0&&stressTrain.pf>=1.02;const score=stable?Math.log1p(train.trades)*Math.log(train.pf)*Math.max(train.mean,0)*10000:0;audit.push({config:c,stable,score,train,test,stressTrain});}
audit.sort((a,b)=>b.score-a.score||b.train.pf-a.train.pf||b.train.trades-a.train.trades);
const selected=[],used=new Set();for(const r of audit){if(!r.stable||used.has(r.config.family))continue;selected.push(r);used.add(r.config.family);if(selected.length>=9)break;}
function portfolio(delta=0){const all=[];for(const r of selected)for(const t of cache.get(r.config.id))all.push({...t,ret:t.ret-delta});all.sort((a,b)=>a.time-b.time);const active=[],accepted=[];let equity=1000,peak=1000,maxDrawdown=0;for(const t of all){for(let i=active.length-1;i>=0;i--)if(active[i].until<=t.time)active.splice(i,1);if(active.some(x=>x.symbol===t.symbol)||active.length>=10)continue;const pnl=equity*.10*t.ret;equity=Math.max(1,equity+pnl);peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/Math.max(peak,1e-9));accepted.push({...t,pnl});active.push({symbol:t.symbol,until:t.time+t.hold*300});}const pm=(a,b)=>{let n=0,g=0,l=0,net=0,w=0;for(const t of accepted){if(t.time<a||t.time>=b)continue;n++;net+=t.pnl;if(t.pnl>0){g+=t.pnl;w++;}else l-=t.pnl;}return{trades:n,tradesPerDay:n/Math.max(days(a,b),1),netPnl:net,pf:l?g/l:g>0?99:0,win:n?w/n:0};};return{endEquity:equity,netPnl:equity-1000,maxDrawdown,train:pm(FROM,TRAIN_END),test:pm(TRAIN_END,TO),full:pm(FROM,TO),accepted:accepted.length};}
const base=portfolio(),stress=portfolio(STRESS_DELTA),gates={stableFamilies:selected.length>=3,frequency:base.test.tradesPerDay>=15,trainPositive:base.train.netPnl>0&&base.train.pf>=1.10,testPositive:base.test.netPnl>0&&base.test.pf>=1.05,drawdown:base.maxDrawdown<=.12,stressTest:stress.test.netPnl>0&&stress.test.pf>=1};
const report={generatedAt:new Date().toISOString(),priceSha256:priceRaw.sha256,flowSha256:flowRaw.sha256,symbols,from:FROM,to:TO,trainEnd:TRAIN_END,friction:FRICTION,stressFriction:STRESS_FRICTION,observationRows:observations.length,candidateCount:configs.length,selected:selected.map(r=>({config:r.config,train:r.train,test:r.test,stressTrain:r.stressTrain})),topCandidates:audit.slice(0,40).map(r=>({config:r.config,stable:r.stable,train:r.train,test:r.test,stressTrain:r.stressTrain})),base,stress,gates,targetMet:Object.values(gates).every(Boolean)};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");console.log("FLOW_EVENT_ALPHA_RESULT="+JSON.stringify({targetMet:report.targetMet,stable:audit.filter(r=>r.stable).length,candidates:configs.length,observations:observations.length,selected:report.selected.map(r=>({family:r.config.family,id:r.config.id,train:r.train,test:r.test,stressTrain:r.stressTrain})),base,stress,gates,top:report.topCandidates.slice(0,12)},null,2));
