import { readFileSync, writeFileSync } from "node:fs";

const INPUT = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-frequency-aligned-12m.json";
const OUTPUT = process.env.MICRO_OUTPUT ?? "/tmp/micro-alpha-frequency.json";
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
if (raw.interval !== "5m" || raw.months.length !== 12) throw new Error("Expected aligned 12-month Gate 5m dataset");

const CORE = ["BTC_USDT","ETH_USDT","SOL_USDT","XRP_USDT","BNB_USDT","DOGE_USDT","ADA_USDT","LINK_USDT","LTC_USDT","AVAX_USDT","BCH_USDT"];
const SYMBOLS = raw.datasets.map(d => d.symbol);
if (!CORE.every(s => SYMBOLS.includes(s))) throw new Error("Missing regime-core symbol");
const data = new Map(raw.datasets.map(d => [d.symbol, d.rows]));
const ref = data.get(CORE[0]);
const FRICTION = 0.0014, STRESS_FRICTION = 0.0022, SLIPPAGE = 0.00025;
const HOUR = 3_600_000, DAY = 86_400_000;
const TRAIN_END = Date.UTC(2026, 4, 1); // Sep-Apr train, May-Aug untouched test.
const START_MS = raw.from * 1000, END_MS = raw.now * 1000;
const sum = xs => xs.reduce((a,b)=>a+b,0);
const median = xs => { if (!xs.length) return 0; const a=[...xs].sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; };
const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;
const rangeRate = r => (r.high-r.low)/Math.max(r.close,1e-12);
const monthKey = ms => new Date(ms).toISOString().slice(0,7).replace("-","");
const clip = (x,a,b) => Math.max(a,Math.min(b,x));

function hourly(rows){
  const out=[]; let b=null;
  for(const r of rows){
    const t=Math.floor(r.time/3600)*3600;
    if(!b||b.time!==t){if(b?.n===12)out.push(b);b={time:t,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume,n:1};}
    else{b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;b.volume+=r.volume;b.n++;}
  }
  if(b?.n===12)out.push(b);
  return out.map(({n,...r})=>r);
}
const hourBy = new Map(CORE.map(s=>[s,hourly(data.get(s))]));
const hourRef = hourBy.get(CORE[0]);
function classify(c){
  const aligned24=Math.max(c.breadth24,1-c.breadth24);
  if(Math.abs(c.median24)>=.04||(Math.abs(c.median24)>=.02&&aligned24>=.82))return"SHOCK_TRANSITION";
  if(c.compression<=.68&&Math.abs(c.median24)<.025)return"COMPRESSION";
  if((c.median30>=.08&&c.median7>=.015&&c.breadth30>=.60)||(c.median30<=-.08&&c.median7<=-.015&&c.breadth30<=.40))return"DIRECTIONAL_TREND";
  if(Math.abs(c.median24)>=.018||aligned24>=.75)return"NON_TREND_EXPANSION";
  return"BALANCED_ROTATION";
}
const contextByHour = new Map();
for(let h=720;h<hourRef.length;h++){
  const fs=[];
  for(const s of CORE){const rows=hourBy.get(s);if(!rows[h]||rows[h].time!==hourRef[h].time)continue;const ranges=rows.slice(h-168,h-6).map(rangeRate);const nowRanges=rows.slice(h-5,h+1).map(rangeRate);fs.push({r24:rows[h].close/rows[h-24].close-1,r7:rows[h].close/rows[h-168].close-1,r30:rows[h].close/rows[h-720].close-1,compression:median(nowRanges)/Math.max(median(ranges),1e-9)});}
  if(fs.length<8)continue;
  const c={median24:median(fs.map(x=>x.r24)),median7:median(fs.map(x=>x.r7)),median30:median(fs.map(x=>x.r30)),breadth24:fs.filter(x=>x.r24>0).length/fs.length,breadth7:fs.filter(x=>x.r7>0).length/fs.length,breadth30:fs.filter(x=>x.r30>0).length/fs.length,compression:median(fs.map(x=>x.compression)),markets:fs.length};
  contextByHour.set(hourRef[h].time,{...c,regime:classify(c)});
}

