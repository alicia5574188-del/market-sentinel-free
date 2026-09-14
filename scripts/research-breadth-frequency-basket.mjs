import { readFileSync, writeFileSync } from "node:fs";

const INPUT=process.env.RESEARCH_DATASET??"/tmp/gate-history-frequency-aligned-12m.json";
const OUTPUT=process.env.BREADTH_OUTPUT??"/tmp/breadth-frequency-basket.json";
const raw=JSON.parse(readFileSync(INPUT,"utf8"));
if(raw.interval!=="5m"||raw.months.length!==12)throw new Error("Expected aligned 12m Gate 5m dataset");
const CORE=["BTC_USDT","ETH_USDT","SOL_USDT","XRP_USDT","BNB_USDT","DOGE_USDT","ADA_USDT","LINK_USDT","LTC_USDT","AVAX_USDT","BCH_USDT"];
const SYMBOLS=raw.datasets.map(d=>d.symbol),data=new Map(raw.datasets.map(d=>[d.symbol,d.rows])),ref=data.get(SYMBOLS[0]);
const FRICTION=.0014,STRESS=.0022,SLIP=.00025,DAY=86_400_000,START=raw.from*1000,END=raw.now*1000,TRAIN_END=Date.UTC(2026,4,1);
const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>xs.length?sum(xs)/xs.length:0,clip=(x,a,b)=>Math.max(a,Math.min(b,x));
const stdev=xs=>{const m=mean(xs);return Math.sqrt(mean(xs.map(x=>(x-m)**2)));};
const median=xs=>{if(!xs.length)return 0;const a=[...xs].sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
const rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12),monthKey=ms=>new Date(ms).toISOString().slice(0,7).replace("-","");

