import { readFileSync, writeFileSync } from 'node:fs';

const SIGNAL_DATASET = process.env.RESEARCH_SIGNAL_DATASET ?? '/tmp/gate-history-session-44m-1h.json';
const EXECUTION_DATASET = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-session-44m-5m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/session-relative-rotation-44m.json';
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const STRESS_FRICTION = Number(process.env.RESEARCH_STRESS_FRICTION ?? 0.0022);
const ENTRY_SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const signalRaw = JSON.parse(readFileSync(SIGNAL_DATASET,'utf8'));
const executionRaw = JSON.parse(readFileSync(EXECUTION_DATASET,'utf8'));
if(signalRaw.interval!=='1h'||executionRaw.interval!=='5m'||signalRaw.months.join()!==executionRaw.months.join()) throw new Error('Requires matching 1h signal + 5m execution datasets');
if(signalRaw.months.length!==44||signalRaw.symbols.length!==11) throw new Error('Requires frozen 44m / 11-symbol core universe');

const sum=(xs)=>xs.reduce((a,b)=>a+b,0);
const median=(xs)=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b);return ys[Math.floor(ys.length/2)];};
const sign=(x)=>x>0?1:x<0?-1:0;
const monthStart=(m)=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=signalRaw.from*1000,toMs=signalRaw.now*1000,discoveryEnd=monthStart(signalRaw.months[30]),validationEnd=monthStart(signalRaw.months[38]);
const executionBySymbol=new Map(executionRaw.datasets.map((d)=>[d.symbol,d.rows]));
function gapPrefix(rows){const p=[0];for(let i=1;i<rows.length;i+=1)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+3600));return p;}
const ret=(rows,i,h)=>rows[i].close/rows[i-h].close-1;
const rangeRate=(r)=>(r.high-r.low)/Math.max(r.close,1e-12);

const byTime=new Map();
for(const {symbol,rows} of signalRaw.datasets){const gaps=gapPrefix(rows);for(let i=168;i<rows.length-1;i+=1){
  const current=rows[i];if(gaps[i]!==gaps[i-168]||rows[i+1].time!==current.time+3600)continue;
  const ranges=rows.slice(i-5,i+1).map(rangeRate);
  const f={symbol,rows,index:i,current,r1:ret(rows,i,1),r4:ret(rows,i,4),r12:ret(rows,i,12),r24:ret(rows,i,24),r7d:ret(rows,i,168),atr6:median(ranges)};
  const arr=byTime.get(current.time)??[];arr.push(f);byTime.set(current.time,arr);
}}
const sessions=[];
for(const [time,rows] of byTime){if(rows.length<9)continue;const nextTime=time+3600;const hour=new Date(nextTime*1000).getUTCHours();if(![0,8,16].includes(hour))continue;
  const c={median1:median(rows.map(r=>r.r1)),median4:median(rows.map(r=>r.r4)),median12:median(rows.map(r=>r.r12)),median24:median(rows.map(r=>r.r24)),
    breadth4:rows.filter(r=>r.r4>0).length/rows.length,breadth24:rows.filter(r=>r.r24>0).length/rows.length};
  const enriched=rows.map(f=>({...f,relative1:f.r1-c.median1,relative4:f.r4-c.median4,relative12:f.r12-c.median12,relative24:f.r24-c.median24,context:c,nextTime}));
  const dispersion=median(enriched.map(f=>Math.abs(f.relative4)));
  enriched.sort((a,b)=>b.relative4-a.relative4||a.symbol.localeCompare(b.symbol));
  sessions.push({time,nextTime,hour,context:{...c,dispersion},top:enriched.slice(0,2),bottom:enriched.slice(-2)});
}