const CONFIGS = [
  {family:"MICRO_MOMENTUM",id:"mom-a",r4:.012,r1:.003,vol:.90,boundary:"2h",stopFloor:.008,atr:3.0,rr:1.6,hold:4},
  {family:"MICRO_MOMENTUM",id:"mom-b",r4:.020,r1:.005,vol:1.05,boundary:"2h",stopFloor:.009,atr:3.0,rr:1.8,hold:6},
  {family:"MICRO_MOMENTUM",id:"mom-c",r4:.015,r1:.004,vol:1.10,boundary:"6h",stopFloor:.008,atr:2.8,rr:1.7,hold:6},
  {family:"RELATIVE_CONTINUATION",id:"relc-a",rel4:.012,r30:.0020,vol:.85,stopFloor:.007,atr:2.8,rr:1.5,hold:4},
  {family:"RELATIVE_CONTINUATION",id:"relc-b",rel4:.020,r30:.0030,vol:1.00,stopFloor:.008,atr:3.0,rr:1.7,hold:6},
  {family:"RELATIVE_CONTINUATION",id:"relc-c",rel4:.016,r30:.0025,vol:1.10,stopFloor:.007,atr:2.6,rr:1.6,hold:4},
  {family:"MICRO_PULLBACK",id:"pull-a",r4:.012,pull:.0020,resume:.0015,stopFloor:.007,atr:2.8,rr:1.6,hold:4},
  {family:"MICRO_PULLBACK",id:"pull-b",r4:.018,pull:.0030,resume:.0020,stopFloor:.008,atr:3.0,rr:1.8,hold:6},
  {family:"MICRO_PULLBACK",id:"pull-c",r4:.015,pull:.0025,resume:.0012,stopFloor:.006,atr:2.5,rr:1.5,hold:3},
  {family:"FALSE_BREAK",id:"fake-a",reclaim:.0005,vol:1.00,stopFloor:.006,atr:2.5,rr:1.5,hold:3},
  {family:"FALSE_BREAK",id:"fake-b",reclaim:.0010,vol:1.15,stopFloor:.007,atr:2.8,rr:1.7,hold:4},
  {family:"FALSE_BREAK",id:"fake-c",reclaim:.0000,vol:1.30,stopFloor:.006,atr:2.5,rr:1.4,hold:2},
  {family:"RELATIVE_REVERSAL",id:"relr-a",rel4:.020,rev15:.0015,stopFloor:.007,atr:2.7,rr:1.5,hold:4},
  {family:"RELATIVE_REVERSAL",id:"relr-b",rel4:.030,rev15:.0020,stopFloor:.008,atr:3.0,rr:1.7,hold:6},
  {family:"RELATIVE_REVERSAL",id:"relr-c",rel4:.024,rev15:.0025,stopFloor:.006,atr:2.5,rr:1.5,hold:3},
  {family:"MICRO_RELEASE",id:"release-a",range2:.015,impulse:.0030,vol:1.10,stopFloor:.007,atr:2.8,rr:1.6,hold:4},
  {family:"MICRO_RELEASE",id:"release-b",range2:.020,impulse:.0040,vol:1.20,stopFloor:.008,atr:3.0,rr:1.8,hold:6},
  {family:"MICRO_RELEASE",id:"release-c",range2:.012,impulse:.0025,vol:1.00,stopFloor:.006,atr:2.5,rr:1.5,hold:3},
];

