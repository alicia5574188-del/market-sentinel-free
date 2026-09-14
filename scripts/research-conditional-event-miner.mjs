import { readFileSync, writeFileSync } from "node:fs";

const INPUT = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-frequency-aligned-12m.json";
const OUTPUT = process.env.EVENT_MINER_OUTPUT ?? "/tmp/conditional-event-miner.json";
const FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const STRESS_DELTA = STRESS_FRICTION - FRICTION;
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
if (raw.interval !== "5m" || raw.months.length !== 12) throw new Error("Expected aligned 12-month 5m dataset");

const rowsBySymbol = new Map(raw.datasets.map((d) => [d.symbol, d.rows]));
const symbols = raw.datasets.map((d) => d.symbol);
const length = Math.min(...raw.datasets.map((d) => d.rows.length));
const monthStart = (m) => Date.UTC(Number(m.slice(0,4)), Number(m.slice(4,6))-1, 1) / 1000;
const trainEnd = monthStart(raw.months[8]);
const testEnd = raw.now;
const days = (a,b) => (b-a)/86400;
const sum = (xs) => xs.reduce((a,b)=>a+b,0);
const median = (xs) => { const a=[...xs].sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length/2)] : 0; };
const ret = (rows,i,n) => rows[i].close/rows[i-n].close-1;
const sessionOf = (hour) => hour < 7 ? "ASIA" : hour < 13 ? "EU" : hour < 21 ? "US" : "LATE";

const events = [];
for (let i=288; i<length-48; i+=3) {
  const time = raw.datasets[0].rows[i].time;
  const snapshot = [];
  for (const symbol of symbols) {
    const rows = rowsBySymbol.get(symbol);
    if (!rows[i] || rows[i].time !== time) continue;
    const r15=ret(rows,i,3), r30=ret(rows,i,6), r60=ret(rows,i,12), r180=ret(rows,i,36);
    const vNow = sum(rows.slice(i-2,i+1).map(r=>r.volume))/3;
    const vBase = sum(rows.slice(i-72,i-12).map(r=>r.volume))/60;
    const rangeNow = sum(rows.slice(i-2,i+1).map(r=>(r.high-r.low)/Math.max(r.close,1e-12)))/3;
    const rangeBase = sum(rows.slice(i-72,i-12).map(r=>(r.high-r.low)/Math.max(r.close,1e-12)))/60;
    snapshot.push({symbol, rows, i, time, r15,r30,r60,r180,
      volBurst:vNow/Math.max(vBase,1e-9), rangeBurst:rangeNow/Math.max(rangeBase,1e-9)});
  }
  if (snapshot.length < 14) continue;
  const m30=median(snapshot.map(x=>x.r30)), m60=median(snapshot.map(x=>x.r60)), m180=median(snapshot.map(x=>x.r180));
  const d = new Date(time*1000); const hour=d.getUTCHours(); const dow=d.getUTCDay();
  for (const x of snapshot) events.push({...x,m30,m60,m180,res30:x.r30-m30,res60:x.r60-m60,res180:x.r180-m180,
    hour,session:sessionOf(hour),weekend:dow===0||dow===6});
}

function futureReturn(e, bars, direction) {
  const exit = e.rows[e.i+bars]?.close;
  if (!(exit>0)) return null;
  return direction*(exit/e.rows[e.i].close-1)-FRICTION;
}

const families = [];
const add = (family, variants) => variants.forEach((v,idx)=>families.push({family,id:`${family.toLowerCase()}-${idx}`,...v}));
const product=(...sets)=>sets.reduce((acc,set)=>acc.flatMap(a=>set.map(v=>[...a,v])),[[]]);
const SESSIONS=["ALL","US"];

