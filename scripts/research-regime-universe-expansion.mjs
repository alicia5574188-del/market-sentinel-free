import { readFileSync, writeFileSync } from "node:fs";
import { advanceRegimePortfolio, evaluateRegimePortfolio, initialRegimePortfolio, REGIME_UNIVERSE } from "../lib/regime-portfolio.ts";

const INPUT = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-expanded-12m.json";
const OUTPUT = process.env.UNIVERSE_OUTPUT ?? "/tmp/regime-universe-expansion.json";
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
if (raw.interval !== "5m" || raw.months.length !== 12) throw new Error("Expected 12-month Gate 5m dataset");
const CORE = [...REGIME_UNIVERSE];
const AVAILABLE = raw.datasets.map((d) => d.symbol);
const EXPANDED = AVAILABLE;
if (!CORE.every((s) => AVAILABLE.includes(s))) throw new Error("Expanded archive must contain all core regime symbols");
if (EXPANDED.length <= CORE.length) throw new Error(`No expanded symbols available: ${EXPANDED.length}`);

const sum = (xs) => xs.reduce((a,b)=>a+b,0);
const monthKey=(ms)=>new Date(ms).toISOString().slice(0,7).replace("-","");
function hourly(rows){const out=[];let b=null;for(const r of rows){const t=Math.floor(r.time/3600)*3600;if(!b||b.time!==t){if(b?.samples>=10)out.push(b);b={time:t,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume,samples:1};}else{b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;b.volume+=r.volume;b.samples++;}}if(b?.samples>=10)out.push(b);return out.map(({samples,...r})=>r);}
const data=new Map(raw.datasets.map(d=>[d.symbol,{five:d.rows,hour:hourly(d.rows)}]));
const allTimes=[...new Set(raw.datasets.flatMap(d=>d.rows.map(r=>r.time)))].sort((a,b)=>a-b);
const fiveIndex=new Map(raw.datasets.map(d=>[d.symbol,new Map(d.rows.map(r=>[r.time,r]))]));
const hourIndex=new Map([...data].map(([s,d])=>[s,new Map(d.hour.map(r=>[r.time,r]))]));
const contracts=Object.fromEntries(AVAILABLE.map(s=>[s,{quantoMultiplier:1e-6,maintenanceRate:.005,leverageMax:20,volume24hUsd:1e9,fundingRate:0}]));

function metrics(state,startEquity){const trades=Object.values(state.accounts).flatMap(a=>[...a.recent,...a.archived]);const unique=[...new Map(trades.map(t=>[t.id,t])).values()].filter(t=>t.status==="CLOSED"&&t.netPnl!=null);const pnl=sum(unique.map(t=>t.netPnl));const gains=sum(unique.filter(t=>t.netPnl>0).map(t=>t.netPnl)),loss=Math.abs(sum(unique.filter(t=>t.netPnl<=0).map(t=>t.netPnl)));const monthly=new Map();const bySymbol=new Map();for(const t of unique){const m=monthKey(t.closedAt);monthly.set(m,(monthly.get(m)??0)+t.netPnl);bySymbol.set(t.symbol,(bySymbol.get(t.symbol)??0)+t.netPnl);}const systemEquities=Object.fromEntries(Object.entries(state.accounts).map(([id,a])=>[id,a.equity]));return{trades:unique.length,netPnl:pnl,profitFactor:loss?gains/loss:gains?99:0,winRate:unique.length?unique.filter(t=>t.netPnl>0).length/unique.length:0,endEquity:sum(Object.values(state.accounts).map(a=>a.equity)),systemEquities,activeMonths:monthly.size,positiveMonths:[...monthly.values()].filter(x=>x>0).length,monthly:Object.fromEntries([...monthly].sort()),bySymbol:Object.fromEntries([...bySymbol].sort()),open:Object.values(state.accounts).reduce((n,a)=>n+Object.keys(a.open).length,0),startEquity};}

function replay(symbols){let state=initialRegimePortfolio(raw.from*1000);const hourlyPaths=Object.fromEntries(symbols.map(s=>[s,[]]));const symbolSet=new Set(symbols);let peak=5000,maxDd=0;let lastHour=null;
 for(const time of allTimes){const quotes={};for(const s of symbols){const r=fiveIndex.get(s)?.get(time);if(!r)continue;quotes[s]={bestBid:r.open,bestAsk:r.open,observedAt:time*1000,fresh:true,completedMinuteAt:(time-300)*1000};}
   if(Object.keys(quotes).length<Math.max(8,symbols.length-2))continue;
   const hour=Math.floor((time-1)/3600)*3600;
   if(hour!==lastHour){lastHour=hour;for(const s of symbols){const h=hourIndex.get(s)?.get(hour);if(h){hourlyPaths[s].push(h);if(hourlyPaths[s].length>721)hourlyPaths[s].shift();}}state=evaluateRegimePortfolio({state,hourly:hourlyPaths,quotes,contracts,now:time*1000});}
   else state=advanceRegimePortfolio({state,quotes,now:time*1000});
   const eq=sum(Object.values(state.accounts).map(a=>a.equity));peak=Math.max(peak,eq);maxDd=Math.max(maxDd,(peak-eq)/peak);
 }
 const m=metrics(state,5000);return{symbols:[...symbolSet],...m,maxDrawdown:maxDd};}
const core=replay(CORE);const expanded=replay(EXPANDED);
const satellites=EXPANDED.filter(s=>!CORE.includes(s));const satellitePnl=sum(satellites.map(s=>expanded.bySymbol[s]??0));const frequencyGain=expanded.trades/Math.max(core.trades,1)-1;const gates={allCorePresent:CORE.every(s=>EXPANDED.includes(s)),hasSatellites:satellites.length>=2,totalPositive:expanded.netPnl>0,profitFactor:expanded.profitFactor>=1.10,maxDrawdown:expanded.maxDrawdown<=0.12,positiveMonthMajority:expanded.positiveMonths>=Math.ceil(expanded.activeMonths*.55),frequencyGain25pct:frequencyGain>=.25,satellitesNonNegative:satellitePnl>=0,doesNotLoseMoreThanCore:expanded.netPnl>=core.netPnl*.85};
const report={generatedAt:new Date().toISOString(),datasetSha256:raw.sha256,months:raw.months,coreSymbols:CORE,expandedSymbols:EXPANDED,satellites,core,expanded,satellitePnl,frequencyGain,gates,replacementCandidate:Object.values(gates).every(Boolean),notes:["Exact production regime strategy module is invoked for signal generation, account admission, cooldown, risk and lifecycle.","Historical bid/ask is unavailable; five-minute open is used as zero-spread executable quote, while production strategy geometry still charges its frozen 0.14% friction and 0.025% entry slippage.","Universe expansion changes cross-market medians/breadth as production would; strategy parameters are unchanged."]};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");console.log("UNIVERSE_EXPANSION_RESULT="+JSON.stringify({replacementCandidate:report.replacementCandidate,core:{symbols:CORE.length,trades:core.trades,pnl:core.netPnl,pf:core.profitFactor,dd:core.maxDrawdown,positiveMonths:core.positiveMonths},expanded:{symbols:EXPANDED.length,trades:expanded.trades,pnl:expanded.netPnl,pf:expanded.profitFactor,dd:expanded.maxDrawdown,positiveMonths:expanded.positiveMonths},satellites,satellitePnl,frequencyGain,gates}));
