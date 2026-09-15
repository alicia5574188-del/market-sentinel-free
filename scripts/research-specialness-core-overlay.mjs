import { readFileSync, writeFileSync } from 'node:fs';

const SIGNAL_DATASET=process.env.RESEARCH_SIGNAL_DATASET??'/tmp/gate-history-overlay-44m-1h.json';
const EXECUTION_DATASET=process.env.RESEARCH_EXECUTION_DATASET??'/tmp/gate-history-overlay-44m-5m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/specialness-core-overlay-44m.json';
const FRICTION=Number(process.env.RESEARCH_FRICTION??0.0014);
const STRESS_FRICTION=Number(process.env.RESEARCH_STRESS_FRICTION??0.0022);
const SLIPPAGE=Number(process.env.RESEARCH_ENTRY_SLIPPAGE??0.00025);
const signalRaw=JSON.parse(readFileSync(SIGNAL_DATASET,'utf8'));
const executionRaw=JSON.parse(readFileSync(EXECUTION_DATASET,'utf8'));
if(signalRaw.interval!=='1h'||executionRaw.interval!=='5m'||signalRaw.months.join()!==executionRaw.months.join())throw new Error('Requires matching canonical 1h signal + 5m execution datasets');
if(signalRaw.months.length!==44||signalRaw.symbols.length!==11)throw new Error('Requires frozen 44m / 11-symbol universe');

const SYSTEMS=['SHOCK_TRANSITION','COMPRESSION','DIRECTIONAL_TREND','NON_TREND_EXPANSION','BALANCED_ROTATION'];
const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>xs.length?sum(xs)/xs.length:0;
const median=xs=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b);return ys[Math.floor(ys.length/2)];};
const sign=x=>x>0?1:x<0?-1:0;
const monthStart=m=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=signalRaw.from*1000,toMs=signalRaw.now*1000,discoveryEnd=monthStart(signalRaw.months[30]),validationEnd=monthStart(signalRaw.months[38]);
const executionBySymbol=new Map(executionRaw.datasets.map(d=>[d.symbol,d.rows]));
const ret=(rows,i,h)=>rows[i].close/rows[i-h].close-1;
const rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12);
function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+3600));return p;}
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}

