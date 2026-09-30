import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const SYMBOLS=['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','DOGE_USDT','ADA_USDT','BNB_USDT','SUI_USDT','AVAX_USDT','LINK_USDT','LTC_USDT','BCH_USDT','AAVE_USDT','UNI_USDT','ARB_USDT','FIL_USDT','PEPE_USDT','ENA_USDT'];
const H=3600,DAY=86400;
const START=Date.UTC(2024,0,1)/1000,EVENT_START=Date.UTC(2024,5,1)/1000,END=Date.UTC(2026,8,1)/1000;
const BASE_COST=.00165,STRESS_COST=.00270,TRAIN_DAYS=180,MAX_GROSS=2.0,DAILY_ENTRY_BUDGET=2.5;
const DEV_MONTHS=['2025-01','2025-02','2025-03','2025-04','2025-05','2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12'];
const EVAL_MONTHS=['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];
const ALL_TEST_MONTHS=[...DEV_MONTHS,...EVAL_MONTHS];
const ARCHIVE_BASE='https://download.gatedata.org/futures_usdt/candlesticks_1h';
const LOOKBACKS=[48,72,120,168],TREND_FLOORS=[.25,.45,.65],EFF_FLOORS=[.12,.20],BUFFERS=[0,.25];
const EXIT_PROFILES=[
  {stopATR:1.5,targetATR:3,maxHold:72,trailTriggerATR:2,trailATR:1.25,key:'s1.5|t3|h72'},
  {stopATR:2,targetATR:3,maxHold:72,trailTriggerATR:2,trailATR:1.25,key:'s2|t3|h72'},
  {stopATR:2,targetATR:3,maxHold:120,trailTriggerATR:2,trailATR:1.25,key:'s2|t3|h120'},
  {stopATR:2,targetATR:5,maxHold:120,trailTriggerATR:2,trailATR:1.25,key:'s2|t5|h120'},
];
const TOP_K=[6,12,24],FRACS=[.10,.15,.20],MAX_PER_SIGNAL=[1,2,3];
const MIN_MODEL_TRADES=24,MODEL_SHRINK=60;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const n=x=>{const v=Number(x);return Number.isFinite(v)?v:null;};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sign=x=>x>0?1:x<0?-1:0;
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const stdev=a=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(Math.max(0,a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)));};
const median=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2;};
const madScale=a=>{if(a.length<3)return 1e-9;const m=median(a),mad=median(a.map(x=>Math.abs(x-m)));return Math.max(1.4826*mad,1e-9);};
const dayKey=t=>new Date(t*1000).toISOString().slice(0,10);
const monthKey=t=>dayKey(t).slice(0,7);
const monthStart=m=>Date.UTC(+m.slice(0,4),+m.slice(5,7)-1,1)/1000;
const daysInMonth=m=>new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),0)).getUTCDate();