function featureAt(symbol,i,median4){
  const rows=data.get(symbol), j=i-1;
  if(j<8640)return null;
  const close=rows[j].close;
  const r=(n)=>close/rows[j-n].close-1;
  const r15=r(3),r30=r(6),r1=r(12),r2=r(24),r4=r(48),r12=r(144),r24=r(288);
  const prev30=rows[j-3].close/rows[j-9].close-1;
  const recent=rows.slice(j-2,j+1), prior2=rows.slice(j-26,j-2), prior6=rows.slice(j-74,j-2);
  const high15=Math.max(...recent.map(x=>x.high)),low15=Math.min(...recent.map(x=>x.low));
  const high2=Math.max(...prior2.map(x=>x.high)),low2=Math.min(...prior2.map(x=>x.low));
  const high6=Math.max(...prior6.map(x=>x.high)),low6=Math.min(...prior6.map(x=>x.low));
  const atr5=median(rows.slice(j-11,j+1).map(rangeRate));
  const recentVol=sum(rows.slice(j-5,j+1).map(x=>x.volume))/6;
  const baseVol=sum(rows.slice(j-77,j-5).map(x=>x.volume))/72;
  const hour=Math.floor(rows[j].time/3600)*3600-3600;
  const context=contextByHour.get(hour); if(!context)return null;
  return{symbol,close,current:rows[j],r15,r30,r1,r2,r4,r12,r24,prev30,relative4:r4-median4,high15,low15,high2,low2,high6,low6,atr5,volumeBurst:recentVol/Math.max(baseVol,1e-9),range2:(high2-low2)/Math.max(close,1e-9),context};
}
function found(config,f){
  if(config.family==="MICRO_MOMENTUM"){
    const d=sign(f.r4),boundary=d>0?(config.boundary==="6h"?f.high6:f.high2):(config.boundary==="6h"?f.low6:f.low2);
    if(!d||Math.abs(f.r4)<config.r4||d*f.r1<config.r1||f.volumeBurst<config.vol||d*(f.close/boundary-1)<0)return null;
    if(f.context.regime==="COMPRESSION"||f.context.regime==="BALANCED_ROTATION")return null;
    return{direction:d,strength:Math.abs(f.r4)+d*f.r1};
  }
  if(config.family==="RELATIVE_CONTINUATION"){
    const d=sign(f.relative4);if(!d||Math.abs(f.relative4)<config.rel4||d*f.r30<config.r30||f.volumeBurst<config.vol)return null;
    return{direction:d,strength:Math.abs(f.relative4)+d*f.r30};
  }
  if(config.family==="MICRO_PULLBACK"){
    const d=sign(f.r4);if(!d||Math.abs(f.r4)<config.r4||d*f.prev30>-config.pull||d*f.r15<config.resume)return null;
    return{direction:d,strength:Math.abs(f.r4)-d*f.prev30+d*f.r15};
  }
  if(config.family==="FALSE_BREAK"){
    const high=f.high15>f.high2&&f.close<f.high2*(1-config.reclaim),low=f.low15<f.low2&&f.close>f.low2*(1+config.reclaim);
    if(high===low||f.volumeBurst<config.vol)return null;
    return{direction:high?-1:1,strength:f.volumeBurst+Math.abs(f.r15)};
  }
  if(config.family==="RELATIVE_REVERSAL"){
    const original=sign(f.relative4),d=-original;if(!original||Math.abs(f.relative4)<config.rel4||d*f.r15<config.rev15)return null;
    return{direction:d,strength:Math.abs(f.relative4)+d*f.r15};
  }
  if(config.family==="MICRO_RELEASE"){
    const d=sign(f.r15),boundary=d>0?f.high2:f.low2;
    if(!d||f.range2>config.range2||Math.abs(f.r15)<config.impulse||f.volumeBurst<config.vol||d*(f.close/boundary-1)<0)return null;
    return{direction:d,strength:Math.abs(f.r15)+f.volumeBurst*.002};
  }
  return null;
}

const evalIndices=[];
for(let i=8641;i<ref.length-1;i+=3)evalIndices.push(i);
const features=new Map();
for(const i of evalIndices){
  const r4s=SYMBOLS.map(s=>{const rows=data.get(s),j=i-1;return j>=48?rows[j].close/rows[j-48].close-1:0;});
  const m4=median(r4s); const rows=[];
  for(const s of SYMBOLS){const f=featureAt(s,i,m4);if(f)rows.push(f);}
  features.set(i,rows);
}

function resolveEvent(config,f,i,friction=FRICTION,slippage=SLIPPAGE){
  const rows=data.get(f.symbol),d=found(config,f);if(!d)return null;
  const entry=rows[i].open*(1+d.direction*slippage);
  const stopRate=clip(Math.max(config.stopFloor,config.atr*f.atr5),config.stopFloor,.025);
  const targetRate=Math.max(stopRate*config.rr,friction*4);
  const stop=entry*(1-d.direction*stopRate),target=entry*(1+d.direction*targetRate),maxBars=config.hold*12;
  let exit=rows[Math.min(rows.length-1,i+maxBars)].open,closedIndex=Math.min(rows.length-1,i+maxBars),outcome="TIME";
  for(let k=i+1;k<=Math.min(rows.length-1,i+maxBars);k++){
    const p=rows[k].open,stopped=d.direction>0?p<=stop:p>=stop,targeted=d.direction>0?p>=target:p<=target;
    if(stopped){exit=stop;closedIndex=k;outcome="STOP";break;}if(targeted){exit=target;closedIndex=k;outcome="TARGET";break;}
  }
  const gross=d.direction*(exit-entry)/entry,net=gross-friction;
  return{family:config.family,configId:config.id,symbol:f.symbol,direction:d.direction,strength:d.strength,openedAt:rows[i].time*1000,closedAt:rows[closedIndex].time*1000,entry,exit,stopRate,targetRate,netReturn:net,grossReturn:gross,outcome};
}