const COMMON={riskRate:0.01,notionalMultiple:0.40,minNotionalMultiple:0.05,stopCap:0.12,cooldownHours:4};
const CONFIGS=[
  {...COMMON,id:'CONT_A',family:'CONT',rel4Min:0.010,confirm24:0,confirm1:0,dispersionMin:0,stopFloor:0.020,stopAtr:2,trailScale:0.70,maxHoldHours:8},
  {...COMMON,id:'CONT_B',family:'CONT',rel4Min:0.015,confirm24:0.005,confirm1:0,dispersionMin:0,stopFloor:0.020,stopAtr:2,trailScale:0.70,maxHoldHours:8},
  {...COMMON,id:'CONT_DISP',family:'CONT',rel4Min:0.010,confirm24:0,confirm1:0,dispersionMin:0.0075,stopFloor:0.020,stopAtr:2,trailScale:0.70,maxHoldHours:8},
  {...COMMON,id:'REVERT_A',family:'REVERT',rel4Min:0.015,reversal1:0.002,balanced24:null,stopFloor:0.015,stopAtr:1.5,rewardRisk:1.5,maxHoldHours:4},
  {...COMMON,id:'REVERT_B',family:'REVERT',rel4Min:0.025,reversal1:0.003,balanced24:null,stopFloor:0.015,stopAtr:1.5,rewardRisk:1.5,maxHoldHours:4},
  {...COMMON,id:'REVERT_BAL',family:'REVERT',rel4Min:0.015,reversal1:0.002,balanced24:0.02,stopFloor:0.015,stopAtr:1.5,rewardRisk:1.5,maxHoldHours:4},
];
const configById=new Map(CONFIGS.map(c=>[c.id,c]));
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}
function candidateSignals(config){const out=[];for(const s of sessions){if(config.dispersionMin&&s.context.dispersion<config.dispersionMin)continue;
  for(const [bucket,dir] of [[s.top,1],[s.bottom,-1]]) for(const f of bucket){
    if(dir*Math.sign(f.relative4)<=0||Math.abs(f.relative4)<config.rel4Min)continue;
    if(config.family==='CONT'){
      if(dir*f.relative24<config.confirm24||dir*f.relative1<config.confirm1)continue;
      out.push({configId:config.id,f,direction:dir,strength:Math.abs(f.relative4)+Math.max(0,dir*f.relative24),sessionHour:s.hour});
    }else{
      const direction=-dir;if(direction*f.relative1<config.reversal1)continue;if(config.balanced24!=null&&Math.abs(s.context.median24)>=config.balanced24)continue;
      out.push({configId:config.id,f,direction,strength:Math.abs(f.relative4)+Math.max(0,direction*f.relative1),sessionHour:s.hour});
    }
  }}return out.sort((a,b)=>a.f.rows[a.f.index+1].time-b.f.rows[b.f.index+1].time||b.strength-a.strength);}
function resolve(config,sig,friction=FRICTION,slippage=ENTRY_SLIPPAGE){const f=sig.f,rows=executionBySymbol.get(f.symbol),entryTime=f.rows[f.index+1].time,index=lowerBound(rows,entryTime);if(rows[index]?.time!==entryTime)return null;
  const d=sig.direction,entry=rows[index].open*(1+d*slippage),stopRate=Math.min(config.stopCap,Math.max(config.stopFloor,config.stopAtr*f.atr6));
  const originalStop=entry*(1-d*stopRate),trail=config.family==='CONT',target=trail?null:entry*(1+d*Math.max(stopRate*config.rewardRisk,friction*2.2));
  let activeStop=originalStop,extreme=entry,exit=entry,closedAt=rows[index].time*1000,outcome='DATA_GAP';
  for(let o=0;o<config.maxHoldHours*12&&index+o<rows.length;o+=1){const candle=rows[index+o];if(o&&candle.time!==rows[index+o-1].time+300){exit=rows[index+o-1].close;closedAt=rows[index+o-1].time*1000;break;}
    const stopped=d>0?candle.low<=activeStop:candle.high>=activeStop;const targeted=!trail&&(d>0?candle.high>=target:candle.low<=target);
    if(stopped||targeted){exit=stopped?activeStop:target;closedAt=candle.time*1000;outcome=stopped?(activeStop===originalStop?'STOP':'TRAIL'):'TARGET';break;}
    if(trail){extreme=d>0?Math.max(extreme,candle.high):Math.min(extreme,candle.low);const cand=extreme*(1-d*stopRate*config.trailScale);activeStop=d>0?Math.max(activeStop,cand):Math.min(activeStop,cand);}
    exit=candle.close;closedAt=candle.time*1000;outcome=o===config.maxHoldHours*12-1?'TIMEOUT':outcome;}
  const grossReturnRate=d*(exit-entry)/entry;return{strategyId:config.id,family:config.family,symbol:f.symbol,side:d>0?'LONG':'SHORT',openedAt:rows[index].time*1000,closedAt,stopRate,strength:sig.strength,sessionHour:sig.sessionHour,friction,outcome,grossReturnRate,netReturnRate:grossReturnRate-friction};}
