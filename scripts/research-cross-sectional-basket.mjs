import { readFileSync, writeFileSync } from "node:fs";

const INPUT=process.env.RESEARCH_DATASET??"/tmp/gate-history-frequency-aligned-12m.json";
const OUTPUT=process.env.BASKET_OUTPUT??"/tmp/cross-sectional-basket-frequency.json";
const raw=JSON.parse(readFileSync(INPUT,"utf8"));
if(raw.interval!=="5m"||raw.months.length!==12)throw new Error("Expected aligned 12m Gate 5m dataset");
const SYMBOLS=raw.datasets.map(d=>d.symbol),data=new Map(raw.datasets.map(d=>[d.symbol,d.rows])),ref=data.get(SYMBOLS[0]);
const FRICTION=.0014,STRESS=.0022,SLIP=.00025,DAY=86_400_000,START=raw.from*1000,END=raw.now*1000,TRAIN_END=Date.UTC(2026,4,1);
const sum=xs=>xs.reduce((a,b)=>a+b,0),clip=(x,a,b)=>Math.max(a,Math.min(b,x));
const mean=xs=>xs.length?sum(xs)/xs.length:0;
const stdev=xs=>{const m=mean(xs);return Math.sqrt(mean(xs.map(x=>(x-m)**2)));};
const median=xs=>{if(!xs.length)return 0;const a=[...xs].sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
const rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12),monthKey=ms=>new Date(ms).toISOString().slice(0,7).replace("-","");

const CONFIGS=[];
for(const lookback of [4,12,24])for(const cadence of [4,6,8])for(const legs of [2,3])for(const mode of ["MOMENTUM","REVERSAL"])for(const score of ["RAW","VOL_ADJ"]){
  if(2*legs>SYMBOLS.length)continue;
  CONFIGS.push({id:`xs-${mode.toLowerCase()}-${score.toLowerCase()}-lb${lookback}-c${cadence}-n${legs}`,lookback,cadence,legs,mode,score});
}

