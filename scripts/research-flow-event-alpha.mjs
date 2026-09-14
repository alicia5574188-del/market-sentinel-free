import { readFileSync, writeFileSync } from "node:fs";

const PRICE_INPUT = process.env.PRICE_DATASET ?? "/tmp/gate-price-5m-202604-202608.json";
const FLOW_INPUT = process.env.FLOW_DATASET ?? "/tmp/gate-flow-5m-202604-202608.json";
const OUTPUT = process.env.FLOW_RESEARCH_OUTPUT ?? "/tmp/flow-event-alpha.json";
const FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const STRESS_DELTA = STRESS_FRICTION - FRICTION;
const DAY = 86400;

const priceRaw = JSON.parse(readFileSync(PRICE_INPUT, "utf8"));
const flowRaw = JSON.parse(readFileSync(FLOW_INPUT, "utf8"));
if (priceRaw.interval !== "5m" || flowRaw.interval !== "5m") throw new Error("Requires 5m price and flow datasets");
const symbols = priceRaw.symbols.filter((s) => flowRaw.symbols.includes(s));
if (symbols.length < 15) throw new Error(`Only ${symbols.length} common symbols`);
const TRAIN_END = Date.UTC(2026, 6, 1) / 1000; // Apr-Jun train, Jul-Aug untouched test
const FROM = Math.max(priceRaw.from, flowRaw.from);
const TO = Math.min(priceRaw.now ?? priceRaw.to, flowRaw.to);
const sum = (xs) => xs.reduce((a,b)=>a+b,0);
const median = (xs) => { const a=[...xs].sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length/2)] : 0; };
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const monthKey = (t) => new Date(t*1000).toISOString().slice(0,7).replace("-","");
const days = (a,b) => (b-a)/DAY;

const priceBySymbol = new Map(priceRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,new Map(d.rows.map(r=>[r.time,r]))]));
const flowMeta = new Map(flowRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,d]));
const flowBySymbol = new Map(flowRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,new Map(d.rows.map(r=>[r[0],r]))]));
const fundingBySymbol = new Map(flowRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,d.funding ?? []]));

function lastFunding(symbol,time){const rows=fundingBySymbol.get(symbol)??[];let value=0;for(const [t,r] of rows){if(t>time)break;value=r;}return value;}
function flowRow(symbol,time){return flowBySymbol.get(symbol)?.get(time)??null;}
function priceRow(symbol,time){return priceBySymbol.get(symbol)?.get(time)??null;}
const times=[...new Set((flowMeta.get(symbols[0])?.rows??[]).map(r=>r[0]).filter(t=>t>=FROM&&t<TO))].sort((a,b)=>a-b);