add("RESIDUAL_REVERSAL", product(["res30","res60"],[0.004,0.007,0.010],[6,12,24],SESSIONS,[1,1.5]).map(([field,thr,hold,session,vol])=>({field,thr,hold,session,vol,mode:"REV"})));
add("RESIDUAL_CONTINUATION", product(["res30","res60"],[0.004,0.007,0.010],[6,12,24],SESSIONS,[1,1.5]).map(([field,thr,hold,session,vol])=>({field,thr,hold,session,vol,mode:"CONT"})));
add("SHOCK_REVERSAL", product(["r30","r60"],[0.006,0.010,0.016],[6,12,24],SESSIONS,[1.5,2]).map(([field,thr,hold,session,vol])=>({field,thr,hold,session,vol,mode:"REV"})));
add("SHOCK_CONTINUATION", product(["r30","r60"],[0.006,0.010,0.016],[6,12,24],SESSIONS,[1.5,2]).map(([field,thr,hold,session,vol])=>({field,thr,hold,session,vol,mode:"CONT"})));
add("MARKET_LAG_CATCHUP", product(["r60","r180"],[0.004,0.008,0.012],[0.004,0.008],[6,12,24]).map(([marketField,marketThr,resThr,hold])=>({marketField,marketThr,resThr,hold,session:"ALL"})));
add("LEADER_CONTINUATION", product(["r60","r180"],[0.004,0.008,0.012],[0.004,0.008],[6,12,24]).map(([marketField,marketThr,resThr,hold])=>({marketField,marketThr,resThr,hold,session:"ALL"})));
add("VOLUME_RANGE_BREAK", product([1.5,2,3],[1.5,2.2],[0.004,0.008,0.012],[6,12,24]).map(([vol,range,thr,hold])=>({vol,range,thr,hold,session:"ALL"})));
add("WEEKEND_RESIDUAL", product(["res30","res60"],[0.004,0.007,0.010],[6,12,24],["REV","CONT"]).map(([field,thr,hold,mode])=>({field,thr,hold,mode,session:"ALL",weekendOnly:true,vol:1})));

function directionFor(c,e) {
  if (c.session!=="ALL" && e.session!==c.session) return 0;
  if (c.weekendOnly && !e.weekend) return 0;
  if (c.family==="RESIDUAL_REVERSAL" || c.family==="RESIDUAL_CONTINUATION" || c.family==="WEEKEND_RESIDUAL") {
    if (e.volBurst < c.vol || Math.abs(e[c.field]) < c.thr) return 0;
    const s=Math.sign(e[c.field]); return c.mode==="REV" ? -s : s;
  }
  if (c.family==="SHOCK_REVERSAL" || c.family==="SHOCK_CONTINUATION") {
    if (e.volBurst < c.vol || Math.abs(e[c.field]) < c.thr) return 0;
    const s=Math.sign(e[c.field]); return c.mode==="REV" ? -s : s;
  }
  if (c.family==="MARKET_LAG_CATCHUP") {
    const market = c.marketField==="r60" ? e.m60 : e.m180;
    const residual = c.marketField==="r60" ? e.res60 : e.res180;
    if (Math.abs(market)<c.marketThr) return 0;
    const s=Math.sign(market); return s*residual <= -c.resThr ? s : 0;
  }
  if (c.family==="LEADER_CONTINUATION") {
    const market = c.marketField==="r60" ? e.m60 : e.m180;
    const residual = c.marketField==="r60" ? e.res60 : e.res180;
    if (Math.abs(market)<c.marketThr) return 0;
    const s=Math.sign(market); return s*residual >= c.resThr ? s : 0;
  }
  if (c.family==="VOLUME_RANGE_BREAK") {
    if (e.volBurst<c.vol || e.rangeBurst<c.range || Math.abs(e.r15)<c.thr) return 0;
    return Math.sign(e.r15);
  }
  return 0;
}

function evaluate(c) {
  const trades=[]; const nextBySymbol=new Map();
  for (const e of events) {
    if (e.time < (nextBySymbol.get(e.symbol)??0)) continue;
    const dir=directionFor(c,e); if (!dir) continue;
    const r=futureReturn(e,c.hold,dir); if (r==null) continue;
    trades.push({time:e.time,symbol:e.symbol,ret:r,dir});
    nextBySymbol.set(e.symbol,e.time+c.hold*300);
  }
  return trades;
}
const stressed = (trades) => trades.map(t=>({...t,ret:t.ret-STRESS_DELTA}));

function metrics(trades,start,end) {
  const x=trades.filter(t=>t.time>=start&&t.time<end); const gains=x.filter(t=>t.ret>0), losses=x.filter(t=>t.ret<=0);
  const gp=sum(gains.map(t=>t.ret)), gl=Math.abs(sum(losses.map(t=>t.ret)));
  let eq=1,peak=1,dd=0; for(const t of x){eq*=Math.max(0.01,1+t.ret*0.1);peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak);}
  return {trades:x.length,tradesPerDay:x.length/Math.max(days(start,end),1),mean:x.length?sum(x.map(t=>t.ret))/x.length:0,
    netReturnUnits:sum(x.map(t=>t.ret)),profitFactor:gl?gp/gl:gp>0?99:0,winRate:x.length?gains.length/x.length:0,maxDrawdown:dd};
}
function foldMetrics(trades) {
  const trainMonths=raw.months.slice(0,8); const folds=[];
  for(let j=0;j<4;j++){const s=monthStart(trainMonths[j*2]); const e=j===3?trainEnd:monthStart(trainMonths[j*2+2]); folds.push(metrics(trades,s,e));}
  return folds;
}