const byTime=new Map();
for(const {symbol,rows} of signalRaw.datasets){
  const gaps=gapPrefix(rows);
  for(let i=720;i<rows.length-1;i++){
    const current=rows[i];
    if(gaps[i]!==gaps[i-720]||rows[i+1].time!==current.time+3600)continue;
    const prev24=rows.slice(i-24,i),prev7=rows.slice(i-168,i),curRanges=rows.slice(i-5,i+1).map(rangeRate),baseRanges=rows.slice(i-168,i-6).map(rangeRate);
    const recentVolume=sum(rows.slice(i-5,i+1).map(r=>r.volume))/6,baseVolume=sum(rows.slice(i-48,i-6).map(r=>r.volume))/42;
    const f={symbol,rows,index:i,current,r1:ret(rows,i,1),r6:ret(rows,i,6),r24:ret(rows,i,24),r7d:ret(rows,i,168),r30d:ret(rows,i,720),atr6:median(curRanges),compression:median(curRanges)/Math.max(median(baseRanges),1e-9),volumeBurst:recentVolume/Math.max(baseVolume,1e-9),high24:Math.max(...prev24.map(r=>r.high)),low24:Math.min(...prev24.map(r=>r.low)),high7d:Math.max(...prev7.map(r=>r.high)),low7d:Math.min(...prev7.map(r=>r.low))};
    const a=byTime.get(current.time)??[];a.push(f);byTime.set(current.time,a);
  }
}
function classify(c){
  const aligned24=Math.max(c.breadth24,1-c.breadth24);
  if(Math.abs(c.median24)>=0.04||(Math.abs(c.median24)>=0.02&&aligned24>=0.82))return'SHOCK_TRANSITION';
  if(c.compression<=0.68&&Math.abs(c.median24)<0.025)return'COMPRESSION';
  if((c.median30>=0.08&&c.median7>=0.015&&c.breadth30>=0.60)||(c.median30<=-0.08&&c.median7<=-0.015&&c.breadth30<=0.40))return'DIRECTIONAL_TREND';
  if(Math.abs(c.median24)>=0.018||aligned24>=0.75)return'NON_TREND_EXPANSION';
  return'BALANCED_ROTATION';
}
const observations=[];let contextHours=0;
for(const [time,rows] of byTime){
  if(rows.length<9)continue;contextHours++;
  const vals=k=>rows.map(r=>r[k]);
  const c={median1:median(vals('r1')),median24:median(vals('r24')),median7:median(vals('r7d')),median30:median(vals('r30d')),breadth24:rows.filter(r=>r.r24>0).length/rows.length,breadth7:rows.filter(r=>r.r7d>0).length/rows.length,breadth30:rows.filter(r=>r.r30d>0).length/rows.length,compression:median(vals('compression')),markets:rows.length};
  const system=classify(c),enriched=rows.map(f=>({...f,time,context:c,system,relative1:f.r1-c.median1,relative24:f.r24-c.median24,relative7:f.r7d-c.median7}));
  const scale1=Math.max(0.001,median(enriched.map(f=>Math.abs(f.relative1))));
  const ranked=[...enriched].sort((a,b)=>Math.abs(b.relative1)-Math.abs(a.relative1));
  const top=ranked[0],topPass=Math.abs(top.relative1)>=0.006&&Math.abs(top.relative1)/scale1>=1.8;
  const rankBySymbol=new Map(ranked.map((f,i)=>[f.symbol,i+1]));
  for(const f of enriched){
    f.specialRank=rankBySymbol.get(f.symbol);f.specialScore=Math.abs(f.relative1)/scale1;f.specialTop1=topPass&&f.symbol===top.symbol;f.specialDirection=sign(f.relative1);
    observations.push(f);
  }
}
observations.sort((a,b)=>a.time-b.time||a.symbol.localeCompare(b.symbol));