function rawEvents(config,friction=FRICTION,slippage=SLIPPAGE){
  const out=[],armed=new Map(SYMBOLS.map(s=>[s,true]));
  for(const i of evalIndices){for(const f of features.get(i)??[]){const hit=found(config,f),wasArmed=armed.get(f.symbol);if(!hit){armed.set(f.symbol,true);continue;}if(!wasArmed)continue;const e=resolveEvent(config,f,i,friction,slippage);if(e)out.push(e);armed.set(f.symbol,false);}}
  return out;
}
const cache=new Map();
const eventsFor=(c,friction=FRICTION,slippage=SLIPPAGE)=>{const key=`${c.id}:${friction}:${slippage}`;if(!cache.has(key))cache.set(key,rawEvents(c,friction,slippage));return cache.get(key);};
function metrics(events,start=START_MS,end=END_MS){
  const xs=events.filter(e=>e.openedAt>=start&&e.openedAt<end),g=sum(xs.filter(e=>e.netReturn>0).map(e=>e.netReturn)),l=Math.abs(sum(xs.filter(e=>e.netReturn<=0).map(e=>e.netReturn)));
  return{trades:xs.length,tradesPerDay:xs.length/Math.max(1,(end-start)/DAY),netReturnSum:sum(xs.map(e=>e.netReturn)),profitFactor:l?g/l:g?99:0,winRate:xs.length?xs.filter(e=>e.netReturn>0).length/xs.length:0};
}
const trainFolds=[[Date.UTC(2025,8,1),Date.UTC(2025,10,1)],[Date.UTC(2025,10,1),Date.UTC(2026,0,1)],[Date.UTC(2026,0,1),Date.UTC(2026,2,1)],[Date.UTC(2026,2,1),TRAIN_END]];
const audit=CONFIGS.map(c=>{const ev=eventsFor(c),train=metrics(ev,START_MS,TRAIN_END),test=metrics(ev,TRAIN_END,END_MS),folds=trainFolds.map(([a,b])=>metrics(ev,a,b));const stable=folds.filter(x=>x.trades>=8&&x.netReturnSum>0&&x.profitFactor>=1.0).length>=3&&train.trades>=60&&train.netReturnSum>0&&train.profitFactor>=1.05;const score=stable?(train.profitFactor-1)*Math.sqrt(train.trades)*Math.min(1,train.tradesPerDay/2):0;return{config:c,train,test,folds,stable,score};});
const selected=[];
for(const family of [...new Set(CONFIGS.map(c=>c.family))]){const rows=audit.filter(r=>r.config.family===family&&r.stable).sort((a,b)=>b.score-a.score);if(rows[0])selected.push(rows[0].config);}

