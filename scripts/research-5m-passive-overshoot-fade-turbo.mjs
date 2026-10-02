import { readFileSync, writeFileSync } from 'node:fs';

const DATASET=process.env.RESEARCH_DATASET??'/tmp/gate-history-passive-5m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/passive-overshoot-fade-turbo.json';
const raw=JSON.parse(readFileSync(DATASET,'utf8'));
if(raw.interval!=='5m')throw new Error('requires Gate 5m candles');
const sourceDatasets=raw.datasets??[];if(sourceDatasets.length<12)throw new Error(`need >=12 symbols, got ${sourceDatasets.length}`);
const INITIAL=1000,DAY=86400000;
const split={discovery:[Date.UTC(2025,8,1),Date.UTC(2026,2,1)],validation:[Date.UTC(2026,2,1),Date.UTC(2026,5,1)],evaluation:[Date.UTC(2026,5,1),Date.UTC(2026,8,1)],full:[Date.UTC(2025,8,1),Date.UTC(2026,8,1)]};
const scenarios={base:{maker:0.0002,taker:0.0007,fillBuffer:0.0002},stress:{maker:0.0004,taker:0.0009,fillBuffer:0.0004},adverse:{maker:0.0004,taker:0.0014,fillBuffer:0.0005}};
const sum=a=>a.reduce((s,x)=>s+x,0),mean=a=>a.length?sum(a)/a.length:0;
const monthKey=ms=>new Date(ms).toISOString().slice(0,7);
function lowerBound(a,x){let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m]<x)lo=m+1;else hi=m;}return lo;}
function removeSorted(a,x){let i=lowerBound(a,x);while(i<a.length&&a[i]!==x)i++;if(i===a.length)throw new Error('rolling median remove miss');a.splice(i,1);}
function insertSorted(a,x){a.splice(lowerBound(a,x),0,x);}
function rollingFeatures(close,ranges,n){
  const len=close.length,ma=new Float64Array(len),med=new Float64Array(len);ma.fill(NaN);med.fill(NaN);
  if(len<=n)return{ma,med};
  let s=0;const sorted=[];for(let j=0;j<n;j++){s+=close[j];insertSorted(sorted,ranges[j]);}
  for(let i=n;i<len;i++){
    ma[i]=s/n;med[i]=sorted[Math.floor(n/2)];
    if(i+1<len){s+=close[i]-close[i-n];removeSorted(sorted,ranges[i-n]);insertSorted(sorted,ranges[i]);}
  }
  return{ma,med};
}
const datasets=sourceDatasets.map(ds=>{
  const n=ds.rows.length,time=new Float64Array(n),open=new Float64Array(n),high=new Float64Array(n),low=new Float64Array(n),close=new Float64Array(n),ranges=new Float64Array(n);
  for(let i=0;i<n;i++){const r=ds.rows[i];time[i]=Number(r.time);open[i]=Number(r.open);high[i]=Number(r.high);low[i]=Number(r.low);close[i]=Number(r.close);ranges[i]=high[i]-low[i];}
  return{symbol:ds.symbol,n,time,open,high,low,close,ranges,f12:rollingFeatures(close,ranges,12),f24:rollingFeatures(close,ranges,24)};
});
const mechanismKey=c=>[c.anchorBars,c.z,c.entryAtr,c.targetAtr,c.stopAtr,c.holdBars,c.orderLifeBars].join('|');
const rawCache=new Map();
function rawTrades(config,scenarioName){
  const key=`${scenarioName}|${mechanismKey(config)}`;if(rawCache.has(key))return rawCache.get(key);
  const scenario=scenarios[scenarioName],out=[];
  for(const d of datasets){
    const f=config.anchorBars===12?d.f12:d.f24;let i=Math.max(config.anchorBars,24);
    while(i<d.n-config.orderLifeBars-config.holdBars-2){
      const anchor=f.ma[i],atr=f.med[i];if(!(anchor>0&&atr>0)){i++;continue;}
      const z=(d.close[i]-anchor)/atr;if(Math.abs(z)<config.z){i++;continue;}
      const direction=z>0?-1:1,limit=d.close[i]-direction*config.entryAtr*atr;let fillIndex=-1;
      for(let j=i+1;j<=i+config.orderLifeBars&&j<d.n;j++){
        const crossed=direction>0?d.low[j]<=limit*(1-scenario.fillBuffer):d.high[j]>=limit*(1+scenario.fillBuffer);if(crossed){fillIndex=j;break;}
      }
      if(fillIndex<0){i+=config.orderLifeBars+1;continue;}
      const entry=limit,target=entry+direction*config.targetAtr*atr,stop=entry-direction*config.stopAtr*atr;
      let exit=entry,exitIndex=fillIndex,outcome='TIMEOUT',exitFee=scenario.taker;const last=Math.min(d.n-1,fillIndex+config.holdBars);
      for(let j=fillIndex+1;j<=last;j++){
        const stopHit=direction>0?d.low[j]<=stop:d.high[j]>=stop,targetHit=direction>0?d.high[j]>=target*(1+scenario.fillBuffer):d.low[j]<=target*(1-scenario.fillBuffer);
        if(stopHit||targetHit){if(stopHit){exit=stop;outcome='STOP';exitFee=scenario.taker;}else{exit=target;outcome='TARGET';exitFee=scenario.maker;}exitIndex=j;break;}
        exit=d.close[j];exitIndex=j;outcome=j===last?'TIMEOUT':outcome;
      }
      const gross=direction*(exit-entry)/entry,net=gross-scenario.maker-exitFee;
      out.push({symbol:d.symbol,openedAt:d.time[fillIndex]*1000,closedAt:d.time[exitIndex]*1000,side:direction>0?'LONG':'SHORT',entry,exit,stopRate:Math.abs(entry-stop)/entry,grossReturnRate:gross,netReturnRate:net,outcome,signalZ:z});
      i=exitIndex+1;
    }
  }
  out.sort((a,b)=>a.openedAt-b.openedAt||Math.abs(b.signalZ)-Math.abs(a.signalZ));rawCache.set(key,out);return out;
}
function portfolio(trades,fraction){
  let equity=INITIAL,peak=INITIAL,maxDD=0;const open=[],accepted=[];
  const settle=time=>{for(const t of open.filter(x=>x.closedAt<=time).sort((a,b)=>a.closedAt-b.closedAt)){equity+=t.netPnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-12));open.splice(open.indexOf(t),1);}};
  for(let i=0;i<trades.length;){const at=trades[i].openedAt;settle(at);const same=[];while(i<trades.length&&trades[i].openedAt===at)same.push(trades[i++]);for(const t of same){if(equity<=100||open.some(x=>x.symbol===t.symbol))continue;const notional=equity*fraction,plannedRisk=notional*(t.stopRate+0.0014),gross=sum(open.map(x=>x.notional)),risk=sum(open.map(x=>x.plannedRisk)),sideGross=sum(open.filter(x=>x.side===t.side).map(x=>x.notional));if(gross+notional>equity*1.5||risk+plannedRisk>equity*.10||sideGross+notional>equity*1.0)continue;const a={...t,equityAtOpen:equity,notional,plannedRisk,netPnl:notional*t.netReturnRate};open.push(a);accepted.push(a);}}
  settle(Infinity);return{trades:accepted,endEquity:equity,maxDrawdown:maxDD};
}
function metrics(account,start,end){
  const rows=account.trades.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netPnl>0),l=rows.filter(t=>t.netPnl<=0);let eq=INITIAL,peak=eq,dd=0;const monthly=new Map();
  for(const t of [...rows].sort((a,b)=>a.closedAt-b.closedAt)){const before=eq;eq+=t.netPnl;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/Math.max(peak,1e-12));const k=monthKey(t.openedAt),m=monthly.get(k)??{start:before,end:before,trades:0};m.end=eq;m.trades++;monthly.set(k,m);}
  const days=(end-start)/DAY,turnover=2*sum(rows.map(t=>t.notional/Math.max(t.equityAtOpen,1e-12)))/days,months=[...monthly.values()].map(x=>x.end/x.start-1);
  return{trades:rows.length,tradesPerDay:rows.length/days,turnoverPerDay:turnover,returnPct:(eq/INITIAL-1)*100,avgMonthPct:(months.length?mean(months):-1)*100,positiveMonths:months.filter(x=>x>0).length,activeMonths:months.length,profitFactor:l.length?sum(g.map(t=>t.netPnl))/Math.abs(sum(l.map(t=>t.netPnl))):g.length?99:0,maxDrawdownPct:dd*100,targets:rows.filter(t=>t.outcome==='TARGET').length,stops:rows.filter(t=>t.outcome==='STOP').length,timeouts:rows.filter(t=>t.outcome==='TIMEOUT').length};
}
function evaluate(config,scenarioName){const account=portfolio(rawTrades(config,scenarioName),config.fraction);return{endEquity:account.endEquity,maxDrawdownPct:account.maxDrawdown*100,periods:Object.fromEntries(Object.entries(split).map(([k,[a,b]])=>[k,metrics(account,a,b)]))};}
const mechanisms=[];for(const anchorBars of [12,24])for(const z of [1.0,1.5])for(const entryAtr of [0.25,0.5])for(const targetAtr of [0.5,1.0])for(const stopAtr of [1.0,1.5])for(const holdBars of [6,12])mechanisms.push({anchorBars,z,entryAtr,targetAtr,stopAtr,holdBars,orderLifeBars:2});
const configs=mechanisms.flatMap(m=>[.10,.20,.30].map(fraction=>({...m,fraction})));
const stressRows=configs.map(config=>{const stress=evaluate(config,'stress'),d=stress.periods.discovery,inBand=d.turnoverPerDay>=3.5&&d.turnoverPerDay<=6.5,qualified=inBand&&d.returnPct>0&&d.profitFactor>=1.02&&d.maxDrawdownPct<=30,score=d.avgMonthPct*2-Math.abs(d.turnoverPerDay-5)*2-d.maxDrawdownPct*.1;return{config,stress,discoveryQualified:qualified,score};}).sort((a,b)=>Number(b.discoveryQualified)-Number(a.discoveryQualified)||b.score-a.score);
const discoveryCandidates=stressRows.filter(x=>x.discoveryQualified).slice(0,20);let selected=null;for(const row of discoveryCandidates){const v=row.stress.periods.validation;if(v.returnPct>0&&v.profitFactor>=1&&v.turnoverPerDay>=3&&v.turnoverPerDay<=7){selected=row;break;}}
const targetBandBest=[...stressRows].filter(x=>x.stress.periods.discovery.turnoverPerDay>=3.5&&x.stress.periods.discovery.turnoverPerDay<=6.5).sort((a,b)=>b.stress.periods.discovery.avgMonthPct-a.stress.periods.discovery.avgMonthPct)[0]??null;
let selectedDetail=null,passes=false;if(selected){const base=evaluate(selected.config,'base'),adverse=evaluate(selected.config,'adverse'),s=selected.stress.periods,a=adverse.periods;passes=s.discovery.avgMonthPct>=5&&s.validation.avgMonthPct>=5&&s.evaluation.avgMonthPct>=5&&s.evaluation.returnPct>0&&s.evaluation.profitFactor>=1&&s.full.turnoverPerDay>=3.5&&s.full.turnoverPerDay<=6.5&&a.discovery.returnPct>0&&a.validation.returnPct>0&&a.evaluation.returnPct>0;selectedDetail={...selected,base,adverse};}
const report={research:'5m-passive-overshoot-fade-v1-turbo',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',decision:passes?'FORWARD_VALIDATION_CANDIDATE':'PASSIVE_OVERSHOOT_REJECTED',passes,data:{source:raw.source,sha256:raw.sha256,months:raw.months,symbols:raw.symbols},hypothesis:'completed 5m OHLCV only; volatility-scaled passive fade limits beyond overshoots; no orderbook/tick feed',costs:scenarios,protocol:{identicalToV1:true,optimization:'rolling 12/24-bar mean and upper-median candle range are precomputed once per symbol; mechanism/scenario trade paths cached across position-size variants; no strategy parameter, fill rule, cost, split, sizing or acceptance change'},configCount:configs.length,mechanismCount:mechanisms.length,rawPathCount:rawCache.size,discoveryQualified:stressRows.filter(x=>x.discoveryQualified).length,selected:selectedDetail,targetBandBest:targetBandBest?{config:targetBandBest.config,stress:targetBandBest.stress}:null,topDiscovery:stressRows.slice(0,10),interpretation:passes?'A low-data slow-passive mechanism survives; next stage requires broader-year and paper fill validation.':'Do not tune these same overshoot/ATR thresholds against evaluation. If target-band economics are negative, close this low-data passive family.'};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+'\n');console.log('PASSIVE_OVERSHOOT_TURBO_JSON='+JSON.stringify({decision:report.decision,passes,configCount:report.configCount,mechanismCount:report.mechanismCount,rawPathCount:report.rawPathCount,discoveryQualified:report.discoveryQualified,selected:report.selected&&{config:report.selected.config,stress:report.selected.stress.periods,adverse:report.selected.adverse.periods},targetBandBest:report.targetBandBest&&{config:report.targetBandBest.config,discovery:report.targetBandBest.stress.periods.discovery,validation:report.targetBandBest.stress.periods.validation,evaluation:report.targetBandBest.stress.periods.evaluation,full:report.targetBandBest.stress.periods.full}}));