const tradeCache=new Map(); const audit=[];
for(const c of families){
  const trades=evaluate(c); tradeCache.set(c.id,trades);
  const train=metrics(trades,raw.from,trainEnd), test=metrics(trades,trainEnd,testEnd), folds=foldMetrics(trades), stressTrain=metrics(stressed(trades),raw.from,trainEnd);
  const positiveFolds=folds.filter(f=>f.netReturnUnits>0&&f.profitFactor>=1.02).length;
  const stable=train.tradesPerDay>=1&&train.netReturnUnits>0&&train.profitFactor>=1.08&&positiveFolds>=3&&stressTrain.netReturnUnits>0&&stressTrain.profitFactor>=1.02;
  const score=stable ? Math.log1p(train.trades)*Math.log(train.profitFactor)*Math.max(train.mean,0)*10000 : 0;
  audit.push({config:c,stable,score,positiveFolds,train,test,stressTrain,folds});
}
audit.sort((a,b)=>b.score-a.score || b.train.profitFactor-a.train.profitFactor || b.train.trades-a.train.trades);
const selected=[]; const usedFamilies=new Set();
for(const row of audit){if(!row.stable||usedFamilies.has(row.config.family))continue;selected.push(row);usedFamilies.add(row.config.family);if(selected.length>=8)break;}

function combined(stress=false){
  const all=[]; for(const row of selected){const source=tradeCache.get(row.config.id)??[];for(const t of (stress?stressed(source):source))all.push({...t,family:row.config.family,hold:row.config.hold});}
  all.sort((a,b)=>a.time-b.time);
  const accepted=[]; const active=[]; let equity=1000,peak=1000,dd=0;
  for(const t of all){for(let i=active.length-1;i>=0;i--)if(active[i].until<=t.time)active.splice(i,1);
    if(active.some(a=>a.symbol===t.symbol)||active.length>=10)continue;
    const notional=equity*0.10,pnl=notional*t.ret; equity=Math.max(1,equity+pnl);peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak);
    accepted.push({...t,pnl,equity});active.push({symbol:t.symbol,until:t.time+t.hold*300});
  }
  const period=(start,end)=>{const x=accepted.filter(t=>t.time>=start&&t.time<end),g=sum(x.filter(t=>t.pnl>0).map(t=>t.pnl)),l=Math.abs(sum(x.filter(t=>t.pnl<=0).map(t=>t.pnl)));return{trades:x.length,tradesPerDay:x.length/Math.max(days(start,end),1),netPnl:sum(x.map(t=>t.pnl)),profitFactor:l?g/l:g>0?99:0,winRate:x.length?x.filter(t=>t.pnl>0).length/x.length:0};};
  return {selectedFamilies:selected.map(r=>r.config.family),endEquity:equity,netPnl:equity-1000,maxDrawdown:dd,train:period(raw.from,trainEnd),test:period(trainEnd,testEnd),full:period(raw.from,testEnd)};
}

const base=combined(false), stress=combined(true);
const gates={hasStableEvents:selected.length>=3,frequency:base.test.tradesPerDay>=15,trainPositive:base.train.netPnl>0&&base.train.profitFactor>=1.08,
  testPositive:base.test.netPnl>0&&base.test.profitFactor>=1.05,drawdown:base.maxDrawdown<=0.12,stressPositive:stress.test.netPnl>0&&stress.test.profitFactor>=1.0};
const report={generatedAt:new Date().toISOString(),datasetSha256:raw.sha256,symbols,months:raw.months,friction:FRICTION,stressFriction:STRESS_FRICTION,
  trainMonths:raw.months.slice(0,8),testMonths:raw.months.slice(8),eventRows:events.length,candidateCount:families.length,
  selected:selected.map(r=>({config:r.config,score:r.score,positiveFolds:r.positiveFolds,train:r.train,test:r.test,stressTrain:r.stressTrain,folds:r.folds})),
  topCandidates:audit.slice(0,30).map(r=>({config:r.config,stable:r.stable,score:r.score,positiveFolds:r.positiveFolds,train:r.train,test:r.test,stressTrain:r.stressTrain})),base,stress,gates,targetMet:Object.values(gates).every(Boolean)};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");
console.log("CONDITIONAL_EVENT_MINER_RESULT="+JSON.stringify({targetMet:report.targetMet,candidateCount:families.length,stable:audit.filter(r=>r.stable).length,
 selected:report.selected.map(r=>({family:r.config.family,id:r.config.id,train:r.train,test:r.test})),base,stress,gates,top:report.topCandidates.slice(0,8)},null,2));