const C=[
  {id:'shock_transition-aligned_downshock_reversal-14',system:'SHOCK_TRANSITION',kind:'ALIGNED_DOWNSHOCK_REVERSAL',symbol24:.08,rebound6:.008,stopFloor:.06,stopAtr:6,rewardRisk:1.5,maxHoldHours:72},
  {id:'shock_transition-counter_downshock_survivor-15',system:'SHOCK_TRANSITION',kind:'COUNTER_DOWNSHOCK_SURVIVOR',relative24:.05,rebound6:.004,stopFloor:.06,stopAtr:6,rewardRisk:2.2,maxHoldHours:96},
  {id:'compression-false_release-4',system:'COMPRESSION',kind:'FALSE_RELEASE',volume:1.1,reclaim:.005,stopFloor:.03,stopAtr:5,rewardRisk:1.5,maxHoldHours:48},
  {id:'compression-quiet_pullback_resume-21',system:'COMPRESSION',kind:'QUIET_PULLBACK_RESUME',relative7:.05,pullbackMin:.003,pullbackMax:.01,resume6:.006,stopFloor:.03,stopAtr:5,rewardRisk:2.2,maxHoldHours:96},
  {id:'directional_trend-bear-market_rebound-12',system:'DIRECTIONAL_TREND',kind:'MARKET_REBOUND',trendSide:-1,drop24:.05,rebound6:.008,stopFloor:.03,stopAtr:5,rewardRisk:1.5,maxHoldHours:72},
  {id:'directional_trend-bull-relative_momentum-7',system:'DIRECTIONAL_TREND',kind:'RELATIVE_MOMENTUM',trendSide:1,relative7:.03,confirm24:.005,stopFloor:.06,stopAtr:6,exitModel:'TRAIL',trailScale:.8,maxHoldHours:168},
  {id:'directional_trend-bear-breakdown_trail-2',system:'DIRECTIONAL_TREND',kind:'BREAKDOWN_TRAIL',trendSide:-1,symbol30:.08,breadth:.30,stopFloor:.10,stopAtr:8,exitModel:'TRAIL',trailScale:.6,maxHoldHours:720},
  {id:'directional_trend-bear-defensive_relative-2',system:'DIRECTIONAL_TREND',kind:'DEFENSIVE_RELATIVE',trendSide:-1,relative7:.03,confirm6:0,stopFloor:.05,stopAtr:5,rewardRisk:1.5,maxHoldHours:72},
  {id:'non_trend_expansion-refined_breadth_continuation-10',system:'NON_TREND_EXPANSION',kind:'REFINED_BREADTH_CONTINUATION',symbol24:.055,impulse6:.003,stopFloor:.035,stopAtr:5,rewardRisk:2.0,maxHoldHours:72},
  {id:'non_trend_expansion-expansion_defender-14',system:'NON_TREND_EXPANSION',kind:'EXPANSION_DEFENDER',relative24:.04,resume6:.004,stopFloor:.05,stopAtr:5,rewardRisk:1.5,maxHoldHours:72},
  {id:'balanced_rotation-relative_pullback_resume-4',system:'BALANCED_ROTATION',kind:'RELATIVE_PULLBACK_RESUME',relative7:.04,pullbackMin:.003,pullbackMax:.01,resume6:.006,stopFloor:.03,stopAtr:5,rewardRisk:1.5,maxHoldHours:96},
  {id:'balanced_rotation-short_horizon_reversal-8',system:'BALANCED_ROTATION',kind:'SHORT_HORIZON_REVERSAL',relative24:.05,reversal6:.003,stopFloor:.03,stopAtr:5,rewardRisk:1.5,maxHoldHours:72},
].map(x=>({...x,riskRate:.015,notionalMultiple:.5,minNotionalMultiple:.05,stopCap:.20,cooldownHours:24}));
const cfgById=new Map(C.map(c=>[c.id,c]));

