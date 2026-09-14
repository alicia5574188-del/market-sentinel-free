import { readFileSync, writeFileSync } from "node:fs";

const PRICE_INPUT=process.env.RESEARCH_DATASET??"/tmp/gate-history-frequency-aligned-12m.json";
const PREMIUM_INPUT=process.env.PREMIUM_DATASET??"/tmp/gate-premium-8h-12m.json";
const OUTPUT=process.env.PREMIUM_RESEARCH_OUTPUT??"/tmp/premium-frequency-research.json";
const priceRaw=JSON.parse(readFileSync(PRICE_INPUT,"utf8")),premRaw=JSON.parse(readFileSync(PREMIUM_INPUT,"utf8"));
if(priceRaw.interval!=="5m"||premRaw.interval!=="8h")throw new Error("Expected 5m price + 8h premium datasets");
const FRICTION=.0014,STRESS=.0022,SLIP=.00025,DAY=86400000,STEP8=8*3600;
const START=priceRaw.from*1000,END=priceRaw.now*1000,TRAIN_END=Date.UTC(2026,4,1);
const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>xs.length?sum(xs)/xs.length:0;
const stdev=xs=>{const m=mean(xs);return Math.sqrt(mean(xs.map(x=>(x-m)**2)));};
const median=xs=>{if(!xs.length)return 0;const a=[...xs].sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
const z=(x,xs)=>{const sd=stdev(xs);return sd>1e-12?(x-mean(xs))/sd:0;};
const monthKey=ms=>new Date(ms).toISOString().slice(0,7).replace("-","");
const price=new Map(priceRaw.datasets.map(d=>[d.symbol,d.rows]));
const usable=premRaw.datasets.filter(d=>d.coverage>=.95&&price.has(d.symbol));
const SYMBOLS=usable.map(d=>d.symbol);
if(SYMBOLS.length<8)throw new Error(`Need >=8 premium-covered symbols, got ${SYMBOLS.length}`);
const premium=new Map(usable.map(d=>[d.symbol,d.premium]));
const priceIndex=new Map();for(const s of SYMBOLS){const m=new Map();for(let i=0;i<price.get(s).length;i++)m.set(price.get(s)[i].time,i);priceIndex.set(s,m);}
const premIndex=new Map(usable.map(d=>[d.symbol,new Map(d.premium.map((r,i)=>[r.t,i]))]));

const CONFIGS=[];
for(const family of ["CARRY_RAW","CARRY_Z","PREMIUM_MR","PREMIUM_MOM","CARRY_TREND","CROWD_UNWIND","DIVERGENCE","BALANCED_COMBO"]){
  for(const lookback of [6,21])CONFIGS.push({id:`premium-${family.toLowerCase()}-lb${lookback}`,family,lookback,legs:3});
}

function feature(symbol,t,lookback){
  const arr=premium.get(symbol),pi=premIndex.get(symbol).get(t);if(pi==null||pi<lookback)return null;
  const p=arr[pi],hist=arr.slice(pi-lookback,pi).map(x=>x.c),d1=p.c-arr[pi-1].c,d3=pi>=3?p.c-arr[pi-3].c:0;
  const entryT=t+STEP8,idx=priceIndex.get(symbol).get(entryT);if(idx==null||idx<288)return null;const rows=price.get(symbol),j=idx-1;
  const r8=rows[j].close/rows[Math.max(0,j-96)].close-1,r24=rows[j].close/rows[j-288].close-1,r72=j>=864?rows[j].close/rows[j-864].close-1:0;
  return{symbol,t,entryT,premium:p.c,pz:z(p.c,hist),d1,d3,r8,r24,r72};
}
function score(c,f,ctx){
  const rz24=ctx.retSd>1e-12?(f.r24-ctx.retMean)/ctx.retSd:0;
  const dz=ctx.deltaSd>1e-12?(f.d1-ctx.deltaMean)/ctx.deltaSd:0;
  if(c.family==="CARRY_RAW")return -f.premium;
  if(c.family==="CARRY_Z")return -f.pz;
  if(c.family==="PREMIUM_MR")return -f.pz-.35*dz;
  if(c.family==="PREMIUM_MOM")return dz+.25*rz24;
  if(c.family==="CARRY_TREND")return -f.pz+.40*rz24;
  if(c.family==="CROWD_UNWIND")return -f.pz-.45*rz24;
  if(c.family==="DIVERGENCE")return rz24-f.pz;
  if(c.family==="BALANCED_COMBO")return -.65*f.pz+.25*rz24-.20*dz;
  return 0;
}
function legTrade(symbol,direction,entryT,friction=FRICTION,slippage=SLIP){
  const rows=price.get(symbol),idx=priceIndex.get(symbol).get(entryT);if(idx==null)return null;
  const entry=rows[idx].open*(1+direction*slippage),exitIdx=priceIndex.get(symbol).get(entryT+STEP8);if(exitIdx==null)return null;
  const stopRate=.04,stop=entry*(1-direction*stopRate);let exit=rows[exitIdx].open,outcome="TIME";
  for(let k=idx+1;k<=exitIdx;k++){const p=rows[k].open;if(direction>0?p<=stop:p>=stop){exit=stop;outcome="STOP";break;}}
  const gross=direction*(exit-entry)/entry,net=gross-friction;return{symbol,direction,openedAt:entryT*1000,closedAt:(entryT+STEP8)*1000,entry,exit,stopRate,grossReturn:gross,netReturn:net,outcome};
}
function simulate(c,{friction=FRICTION,slippage=SLIP}={}){
  let equity=1000,peak=1000,maxDD=0,baskets=0;const trades=[],monthly=new Map();
  const ts=[...new Set(usable.flatMap(d=>d.premium.map(r=>r.t)))].sort((a,b)=>a-b);
  for(const t of ts){const fs=SYMBOLS.map(s=>feature(s,t,c.lookback)).filter(Boolean);if(fs.length<2*c.legs)continue;
    const premVals=fs.map(f=>f.premium),retVals=fs.map(f=>f.r24),delVals=fs.map(f=>f.d1),ctx={premMean:mean(premVals),premSd:stdev(premVals),retMean:mean(retVals),retSd:stdev(retVals),deltaMean:mean(delVals),deltaSd:stdev(delVals)};
    const ranked=fs.map(f=>({...f,alpha:score(c,f,ctx)})).sort((a,b)=>a.alpha-b.alpha);const low=ranked.slice(0,c.legs),high=ranked.slice(-c.legs);
    const picks=[...high.map(x=>[x.symbol,1,x.alpha]),...low.map(x=>[x.symbol,-1,x.alpha])];const notional0=equity/(2*c.legs),batch=[];
    for(const [s,d,a] of picks){const tr=legTrade(s,d,t+STEP8,friction,slippage);if(tr)batch.push({...tr,alpha:a,configId:c.id,notional:notional0,plannedRisk:notional0*(.04+friction),netPnl:notional0*tr.netReturn});}
    if(batch.length!==2*c.legs)continue;
    const totalRisk=sum(batch.map(x=>x.plannedRisk)),lr=sum(batch.filter(x=>x.direction>0).map(x=>x.plannedRisk)),sr=sum(batch.filter(x=>x.direction<0).map(x=>x.plannedRisk));const scale=Math.min(1,equity*.10/Math.max(totalRisk,1e-9),equity*.065/Math.max(lr,1e-9),equity*.065/Math.max(sr,1e-9));
    const batchPnl=sum(batch.map(tr=>{tr.notional*=scale;tr.plannedRisk*=scale;tr.netPnl=tr.notional*tr.netReturn;trades.push(tr);const m=monthKey(tr.closedAt);monthly.set(m,(monthly.get(m)??0)+tr.netPnl);return tr.netPnl;}));
    equity=Math.max(.01,equity+batchPnl);peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));baskets++;
  }
  const period=(a,b)=>{const xs=trades.filter(t=>t.openedAt>=a&&t.openedAt<b),g=sum(xs.filter(t=>t.netPnl>0).map(t=>t.netPnl)),l=Math.abs(sum(xs.filter(t=>t.netPnl<=0).map(t=>t.netPnl)));return{trades:xs.length,tradesPerDay:xs.length/((b-a)/DAY),netPnl:sum(xs.map(t=>t.netPnl)),profitFactor:l?g/l:g?99:0,winRate:xs.length?xs.filter(t=>t.netPnl>0).length/xs.length:0};};
  const g=sum(trades.filter(t=>t.netPnl>0).map(t=>t.netPnl)),l=Math.abs(sum(trades.filter(t=>t.netPnl<=0).map(t=>t.netPnl)));
  return{config:c,baskets,trades:trades.length,tradesPerDay:trades.length/((END-START)/DAY),netPnl:equity-1000,endEquity:equity,profitFactor:l?g/l:g?99:0,winRate:trades.length?trades.filter(t=>t.netPnl>0).length/trades.length:0,maxDrawdown:maxDD,positiveMonths:[...monthly.values()].filter(v=>v>0).length,activeMonths:monthly.size,monthly:Object.fromEntries([...monthly].sort()),train:period(START,TRAIN_END),test:period(TRAIN_END,END)};
}
const audit=[],base=new Map();
for(const c of CONFIGS){const r=simulate(c);base.set(c.id,r);const monthEntries=Object.entries(r.monthly).filter(([m])=>m>="202509"&&m<="202604");const folds=[];for(let k=0;k<4;k++)folds.push({netPnl:sum(monthEntries.slice(k*2,k*2+2).map(([,v])=>v))});const stable=folds.filter(x=>x.netPnl>0).length>=3&&r.train.netPnl>0&&r.train.profitFactor>=1.05&&r.train.tradesPerDay>=15;const score=stable?(r.train.profitFactor-1)*Math.sqrt(r.train.trades):0;audit.push({config:c,train:r.train,test:r.test,folds,stable,score,full:{trades:r.trades,tradesPerDay:r.tradesPerDay,netPnl:r.netPnl,profitFactor:r.profitFactor,maxDrawdown:r.maxDrawdown,positiveMonths:r.positiveMonths,activeMonths:r.activeMonths}});}
const eligible=audit.filter(x=>x.stable).sort((a,b)=>b.score-a.score),chosen=eligible[0]?.config??null,best=chosen?base.get(chosen.id):null,stress=chosen?simulate(chosen,{friction:STRESS}):null,adverse=chosen?simulate(chosen,{slippage:SLIP*2}):null;
const gates=best?{frequency:best.tradesPerDay>=15,pf:best.profitFactor>=1.10,drawdown:best.maxDrawdown<=.08,train:best.train.netPnl>0&&best.train.profitFactor>=1.05,test:best.test.netPnl>0&&best.test.profitFactor>=1.05,stress:stress.netPnl>0&&stress.profitFactor>=1.02,adverse:adverse.netPnl>0&&adverse.profitFactor>=1.02}:{};
const report={generatedAt:new Date().toISOString(),dataset:{priceSha:priceRaw.sha256??null,premiumSource:premRaw.source,symbols:SYMBOLS,usableCount:SYMBOLS.length,coverage:Object.fromEntries(usable.map(d=>[d.symbol,d.coverage]))},architecture:{type:"8h premium-index cross-sectional long-short",frequency:"3 long + 3 short every 8h => structural target 18 trades/day",antiLeakage:"premium candle t is only used for entry at t+8h",risk:"shared 1000U, 1x gross before risk scale, <=10% total planned stop risk, <=6.5% same-side",cost:"0.14% round-trip friction + 0.025% adverse entry; stress 0.22%; funding cashflows intentionally excluded from PnL",selection:"Sep-Apr train only + four 2-month folds; May-Aug untouched"},audit,chosen:chosen?.id??null,best,stress,adverse,gates,targetMet:Object.keys(gates).length>0&&Object.values(gates).every(Boolean)};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");
console.log("PREMIUM_FREQUENCY_RESULT="+JSON.stringify({targetMet:report.targetMet,symbols:SYMBOLS.length,chosen:report.chosen,best:best&&{trades:best.trades,tradesPerDay:best.tradesPerDay,net:best.netPnl,pf:best.profitFactor,dd:best.maxDrawdown,train:best.train,test:best.test},stress:stress&&{net:stress.netPnl,pf:stress.profitFactor,dd:stress.maxDrawdown},adverse:adverse&&{net:adverse.netPnl,pf:adverse.profitFactor,dd:adverse.maxDrawdown},top:audit.sort((a,b)=>b.score-a.score||b.train.profitFactor-a.train.profitFactor).slice(0,10).map(x=>({id:x.config.id,stable:x.stable,score:x.score,train:x.train,test:x.test,full:x.full,folds:x.folds})),gates},null,2));