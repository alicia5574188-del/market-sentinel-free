import { readFileSync, writeFileSync } from "node:fs";

const PRICE_INPUT=process.env.RESEARCH_DATASET??"/tmp/gate-history-frequency-aligned-12m.json";
const STATS_INPUT=process.env.STATS_DATASET??"/tmp/gate-contract-stats-4h.json";
const OUTPUT=process.env.RIDGE_OUTPUT??"/tmp/derivatives-ridge-frequency.json";
const priceRaw=JSON.parse(readFileSync(PRICE_INPUT,"utf8"));
const statsRaw=JSON.parse(readFileSync(STATS_INPUT,"utf8"));
if(priceRaw.interval!=="5m"||statsRaw.interval!=="4h")throw new Error("Expected aligned Gate 5m prices and 4h contract stats");

const FRICTION=.0014, STRESS=.0022, SLIP=.00025, DAY=86_400_000, STEP4=4*3600, STEP8=8*3600;
const TRAIN_END=Date.UTC(2026,6,1), START=statsRaw.from*1000, END=statsRaw.to*1000;
const CV1=Date.UTC(2026,4,1), CV2=Date.UTC(2026,5,1);
const sum=xs=>xs.reduce((a,b)=>a+b,0), mean=xs=>xs.length?sum(xs)/xs.length:0;
const stdev=xs=>{const m=mean(xs);return Math.sqrt(mean(xs.map(x=>(x-m)**2)));};
const median=xs=>{if(!xs.length)return 0;const a=[...xs].sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
const monthKey=ms=>new Date(ms).toISOString().slice(0,7).replace("-","");
const safeLog=x=>Math.log(Math.max(x,1e-9));
const pct=(a,b)=>b>0?a/b-1:0;
const dot=(a,b)=>a.reduce((n,x,i)=>n+x*b[i],0);

const price=new Map(priceRaw.datasets.map(d=>[d.symbol,d.rows]));
const usable=statsRaw.datasets.filter(d=>d.coverage>=.90&&price.has(d.symbol));
const SYMBOLS=usable.map(d=>d.symbol);
if(SYMBOLS.length<8)throw new Error(`Need >=8 stats-covered symbols, got ${SYMBOLS.length}`);
const stats=new Map(usable.map(d=>[d.symbol,d.rows]));
const statsIndex=new Map(usable.map(d=>[d.symbol,new Map(d.rows.map((r,i)=>[r.time,i]))]));
const priceIndex=new Map();for(const s of SYMBOLS){const m=new Map();for(let i=0;i<price.get(s).length;i++)m.set(price.get(s)[i].time,i);priceIndex.set(s,m);}

const RAW_KEYS=["funding","oi8","oi24","oi72","r8","r24","r72","taker","lsr","topLsr","topAcct","userLsr","liq"];
function rawFeature(symbol,t){
  const rows=stats.get(symbol),i=statsIndex.get(symbol).get(t);if(i==null||i<18)return null;
  const a=rows[i],p2=rows[i-2],p6=rows[i-6],p18=rows[i-18];if(!p2||!p6||!p18)return null;
  const taker=(a.long_taker_size-a.short_taker_size)/Math.max(a.long_taker_size+a.short_taker_size,1);
  const liq=(a.long_liq_usd-a.short_liq_usd)/Math.max(a.long_liq_usd+a.short_liq_usd+Math.abs(a.open_interest_usd)*1e-6,1);
  return{symbol,t,entryT:t+STEP4,exitT:t+STEP4+STEP8,funding:a.last_funding_rate,oi8:pct(a.open_interest_usd,p2.open_interest_usd),oi24:pct(a.open_interest_usd,p6.open_interest_usd),oi72:pct(a.open_interest_usd,p18.open_interest_usd),r8:pct(a.mark_price,p2.mark_price),r24:pct(a.mark_price,p6.mark_price),r72:pct(a.mark_price,p18.mark_price),taker,lsr:safeLog(a.lsr_account),topLsr:safeLog(a.top_lsr_size),topAcct:safeLog(a.top_lsr_account),userLsr:safeLog((a.long_users+1)/(a.short_users+1)),liq};
}
function openPrice(symbol,t){const idx=priceIndex.get(symbol).get(t);return idx==null?null:price.get(symbol)[idx].open;}
function futureGross(symbol,entryT,exitT){const a=openPrice(symbol,entryT),b=openPrice(symbol,exitT);return a>0&&b>0?b/a-1:null;}
function zCross(rows,key){const xs=rows.map(x=>x[key]),m=mean(xs),sd=stdev(xs);for(const r of rows)r[`z_${key}`]=sd>1e-12?(r[key]-m)/sd:0;}

const timeline=[...new Set(usable.flatMap(d=>d.rows.map(r=>r.time)))].sort((a,b)=>a-b).filter(t=>t%STEP8===0);
const frameByT=new Map(),examples=[];
for(const t of timeline){
  const rows=SYMBOLS.map(s=>rawFeature(s,t)).filter(Boolean).filter(f=>openPrice(f.symbol,f.entryT)!=null&&openPrice(f.symbol,f.exitT)!=null);
  if(rows.length<8)continue;
  for(const k of RAW_KEYS)zCross(rows,k);
  const labels=rows.map(r=>futureGross(r.symbol,r.entryT,r.exitT));const med=median(labels.filter(Number.isFinite));
  for(let i=0;i<rows.length;i++)rows[i].label=labels[i]-med;
  frameByT.set(t,rows);examples.push(...rows.filter(r=>Number.isFinite(r.label)));
}

const VARIANTS={
  LINEAR:{names:RAW_KEYS.map(k=>`z_${k}`),build:r=>RAW_KEYS.map(k=>r[`z_${k}`])},
  CORE7:{names:["z_funding","z_oi24","z_r24","z_taker","z_lsr","z_topLsr","z_liq"],build:r=>[r.z_funding,r.z_oi24,r.z_r24,r.z_taker,r.z_lsr,r.z_topLsr,r.z_liq]},
  CURVED:{names:[...RAW_KEYS.map(k=>`z_${k}`),...RAW_KEYS.map(k=>`sq_${k}`)],build:r=>{const a=RAW_KEYS.map(k=>r[`z_${k}`]);return[...a,...a.map(x=>x*Math.abs(x))];}},
  INTERACT:{names:[...RAW_KEYS.map(k=>`z_${k}`),"funding_x_oi","funding_x_crowd","oi_x_price","taker_x_price","liq_x_price","crowd_x_price","oi_x_taker","top_x_funding"],build:r=>{const a=RAW_KEYS.map(k=>r[`z_${k}`]);return[...a,r.z_funding*r.z_oi24,r.z_funding*r.z_lsr,r.z_oi24*r.z_r24,r.z_taker*r.z_r8,r.z_liq*r.z_r8,r.z_topLsr*r.z_r24,r.z_oi8*r.z_taker,r.z_topLsr*r.z_funding];}},
};
const LAMBDAS=[.01,.1,1,10,100];

function fitScaler(rows,variant){const vs=VARIANTS[variant],matrix=rows.map(r=>vs.build(r));const p=vs.names.length,mu=[],sd=[];for(let j=0;j<p;j++){const xs=matrix.map(x=>x[j]);mu[j]=mean(xs);sd[j]=Math.max(stdev(xs),1e-9);}return{mu,sd};}
function transform(r,variant,scaler){const x=VARIANTS[variant].build(r);return x.map((v,i)=>(v-scaler.mu[i])/scaler.sd[i]);}
function solve(A,b){const n=b.length,M=A.map((r,i)=>[...r,b[i]]);for(let i=0;i<n;i++){let pivot=i;for(let j=i+1;j<n;j++)if(Math.abs(M[j][i])>Math.abs(M[pivot][i]))pivot=j;[M[i],M[pivot]]=[M[pivot],M[i]];const d=M[i][i];if(Math.abs(d)<1e-12)continue;for(let k=i;k<=n;k++)M[i][k]/=d;for(let j=0;j<n;j++){if(j===i)continue;const f=M[j][i];if(!f)continue;for(let k=i;k<=n;k++)M[j][k]-=f*M[i][k];}}return M.map(r=>r[n]);}
function fitRidge(rows,variant,lambda){const scaler=fitScaler(rows,variant),p=VARIANTS[variant].names.length,XtX=Array.from({length:p},()=>Array(p).fill(0)),Xty=Array(p).fill(0);for(const r of rows){const x=transform(r,variant,scaler),y=r.label;for(let i=0;i<p;i++){Xty[i]+=x[i]*y;for(let j=0;j<p;j++)XtX[i][j]+=x[i]*x[j];}}for(let i=0;i<p;i++)XtX[i][i]+=lambda;return{variant,lambda,scaler,beta:solve(XtX,Xty)};}
const predict=(m,r)=>dot(m.beta,transform(r,m.variant,m.scaler));

function legTrade(symbol,direction,entryT,friction=FRICTION,slippage=SLIP){const rows=price.get(symbol),idx=priceIndex.get(symbol).get(entryT),exitIdx=priceIndex.get(symbol).get(entryT+STEP8);if(idx==null||exitIdx==null)return null;const entry=rows[idx].open*(1+direction*slippage),stopRate=.04,stop=entry*(1-direction*stopRate);let exit=rows[exitIdx].open,closedAt=(entryT+STEP8)*1000,outcome="TIME";for(let k=idx+1;k<=exitIdx;k++){const p=rows[k].open;if(direction>0?p<=stop:p>=stop){exit=stop;closedAt=rows[k].time*1000;outcome="STOP";break;}}const gross=direction*(exit-entry)/entry,net=gross-friction;return{symbol,direction,openedAt:entryT*1000,closedAt,entry,exit,stopRate,grossReturn:gross,netReturn:net,outcome};}
function simulate(model,{from=START,to=END,friction=FRICTION,slippage=SLIP,legs=3}={}){let equity=1000,peak=1000,maxDD=0,baskets=0;const trades=[],monthly=new Map(),ics=[];for(const t of timeline){const entryMs=(t+STEP4)*1000;if(entryMs<from||entryMs>=to)continue;const rows=frameByT.get(t);if(!rows||rows.length<2*legs)continue;const scored=rows.map(r=>({...r,pred:predict(model,r)})).sort((a,b)=>a.pred-b.pred);const actual=scored.map(r=>r.label),preds=scored.map(r=>r.pred);const am=mean(actual),pm=mean(preds),asd=stdev(actual),psd=stdev(preds);if(asd>1e-12&&psd>1e-12)ics.push(mean(actual.map((x,i)=>(x-am)*(preds[i]-pm)))/(asd*psd));const picks=[...scored.slice(-legs).map(x=>[x.symbol,1,x.pred]),...scored.slice(0,legs).map(x=>[x.symbol,-1,x.pred])];const notional0=equity/(2*legs),batch=[];for(const [s,d,pred] of picks){const tr=legTrade(s,d,t+STEP4,friction,slippage);if(tr)batch.push({...tr,pred,notional:notional0,plannedRisk:notional0*(.04+friction),netPnl:notional0*tr.netReturn});}if(batch.length!==2*legs)continue;const total=sum(batch.map(x=>x.plannedRisk)),lr=sum(batch.filter(x=>x.direction>0).map(x=>x.plannedRisk)),sr=sum(batch.filter(x=>x.direction<0).map(x=>x.plannedRisk));const scale=Math.min(1,equity*.10/Math.max(total,1e-9),equity*.065/Math.max(lr,1e-9),equity*.065/Math.max(sr,1e-9));batch.sort((a,b)=>a.closedAt-b.closedAt);for(const tr of batch){tr.notional*=scale;tr.plannedRisk*=scale;tr.netPnl=tr.notional*tr.netReturn;equity=Math.max(.01,equity+tr.netPnl);trades.push(tr);peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));const m=monthKey(tr.closedAt);monthly.set(m,(monthly.get(m)??0)+tr.netPnl);}baskets++;}
  const gains=sum(trades.filter(t=>t.netPnl>0).map(t=>t.netPnl)),loss=Math.abs(sum(trades.filter(t=>t.netPnl<=0).map(t=>t.netPnl)));return{trades:trades.length,tradesPerDay:trades.length/Math.max(1,(to-from)/DAY),baskets,netPnl:equity-1000,endEquity:equity,profitFactor:loss?gains/loss:gains?99:0,winRate:trades.length?trades.filter(t=>t.netPnl>0).length/trades.length:0,maxDrawdown:maxDD,meanCrossSectionIc:mean(ics),positiveMonths:[...monthly.values()].filter(v=>v>0).length,activeMonths:monthly.size,monthly:Object.fromEntries([...monthly].sort())};}