function parseCandle(x){const time=n(x.t??x[0]),volume=n(x.v??x[1])??0,close=n(x.c??x[2]),high=n(x.h??x[3]),low=n(x.l??x[4]),open=n(x.o??x[5]);return time>0&&open>0&&close>0&&high>=low&&low>0?{time,volume,open,high,low,close}:null;}
function archiveMonths(){const out=[];let d=new Date(START*1000);d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));while(d.getTime()/1000<END){out.push(d.toISOString().slice(0,7).replace('-',''));d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));}return out;}
function archiveMonthBounds(ym){const y=+ym.slice(0,4),m=+ym.slice(4,6)-1;return [Date.UTC(y,m,1)/1000,Date.UTC(y,m+1,1)/1000];}
async function archiveMonth(symbol,ym,tries=5){const url=`${ARCHIVE_BASE}/${ym}/${symbol}-${ym}.csv.gz`;let last;for(let i=0;i<tries;i++){try{const r=await fetch(url);if(r.status===404)return {status:404,rows:[],bytes:0};const buf=Buffer.from(await r.arrayBuffer());if(r.ok){const text=gunzipSync(buf).toString('utf8'),rows=text.split(/\r?\n/).filter(Boolean).map(line=>parseCandle(line.split(','))).filter(Boolean);return {status:r.status,rows,bytes:buf.length};}last=new Error(`${r.status} ${url} ${buf.toString('utf8').slice(0,120)}`);if(r.status!==429&&r.status<500)break;}catch(e){last=e;}await sleep(250*(i+1));}throw last??new Error(url);}
const archiveDiagnostics={};
async function candles(symbol){const out=[],missing=[],errors=[];for(const ym of archiveMonths()){try{const got=await archiveMonth(symbol,ym);if(got.status===404){missing.push(ym);continue;}const [lo,hi]=archiveMonthBounds(ym);out.push(...got.rows.filter(r=>r.time>=lo&&r.time<hi&&r.time>=START&&r.time<END));}catch(e){errors.push({ym,error:String(e)});}}const rows=[...new Map(out.map(r=>[r.time,r])).values()].sort((a,b)=>a.time-b.time);archiveDiagnostics[symbol]={rows:rows.length,first:rows[0]?.time??null,last:rows.at(-1)?.time??null,missing,errors};return rows;}
const raw=new Map();let cursor=0;async function worker(){while(cursor<SYMBOLS.length){const s=SYMBOLS[cursor++];try{raw.set(s,await candles(s));}catch(e){console.error('FETCH_FAIL',s,String(e));raw.set(s,[]);}}}await Promise.all(Array.from({length:6},worker));
const activeSymbols=[...raw].filter(([,rows])=>rows.length>14000&&(rows.at(-1)?.time??0)>=Date.UTC(2026,7,31,23)/1000).map(([s])=>s),maps=new Map(activeSymbols.map(s=>[s,new Map(raw.get(s).map(r=>[r.time,r]))]));
if(!activeSymbols.includes('BTC_USDT')||!activeSymbols.includes('ETH_USDT'))throw new Error('BTC/ETH coverage required');

const variants=[];for(const lookback of LOOKBACKS)for(const trendFloor of TREND_FLOORS)for(const effFloor of EFF_FLOORS)for(const bufferATR of BUFFERS)variants.push({lookback,trendFloor,effFloor,bufferATR,key:`L${lookback}|z${trendFloor}|e${effFloor}|b${bufferATR}`});
const events=[];
for(const symbol of activeSymbols){
  const rows=raw.get(symbol),rets=Array(rows.length).fill(0);for(let i=1;i<rows.length;i++)rets[i]=rows[i].close/rows[i-1].close-1;
  for(let i=336;i<rows.length;i++){
    const r=rows[i];if(r.time<EVENT_START||r.time-rows[i-336].time!==336*H||new Date(r.time*1000).getUTCHours()%4!==0)continue;
    const vol168=stdev(rets.slice(i-167,i+1));if(!(vol168>1e-8))continue;
    const r168=r.close/rows[i-168].close-1,r336=r.close/rows[i-336].close-1,z168=r168/(vol168*Math.sqrt(168)),z336=r336/(vol168*Math.sqrt(336)),trend=.55*z168+.45*z336,dir=sign(trend);if(!dir)continue;
    const tr=rows.slice(i-23,i+1).map((x,j)=>{const prev=j===0?rows[i-24].close:rows[i-24+j].close;return Math.max(x.high-x.low,Math.abs(x.high-prev),Math.abs(x.low-prev));}),atrPct=mean(tr)/r.close;if(!(atrPct>0))continue;
    const sma72=mean(rows.slice(i-71,i+1).map(x=>x.close)),sma168=mean(rows.slice(i-167,i+1).map(x=>x.close)),sma336=mean(rows.slice(i-335,i+1).map(x=>x.close)),align=((r.close>sma72?1:-1)+(sma72>sma168?1:-1)+(sma168>sma336?1:-1))/3;if(dir*align<.3)continue;
    const lv=Math.log1p(Math.max(0,r.volume)),prevLv=rows.slice(i-168,i).map(x=>Math.log1p(Math.max(0,x.volume))),zVol=(lv-median(prevLv))/madScale(prevLv);
    const matches=[];
    for(const v of variants){
      const prev=rows.slice(i-v.lookback,i),hi=Math.max(...prev.map(x=>x.high)),lo=Math.min(...prev.map(x=>x.low));let travel=0;for(let j=i-v.lookback+1;j<=i;j++)travel+=Math.abs(rows[j].close-rows[j-1].close);const eff=Math.abs(r.close-rows[i-v.lookback].close)/Math.max(travel,r.close*1e-9),penetration=dir>0?(r.close-hi)/(r.close*atrPct):(lo-r.close)/(r.close*atrPct);
      if(Math.abs(trend)>=v.trendFloor&&eff>=v.effFloor&&penetration>=v.bufferATR){const score=.45*clamp(Math.abs(trend),0,4)+.30*clamp(penetration+1,0,4)+.18*clamp(eff*4,0,4)+.07*clamp(Math.max(0,zVol)*.3,0,2);matches.push({variant:v.key,score});}
    }
    if(!matches.length)continue;const entry=maps.get(symbol)?.get(r.time+H);if(!entry)continue;events.push({symbol,signalTime:r.time,entryTime:r.time+H,dir,entryOpen:entry.open,atrPct,matches});
  }
}