const observations=[];
for(let ti=12;ti<times.length-24;ti+=1){
  const time=times[ti]; const snapshot=[];
  for(const symbol of symbols){
    const f0=flowRow(symbol,time),p0=priceRow(symbol,time); if(!f0||!p0)continue;
    const back=(bars)=>{const t=time-bars*300;return{f:flowRow(symbol,t),p:priceRow(symbol,t)};};
    const b3=back(3),b6=back(6),b12=back(12);if(!b3.f||!b3.p||!b6.f||!b6.p||!b12.f||!b12.p)continue;
    const r=(p)=>p0.close/p.close-1;
    const oi=(f)=>f0[2]>0&&f[2]>0?f0[2]/f[2]-1:0;
    const oiUsd=(f)=>f0[1]>0&&f[1]>0?f0[1]/f[1]-1:0;
    const taker=(f)=>{const l=Number(f[3]??0),s=Number(f[4]??0),d=l+s;return d>0?(l-s)/d:0;};
    const liq=(f)=>{const long=Number(f[5]??0),short=Number(f[6]??0),total=long+short;return{total,dir:total>0?(short-long)/total:0,rate:total/Math.max(Number(f[1]??0),1)};};
    const recentRows=[f0,b3.f,b6.f,b12.f].filter(Boolean);
    const tkNow=taker(f0),liqNow=liq(f0);
    const feature={symbol,time,price:p0.close,r15:r(b3.p),r30:r(b6.p),r60:r(b12.p),
      oi15:oi(b3.f),oi30:oi(b6.f),oi60:oi(b12.f),oiUsd30:oiUsd(b6.f),
      taker:tkNow,taker3:median(recentRows.slice(0,2).map(taker)),
      liqRate:liqNow.rate,liqDir:liqNow.dir,liqUsd:liqNow.total,
      lsrTaker:Number(f0[7]??0),lsrAccount:Number(f0[8]??0),topLsrSize:Number(f0[9]??0),topLsrAccount:Number(f0[10]??0),
      funding:lastFunding(symbol,time)};
    snapshot.push(feature);
  }
  if(snapshot.length<Math.max(12,symbols.length-3))continue;
  const med={r30:median(snapshot.map(x=>x.r30)),oi30:median(snapshot.map(x=>x.oi30)),taker:median(snapshot.map(x=>x.taker))};
  for(const x of snapshot)observations.push({...x,resPrice:x.r30-med.r30,resOi:x.oi30-med.oi30,resTaker:x.taker-med.taker});
}

const configs=[];
const P=(...sets)=>sets.reduce((a,s)=>a.flatMap(x=>s.map(v=>[...x,v])),[[]]);
const add=(family,variants)=>variants.forEach((v,i)=>configs.push({family,id:`${family}-${i}`,...v}));
add("OI_TAKER_CONT",P(["r15","r30"],[.0025,.005,.01],["oi15","oi30"],[.002,.005,.01],[.15,.30,.50],[3,6,12]).map(([priceField,priceThr,oiField,oiThr,takerThr,hold])=>({priceField,priceThr,oiField,oiThr,takerThr,hold})));
add("OI_TAKER_FADE",P(["r15","r30"],[.005,.01,.015],["oi15","oi30"],[.004,.008,.015],[.30,.50,.65],[3,6,12]).map(([priceField,priceThr,oiField,oiThr,takerThr,hold])=>({priceField,priceThr,oiField,oiThr,takerThr,hold})));
add("OI_DROP_EXHAUSTION",P(["r15","r30"],[.006,.012,.02],["oi15","oi30"],[.003,.008,.015],[.15,.30],[3,6,12]).map(([priceField,priceThr,oiField,oiDrop,takerThr,hold])=>({priceField,priceThr,oiField,oiDrop,takerThr,hold})));
add("TAKER_ABSORPTION",P([.35,.50,.65],[.0015,.003,.005],[3,6,12]).map(([takerThr,maxPrice,hold])=>({takerThr,maxPrice,hold})));
add("LIQ_CASCADE_CONT",P([1e-6,5e-6,2e-5,1e-4],[.50,.75],[0,.15],[3,6,12]).map(([liqRate,liqDir,takerThr,hold])=>({liqRate,liqDir,takerThr,hold})));
add("LIQ_ABSORPTION_FADE",P([5e-6,2e-5,1e-4],[.50,.75],[.0015,.003,.006],[3,6,12]).map(([liqRate,liqDir,maxPrice,hold])=>({liqRate,liqDir,maxPrice,hold})));
add("CROWDING_FADE",P([1.4,1.8,2.5],[1.15,1.35],[0,.0001,.0003],[6,12,24]).map(([lsr,top,funding,hold])=>({lsr,top,funding,hold})));
add("FLOW_RESIDUAL_CONT",P([.20,.35,.50],[.003,.007],[.002,.005],[3,6,12]).map(([takerRes,oiRes,priceRes,hold])=>({takerRes,oiRes,priceRes,hold})));
add("FLOW_RESIDUAL_FADE",P([.25,.40,.55],[.003,.007],[.004,.008],[3,6,12]).map(([takerRes,oiRes,priceRes,hold])=>({takerRes,oiRes,priceRes,hold})));