const tradeCache=new Map();
function rawTrades(config,friction=FRICTION,slippage=ENTRY_SLIPPAGE){const key=`${config.id}:${friction}:${slippage}`;if(tradeCache.has(key))return tradeCache.get(key);const trades=candidateSignals(config).flatMap(sig=>{const t=resolve(config,sig,friction,slippage);return t?[t]:[];}).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength);tradeCache.set(key,trades);return trades;}
function portfolio(trades,configs=[...CONFIGS]){let equity=1000,peak=equity,maxDrawdown=0;const open=[],accepted=[],cooldown=new Map();const cfg=new Map(configs.map(c=>[c.id,c]));
  const settle=(time)=>{for(const t of open.filter(r=>r.closedAt<=time).sort((a,b)=>a.closedAt-b.closedAt)){equity+=t.netPnl;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);open.splice(open.indexOf(t),1);cooldown.set(`${t.strategyId}:${t.symbol}`,t.closedAt+cfg.get(t.strategyId).cooldownHours*3600000);}};
  for(let i=0;i<trades.length;){const openedAt=trades[i].openedAt;settle(openedAt);const same=[];while(i<trades.length&&trades[i].openedAt===openedAt)same.push(trades[i++]);for(const t of same.sort((a,b)=>b.strength-a.strength||a.strategyId.localeCompare(b.strategyId)||a.symbol.localeCompare(b.symbol))){const c=cfg.get(t.strategyId);if(equity<=100||open.some(r=>r.symbol===t.symbol)||(cooldown.get(`${t.strategyId}:${t.symbol}`)??0)>t.openedAt)continue;const sameSide=open.filter(r=>r.side===t.side);const multiple=Math.min(c.notionalMultiple,c.riskRate/Math.max(t.stopRate+t.friction,1e-9));if(multiple<c.minNotionalMultiple)continue;const notional=equity*multiple,plannedRisk=notional*(t.stopRate+t.friction);if(sum(open.map(r=>r.plannedRisk))+plannedRisk>equity*0.10||sum(sameSide.map(r=>r.plannedRisk))+plannedRisk>equity*0.065)continue;const at={...t,equityAtOpen:equity,notional,plannedRisk,netPnl:notional*t.netReturnRate};open.push(at);accepted.push(at);}}
  settle(Infinity);return{trades:accepted,endEquity:equity,maxDrawdown};}
