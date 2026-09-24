import { readFileSync, writeFileSync } from "node:fs";

const INPUT = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-44m-5m.json";
const OUTPUT = process.env.CROSS_SECTION_OUTPUT ?? "/tmp/cross-sectional-residual.json";
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
if (raw.interval !== "5m" || raw.months.length < 44 || raw.datasets.length < 11) throw new Error("Need frozen 44-month 11-symbol Gate 5m archive");

const STEP = 300; const DECISION = 900; const BASE_COST = 0.0014; const STRESS_COST = 0.0022;
const BASE_SLIP = 0.00025; const ADVERSE_SLIP = 0.0005; const RISK = 0.01; const MAX_NOTIONAL = 1.5;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => { const a = [...xs].sort((x,y)=>x-y); if (!a.length) return 0; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };
const mad = (xs) => { const m=median(xs); return Math.max(median(xs.map(x=>Math.abs(x-m))) * 1.4826, 1e-6); };
const monthStart = (m) => Date.UTC(Number(m.slice(0,4)), Number(m.slice(4))-1, 1);
const fromMs=monthStart(raw.months[0]), discoveryEnd=monthStart(raw.months[30]), validationEnd=monthStart(raw.months[38]);
const ly=Number(raw.months.at(-1).slice(0,4)), lm=Number(raw.months.at(-1).slice(4)); const endMs=Date.UTC(ly,lm,1);
const folds=[[fromMs,monthStart(raw.months[10])],[monthStart(raw.months[10]),monthStart(raw.months[20])],[monthStart(raw.months[20]),discoveryEnd]];
const monthKey=(t)=>new Date(t).toISOString().slice(0,7).replace("-","");

const datasets = raw.datasets.slice(0,11).map(d=>({symbol:d.symbol,rows:d.rows}));
const bySymbol = new Map(datasets.map(d=>[d.symbol,d.rows]));
function exactIndex(rows,time){ let l=0,r=rows.length-1; while(l<=r){const m=(l+r)>>1,v=rows[m].time; if(v===time)return m; if(v<time)l=m+1; else r=m-1;} return -1; }
function atrRate(rows,i){ if(i<36)return null; let s=0; for(let j=i-35;j<=i;j++){const p=j?rows[j-1].close:rows[j].open; s+=Math.max(rows[j].high-rows[j].low,Math.abs(rows[j].high-p),Math.abs(rows[j].low-p));} return s/36/rows[i].close; }
function resolve(rows,i,side,reward,holdBars,cost,slip){ if(i+1>=rows.length)return null; const sign=side==="LONG"?1:-1; const ar=atrRate(rows,i); if(!ar)return null; const stopRate=Math.max(0.0075,Math.min(0.03,ar*5)); const entry=rows[i+1].open*(1+sign*slip); const stop=entry*(1-sign*stopRate), target=entry*(1+sign*stopRate*reward); let exit=rows[Math.min(rows.length-1,i+holdBars)].close, closedAt=rows[Math.min(rows.length-1,i+holdBars)].time*1000, outcome="TIME";
  for(let k=1;k<=holdBars && i+k<rows.length;k++){const b=rows[i+k]; const stopped=side==="LONG"?b.low<=stop:b.high>=stop; const hit=side==="LONG"?b.high>=target:b.low<=target; if(stopped){exit=stop;closedAt=b.time*1000;outcome="STOP";break;} if(hit){exit=target;closedAt=b.time*1000;outcome="TARGET";break;}}
  const gross=sign*(exit-entry)/entry; return {net:gross-cost,stopRate,openedAt:rows[i+1].time*1000,closedAt,outcome}; }