function pathOutcome(c,p){const pm=maps.get(c.symbol),entry=c.entryOpen,atrAbs=Math.max(entry*c.atrPct,entry*1e-6);let stop=entry-c.dir*p.stopATR*atrAbs,target=entry+c.dir*p.targetATR*atrAbs,best=entry,trail=false;for(let k=0;k<p.maxHold;k++){const bar=pm?.get(c.entryTime+k*H);if(!bar)break;if(c.dir>0){if(bar.open<=stop)return finish(bar.time,bar.open,'STOP_GAP',k+1);if(bar.open>=target)return finish(bar.time,bar.open,'TARGET_GAP',k+1);}else{if(bar.open>=stop)return finish(bar.time,bar.open,'STOP_GAP',k+1);if(bar.open<=target)return finish(bar.time,bar.open,'TARGET_GAP',k+1);}const stopHit=c.dir>0?bar.low<=stop:bar.high>=stop,targetHit=c.dir>0?bar.high>=target:bar.low<=target;if(stopHit)return finish(bar.time,stop,trail?'TRAIL_STOP':'STOP',k+1);if(targetHit)return finish(bar.time,target,'TARGET',k+1);best=c.dir>0?Math.max(best,bar.high):Math.min(best,bar.low);if(c.dir*(best-entry)>=p.trailTriggerATR*atrAbs){trail=true;const next=c.dir>0?best-p.trailATR*atrAbs:best+p.trailATR*atrAbs;stop=c.dir>0?Math.max(stop,next):Math.min(stop,next);}}
  const last=pm?.get(c.entryTime+(p.maxHold-1)*H);if(!last)return null;return finish(last.time,last.close,'TIME',p.maxHold);
  function finish(t,px,reason,heldHours){return {exitTime:t+H,gross:c.dir*(px/entry-1),reason,heldHours};}
}
const recordsByModel=new Map(),recordsByMonth=new Map();
for(const e of events){for(const p of EXIT_PROFILES){const o=pathOutcome(e,p);if(!o)continue;for(const m of e.matches){const model=`${m.variant}|${p.key}`,rec={...e,...o,score:m.score,variant:m.variant,profile:p.key,model,net:o.gross-BASE_COST};delete rec.matches;const a=recordsByModel.get(model)??[];a.push(rec);recordsByModel.set(model,a);const mk=monthKey(rec.entryTime),b=recordsByMonth.get(mk)??[];b.push(rec);recordsByMonth.set(mk,b);}}}
for(const a of recordsByModel.values())a.sort((x,y)=>x.entryTime-y.entryTime);