function portfolio(configs,{riskRate=.0035,friction=FRICTION,slippage=SLIPPAGE}={}){
  const events=configs.flatMap(c=>eventsFor(c,friction,slippage)).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength);
  let equity=1000,peak=1000,maxDrawdown=0;const open=new Map(),closed=[],rejects={occupied:0,risk:0,correlated:0};
  const flush=(until)=>{for(const [s,t] of [...open])if(t.closedAt<=until){equity=Math.max(.01,equity+t.notional*t.netReturn);closed.push({...t,netPnl:t.notional*t.netReturn});open.delete(s);peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/Math.max(peak,1e-9));}};
  const riskOpen=(dir)=>[...open.values()].filter(t=>dir==null||t.direction===dir).reduce((n,t)=>n+t.plannedRisk,0);
  for(const e of events){flush(e.openedAt);if(open.has(e.symbol)){rejects.occupied++;continue;}const planned=equity*riskRate;if(riskOpen(null)+planned>equity*.10+1e-9){rejects.risk++;continue;}if(riskOpen(e.direction)+planned>equity*.065+1e-9){rejects.correlated++;continue;}const notional=Math.min(equity*.50,planned/Math.max(e.stopRate+friction,1e-9));if(notional<equity*.03)continue;open.set(e.symbol,{...e,notional,plannedRisk:notional*(e.stopRate+friction)});}
  flush(Infinity);
  const monthly=new Map();for(const t of closed){const m=monthKey(t.closedAt);monthly.set(m,(monthly.get(m)??0)+t.netPnl);}
  const period=(a,b)=>{const xs=closed.filter(t=>t.openedAt>=a&&t.openedAt<b),g=sum(xs.filter(t=>t.netPnl>0).map(t=>t.netPnl)),l=Math.abs(sum(xs.filter(t=>t.netPnl<=0).map(t=>t.netPnl)));return{trades:xs.length,tradesPerDay:xs.length/((b-a)/DAY),netPnl:sum(xs.map(t=>t.netPnl)),profitFactor:l?g/l:g?99:0,winRate:xs.length?xs.filter(t=>t.netPnl>0).length/xs.length:0};};
  const g=sum(closed.filter(t=>t.netPnl>0).map(t=>t.netPnl)),l=Math.abs(sum(closed.filter(t=>t.netPnl<=0).map(t=>t.netPnl)));
  return{riskRate,trades:closed.length,tradesPerDay:closed.length/((END_MS-START_MS)/DAY),netPnl:equity-1000,endEquity:equity,profitFactor:l?g/l:g?99:0,winRate:closed.length?closed.filter(t=>t.netPnl>0).length/closed.length:0,maxDrawdown,positiveMonths:[...monthly.values()].filter(x=>x>0).length,activeMonths:monthly.size,monthly:Object.fromEntries([...monthly].sort()),rejects,train:period(START_MS,TRAIN_END),test:period(TRAIN_END,END_MS)};
}
const profiles=[.0025,.0035,.0050].map(riskRate=>portfolio(selected,{riskRate}));
const qualified=p=>p.tradesPerDay>=15&&p.profitFactor>=1.10&&p.maxDrawdown<=.08&&p.train.netPnl>0&&p.train.profitFactor>=1.05&&p.test.netPnl>0&&p.test.profitFactor>=1.05;
const ranked=[...profiles].sort((a,b)=>Number(qualified(b))-Number(qualified(a))||b.tradesPerDay-a.tradesPerDay||b.profitFactor-a.profitFactor);
const best=ranked[0]??null;
const stress=best?portfolio(selected,{riskRate:best.riskRate,friction:STRESS_FRICTION,slippage:SLIPPAGE}):null;
const adverse=best?portfolio(selected,{riskRate:best.riskRate,friction:FRICTION,slippage:SLIPPAGE*2}):null;
const gates=best?{frequency:best.tradesPerDay>=15,pf:best.profitFactor>=1.10,drawdown:best.maxDrawdown<=.08,train:best.train.netPnl>0&&best.train.profitFactor>=1.05,test:best.test.netPnl>0&&best.test.profitFactor>=1.05,stress:stress.netPnl>0&&stress.profitFactor>=1.03,adverse:adverse.netPnl>0&&adverse.profitFactor>=1.03}:{};
const report={generatedAt:new Date().toISOString(),dataset:{sha256:raw.sha256,months:raw.months,symbols:SYMBOLS,alignment:raw.alignment},architecture:{macro:"canonical five-regime context from 11 major symbols",microCadence:"15m completed-data signals / 5m executable-open lifecycle",families:[...new Set(CONFIGS.map(c=>c.family))],portfolio:"one shared 1000U micro account; one open position per symbol; 10% total risk cap; 6.5% same-side cap",riskSearch:[.0025,.0035,.005],selection:"first 8 months plus four chronological train folds only; last 4 months untouched until final evaluation"},configAudit:audit,selectedConfigs:selected.map(c=>c.id),profiles,best,stress,adverse,gates,targetMet:Object.keys(gates).length>0&&Object.values(gates).every(Boolean),notes:["No production or LIVE code is changed.","Strategy selection never uses the final four months.","The micro layer intentionally lowers per-trade planned risk while retaining the existing 10% total and 6.5% same-side account caps so higher turnover does not require higher aggregate risk.","Base cost uses 0.14% friction plus 0.025% adverse entry; stress uses 0.22% friction; adverse doubles entry slippage."]};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");
console.log("MICRO_ALPHA_RESULT="+JSON.stringify({targetMet:report.targetMet,selected:report.selectedConfigs,best:best&&{risk:best.riskRate,trades:best.trades,tradesPerDay:best.tradesPerDay,net:best.netPnl,pf:best.profitFactor,dd:best.maxDrawdown,train:best.train,test:best.test,rejects:best.rejects},stress:stress&&{net:stress.netPnl,pf:stress.profitFactor,dd:stress.maxDrawdown},adverse:adverse&&{net:adverse.netPnl,pf:adverse.profitFactor,dd:adverse.maxDrawdown},gates},null,2));