function fitRowsBefore(cut){return examples.filter(r=>r.exitT*1000<cut);}
const candidates=[];
for(const variant of Object.keys(VARIANTS))for(const lambda of LAMBDAS){const folds=[];for(const [fitCut,a,b] of [[CV1,CV1,CV2],[CV2,CV2,TRAIN_END]]){const rows=fitRowsBefore(fitCut);if(rows.length<500)continue;const model=fitRidge(rows,variant,lambda),m=simulate(model,{from:a,to:b,legs:3});folds.push(m);}if(folds.length!==2)continue;const minPf=Math.min(...folds.map(f=>f.profitFactor)),avgPf=mean(folds.map(f=>f.profitFactor)),net=sum(folds.map(f=>f.netPnl)),dd=Math.max(...folds.map(f=>f.maxDrawdown)),freq=Math.min(...folds.map(f=>f.tradesPerDay));const stable=freq>=15&&folds.every(f=>f.netPnl>0&&f.profitFactor>=1.02);candidates.push({variant,lambda,folds,minPf,avgPf,net,dd,freq,stable,score:(stable?1000:0)+minPf*100+avgPf*10+net/100});}
candidates.sort((a,b)=>b.score-a.score);const selected=candidates[0];
const finalModel=fitRidge(fitRowsBefore(TRAIN_END),selected.variant,selected.lambda);
const train=simulate(finalModel,{from:START,to:TRAIN_END,legs:3}),test=simulate(finalModel,{from:TRAIN_END,to:END,legs:3}),full=simulate(finalModel,{from:START,to:END,legs:3}),stress=simulate(finalModel,{from:TRAIN_END,to:END,legs:3,friction:STRESS}),adverse=simulate(finalModel,{from:TRAIN_END,to:END,legs:3,slippage:SLIP*2});
const gates={frequency:test.tradesPerDay>=15,pf:full.profitFactor>=1.15,drawdown:full.maxDrawdown<=.05,cv:selected.folds.every(f=>f.profitFactor>=1.02&&f.netPnl>0),test:test.profitFactor>=1.10&&test.netPnl>0,stress:stress.profitFactor>=1.05&&stress.netPnl>0,adverse:adverse.profitFactor>=1.05&&adverse.netPnl>0};
const report={generatedAt:new Date().toISOString(),dataset:{source:statsRaw.source,from:statsRaw.from,to:statsRaw.to,usableSymbols:SYMBOLS,coverage:Object.fromEntries(usable.map(d=>[d.symbol,d.coverage]))},architecture:{type:"constrained cross-sectional ridge ranker on Gate-native derivatives statistics",target:"future 8h cross-sectional residual return",features:RAW_KEYS,variants:Object.fromEntries(Object.entries(VARIANTS).map(([k,v])=>[k,v.names])),selection:"lambda/feature family selected only from May and June rolling validation; July-Aug untouched",execution:"stats t -> entry t+4h -> fixed 8h lifecycle; top 3 long + bottom 3 short every 8h",frequency:"structural ~18 trades/day",risk:"shared 1000U, 1x gross before scale, 4% stop, <=10% planned stop risk, <=6.5% same-side",cost:"0.14% round-trip friction + 0.025% adverse entry; stress 0.22%; funding cashflows excluded"},candidateCv:candidates,selected:{variant:selected.variant,lambda:selected.lambda,folds:selected.folds,stable:selected.stable,weights:Object.fromEntries(VARIANTS[selected.variant].names.map((n,i)=>[n,finalModel.beta[i]]))},train,test,full,stress,adverse,gates,targetMet:Object.values(gates).every(Boolean)};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");
console.log("DERIVATIVES_RIDGE_RESULT="+JSON.stringify({targetMet:report.targetMet,selected:{variant:selected.variant,lambda:selected.lambda,stable:selected.stable,folds:selected.folds.map(f=>({tradesPerDay:f.tradesPerDay,net:f.netPnl,pf:f.profitFactor,dd:f.maxDrawdown,ic:f.meanCrossSectionIc}))},train:{tradesPerDay:train.tradesPerDay,net:train.netPnl,pf:train.profitFactor,dd:train.maxDrawdown,ic:train.meanCrossSectionIc},test:{tradesPerDay:test.tradesPerDay,net:test.netPnl,pf:test.profitFactor,dd:test.maxDrawdown,ic:test.meanCrossSectionIc},full:{tradesPerDay:full.tradesPerDay,net:full.netPnl,pf:full.profitFactor,dd:full.maxDrawdown},stress:{net:stress.netPnl,pf:stress.profitFactor,dd:stress.maxDrawdown},adverse:{net:adverse.netPnl,pf:adverse.profitFactor,dd:adverse.maxDrawdown},gates,topCv:candidates.slice(0,8).map(c=>({variant:c.variant,lambda:c.lambda,stable:c.stable,minPf:c.minPf,avgPf:c.avgPf,net:c.net,dd:c.dd,freq:c.freq}))},null,2));