function direction(c,o){
  if(c.family==="OI_TAKER_CONT"||c.family==="OI_TAKER_FADE"){
    const p=o[c.priceField],oi=o[c.oiField],s=Math.sign(p);if(!s||Math.abs(p)<c.priceThr||oi<c.oiThr||s*o.taker<c.takerThr)return 0;return c.family.endsWith("CONT")?s:-s;}
  if(c.family==="OI_DROP_EXHAUSTION"){
    const p=o[c.priceField],oi=o[c.oiField],s=Math.sign(p);if(!s||Math.abs(p)<c.priceThr||oi>-c.oiDrop||s*o.taker<c.takerThr)return 0;return -s;}
  if(c.family==="TAKER_ABSORPTION"){
    const s=Math.sign(o.taker);if(!s||Math.abs(o.taker)<c.takerThr||Math.abs(o.r15)>c.maxPrice||s*o.r15>c.maxPrice*.5)return 0;return -s;}
  if(c.family==="LIQ_CASCADE_CONT"){
    const s=Math.sign(o.liqDir);if(!s||o.liqRate<c.liqRate||Math.abs(o.liqDir)<c.liqDir||s*o.taker<c.takerThr)return 0;return s;}
  if(c.family==="LIQ_ABSORPTION_FADE"){
    const s=Math.sign(o.liqDir);if(!s||o.liqRate<c.liqRate||Math.abs(o.liqDir)<c.liqDir||Math.abs(o.r15)>c.maxPrice||s*o.r15>c.maxPrice*.5)return 0;return -s;}
  if(c.family==="CROWDING_FADE"){
    const longCrowd=o.lsrTaker>=c.lsr&&o.topLsrSize>=c.top&&o.funding>=c.funding;
    const shortCrowd=o.lsrTaker>0&&o.lsrTaker<=1/c.lsr&&o.topLsrSize>0&&o.topLsrSize<=1/c.top&&o.funding<=-c.funding;
    return longCrowd?-1:shortCrowd?1:0;}
  if(c.family==="FLOW_RESIDUAL_CONT"||c.family==="FLOW_RESIDUAL_FADE"){
    const s=Math.sign(o.resTaker);if(!s||Math.abs(o.resTaker)<c.takerRes||s*o.resOi<c.oiRes||s*o.resPrice<c.priceRes)return 0;return c.family.endsWith("CONT")?s:-s;}
  return 0;
}

function futureReturn(o,hold,dir){const p=priceRow(o.symbol,o.time+hold*300);if(!p)return null;return dir*(p.close/o.price-1)-FRICTION;}
function trades(c){const out=[],next=new Map();for(const o of observations){if(o.time<(next.get(o.symbol)??0))continue;const d=direction(c,o);if(!d)continue;const r=futureReturn(o,c.hold,d);if(r==null)continue;out.push({time:o.time,symbol:o.symbol,ret:r,dir:d,hold:c.hold,family:c.family,configId:c.id});next.set(o.symbol,o.time+c.hold*300);}return out;}
function metrics(t,a,b,delta=0){let n=0,g=0,l=0,net=0,w=0;const monthly=new Map();for(const x of t){if(x.time<a||x.time>=b)continue;n++;const r=x.ret-delta;net+=r;monthly.set(monthKey(x.time),(monthly.get(monthKey(x.time))??0)+r);if(r>0){g+=r;w++;}else l-=r;}return{trades:n,tradesPerDay:n/Math.max(days(a,b),1),net,pf:l?g/l:g>0?99:0,win:n?w/n:0,mean:n?net/n:0,positiveMonths:[...monthly.values()].filter(v=>v>0).length,activeMonths:monthly.size,monthly:Object.fromEntries(monthly)};}