function scoreRows(i,c){
  const j=i-1,lb=c.lookback*12;
  const rows=[];
  for(const s of SYMBOLS){const r=data.get(s);if(j-lb<1)continue;const ret=r[j].close/r[j-lb].close-1;const rs=[];for(let k=j-lb+1;k<=j;k++)rs.push(r[k].close/r[k-1].close-1);const vol=Math.max(stdev(rs),1e-5);rows.push({symbol:s,ret,vol,score:c.score==="VOL_ADJ"?ret/(vol*Math.sqrt(lb)):ret});}
  rows.sort((a,b)=>a.score-b.score);return rows;
}
function legTrade(symbol,direction,i,c,friction=FRICTION,slippage=SLIP){
  const rows=data.get(symbol),entry=rows[i].open*(1+direction*slippage),j=i-1;
  const atr=median(rows.slice(Math.max(0,j-71),j+1).map(rangeRate));
  const stopRate=clip(Math.max(.02,atr*6),.02,.05),stop=entry*(1-direction*stopRate),bars=c.cadence*12;
  let exit=rows[Math.min(rows.length-1,i+bars)].open,closedIndex=Math.min(rows.length-1,i+bars),outcome="TIME";
  for(let k=i+1;k<=Math.min(rows.length-1,i+bars);k++){const p=rows[k].open;if(direction>0?p<=stop:p>=stop){exit=stop;closedIndex=k;outcome="STOP";break;}}
  const gross=direction*(exit-entry)/entry,net=gross-friction;
  return{symbol,direction,openedAt:rows[i].time*1000,closedAt:rows[closedIndex].time*1000,entry,exit,stopRate,grossReturn:gross,netReturn:net,outcome};
}
function simulate(c,{friction=FRICTION,slippage=SLIP,grossExposure=1}={}){
  const trades=[];let equity=1000,peak=1000,maxDD=0,baskets=0;
  const startIndex=Math.max(24*12+1,c.lookback*12+1);
  for(let i=startIndex;i<ref.length-c.cadence*12;i++){
    const ts=ref[i].time;if(ts%(c.cadence*3600)!==0)continue;
    const ranked=scoreRows(i,c);if(ranked.length<2*c.legs)continue;
    const low=ranked.slice(0,c.legs),high=ranked.slice(-c.legs),picks=[];
    if(c.mode==="MOMENTUM"){for(const x of high)picks.push([x.symbol,1]);for(const x of low)picks.push([x.symbol,-1]);}
    else{for(const x of high)picks.push([x.symbol,-1]);for(const x of low)picks.push([x.symbol,1]);}
    const legNotional=equity*grossExposure/(2*c.legs),batch=[];
    for(const [s,d] of picks){const t=legTrade(s,d,i,c,friction,slippage);batch.push({...t,notional:legNotional,plannedRisk:legNotional*(t.stopRate+friction),netPnl:legNotional*t.netReturn,configId:c.id});}
    const totalRisk=sum(batch.map(t=>t.plannedRisk)),longRisk=sum(batch.filter(t=>t.direction>0).map(t=>t.plannedRisk)),shortRisk=sum(batch.filter(t=>t.direction<0).map(t=>t.plannedRisk));
    const scale=Math.min(1,equity*.10/Math.max(totalRisk,1e-9),equity*.065/Math.max(longRisk,1e-9),equity*.065/Math.max(shortRisk,1e-9));
    for(const t of batch){t.notional*=scale;t.plannedRisk*=scale;t.netPnl=t.notional*t.netReturn;}
    batch.sort((a,b)=>a.closedAt-b.closedAt);
    for(const t of batch){equity=Math.max(.01,equity+t.netPnl);trades.push(t);peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));}
    baskets++;
  }
  const period=(a,b)=>{const xs=trades.filter(t=>t.openedAt>=a&&t.openedAt<b),g=sum(xs.filter(t=>t.netPnl>0).map(t=>t.netPnl)),l=Math.abs(sum(xs.filter(t=>t.netPnl<=0).map(t=>t.netPnl)));return{trades:xs.length,tradesPerDay:xs.length/((b-a)/DAY),netPnl:sum(xs.map(t=>t.netPnl)),profitFactor:l?g/l:g?99:0,winRate:xs.length?xs.filter(t=>t.netPnl>0).length/xs.length:0};};
  const g=sum(trades.filter(t=>t.netPnl>0).map(t=>t.netPnl)),l=Math.abs(sum(trades.filter(t=>t.netPnl<=0).map(t=>t.netPnl))),monthly=new Map();for(const t of trades){const m=monthKey(t.closedAt);monthly.set(m,(monthly.get(m)??0)+t.netPnl);}
  return{config:c,baskets,trades:trades.length,tradesPerDay:trades.length/((END-START)/DAY),netPnl:equity-1000,endEquity:equity,profitFactor:l?g/l:g?99:0,winRate:trades.length?trades.filter(t=>t.netPnl>0).length/trades.length:0,maxDrawdown:maxDD,positiveMonths:[...monthly.values()].filter(x=>x>0).length,activeMonths:monthly.size,monthly:Object.fromEntries([...monthly].sort()),train:period(START,TRAIN_END),test:period(TRAIN_END,END)};
}
const baseById=new Map(),audit=[];
for(const c of CONFIGS){const r=simulate(c);baseById.set(c.id,r);const trainMonths=Object.entries(r.monthly).filter(([m])=>m>="202509"&&m<="202604").map(([,p])=>p),foldProxy=[];for(let k=0;k<4;k++){const seg=trainMonths.slice(k*2,k*2+2);foldProxy.push({netPnl:sum(seg)});}
  const stable=foldProxy.filter(x=>x.netPnl>0).length>=3&&r.train.trades>=200&&r.train.netPnl>0&&r.train.profitFactor>=1.05;
  const score=stable?(r.train.profitFactor-1)*Math.sqrt(r.train.trades)*Math.min(1,r.train.tradesPerDay/15):0;
  audit.push({config:c,train:r.train,test:r.test,foldProxy,stable,score,full:{trades:r.trades,tradesPerDay:r.tradesPerDay,netPnl:r.netPnl,profitFactor:r.profitFactor,maxDrawdown:r.maxDrawdown}});
}
const eligible=audit.filter(x=>x.stable).sort((a,b)=>b.score-a.score),chosen=eligible[0]?.config??null;
const best=chosen?baseById.get(chosen.id):null,stress=chosen?simulate(chosen,{friction:STRESS,slippage:SLIP}):null,adverse=chosen?simulate(chosen,{friction:FRICTION,slippage:SLIP*2}):null;
const gates=best?{frequency:best.tradesPerDay>=15,pf:best.profitFactor>=1.10,drawdown:best.maxDrawdown<=.08,train:best.train.netPnl>0&&best.train.profitFactor>=1.05,test:best.test.netPnl>0&&best.test.profitFactor>=1.05,stress:stress.netPnl>0&&stress.profitFactor>=1.02,adverse:adverse.netPnl>0&&adverse.profitFactor>=1.02}:{};
const report={generatedAt:new Date().toISOString(),dataset:{sha256:raw.sha256,symbols:SYMBOLS,months:raw.months},architecture:{type:"market-neutral cross-sectional long-short basket",selection:"train Sep-Apr only; final May-Aug untouched",risk:"one 1000U account, 1.0x gross exposure before risk scaling, <=10% total stop risk, <=6.5% per side",execution:"completed lookback ranks, next 5m open entry, 5m executable-open stop checks, fixed cadence exit",configGrid:{lookbacks:[4,12,24],cadences:[4,6,8],legs:[2,3],modes:["MOMENTUM","REVERSAL"],scores:["RAW","VOL_ADJ"]}},audit,chosen:chosen?.id??null,best,stress,adverse,gates,targetMet:Object.keys(gates).length>0&&Object.values(gates).every(Boolean)};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");
console.log("CROSS_SECTIONAL_BASKET_RESULT="+JSON.stringify({targetMet:report.targetMet,chosen:report.chosen,best:best&&{tradesPerDay:best.tradesPerDay,trades:best.trades,pf:best.profitFactor,net:best.netPnl,dd:best.maxDrawdown,train:best.train,test:best.test},stress:stress&&{pf:stress.profitFactor,net:stress.netPnl,dd:stress.maxDrawdown},adverse:adverse&&{pf:adverse.profitFactor,net:adverse.netPnl,dd:adverse.maxDrawdown},topTrain:audit.sort((a,b)=>b.score-a.score).slice(0,8).map(x=>({id:x.config.id,stable:x.stable,score:x.score,train:x.train,test:x.test,full:x.full})),gates},null,2));