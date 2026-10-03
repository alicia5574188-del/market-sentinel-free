import { readFileSync, writeFileSync } from "node:fs";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-brm-satellite.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/brm-trend7-external-satellite.json";
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const STRESS_FRICTION = Number(process.env.RESEARCH_STRESS_FRICTION ?? 0.0022);
const ENTRY_SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
if (raw.interval !== "5m") throw new Error("Requires Gate 5m dataset");

const CORE = ["BTC_USDT","ETH_USDT","SOL_USDT","XRP_USDT","BNB_USDT","DOGE_USDT","ADA_USDT","LINK_USDT","LTC_USDT","AVAX_USDT","BCH_USDT"];
const SATELLITES = ["SUI_USDT", "UNI_USDT"];
const CORE_SET = new Set(CORE); const SATELLITE_SET = new Set(SATELLITES);
for (const symbol of [...CORE, ...SATELLITES]) if (!raw.symbols.includes(symbol)) throw new Error(`Missing ${symbol}`);

const CONFIG = {
  id: "directional_trend-bull-relative_momentum-7", relative7: 0.03, confirm24: 0.005,
  stopFloor: 0.06, stopAtr: 6, stopCap: 0.20, trailScale: 0.8, maxHoldHours: 168,
  riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 24,
};
const GATE = { id: "TREND7_GE_040", median7Min: 0.04 };
const sum = (xs) => xs.reduce((a,b)=>a+b,0);
const median = (xs) => { if (!xs.length) return 0; const ys=[...xs].sort((a,b)=>a-b); return ys[Math.floor(ys.length/2)]; };
const sign = (x) => x>0?1:x<0?-1:0;
const monthStart = (m) => Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs = raw.from*1000, toMs = raw.now*1000;

function aggregate1h(rows) {
  const result=[]; let bucket=null;
  for (const row of rows) {
    const time=Math.floor(row.time/3600)*3600;
    if (!bucket || bucket.time!==time) {
      if (bucket?.samples>=10) result.push(bucket);
      bucket={time,open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume,samples:1};
    } else {
      bucket.high=Math.max(bucket.high,row.high); bucket.low=Math.min(bucket.low,row.low); bucket.close=row.close; bucket.volume+=row.volume; bucket.samples+=1;
    }
  }
  if (bucket?.samples>=10) result.push(bucket);
  const filled=[];
  for (const row of result) {
    const prev=filled.at(-1); const missing=prev?(row.time-prev.time)/3600-1:0;
    if (prev && missing>0 && missing<=3) for (let o=1;o<=missing;o+=1) filled.push({time:prev.time+o*3600,open:prev.close,high:prev.close,low:prev.close,close:prev.close,volume:0,samples:0,synthetic:true});
    filled.push(row);
  }
  return filled;
}
function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i+=1)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+3600));return p;}
const ret=(rows,i,h)=>rows[i].close/rows[i-h].close-1;
const rangeRate=(r)=>(r.high-r.low)/Math.max(r.close,1e-12);