const configs=[];
for(const family of ["MOMENTUM","REVERSAL","LAGGARD"]) for(const z of [1.0,1.35,1.7,2.05]) for(const reward of [1.4,1.8,2.2]) for(const holdBars of [36,72,144]) configs.push({id:`${family}-z${z}-r${reward}-h${holdBars}`,family,z,reward,holdBars});
const eventsByConfig=new Map(configs.map(c=>[c.id,[]]));
const baseRows=datasets[0].rows;
for(let bi=144;bi<baseRows.length-2;bi++){
  const t=baseRows[bi].time; if(t%DECISION!==0)continue;
  const snaps=[];
  for(const {symbol,rows} of datasets){const i=exactIndex(rows,t); if(i<144 || i+145>=rows.length)continue; const get=(n)=>rows[i].close/rows[i-n].close-1; snaps.push({symbol,rows,i,r30:get(6),r2:get(24),r6:get(72),prev30:rows[i-6].close/rows[i-12].close-1});}
  if(snaps.length<9)continue;
  const med30=median(snaps.map(s=>s.r30)), med2=median(snaps.map(s=>s.r2)), med6=median(snaps.map(s=>s.r6));
  const residual2=snaps.map(s=>s.r2-med2), scale=mad(residual2); const marketStrength=med2/Math.max(mad(snaps.map(s=>s.r2)),1e-6);
  for(const s of snaps){const z2=(s.r2-med2)/scale, res30=s.r30-med30, res6=s.r6-med6, prevRes30=s.prev30-med30; for(const c of configs){let side=null,score=0;
      if(c.family==="MOMENTUM" && Math.abs(z2)>=c.z && Math.sign(res30)===Math.sign(z2) && Math.sign(res6)===Math.sign(z2)){side=z2>0?"LONG":"SHORT";score=Math.abs(z2);}
      else if(c.family==="REVERSAL" && Math.abs(z2)>=c.z && Math.sign(res30)===-Math.sign(z2) && Math.abs(res30)>=0.0015){side=z2>0?"SHORT":"LONG";score=Math.abs(z2)+Math.abs(res30)*100;}
      else if(c.family==="LAGGARD" && Math.abs(marketStrength)>=0.65 && Math.abs(z2)>=c.z && Math.sign(z2)===-Math.sign(med2) && Math.sign(res30)===Math.sign(med2) && Math.sign(prevRes30)!==Math.sign(med2)){side=med2>0?"LONG":"SHORT";score=Math.abs(z2)+Math.abs(marketStrength);}
      if(!side)continue;
      const base=resolve(s.rows,s.i,side,c.reward,c.holdBars,BASE_COST,BASE_SLIP), stress=resolve(s.rows,s.i,side,c.reward,c.holdBars,STRESS_COST,BASE_SLIP), adverse=resolve(s.rows,s.i,side,c.reward,c.holdBars,BASE_COST,ADVERSE_SLIP); if(!base||!stress||!adverse)continue;
      eventsByConfig.get(c.id).push({symbol:s.symbol,side,score,...base,stressNet:stress.net,adverseNet:adverse.net});
    }}
}

function portfolio(events,start,end,valueKey="net"){
  const rows=events.filter(e=>e.openedAt>=start&&e.openedAt<end).sort((a,b)=>a.openedAt-b.openedAt||b.score-a.score); let equity=1000,peak=1000,maxDrawdown=0; const open=[],cool=new Map(),taken=[],monthly=new Map(),symbolPnl=new Map();
  for(const e of rows){for(let i=open.length-1;i>=0;i--)if(open[i].closedAt<=e.openedAt)open.splice(i,1); if(open.length>=3||open.some(x=>x.symbol===e.symbol)||(cool.get(e.symbol)??0)>e.openedAt)continue; const notionalFrac=Math.min(MAX_NOTIONAL,RISK/e.stopRate); const pnl=equity*notionalFrac*e[valueKey]; equity+=pnl; peak=Math.max(peak,equity); maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak); const row={...e,pnl}; taken.push(row);open.push(e);cool.set(e.symbol,e.closedAt+3*3600_000); const m=monthKey(e.openedAt);monthly.set(m,(monthly.get(m)??0)+pnl);symbolPnl.set(e.symbol,(symbolPnl.get(e.symbol)??0)+pnl); }
  const gains=sum(taken.filter(x=>x.pnl>0).map(x=>x.pnl)), losses=Math.abs(sum(taken.filter(x=>x.pnl<=0).map(x=>x.pnl))); const pos=[...symbolPnl.values()].filter(x=>x>0),pt=sum(pos);
  return {trades:taken.length,netPnl:equity-1000,endEquity:equity,winRate:taken.length?taken.filter(x=>x.pnl>0).length/taken.length:0,profitFactor:losses?gains/losses:gains?99:0,maxDrawdown,activeMonths:monthly.size,positiveMonths:[...monthly.values()].filter(x=>x>0).length,largestPositiveSymbolShare:pt?Math.max(...pos)/pt:1,monthly:Object.fromEntries([...monthly].sort())}; }
