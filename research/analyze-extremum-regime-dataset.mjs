import { readFile, writeFile } from "node:fs/promises";

const COST = 0.0019;
const MIN_SOURCES = 3;
const dataset = JSON.parse(await readFile(process.argv[2] ?? "extremum-regime-dataset.json","utf8"));

const median = values => {
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return 0;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sum=a=>a.reduce((x,y)=>x+y,0);

function composite(bySource, seconds){
  const maps=Object.fromEntries(Object.entries(bySource).map(([source,rows])=>[source,new Map(rows.map(r=>[r.time,r]))]));
  const times=[...new Set(Object.values(bySource).flatMap(rows=>rows.map(r=>r.time)))].sort((a,b)=>a-b);
  const out=[];
  for(const time of times){
    const present=Object.entries(maps).flatMap(([source,map])=>map.get(time)?[{source,row:map.get(time)}]:[]);
    if(present.length<MIN_SOURCES)continue;
    const oneStep=[],threeStep=[],newHigh=[],newLow=[];
    for(const {source,row} of present){
      const map=maps[source],p1=map.get(time-seconds),p3=map.get(time-3*seconds);
      if(p1)oneStep.push(row.close/p1.close-1);
      if(p3)threeStep.push(row.close/p3.close-1);
      const prior=[1,2,3,4,5].map(n=>map.get(time-n*seconds)).filter(Boolean);
      if(prior.length>=3){
        newHigh.push(row.high>=Math.max(...prior.map(x=>x.high)));
        newLow.push(row.low<=Math.min(...prior.map(x=>x.low)));
      }
    }
    const breadth=oneStep.length?(oneStep.filter(x=>x>0).length-oneStep.filter(x=>x<0).length)/oneStep.length:0;
    out.push({
      time,
      open:median(present.map(x=>x.row.open)),
      high:median(present.map(x=>x.row.high)),
      low:median(present.map(x=>x.row.low)),
      close:median(present.map(x=>x.row.close)),
      sourceCount:present.length,
      breadth,
      ret3:median(threeStep),
      newHighShare:newHigh.length?newHigh.filter(Boolean).length/newHigh.length:0.5,
      newLowShare:newLow.length?newLow.filter(Boolean).length/newLow.length:0.5,
      sourceRows:Object.fromEntries(present.map(x=>[x.source,x.row])),
      sourceMaps:maps
    });
  }
  return out;
}

function regimeSeries(rows, seconds=300){
  const out=[];
  for(let i=0;i<rows.length;i++){
    const r=rows[i];
    if(i<12){out.push({...r,regime:"TRANSITION",efficiency:0,normalizedMove:0,trendAgreement:0.5,atr:0});continue;}
    const w=rows.slice(i-12,i+1),recent=w.slice(-7);
    const ret=recent.at(-1).close/recent[0].close-1;
    const path=sum(recent.slice(1).map((x,j)=>Math.abs(x.close/recent[j].close-1)));
    const eff=Math.abs(ret)/Math.max(path,1e-9);
    const atr=median(w.slice(0,-1).map(x=>(x.high-x.low)/x.close));
    const normalized=Math.abs(ret)/Math.max(atr,0.0002);
    const sourceMoves=[];
    for(const [source,current] of Object.entries(r.sourceRows)){
      const prior=r.sourceMaps[source]?.get(r.time-6*seconds);
      if(prior)sourceMoves.push(current.close/prior.close-1);
    }
    const directional=sourceMoves.length?Math.max(sourceMoves.filter(x=>x>0).length,sourceMoves.filter(x=>x<0).length)/sourceMoves.length:0.5;
    let regime="TRANSITION";
    if(ret>0&&normalized>=2.0&&eff>=0.55&&directional>=0.75)regime="TREND_UP";
    else if(ret<0&&normalized>=2.0&&eff>=0.55&&directional>=0.75)regime="TREND_DOWN";
    else if(eff<=0.38||normalized<=0.95)regime="SWING";
    out.push({...r,regime,efficiency:eff,normalizedMove:normalized,trendAgreement:directional,atr});
  }
  return out;
}

function latestCompletedFive(five, minuteTime){
  const closeTime=minuteTime+60;
  let lo=0,hi=five.length-1,best=-1;
  while(lo<=hi){
    const mid=(lo+hi)>>1;
    if(five[mid].time+300<=closeTime){best=mid;lo=mid+1;}else hi=mid-1;
  }
  return best>=0?five[best]:null;
}

function minuteContext(rows,i,requireMulti){
  if(i<25)return null;
  const r=rows[i],prev=rows[i-1],w=rows.slice(i-20,i);
  const atr=Math.max(0.0002,median(w.map(x=>(x.high-x.low)/x.close)));
  const high=Math.max(...w.map(x=>x.high)),low=Math.min(...w.map(x=>x.low));
  const impulse=r.close/rows[i-5].close-1;
  const range=Math.max(r.high-r.low,r.close*0.00005);
  const upper=(r.high-Math.max(r.open,r.close))/range;
  const lower=(Math.min(r.open,r.close)-r.low)/range;
  const ret1=r.close/prev.close-1;
  const nearHigh=(high-r.close)/r.close<=atr*0.40;
  const nearLow=(r.close-low)/r.close<=atr*0.40;
  const topMulti=!requireMulti||(r.breadth<=-0.50&&r.newHighShare<=0.75);
  const bottomMulti=!requireMulti||(r.breadth>=0.50&&r.newLowShare<=0.75);
  const top=impulse>atr*1.15&&nearHigh&&r.close<r.open&&(upper>=0.30||ret1<-atr*0.20)&&topMulti;
  const bottom=impulse<-atr*1.15&&nearLow&&r.close>r.open&&(lower>=0.30||ret1>atr*0.20)&&bottomMulti;
  const h12=Math.max(...rows.slice(i-12,i).map(x=>x.high)),l12=Math.min(...rows.slice(i-12,i).map(x=>x.low));
  const dd=(h12-r.close)/r.close, bounce=(r.close-l12)/r.close;
  const restartUp=r.close>prev.high&&r.close>r.open&&(!requireMulti||r.breadth>=0.50);
  const restartDown=r.close<prev.low&&r.close<r.open&&(!requireMulti||r.breadth<=-0.50);
  const pullbackLong=dd>=atr*0.70&&dd<=atr*3.50&&restartUp;
  const pullbackShort=bounce>=atr*0.70&&bounce<=atr*3.50&&restartDown;
  return{atr,top,bottom,pullbackLong,pullbackShort};
}

function localMiss(rows,index,side){
  const a=Math.max(0,index-5),b=Math.min(rows.length,index+6),w=rows.slice(a,b),entry=rows[index].close;
  if(side==="SHORT")return(Math.max(...w.map(x=>x.high))-entry)/entry;
  return(entry-Math.min(...w.map(x=>x.low)))/entry;
}

function simulate(symbol,minute,five,variant){
  const requireMulti=variant.includes("multisource"),useRegime=variant.includes("regime_hybrid");
  const trades=[];let position=null;
  for(let i=25;i<minute.length;i++){
    const r=minute[i],ctx=minuteContext(minute,i,requireMulti);if(!ctx)continue;
    const fiveState=latestCompletedFive(five,r.time),actualRegime=fiveState?.regime??"TRANSITION";
    const regime=useRegime?actualRegime:"SWING";
    if(position){
      const side=position.side,age=i-position.entryIndex;
      const stopped=side==="LONG"?r.low<=position.stopPrice:r.high>=position.stopPrice;
      let exitReason=null,exitPrice=r.close;
      if(stopped){exitReason="STOP";exitPrice=position.stopPrice;}
      else if(position.entryRegime==="TREND_UP"&&side==="LONG"&&(ctx.top||actualRegime!=="TREND_UP"))exitReason="TREND_TOP_OR_DEATH";
      else if(position.entryRegime==="TREND_DOWN"&&side==="SHORT"&&(ctx.bottom||actualRegime!=="TREND_DOWN"))exitReason="TREND_BOTTOM_OR_DEATH";
      else if(position.entryRegime==="SWING"&&side==="LONG"&&ctx.top)exitReason="OPPOSITE_EXTREMUM";
      else if(position.entryRegime==="SWING"&&side==="SHORT"&&ctx.bottom)exitReason="OPPOSITE_EXTREMUM";
      else if(age>=(position.entryRegime.startsWith("TREND")?45:25))exitReason="TIME";
      if(exitReason){
        const gross=(side==="LONG"?exitPrice/position.entryPrice-1:position.entryPrice/exitPrice-1);
        const net=gross-COST;
        trades.push({...position,exitIndex:i,exitAt:r.time+60,exitPrice,gross,net,exitReason,
          exitMiss:localMiss(minute,i,side==="LONG"?"SHORT":"LONG")});
        position=null;
        continue;
      }
    }
    if(position)continue;
    let side=null,entryKind=null;
    if(regime==="SWING"){
      if(ctx.bottom){side="LONG";entryKind="SWING_BOTTOM";}
      else if(ctx.top){side="SHORT";entryKind="SWING_TOP";}
    }else if(regime==="TREND_UP"&&ctx.pullbackLong){side="LONG";entryKind="TREND_PULLBACK";}
    else if(regime==="TREND_DOWN"&&ctx.pullbackShort){side="SHORT";entryKind="TREND_RALLY";}
    if(!side)continue;
    const structural=side==="LONG"?Math.min(...minute.slice(i-5,i+1).map(x=>x.low)):Math.max(...minute.slice(i-5,i+1).map(x=>x.high));
    const rawStop=side==="LONG"?(r.close-structural)/r.close:(structural-r.close)/r.close;
    const stopRate=clamp(Math.max(rawStop+ctx.atr*0.20,ctx.atr*1.35),0.0020,0.0120);
    const stopPrice=r.close*(side==="LONG"?1-stopRate:1+stopRate);
    const againstTrend=actualRegime==="TREND_UP"&&side==="SHORT"||actualRegime==="TREND_DOWN"&&side==="LONG";
    position={symbol,variant,side,entryKind,entryRegime:regime,actualRegime,againstTrend,entryIndex:i,entryAt:r.time+60,
      entryPrice:r.close,stopRate,stopPrice,entryMiss:localMiss(minute,i,side)};
  }
  if(position){
    const i=minute.length-1,r=minute[i],side=position.side,exitPrice=r.close,
      gross=side==="LONG"?exitPrice/position.entryPrice-1:position.entryPrice/exitPrice-1;
    trades.push({...position,exitIndex:i,exitAt:r.time+60,exitPrice,gross,net:gross-COST,exitReason:"END",
      exitMiss:localMiss(minute,i,side==="LONG"?"SHORT":"LONG")});
  }
  return trades;
}

function metrics(trades){
  const wins=trades.filter(t=>t.net>0),losses=trades.filter(t=>t.net<=0);
  const grossWin=sum(wins.map(t=>t.net)),grossLoss=Math.abs(sum(losses.map(t=>t.net)));
  let curve=0,peak=0,maxDd=0;
  for(const t of [...trades].sort((a,b)=>a.exitAt-b.exitAt)){curve+=t.net;peak=Math.max(peak,curve);maxDd=Math.max(maxDd,peak-curve);}
  const near=trades.map(t=>Math.max(0,t.entryMiss));
  const exits=trades.map(t=>Math.max(0,t.exitMiss));
  return{
    trades:trades.length,wins:wins.length,winRate:trades.length?wins.length/trades.length:0,
    netRate:sum(trades.map(t=>t.net)),averageNetRate:trades.length?sum(trades.map(t=>t.net))/trades.length:0,
    medianNetRate:median(trades.map(t=>t.net)),profitFactor:grossLoss>0?grossWin/grossLoss:(grossWin>0?99:0),maxTradeCurveDrawdown:maxDd,
    entryNear25bpRate:near.length?near.filter(x=>x<=0.0025).length/near.length:0,medianEntryMissRate:median(near),
    exitNear25bpRate:exits.length?exits.filter(x=>x<=0.0025).length/exits.length:0,medianExitMissRate:median(exits),
    againstTrendTrades:trades.filter(t=>t.againstTrend).length,
    againstTrendNetRate:sum(trades.filter(t=>t.againstTrend).map(t=>t.net)),
    trendAttackTrades:trades.filter(t=>t.entryKind==="TREND_PULLBACK"||t.entryKind==="TREND_RALLY").length,
    trendAttackNetRate:sum(trades.filter(t=>t.entryKind==="TREND_PULLBACK"||t.entryKind==="TREND_RALLY").map(t=>t.net))
  };
}

const variants=["always_reverse_price_only","always_reverse_multisource","regime_hybrid_price_only","regime_hybrid_multisource"];
const all=Object.fromEntries(variants.map(v=>[v,[]])),coverage={},regimeMinutes={TREND_UP:0,TREND_DOWN:0,SWING:0,TRANSITION:0};

for(const symbol of dataset.symbols){
  const one=dataset.candles?.[symbol]?.["1m"]??{},fiveRaw=dataset.candles?.[symbol]?.["5m"]??{};
  const minute=composite(one,60),five=regimeSeries(composite(fiveRaw,300),300);
  coverage[symbol]={minuteRows:minute.length,fiveRows:five.length,minuteSources:Object.keys(one).length,fiveSources:Object.keys(fiveRaw).length};
  for(const r of minute){
    const s=latestCompletedFive(five,r.time);if(s)regimeMinutes[s.regime]=(regimeMinutes[s.regime]??0)+1;
  }
  if(minute.length<60||five.length<20)continue;
  for(const v of variants)all[v].push(...simulate(symbol,minute,five,v));
}

const allTimes=Object.values(all).flat().map(t=>t.entryAt).sort((a,b)=>a-b);
const splitAt=allTimes.length?allTimes[0]+0.60*(allTimes.at(-1)-allTimes[0]):dataset.collectedAt;
const results={};
for(const v of variants){
  const trades=all[v];
  results[v]={all:metrics(trades),first60:metrics(trades.filter(t=>t.entryAt<splitAt)),last40:metrics(trades.filter(t=>t.entryAt>=splitAt))};
}

const report={
  version:"extremum-regime-lab-v1",
  datasetVersion:dataset.version,
  collectedAt:dataset.collectedAt,
  analyzedAt:Date.now(),
  costRate:COST,
  minSources:MIN_SOURCES,
  splitAt,
  coverage,
  regimeMinutes,
  results,
  notes:[
    "Signals use only bars completed at decision time; centered local extrema are used only for post-hoc distance scoring.",
    "This is a short-window feasibility test, not evidence of future profitability.",
    "regime_hybrid never opens counter-trend positions while TREND_UP/TREND_DOWN is active; local extrema in trend are used primarily as exits/profit protection."
  ]
};
await writeFile("extremum-regime-report.json",JSON.stringify(report,null,2));

const pct=v=>(100*v).toFixed(2)+"%";
const row=v=>{const m=results[v].all,h=results[v].last40;return `| ${v} | ${m.trades} | ${pct(m.winRate)} | ${pct(m.netRate)} | ${m.profitFactor.toFixed(2)} | ${pct(m.entryNear25bpRate)} | ${m.againstTrendTrades} | ${pct(m.againstTrendNetRate)} | ${h.trades} | ${pct(h.netRate)} |\n`;};
let md=`# Extremum Regime Lab\n\nDataset: ${new Date(dataset.collectedAt).toISOString()} · modeled round-trip friction ${pct(COST)} · minimum simultaneous sources ${MIN_SOURCES}.\n\n| Variant | Trades | Win rate | Sum net return | PF | Entry <=25bp from local extremum | Against-trend trades | Against-trend net | Last40 trades | Last40 net |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
for(const v of variants)md+=row(v);
md+=`\nRegime minute counts: ${JSON.stringify(regimeMinutes)}\n\nThe regime hybrid uses SWING for two-sided reversal, TREND_UP for trough-to-long only, TREND_DOWN for rally-to-short only, and TRANSITION for no new entry.\n`;
await writeFile("extremum-regime-report.md",md);
console.log(md);