function statsForModel(model,testMonth,cost=BASE_COST){const end=monthStart(testMonth),start=end-TRAIN_DAYS*DAY,a=(recordsByModel.get(model)??[]).filter(x=>x.entryTime>=start&&x.exitTime<=end),nets=a.map(x=>x.gross-cost);if(!nets.length)return {model,n:0,meanNet:0,pf:0,hit:0,sd:0,rank:-Infinity};const mn=mean(nets),sd=stdev(nets),g=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0),pf=l?g/l:g?99:0,shrink=a.length/(a.length+MODEL_SHRINK),shrunk=mn*shrink,rank=shrunk*Math.sqrt(a.length)/Math.max(sd,.002);return {model,n:a.length,meanNet:mn,shrunkMean:shrunk,pf,hit:nets.filter(x=>x>0).length/nets.length,sd,rank};}
const selectionCache=new Map();
function selectedForMonth(month,topK){const key=`${month}|${topK}`;if(selectionCache.has(key))return selectionCache.get(key);const stats=[...recordsByModel.keys()].map(model=>statsForModel(model,month)).filter(x=>x.n>=MIN_MODEL_TRADES&&x.shrunkMean>0&&x.pf>=1).sort((a,b)=>b.rank-a.rank||b.shrunkMean-a.shrunkMean),selected=stats.slice(0,topK);selectionCache.set(key,{selected,eligible:stats.length});return {selected,eligible:stats.length};}
function monthCandidates(month,topK){const {selected,eligible}=selectedForMonth(month,topK),ranks=new Map(selected.map(x=>[x.model,x.rank])),a=(recordsByMonth.get(month)??[]).filter(x=>ranks.has(x.model));const best=new Map();for(const x of a){const k=`${x.symbol}|${x.entryTime}`,priority=ranks.get(x.model)*10+x.score,old=best.get(k);if(!old||priority>old.priority)best.set(k,{...x,priority});}return {selected,eligible,candidates:[...best.values()].sort((x,y)=>x.entryTime-y.entryTime||y.priority-x.priority)};}
function simulateMonth(policy,cost,month){const mc=monthCandidates(month,policy.topK),grouped=new Map();for(const c of mc.candidates){const a=grouped.get(c.entryTime)??[];a.push(c);grouped.set(c.entryTime,a);}let equity=1,peak=1,maxDD=0;const active=[],busy=new Map(),usedDay=new Map(),trades=[];function release(t){active.sort((a,b)=>a.exitTime-b.exitTime);while(active.length&&active[0].exitTime<=t){const p=active.shift(),net=p.gross-cost,pnl=p.entryEq*policy.frac*net;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));trades.push({...p,net,pnl});}}
  for(const [t,a] of [...grouped].sort((x,y)=>x[0]-y[0])){release(t);const d=dayKey(t);let used=usedDay.get(d)??0,nTime=0;for(const c of a.sort((x,y)=>y.priority-x.priority)){if(nTime>=policy.maxPer)break;if((busy.get(c.symbol)??0)>t)continue;if(used+policy.frac>DAILY_ENTRY_BUDGET+1e-9)break;if(active.length*policy.frac+policy.frac>MAX_GROSS+1e-9)break;active.push({...c,entryEq:equity});busy.set(c.symbol,c.exitTime);used+=policy.frac;nTime++;}usedDay.set(d,used);}release(monthStart(month)+45*DAY);const nets=trades.map(x=>x.net),g=nets.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-nets.filter(x=>x<=0).reduce((s,x)=>s+x,0);return {month,totalReturn:equity-1,maxDD,trades:trades.length,avgTradesPerDay:trades.length/daysInMonth(month),avgDailyTwoWayTurnover:trades.length*policy.frac*2/daysInMonth(month),meanTradeNet:mean(nets),pf:l?g/l:g?99:0,hit:nets.length?nets.filter(x=>x>0).length/nets.length:0,meanHeldHours:mean(trades.map(x=>x.heldHours)),eligibleModels:mc.eligible,selectedModels:mc.selected.map(x=>({model:x.model,n:x.n,meanNet:x.meanNet,pf:x.pf,rank:x.rank}))};}