const compact=x=>({trades:x.trades,netPnl:x.netPnl,profitFactor:x.profitFactor,winRate:x.winRate,maxDrawdown:x.maxDrawdown,activeMonths:x.activeMonths,positiveMonths:x.positiveMonths,largestPositiveSymbolShare:x.largestPositiveSymbolShare});
const audit=[];
for(const c of configs){const ev=eventsByConfig.get(c.id); const d=portfolio(ev,fromMs,discoveryEnd), ds=portfolio(ev,fromMs,discoveryEnd,"stressNet"), da=portfolio(ev,fromMs,discoveryEnd,"adverseNet"); const fm=folds.map(([a,b])=>portfolio(ev,a,b)); const fms=folds.map(([a,b])=>portfolio(ev,a,b,"stressNet")); const pass=d.trades>=70&&d.netPnl>0&&d.profitFactor>=1.08&&d.maxDrawdown<=0.14&&d.positiveMonths>=Math.ceil(d.activeMonths*.5)&&d.largestPositiveSymbolShare<=.45&&ds.netPnl>0&&ds.profitFactor>=1.02&&da.netPnl>0&&fm.every(x=>x.trades>=12&&x.netPnl>0&&x.profitFactor>=1.02)&&fms.filter(x=>x.netPnl>0).length>=2; audit.push({config:c,discovery:compact(d),stressDiscovery:compact(ds),adverseDiscovery:compact(da),folds:fm.map(compact),pass,validation:compact(portfolio(ev,discoveryEnd,validationEnd)),evaluation:compact(portfolio(ev,validationEnd,endMs)),stressValidation:compact(portfolio(ev,discoveryEnd,validationEnd,"stressNet")),stressEvaluation:compact(portfolio(ev,validationEnd,endMs,"stressNet")),adverseEvaluation:compact(portfolio(ev,validationEnd,endMs,"adverseNet"))}); }
const selected=[]; for(const family of ["MOMENTUM","REVERSAL","LAGGARD"]){const rows=audit.filter(x=>x.config.family===family&&x.pass).sort((a,b)=>(b.discovery.netPnl+b.stressDiscovery.netPnl)-(a.discovery.netPnl+a.stressDiscovery.netPnl)); if(rows[0])selected.push(rows[0]);}
const combinedEvents=selected.flatMap(x=>eventsByConfig.get(x.config.id)); const combined={discovery:compact(portfolio(combinedEvents,fromMs,discoveryEnd)),validation:compact(portfolio(combinedEvents,discoveryEnd,validationEnd)),evaluation:compact(portfolio(combinedEvents,validationEnd,endMs)),stressEvaluation:compact(portfolio(combinedEvents,validationEnd,endMs,"stressNet")),adverseEvaluation:compact(portfolio(combinedEvents,validationEnd,endMs,"adverseNet"))}; const evalDays=(endMs-validationEnd)/86400_000;
const gates={independentFamilies:selected.length>=2,validationTrades:combined.validation.trades>=50,validationPositive:combined.validation.netPnl>0&&combined.validation.profitFactor>=1.08,evaluationTrades:combined.evaluation.trades>=30,evaluationPositive:combined.evaluation.netPnl>0&&combined.evaluation.profitFactor>=1.10,stressPositive:combined.stressEvaluation.netPnl>0&&combined.stressEvaluation.profitFactor>=1.03,adversePositive:combined.adverseEvaluation.netPnl>0&&combined.adverseEvaluation.profitFactor>=1.03,drawdown:combined.evaluation.maxDrawdown<=.12,frequency:combined.evaluation.trades/evalDays>=0.35};
const report={generatedAt:new Date().toISOString(),datasetSha256:raw.sha256,split:{discovery:raw.months.slice(0,30),validation:raw.months.slice(30,38),evaluation:raw.months.slice(38)},selectionRule:"All parameter selection uses only discovery and three internal discovery folds. Validation/evaluation never participate in selection.",selected:selected.map(x=>x.config),selectedEvidence:selected.map(x=>({config:x.config,discovery:x.discovery,stressDiscovery:x.stressDiscovery,folds:x.folds,validation:x.validation,evaluation:x.evaluation,stressEvaluation:x.stressEvaluation,adverseEvaluation:x.adverseEvaluation})),combined,evaluationTradesPerDay:combined.evaluation.trades/evalDays,logicalCombinedWithFiveRegimePerDay:0.842391304347826+combined.evaluation.trades/evalDays,gates,replacementCandidate:Object.values(gates).every(Boolean),audit:audit.sort((a,b)=>Number(b.pass)-Number(a.pass)||b.discovery.profitFactor-a.discovery.profitFactor)};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n"); console.log("CROSS_SECTION_RESULT="+JSON.stringify({replacementCandidate:report.replacementCandidate,selected:report.selected,combined:report.combined,evaluationTradesPerDay:report.evaluationTradesPerDay,logicalCombinedWithFiveRegimePerDay:report.logicalCombinedWithFiveRegimePerDay,gates:report.gates,topDiscovery:report.audit.slice(0,12).map(x=>({id:x.config.id,pass:x.pass,d:x.discovery,v:x.validation,e:x.evaluation}))}));