const executionBySymbol=new Map(raw.datasets.map(d=>[d.symbol,d.rows]));
const hourlyBySymbol=new Map(raw.datasets.map(d=>[d.symbol,aggregate1h(d.rows)]));
const byTime=new Map();
for (const [symbol,rows] of hourlyBySymbol) {
  const gaps=gapPrefix(rows);
  for(let i=720;i<rows.length-1;i+=1){
    const current=rows[i]; if(gaps[i]!==gaps[i-720]||rows[i+1].time!==current.time+3600) continue;
    const recentRanges=rows.slice(i-5,i+1).map(rangeRate), baselineRanges=rows.slice(i-168,i-6).map(rangeRate);
    const recentVolume=sum(rows.slice(i-5,i+1).map(r=>r.volume))/6, baselineVolume=sum(rows.slice(i-48,i-6).map(r=>r.volume))/42;
    const f={symbol,rows,index:i,current,r1:ret(rows,i,1),r6:ret(rows,i,6),r24:ret(rows,i,24),r7d:ret(rows,i,168),r30d:ret(rows,i,720),
      atr6:median(recentRanges),compression:median(recentRanges)/Math.max(median(baselineRanges),1e-9),volumeBurst:recentVolume/Math.max(baselineVolume,1e-9)};
    const arr=byTime.get(current.time)??[];arr.push(f);byTime.set(current.time,arr);
  }
}
function classify(c){
  const aligned24=Math.max(c.breadth24,1-c.breadth24);
  if(Math.abs(c.median24)>=0.04||(Math.abs(c.median24)>=0.02&&aligned24>=0.82))return"SHOCK_TRANSITION";
  if(c.compression<=0.68&&Math.abs(c.median24)<0.025)return"COMPRESSION";
  if((c.median30>=0.08&&c.median7>=0.015&&c.breadth30>=0.60)||(c.median30<=-0.08&&c.median7<=-0.015&&c.breadth30<=0.40))return"DIRECTIONAL_TREND";
  if(Math.abs(c.median24)>=0.018||aligned24>=0.75)return"NON_TREND_EXPANSION";
  return"BALANCED_ROTATION";
}
const observations=[];
for(const [time,rows] of byTime){
  const core=rows.filter(r=>CORE_SET.has(r.symbol)); if(core.length<9)continue;
  const c={median24:median(core.map(r=>r.r24)),median7:median(core.map(r=>r.r7d)),median30:median(core.map(r=>r.r30d)),
    breadth24:core.filter(r=>r.r24>0).length/core.length,breadth7:core.filter(r=>r.r7d>0).length/core.length,breadth30:core.filter(r=>r.r30d>0).length/core.length,
    compression:median(core.map(r=>r.compression)),markets:core.length};
  const system=classify(c);
  for(const f of rows.filter(r=>SATELLITE_SET.has(r.symbol))) observations.push({...f,time,context:c,system,relative24:f.r24-c.median24,relative7:f.r7d-c.median7});
}
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}
function signal(f){
  if(f.system!=="DIRECTIONAL_TREND"||f.context.median30<=0)return null;
  const direction=sign(f.relative7); if(!direction||Math.abs(f.relative7)<CONFIG.relative7||direction*f.relative24<CONFIG.confirm24)return null;
  return{direction,strength:Math.abs(f.relative7)+direction*f.relative24};
}
function resolve(f,found,friction=FRICTION,slippage=ENTRY_SLIPPAGE){
  const rows=executionBySymbol.get(f.symbol);const entryTime=f.rows[f.index+1].time;const index=lowerBound(rows,entryTime);if(rows[index]?.time!==entryTime)return null;
  const direction=found.direction,entry=rows[index].open*(1+direction*slippage),stopRate=Math.min(CONFIG.stopCap,Math.max(CONFIG.stopFloor,CONFIG.stopAtr*f.atr6));
  const originalStop=entry*(1-direction*stopRate);let activeStop=originalStop,extreme=entry,exit=entry,closedAt=rows[index].time*1000,outcome="DATA_GAP";
  for(let o=0;o<CONFIG.maxHoldHours*12&&index+o<rows.length;o+=1){
    const candle=rows[index+o];if(o&&candle.time!==rows[index+o-1].time+300){exit=rows[index+o-1].close;closedAt=rows[index+o-1].time*1000;break;}
    const stopped=direction>0?candle.low<=activeStop:candle.high>=activeStop;if(stopped){exit=activeStop;closedAt=candle.time*1000;outcome=activeStop===originalStop?"STOP":"TRAIL";break;}
    extreme=direction>0?Math.max(extreme,candle.high):Math.min(extreme,candle.low);const candidate=extreme*(1-direction*stopRate*CONFIG.trailScale);
    activeStop=direction>0?Math.max(activeStop,candidate):Math.min(activeStop,candidate);exit=candle.close;closedAt=candle.time*1000;outcome=o===CONFIG.maxHoldHours*12-1?"TIMEOUT":outcome;
  }
  const grossReturnRate=direction*(exit-entry)/entry;
  return{strategyId:CONFIG.id,symbol:f.symbol,side:direction>0?"LONG":"SHORT",openedAt:rows[index].time*1000,closedAt,stopRate,strength:found.strength,friction,outcome,grossReturnRate,netReturnRate:grossReturnRate-friction,median7:f.context.median7};
}
function rawTrades(friction=FRICTION,slippage=ENTRY_SLIPPAGE){const trades=[];for(const f of observations){const found=signal(f);if(!found)continue;const t=resolve(f,found,friction,slippage);if(t)trades.push(t);}return trades.sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength);}
function portfolio(trades){
  let equity=1000,peak=equity,maxDrawdown=0;const open=[],accepted=[],cooldown=new Map();
  const settle=(time)=>{for(const t of open.filter(x=>x.closedAt<=time).sort((a,b)=>a.closedAt-b.closedAt)){equity+=t.netPnl;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);open.splice(open.indexOf(t),1);cooldown.set(t.symbol,t.closedAt+CONFIG.cooldownHours*3600000);}};
  for(let i=0;i<trades.length;){const openedAt=trades[i].openedAt;settle(openedAt);const sim=[];while(i<trades.length&&trades[i].openedAt===openedAt)sim.push(trades[i++]);
    for(const t of sim.sort((a,b)=>b.strength-a.strength||a.symbol.localeCompare(b.symbol))){if(equity<=100||open.some(x=>x.symbol===t.symbol)||(cooldown.get(t.symbol)??0)>t.openedAt)continue;
      const same=open.filter(x=>x.side===t.side),multiple=Math.min(CONFIG.notionalMultiple,CONFIG.riskRate/Math.max(t.stopRate+t.friction,1e-9));if(multiple<CONFIG.minNotionalMultiple)continue;
      const notional=equity*multiple,plannedRisk=notional*(t.stopRate+t.friction);if(sum(open.map(x=>x.plannedRisk))+plannedRisk>equity*.10||sum(same.map(x=>x.plannedRisk))+plannedRisk>equity*.065)continue;
      const x={...t,equityAtOpen:equity,notional,plannedRisk,netPnl:notional*t.netReturnRate};open.push(x);accepted.push(x);}}
  settle(Infinity);return{trades:accepted,endEquity:equity,maxDrawdown};
}
function metrics(result,start,end){
  const rows=result.trades.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netPnl>0),l=rows.filter(t=>t.netPnl<=0);
  const bySymbol=Object.fromEntries(SATELLITES.map(s=>[s,{trades:rows.filter(t=>t.symbol===s).length,netPnl:sum(rows.filter(t=>t.symbol===s).map(t=>t.netPnl))}]));
  return{trades:rows.length,netPnl:sum(rows.map(t=>t.netPnl)),profitFactor:l.length?sum(g.map(t=>t.netPnl))/Math.abs(sum(l.map(t=>t.netPnl))):g.length?99:0,bySymbol};
}
const splitAt=monthStart("202603");
function evaluate(rows){const p=portfolio(rows);return{full:metrics(p,fromMs,toMs),early:metrics(p,fromMs,splitAt),late:metrics(p,splitAt,toMs)};}
const base=rawTrades(FRICTION,ENTRY_SLIPPAGE),stress=rawTrades(STRESS_FRICTION,ENTRY_SLIPPAGE),adverse=rawTrades(FRICTION,ENTRY_SLIPPAGE*2);
const ungated={base:evaluate(base),stress:evaluate(stress),adverse:evaluate(adverse)};
const gateFn=(t)=>t.median7>=GATE.median7Min;
const gated={base:evaluate(base.filter(gateFn)),stress:evaluate(stress.filter(gateFn)),adverse:evaluate(adverse.filter(gateFn))};
const m=gated.base.full,s=gated.stress.full,a=gated.adverse.full;
const externalPass=m.trades>=20&&m.netPnl>0&&m.profitFactor>=1.05&&s.netPnl>0&&s.profitFactor>=1.0&&a.netPnl>0&&a.profitFactor>=1.0
  &&SATELLITES.every(sym=>m.bySymbol[sym].trades>=5&&m.bySymbol[sym].netPnl>0)
  &&gated.base.early.trades>=5&&gated.base.early.netPnl>0&&gated.base.late.trades>=5&&gated.base.late.netPnl>0;
const out={generatedAt:new Date().toISOString(),decision:externalPass?"EXTERNAL_SYMBOL_PASS":"EXTERNAL_SYMBOL_FAIL",methodology:{
  hypothesis:"Frozen BULL_RELATIVE_MOMENTUM-7 remains positive on pre-existing SUI/UNI satellite execution symbols when core 11-market median7 >= 4%.",
  temporalBlind:false,crossSectionalHoldout:true,configFrozen:CONFIG,gateFrozen:GATE,coreContext:CORE,satellites:SATELLITES,
  split:"202510-202602 early / 202603-202608 late",passRule:">=20 gated trades; base PF>=1.05/net>0; stress/adverse PF>=1/net>0; each satellite >=5 trades and net>0; early and late each >=5 trades and net>0",noProductionAuthority:true},
  dataset:{source:raw.source,months:raw.months,symbols:raw.symbols,sha256:raw.sha256??null},rawSignalCount:base.length,ungated,gated,externalPass};
writeFileSync(OUTPUT,JSON.stringify(out,null,2));
console.log(JSON.stringify({output:OUTPUT,decision:out.decision,rawSignalCount:out.rawSignalCount,ungated:out.ungated.base,gated:out.gated,externalPass},null,2));