function simulate(policy,cost,months){const monthly=months.map(m=>simulateMonth(policy,cost,m));return {months,monthly,totalCompounded:monthly.reduce((e,x)=>e*(1+x.totalReturn),1)-1,maxDD:Math.max(...monthly.map(x=>x.maxDD)),avgMonthReturn:mean(monthly.map(x=>x.totalReturn)),medianMonthReturn:median(monthly.map(x=>x.totalReturn)),minMonthReturn:Math.min(...monthly.map(x=>x.totalReturn)),positiveMonths:monthly.filter(x=>x.totalReturn>0).length,monthsAtLeast5pct:monthly.filter(x=>x.totalReturn>=.05).length,avgTradesPerDay:mean(monthly.map(x=>x.avgTradesPerDay)),avgDailyTwoWayTurnover:mean(monthly.map(x=>x.avgDailyTwoWayTurnover)),trades:monthly.reduce((s,x)=>s+x.trades,0),meanTradeNet:mean(monthly.map(x=>x.meanTradeNet).filter(Number.isFinite)),meanHeldHours:mean(monthly.map(x=>x.meanHeldHours).filter(Number.isFinite))};}
const policies=[];for(const topK of TOP_K)for(const frac of FRACS)for(const maxPer of MAX_PER_SIGNAL)policies.push({topK,frac,maxPer,key:`k${topK}|n${frac}|m${maxPer}`});
const evaluated=[];for(const policy of policies)evaluated.push({policy,development:simulate(policy,BASE_COST,DEV_MONTHS),developmentStress:simulate(policy,STRESS_COST,DEV_MONTHS)});
const feasible=evaluated.filter(x=>x.development.avgMonthReturn>=.05&&x.development.positiveMonths>=9&&x.development.minMonthReturn>-.05&&x.developmentStress.avgMonthReturn>=0).sort((a,b)=>b.development.avgTradesPerDay-a.development.avgTradesPerDay||b.development.avgMonthReturn-a.development.avgMonthReturn),target=feasible[0]??null,bestReturn=[...evaluated].sort((a,b)=>b.development.avgMonthReturn-a.development.avgMonthReturn)[0]??null,bestFrequencyPositive=[...evaluated].filter(x=>x.development.avgMonthReturn>0).sort((a,b)=>b.development.avgTradesPerDay-a.development.avgTradesPerDay||b.development.avgMonthReturn-a.development.avgMonthReturn)[0]??null;
function enrich(x){if(!x)return null;return {...x,evaluation:simulate(x.policy,BASE_COST,EVAL_MONTHS),evaluationStress:simulate(x.policy,STRESS_COST,EVAL_MONTHS)};}
function pareto(rows){const out=[];for(const a of rows){if(rows.some(b=>b!==a&&b.development.avgTradesPerDay>=a.development.avgTradesPerDay&&b.development.avgMonthReturn>=a.development.avgMonthReturn&&(b.development.avgTradesPerDay>a.development.avgTradesPerDay||b.development.avgMonthReturn>a.development.avgMonthReturn)))continue;out.push(a);}return out.sort((a,b)=>b.development.avgTradesPerDay-a.development.avgTradesPerDay);}
const monthlySelection={};for(const m of ALL_TEST_MONTHS){const z=selectedForMonth(m,24);monthlySelection[m]={eligible:z.eligible,top24:z.selected};}
const report={decision:target?'BREAKOUT_WALKFORWARD_TARGET_FOUND':'BREAKOUT_WALKFORWARD_NO_5PCT_DEVELOPMENT',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',evaluationNote:'2026 is historical evaluation, NOT an untouched blind set, because earlier research has already inspected it. Every monthly model selection remains causal: only outcomes fully settled before that month enter its 180-day selector.',goal:'expand the only breakout sub-signal that stayed after-cost positive across 2025 and 2026, while preserving causal selection and improving frequency',method:'Gate official 1h OHLCV. Every 4h, generate Donchian trend-break variants across 48/72/120/168h lookbacks, three medium-term trend-strength floors, two path-efficiency floors and two ATR breakout buffers. Four path-dependent ATR exit profiles are treated as model variants. For each test month, rank models only on the preceding 180 days of fully settled after-cost outcomes, retain the top-K positive/PF>=1 models, then trade that month without peeking forward.',cost:{base:BASE_COST,stress:STRESS_COST},data:{start:new Date(START*1000).toISOString(),eventStart:new Date(EVENT_START*1000).toISOString(),end:new Date(END*1000).toISOString(),activeSymbols,archiveDiagnostics},variantCount:variants.length,exitProfileCount:EXIT_PROFILES.length,modelCount:recordsByModel.size,eventCount:events.length,recordCount:[...recordsByModel.values()].reduce((s,a)=>s+a.length,0),selector:{trainDays:TRAIN_DAYS,minModelTrades:MIN_MODEL_TRADES,shrink:MODEL_SHRINK,topK:TOP_K},developmentMonths:DEV_MONTHS,evaluationMonths:EVAL_MONTHS,policyCount:policies.length,feasibleCount:feasible.length,target:enrich(target),bestReturn:enrich(bestReturn),bestFrequencyPositive:enrich(bestFrequencyPositive),paretoFrontier:pareto(evaluated),monthlySelection};
writeFileSync('/tmp/breakout-walkforward-expansion-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({decision:report.decision,activeSymbols:activeSymbols.length,variantCount:report.variantCount,modelCount:report.modelCount,eventCount:report.eventCount,recordCount:report.recordCount,policyCount:report.policyCount,feasibleCount:report.feasibleCount,target:report.target,bestReturn:report.bestReturn,bestFrequencyPositive:report.bestFrequencyPositive,paretoFrontier:report.paretoFrontier},null,2));