function signal(c,f){
  if(f.system!==c.system)return null;
  if(c.trendSide&&sign(f.context.median30)!==c.trendSide)return null;
  if(c.kind==='ALIGNED_DOWNSHOCK_REVERSAL'){if(f.context.median24>=0||f.context.median30>=0||f.r24>-c.symbol24||f.r6<c.rebound6)return null;return{direction:1,strength:-f.r24+f.r6};}
  if(c.kind==='COUNTER_DOWNSHOCK_SURVIVOR'){if(f.context.median24>=0||f.context.median30<=0||f.relative24<c.relative24||f.r6<c.rebound6)return null;return{direction:1,strength:f.relative24+f.r6};}
  if(c.kind==='FALSE_RELEASE'){if(f.volumeBurst<c.volume)return null;const hi=f.current.high>f.high24&&f.current.close<f.high24*(1-c.reclaim),lo=f.current.low<f.low24&&f.current.close>f.low24*(1+c.reclaim);if(hi===lo)return null;return{direction:hi?-1:1,strength:f.volumeBurst+Math.abs(f.r1)};}
  if(c.kind==='QUIET_PULLBACK_RESUME'||c.kind==='RELATIVE_PULLBACK_RESUME'){const d=sign(f.relative7),pb=d*f.r24;if(!d||Math.abs(f.relative7)<c.relative7||pb>-c.pullbackMin||pb<-c.pullbackMax||d*f.r6<c.resume6)return null;return{direction:d,strength:Math.abs(f.relative7)+Math.abs(f.r24)+d*f.r6};}
  if(c.kind==='MARKET_REBOUND'){if(f.r24>-c.drop24||f.r6<c.rebound6)return null;return{direction:1,strength:-f.r24+f.r6};}
  if(c.kind==='RELATIVE_MOMENTUM'){const d=sign(f.relative7);if(!d||Math.abs(f.relative7)<c.relative7||d*f.relative24<c.confirm24)return null;return{direction:d,strength:Math.abs(f.relative7)+d*f.relative24};}
  if(c.kind==='BREAKDOWN_TRAIL'){if(f.r30d>-c.symbol30||f.context.breadth30>c.breadth||f.current.close>=f.low7d)return null;return{direction:-1,strength:-f.r30d+(1-f.context.breadth30)*.02};}
  if(c.kind==='DEFENSIVE_RELATIVE'){const md=sign(f.context.median30),d=-md;if(!md||d*f.relative7<c.relative7||d*f.r6<c.confirm6)return null;return{direction:d,strength:d*f.relative7+d*f.r6};}
  if(c.kind==='REFINED_BREADTH_CONTINUATION'){const d=sign(f.context.median24),boundary=d>0?f.high24:f.low24;if(!d||sign(f.r24)!==d||Math.abs(f.r24)<c.symbol24||d*f.r6<c.impulse6||d*(f.current.close/boundary-1)<0)return null;return{direction:d,strength:Math.abs(f.r24)+d*f.r6};}
  if(c.kind==='EXPANSION_DEFENDER'){const md=sign(f.context.median24),d=-md;if(!md||d*f.relative24<c.relative24||d*f.r6<c.resume6)return null;return{direction:d,strength:d*f.relative24+d*f.r6};}
  if(c.kind==='SHORT_HORIZON_REVERSAL'){const o=sign(f.relative24),d=-o;if(!o||Math.abs(f.relative24)<c.relative24||d*f.r6<c.reversal6)return null;return{direction:d,strength:Math.abs(f.relative24)+d*f.r6};}
  return null;
}
function resolve(c,f,s,friction=FRICTION,slippage=SLIPPAGE){
  const rows=executionBySymbol.get(f.symbol),entryTime=f.rows[f.index+1].time,idx=lowerBound(rows,entryTime);if(rows[idx]?.time!==entryTime)return null;
  const d=s.direction,entry=rows[idx].open*(1+d*slippage),stopRate=Math.min(c.stopCap,Math.max(c.stopFloor,c.stopAtr*f.atr6)),trail=c.exitModel==='TRAIL',targetRate=trail?null:Math.max(stopRate*c.rewardRisk,friction*2.2),origStop=entry*(1-d*stopRate),target=trail?null:entry*(1+d*targetRate);
  let activeStop=origStop,extreme=entry,exit=entry,closedAt=rows[idx].time*1000,outcome='DATA_GAP';
  for(let o=0;o<c.maxHoldHours*12&&idx+o<rows.length;o++){
    const bar=rows[idx+o];if(o&&bar.time!==rows[idx+o-1].time+300){exit=rows[idx+o-1].close;closedAt=rows[idx+o-1].time*1000;break;}
    const stopped=d>0?bar.low<=activeStop:bar.high>=activeStop,targeted=!trail&&(d>0?bar.high>=target:bar.low<=target);
    if(stopped||targeted){exit=stopped?activeStop:target;closedAt=bar.time*1000;outcome=stopped?(activeStop===origStop?'STOP':'TRAIL'):'TARGET';break;}
    if(trail){extreme=d>0?Math.max(extreme,bar.high):Math.min(extreme,bar.low);const cand=extreme*(1-d*stopRate*c.trailScale);activeStop=d>0?Math.max(activeStop,cand):Math.min(activeStop,cand);}
    exit=bar.close;closedAt=bar.time*1000;outcome=o===c.maxHoldHours*12-1?'TIMEOUT':outcome;
  }
  const gross=d*(exit-entry)/entry;
  return{strategyId:c.id,system:c.system,kind:c.kind,symbol:f.symbol,side:d>0?'LONG':'SHORT',direction:d,openedAt:rows[idx].time*1000,closedAt,stopRate,strength:s.strength,friction,netReturnRate:gross-friction,specialTop1:f.specialTop1,specialRank:f.specialRank,specialScore:f.specialScore,specialDirection:f.specialDirection,specialAligned:f.specialTop1&&f.specialDirection===d,specialCounter:f.specialTop1&&f.specialDirection===-d};
}
const rawCache=new Map();
function rawTrades(c,friction=FRICTION,slippage=SLIPPAGE){const key=`${c.id}:${friction}:${slippage}`;if(rawCache.has(key))return rawCache.get(key);const out=[];for(const f of observations){const s=signal(c,f);if(!s)continue;const t=resolve(c,f,s,friction,slippage);if(t)out.push(t);}out.sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength);rawCache.set(key,out);return out;}
function category(t,name){if(name==='ALL')return true;if(name==='SPECIAL_TOP1')return t.specialTop1;if(name==='SPECIAL_ALIGNED')return t.specialAligned;if(name==='SPECIAL_COUNTER')return t.specialCounter;if(name==='NON_SPECIAL')return!t.specialTop1;return false;}
function portfolio(trades,categoryName){let equity=1000,peak=1000,dd=0;const open=[],accepted=[],cool=new Map();const settle=time=>{for(const t of open.filter(x=>x.closedAt<=time).sort((a,b)=>a.closedAt-b.closedAt)){equity+=t.netPnl;peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak);open.splice(open.indexOf(t),1);cool.set(`${t.strategyId}:${t.symbol}`,t.closedAt+cfgById.get(t.strategyId).cooldownHours*3600000);}};for(let i=0;i<trades.length;){const at=trades[i].openedAt;settle(at);const same=[];while(i<trades.length&&trades[i].openedAt===at)same.push(trades[i++]);for(const t of same.sort((a,b)=>b.strength-a.strength||a.strategyId.localeCompare(b.strategyId))){if(!category(t,categoryName))continue;const c=cfgById.get(t.strategyId);if(equity<=100||open.some(x=>x.symbol===t.symbol)||(cool.get(`${t.strategyId}:${t.symbol}`)??0)>t.openedAt)continue;const sameSide=open.filter(x=>x.side===t.side),multiple=Math.min(c.notionalMultiple,c.riskRate/Math.max(t.stopRate+t.friction,1e-9));if(multiple<c.minNotionalMultiple)continue;const notional=equity*multiple,plannedRisk=notional*(t.stopRate+t.friction);if(sum(open.map(x=>x.plannedRisk))+plannedRisk>equity*.10||sum(sameSide.map(x=>x.plannedRisk))+plannedRisk>equity*.065)continue;const x={...t,equityAtOpen:equity,notional,plannedRisk,netPnl:notional*t.netReturnRate};open.push(x);accepted.push(x);}}settle(Infinity);return{trades:accepted,endEquity:equity,maxDrawdown:dd};}
function metrics(rows,start,end,valueKey='netReturnRate'){const xs=rows.filter(t=>t.openedAt>=start&&t.openedAt<end),g=xs.filter(t=>t[valueKey]>0),l=xs.filter(t=>t[valueKey]<=0),monthly=signalRaw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1);if(s<start||e>end)return[];const ms=xs.filter(t=>t.openedAt>=s&&t.openedAt<e);return[{month:m,trades:ms.length,value:sum(ms.map(t=>t[valueKey]))}];});return{trades:xs.length,tradesPerDay:xs.length/Math.max(1,(end-start)/86400000),sum:sum(xs.map(t=>t[valueKey])),mean:mean(xs.map(t=>t[valueKey])),profitFactor:l.length?sum(g.map(t=>t[valueKey]))/Math.abs(sum(l.map(t=>t[valueKey]))):g.length?99:0,winRate:xs.length?g.length/xs.length:0,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.value>0).length};}
const SPLITS={discovery:[fromMs,discoveryEnd],validation:[discoveryEnd,validationEnd],evaluation:[validationEnd,toMs]};
const CATS=['ALL','SPECIAL_TOP1','SPECIAL_ALIGNED','SPECIAL_COUNTER','NON_SPECIAL'];
function analyze(friction=FRICTION,slippage=SLIPPAGE){
  const allRaw=C.flatMap(c=>rawTrades(c,friction,slippage));
  const signalLevel={};for(const [split,[s,e]] of Object.entries(SPLITS)){signalLevel[split]={};for(const cat of CATS)signalLevel[split][cat]=metrics(allRaw.filter(t=>category(t,cat)),s,e);}
  const systems={};for(const sys of SYSTEMS){const ts=C.filter(c=>c.system===sys).flatMap(c=>rawTrades(c,friction,slippage)).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength);systems[sys]={};for(const cat of CATS){const acc=portfolio(ts,cat);systems[sys][cat]={full:{trades:acc.trades.length,endEquity:acc.endEquity,maxDrawdown:acc.maxDrawdown},periods:Object.fromEntries(Object.entries(SPLITS).map(([k,[s,e]])=>[k,metrics(acc.trades,s,e,'netPnl')]))};}}
  const byStrategy={};for(const c of C){const ts=rawTrades(c,friction,slippage);byStrategy[c.id]=Object.fromEntries(Object.entries(SPLITS).map(([k,[s,e]])=>[k,Object.fromEntries(CATS.map(cat=>[cat,metrics(ts.filter(t=>category(t,cat)),s,e)]))]));}
  return{signalLevel,systems,byStrategy};
}
const base=analyze(),stress=analyze(STRESS_FRICTION,SLIPPAGE),adverse=analyze(FRICTION,SLIPPAGE*2);
const dAll=base.signalLevel.discovery.ALL,dSp=base.signalLevel.discovery.SPECIAL_TOP1,vSp=base.signalLevel.validation.SPECIAL_TOP1,eSp=base.signalLevel.evaluation.SPECIAL_TOP1,sv=stress.signalLevel.validation.SPECIAL_TOP1,se=stress.signalLevel.evaluation.SPECIAL_TOP1,av=adverse.signalLevel.validation.SPECIAL_TOP1,ae=adverse.signalLevel.evaluation.SPECIAL_TOP1;
const discoveryEnhanced=dSp.trades>=100&&dSp.mean>dAll.mean&&dSp.profitFactor>dAll.profitFactor&&dSp.sum>0;
const heldOutStable=vSp.trades>=30&&eSp.trades>=20&&vSp.mean>0&&eSp.mean>0&&vSp.profitFactor>1&&eSp.profitFactor>1&&sv.mean>0&&se.mean>0&&av.mean>0&&ae.mean>0;
const decision=discoveryEnhanced&&heldOutStable?'OVERLAY_SIGNAL_FOUND':'NO_OVERLAY_SIGNAL';
const result={research:'specialness-core-overlay',premise:'specialness chooses who; the frozen 12-strategy five-regime core decides direction. Test whether existing signals are materially stronger when their symbol is the current PRICE1 cross-sectional outlier.',canonical:{signalSha256:signalRaw.sha256,executionSha256:executionRaw.sha256,months:signalRaw.months.length,symbols:signalRaw.symbols},selector:{type:'PRICE1_HOURLY_SNAPSHOT',minAbsRelative1h:.006,minRobustScore:1.8,note:'same PRICE1 geometry as selector-quality audit, sampled only at the core system hourly decision point'},selectedStrategies:C.map(c=>c.id),contextHours,base,stress,adverse,gates:{discoveryEnhanced,heldOutStable},decision,protocolNote:'No core direction rule or lifecycle parameter is changed. This audit only stratifies frozen core signals by contemporaneous specialness; production/PAPER/LIVE are untouched.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,gates:result.gates,selectedStrategies:result.selectedStrategies,signalLevel:base.signalLevel,stressSignalLevel:stress.signalLevel,adverseSignalLevel:adverse.signalLevel,systems:Object.fromEntries(SYSTEMS.map(s=>[s,Object.fromEntries(CATS.map(c=>[c,base.systems[s][c].periods]))]))},null,2));