const CONFIGS=[];
for(const lookback of [24,72,168]){
  for(const cadence of [12,24]){
    const legSet=cadence===12?[4,5,6]:[8];
    for(const legs of legSet)for(const mode of ["MOMENTUM","REVERSAL","ADAPTIVE"])for(const score of ["RAW","VOL_ADJ"])
      CONFIGS.push({id:`breadth-${mode.toLowerCase()}-${score.toLowerCase()}-lb${lookback}-c${cadence}-n${legs}`,lookback,cadence,legs,mode,score});
  }
}
function coreState(i){
  const j=i-1,rets=[];for(const s of CORE){const r=data.get(s);rets.push(r[j].close/r[j-288].close-1);}const m=median(rets),breadth=rets.filter(x=>x>0).length/rets.length,aligned=Math.max(breadth,1-breadth);return{median24:m,breadth,aligned,directional:Math.abs(m)>=.015&&aligned>=.67};
}
function rankRows(i,c){
  const j=i-1,lb=c.lookback*12,out=[];
  for(const s of SYMBOLS){const r=data.get(s);if(j-lb<1)continue;const ret=r[j].close/r[j-lb].close-1,rs=[];for(let k=j-lb+1;k<=j;k++)rs.push(r[k].close/r[k-1].close-1);const vol=Math.max(stdev(rs),1e-5),score=c.score==="VOL_ADJ"?ret/(vol*Math.sqrt(lb)):ret;out.push({symbol:s,ret,score});}
  out.sort((a,b)=>a.score-b.score);return out;
}
function trade(symbol,direction,i,c,friction=FRICTION,slippage=SLIP){
  const rows=data.get(symbol),entry=rows[i].open*(1+direction*slippage),j=i-1,atr=median(rows.slice(Math.max(0,j-143),j+1).map(rangeRate));
  const stopRate=clip(Math.max(.03,atr*8),.03,.08),stop=entry*(1-direction*stopRate),bars=c.cadence*12;
  let exit=rows[Math.min(rows.length-1,i+bars)].open,kx=Math.min(rows.length-1,i+bars),outcome="TIME";
  for(let k=i+1;k<=Math.min(rows.length-1,i+bars);k++){const p=rows[k].open;if(direction>0?p<=stop:p>=stop){exit=stop;kx=k;outcome="STOP";break;}}
  const gross=direction*(exit-entry)/entry,net=gross-friction;
  return{symbol,direction,openedAt:rows[i].time*1000,closedAt:rows[kx].time*1000,stopRate,grossReturn:gross,netReturn:net,outcome};
}
function simulate(c,{friction=FRICTION,slippage=SLIP,grossExposure=1}={}){
  const trades=[];let equity=1000,peak=1000,maxDD=0,baskets=0;
  const warm=Math.max(168*12+1,c.lookback*12+1);
  for(let i=warm;i<ref.length-c.cadence*12;i++){
    const ts=ref[i].time;if(ts%(c.cadence*3600)!==0)continue;
    const ranked=rankRows(i,c);if(ranked.length<2*c.legs)continue;
    const state=coreState(i),effective=c.mode==="ADAPTIVE"?(state.directional?"MOMENTUM":"REVERSAL"):c.mode;
    const low=ranked.slice(0,c.legs),high=ranked.slice(-c.legs),picks=[];
    if(effective==="MOMENTUM"){for(const x of high)picks.push([x.symbol,1]);for(const x of low)picks.push([x.symbol,-1]);}
    else{for(const x of high)picks.push([x.symbol,-1]);for(const x of low)picks.push([x.symbol,1]);}
    const notional0=equity*grossExposure/(2*c.legs),batch=picks.map(([s,d])=>{const t=trade(s,d,i,c,friction,slippage);return{...t,notional:notional0,plannedRisk:notional0*(t.stopRate+friction),netPnl:notional0*t.netReturn,configId:c.id,effectiveMode:effective};});
    const total=sum(batch.map(t=>t.plannedRisk)),lr=sum(batch.filter(t=>t.direction>0).map(t=>t.plannedRisk)),sr=sum(batch.filter(t=>t.direction<0).map(t=>t.plannedRisk));
    const scale=Math.min(1,equity*.10/Math.max(total,1e-9),equity*.065/Math.max(lr,1e-9),equity*.065/Math.max(sr,1e-9));
    batch.sort((a,b)=>a.closedAt-b.closedAt);for(const t of batch){t.notional*=scale;t.plannedRisk*=scale;t.netPnl=t.notional*t.netReturn;equity=Math.max(.01,equity+t.netPnl);trades.push(t);peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));}baskets++;
  }
  const period=(a,b)=>{const xs=trades.filter(t=>t.openedAt>=a&&t.openedAt<b),g=sum(xs.filter(t=>t.netPnl>0).map(t=>t.netPnl)),l=Math.abs(sum(xs.filter(t=>t.netPnl<=0).map(t=>t.netPnl)));return{trades:xs.length,tradesPerDay:xs.length/((b-a)/DAY),netPnl:sum(xs.map(t=>t.netPnl)),profitFactor:l?g/l:g?99:0,winRate:xs.length?xs.filter(t=>t.netPnl>0).length/xs.length:0};};
  const g=sum(trades.filter(t=>t.netPnl>0).map(t=>t.netPnl)),l=Math.abs(sum(trades.filter(t=>t.netPnl<=0).map(t=>t.netPnl))),monthly=new Map();for(const t of trades){const m=monthKey(t.closedAt);monthly.set(m,(monthly.get(m)??0)+t.netPnl);}
  return{config:c,baskets,trades:trades.length,tradesPerDay:trades.length/((END-START)/DAY),netPnl:equity-1000,endEquity:equity,profitFactor:l?g/l:g?99:0,winRate:trades.length?trades.filter(t=>t.netPnl>0).length/trades.length:0,maxDrawdown:maxDD,positiveMonths:[...monthly.values()].filter(x=>x>0).length,activeMonths:monthly.size,monthly:Object.fromEntries([...monthly].sort()),train:period(START,TRAIN_END),test:period(TRAIN_END,END)};
}
const audit=[],base=new Map();
for(const c of CONFIGS){const r=simulate(c);base.set(c.id,r);const ms=Object.entries(r.monthly).filter(([m])=>m>="202509"&&m<="202604").map(([,p])=>p),folds=[];for(let k=0;k<4;k++)folds.push({netPnl:sum(ms.slice(k*2,k*2+2))});const stable=folds.filter(x=>x.netPnl>0).length>=3&&r.train.netPnl>0&&r.train.profitFactor>=1.05;const score=stable?(r.train.profitFactor-1)*Math.sqrt(r.train.trades):0;audit.push({config:c,train:r.train,test:r.test,folds,stable,score,full:{trades:r.trades,tradesPerDay:r.tradesPerDay,netPnl:r.netPnl,profitFactor:r.profitFactor,maxDrawdown:r.maxDrawdown}});}
const eligible=audit.filter(x=>x.stable).sort((a,b)=>b.score-a.score),chosen=eligible[0]?.config??null,best=chosen?base.get(chosen.id):null,stress=chosen?simulate(chosen,{friction:STRESS}):null,adverse=chosen?simulate(chosen,{slippage:SLIP*2}):null;
const gates=best?{frequency:best.tradesPerDay>=15,pf:best.profitFactor>=1.10,drawdown:best.maxDrawdown<=.08,train:best.train.netPnl>0&&best.train.profitFactor>=1.05,test:best.test.netPnl>0&&best.test.profitFactor>=1.05,stress:stress.netPnl>0&&stress.profitFactor>=1.02,adverse:adverse.netPnl>0&&adverse.profitFactor>=1.02}:{};
const report={generatedAt:new Date().toISOString(),dataset:{sha256:raw.sha256,symbols:SYMBOLS,months:raw.months},architecture:{type:"low-turnover high-breadth market-neutral basket",target:"frequency from breadth rather than repeated short-horizon churn",risk:"shared 1000U, <=10% stop risk, <=6.5% same-side risk",execution:"12h/24h baskets; 5m executable-open entry/stop/time exit",selection:"Sep-Apr only with four 2-month train folds; May-Aug untouched"},audit,chosen:chosen?.id??null,best,stress,adverse,gates,targetMet:Object.keys(gates).length>0&&Object.values(gates).every(Boolean)};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");
console.log("BREADTH_BASKET_RESULT="+JSON.stringify({targetMet:report.targetMet,chosen:report.chosen,best:best&&{tradesPerDay:best.tradesPerDay,trades:best.trades,pf:best.profitFactor,net:best.netPnl,dd:best.maxDrawdown,train:best.train,test:best.test},stress:stress&&{pf:stress.profitFactor,net:stress.netPnl,dd:stress.maxDrawdown},adverse:adverse&&{pf:adverse.profitFactor,net:adverse.netPnl,dd:adverse.maxDrawdown},top:audit.sort((a,b)=>b.score-a.score).slice(0,10).map(x=>({id:x.config.id,stable:x.stable,score:x.score,train:x.train,test:x.test,full:x.full})),gates},null,2));