const cache=new Map(),audit=[];
for(const c of configs){const t=trades(c);cache.set(c.id,t);const train=metrics(t,FROM,TRAIN_END),test=metrics(t,TRAIN_END,TO),stressTrain=metrics(t,FROM,TRAIN_END,STRESS_DELTA);
  const stable=train.tradesPerDay>=.5&&train.trades>=45&&train.net>0&&train.pf>=1.10&&train.positiveMonths>=2&&stressTrain.net>0&&stressTrain.pf>=1.02;
  const score=stable?Math.log1p(train.trades)*Math.log(train.pf)*Math.max(train.mean,0)*10000:0;audit.push({config:c,stable,score,train,test,stressTrain});}
audit.sort((a,b)=>b.score-a.score||b.train.pf-a.train.pf||b.train.trades-a.train.trades);
const selected=[],used=new Set();for(const r of audit){if(!r.stable||used.has(r.config.family))continue;selected.push(r);used.add(r.config.family);if(selected.length>=9)break;}

function portfolio(delta=0){const all=[];for(const r of selected)for(const t of cache.get(r.config.id))all.push({...t,ret:t.ret-delta});all.sort((a,b)=>a.time-b.time);const active=[],accepted=[];let equity=1000,peak=1000,maxDrawdown=0;
  for(const t of all){for(let i=active.length-1;i>=0;i--)if(active[i].until<=t.time)active.splice(i,1);if(active.some(x=>x.symbol===t.symbol)||active.length>=10)continue;
    const notional=equity*.10,pnl=notional*t.ret;equity=Math.max(1,equity+pnl);peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/Math.max(peak,1e-9));accepted.push({...t,pnl});active.push({symbol:t.symbol,until:t.time+t.hold*300});}
  const pm=(a,b)=>{let n=0,g=0,l=0,net=0,w=0;for(const t of accepted){if(t.time<a||t.time>=b)continue;n++;net+=t.pnl;if(t.pnl>0){g+=t.pnl;w++;}else l-=t.pnl;}return{trades:n,tradesPerDay:n/Math.max(days(a,b),1),netPnl:net,pf:l?g/l:g>0?99:0,win:n?w/n:0};};
  return{endEquity:equity,netPnl:equity-1000,maxDrawdown,train:pm(FROM,TRAIN_END),test:pm(TRAIN_END,TO),full:pm(FROM,TO),accepted:accepted.length};}
const base=portfolio(),stress=portfolio(STRESS_DELTA);
const gates={stableFamilies:selected.length>=3,frequency:base.test.tradesPerDay>=15,trainPositive:base.train.netPnl>0&&base.train.pf>=1.10,testPositive:base.test.netPnl>0&&base.test.pf>=1.05,drawdown:base.maxDrawdown<=.12,stressTest:stress.test.netPnl>0&&stress.test.pf>=1.0};
const report={generatedAt:new Date().toISOString(),priceSha256:priceRaw.sha256,flowSha256:flowRaw.sha256,symbols,from:FROM,to:TO,trainEnd:TRAIN_END,friction:FRICTION,stressFriction:STRESS_FRICTION,observationRows:observations.length,candidateCount:configs.length,
  selected:selected.map(r=>({config:r.config,train:r.train,test:r.test,stressTrain:r.stressTrain})),topCandidates:audit.slice(0,40).map(r=>({config:r.config,stable:r.stable,train:r.train,test:r.test,stressTrain:r.stressTrain})),base,stress,gates,targetMet:Object.values(gates).every(Boolean)};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");
console.log("FLOW_EVENT_ALPHA_RESULT="+JSON.stringify({targetMet:report.targetMet,stable:audit.filter(r=>r.stable).length,candidates:configs.length,selected:report.selected.map(r=>({family:r.config.family,id:r.config.id,train:r.train,test:r.test,stressTrain:r.stressTrain})),base,stress,gates,top:report.topCandidates.slice(0,12)},null,2));