function metrics(account,start,end){const rows=account.trades.filter(t=>t.openedAt>=start&&t.openedAt<end),g=rows.filter(t=>t.netPnl>0),l=rows.filter(t=>t.netPnl<=0);const monthly=signalRaw.months.flatMap(m=>{const s=monthStart(m),e=Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6)),1);if(s<start||e>end)return[];const xs=rows.filter(t=>t.openedAt>=s&&t.openedAt<e);return[{month:m,trades:xs.length,pnl:sum(xs.map(t=>t.netPnl))}];});let eq=1000,pk=eq,dd=0;for(const t of [...rows].sort((a,b)=>a.closedAt-b.closedAt)){eq+=t.netPnl;pk=Math.max(pk,eq);dd=Math.max(dd,(pk-eq)/pk);}const bySymbol=Object.fromEntries([...new Set(rows.map(t=>t.symbol))].map(sym=>[sym,sum(rows.filter(t=>t.symbol===sym).map(t=>t.netPnl))]));const pos=Object.values(bySymbol).filter(v=>v>0),pt=sum(pos);return{trades:rows.length,tradesPerDay:rows.length/Math.max(1,(end-start)/86400000),netPnl:sum(rows.map(t=>t.netPnl)),profitFactor:l.length?sum(g.map(t=>t.netPnl))/Math.abs(sum(l.map(t=>t.netPnl))):g.length?99:0,maxDrawdown:dd,activeMonths:monthly.filter(x=>x.trades).length,positiveMonths:monthly.filter(x=>x.pnl>0).length,largestPositiveSymbolShare:pt?Math.max(...pos)/pt:1,bySymbol,monthly};}
const compact=m=>({trades:m.trades,tradesPerDay:m.tradesPerDay,netPnl:m.netPnl,profitFactor:m.profitFactor,maxDrawdown:m.maxDrawdown,activeMonths:m.activeMonths,positiveMonths:m.positiveMonths,largestPositiveSymbolShare:m.largestPositiveSymbolShare});
const folds=(account)=>[[0,10],[10,20],[20,30]].map(([a,b])=>metrics(account,monthStart(signalRaw.months[a]),monthStart(signalRaw.months[b])));
function audit(config){const base=portfolio(rawTrades(config),[config]),stress=portfolio(rawTrades(config,STRESS_FRICTION),[config]),adverse=portfolio(rawTrades(config,FRICTION,ENTRY_SLIPPAGE*2),[config]);const period=(a,s,e)=>metrics(a,s,e);const d=period(base,fromMs,discoveryEnd),v=period(base,discoveryEnd,validationEnd),ev=period(base,validationEnd,toMs),fs=folds(base);const discoveryQualified=d.trades>=500&&d.netPnl>0&&d.profitFactor>=1.08&&d.activeMonths>=20&&d.positiveMonths>=Math.ceil(d.activeMonths*.55)&&d.largestPositiveSymbolShare<=.45&&fs.filter(x=>x.netPnl>0).length>=2&&fs.at(-1).netPnl>0;const later=(x,y,z,min)=>x.trades>=min&&x.netPnl>0&&x.profitFactor>=1.03&&y.trades>=min&&y.netPnl>0&&y.profitFactor>=1&&z.trades>=min&&z.netPnl>0&&z.profitFactor>=1;const sv=period(stress,discoveryEnd,validationEnd),sev=period(stress,validationEnd,toMs),av=period(adverse,discoveryEnd,validationEnd),aev=period(adverse,validationEnd,toMs);return{config,discovery:compact(d),validation:compact(v),evaluation:compact(ev),stressValidation:compact(sv),stressEvaluation:compact(sev),adverseValidation:compact(av),adverseEvaluation:compact(aev),discoveryFolds:fs.map(compact),discoveryQualified,validationPass:later(v,sv,av,100),evaluationPass:later(ev,sev,aev,75)};}
const audits=CONFIGS.map(audit);const familyWinners={};for(const fam of ['CONT','REVERT']){const q=audits.filter(a=>a.config.family===fam&&a.discoveryQualified).sort((a,b)=>b.discovery.netPnl-a.discovery.netPnl||b.discovery.profitFactor-a.discovery.profitFactor);familyWinners[fam]=q[0]??null;}
const selected=Object.values(familyWinners).filter(Boolean);let combined=null;if(selected.length){const configs=selected.map(x=>x.config);const build=(fr,sl)=>portfolio(configs.flatMap(c=>rawTrades(c,fr,sl)).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength),configs);const base=build(FRICTION,ENTRY_SLIPPAGE),stress=build(STRESS_FRICTION,ENTRY_SLIPPAGE),adverse=build(FRICTION,ENTRY_SLIPPAGE*2);combined={strategies:configs.map(c=>c.id),discovery:compact(metrics(base,fromMs,discoveryEnd)),validation:compact(metrics(base,discoveryEnd,validationEnd)),evaluation:compact(metrics(base,validationEnd,toMs)),stressValidation:compact(metrics(stress,discoveryEnd,validationEnd)),stressEvaluation:compact(metrics(stress,validationEnd,toMs)),adverseValidation:compact(metrics(adverse,discoveryEnd,validationEnd)),adverseEvaluation:compact(metrics(adverse,validationEnd,toMs))};}
const accepted=audits.filter(a=>a.discoveryQualified&&a.validationPass&&a.evaluationPass);const decision=accepted.length?'FORWARD_CANDIDATE':'NO_RELEASE';const out={generatedAt:new Date().toISOString(),decision,methodology:{name:'Session Relative Rotation',sessionsUTC:[0,8,16],topBottom:2,configCount:CONFIGS.length,selection:'predeclared configs; discovery qualification then untouched validation/evaluation',noProductionAuthority:true},dataset:{signalSha256:signalRaw.sha256,executionSha256:executionRaw.sha256,months:signalRaw.months,symbols:signalRaw.symbols},sessionCount:sessions.length,audits,familyWinners:Object.fromEntries(Object.entries(familyWinners).map(([k,v])=>[k,v?.config.id??null])),combined,accepted:accepted.map(a=>a.config.id)};writeFileSync(OUTPUT,JSON.stringify(out,null,2));console.log(JSON.stringify({output:OUTPUT,decision,sessionCount:sessions.length,familyWinners:out.familyWinners,accepted:out.accepted,combined,leaderboard:[...audits].sort((a,b)=>b.discovery.netPnl-a.discovery.netPnl).map(a=>({id:a.config.id,dq:a.discoveryQualified,vp:a.validationPass,ep:a.evaluationPass,dN:a.discovery.trades,dTPD:a.discovery.tradesPerDay,dPF:a.discovery.profitFactor,dNet:a.discovery.netPnl,vN:a.validation.trades,vPF:a.validation.profitFactor,vNet:a.validation.netPnl,eN:a.evaluation.trades,ePF:a.evaluation.profitFactor,eNet:a.evaluation.netPnl}))},null,2));
