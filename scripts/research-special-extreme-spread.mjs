import { readFileSync, writeFileSync } from 'node:fs';

const SIGNAL_DATASET=process.env.RESEARCH_SIGNAL_DATASET??'/tmp/gate-history-spread-44m-1h.json';
const EXECUTION_DATASET=process.env.RESEARCH_EXECUTION_DATASET??'/tmp/gate-history-spread-44m-5m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/special-extreme-spread-44m.json';
const FRICTION=Number(process.env.RESEARCH_FRICTION??0.0014);
const STRESS_FRICTION=Number(process.env.RESEARCH_STRESS_FRICTION??0.0022);
const SLIPPAGE=Number(process.env.RESEARCH_ENTRY_SLIPPAGE??0.00025);
const signalRaw=JSON.parse(readFileSync(SIGNAL_DATASET,'utf8'));
const executionRaw=JSON.parse(readFileSync(EXECUTION_DATASET,'utf8'));
if(signalRaw.interval!=='1h'||executionRaw.interval!=='5m'||signalRaw.months.join()!==executionRaw.months.join())throw new Error('Requires matching canonical 1h + 5m datasets');
if(signalRaw.months.length!==44||signalRaw.symbols.length!==11)throw new Error('Requires frozen 44m / 11-symbol core universe');
const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>xs.length?sum(xs)/xs.length:0;
const median=xs=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b),m=Math.floor(ys.length/2);return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2;};
const quantile=(xs,q)=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b),p=(ys.length-1)*q,lo=Math.floor(p),hi=Math.ceil(p);return lo===hi?ys[lo]:ys[lo]+(ys[hi]-ys[lo])*(p-lo);};
const monthStart=m=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=signalRaw.from*1000,toMs=signalRaw.now*1000,discoveryEnd=monthStart(signalRaw.months[30]),validationEnd=monthStart(signalRaw.months[38]);
const ret=(rows,i,h)=>rows[i].close/rows[i-h].close-1,rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12);
function gapPrefix(rows,step){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+step));return p;}
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const m=(lo+hi)>>1;if(rows[m].time<time)lo=m+1;else hi=m;}return lo;}
const execBySymbol=new Map(executionRaw.datasets.map(d=>[d.symbol,d.rows]));

const byTime=new Map();
for(const {symbol,rows} of signalRaw.datasets){const gp=gapPrefix(rows,3600);for(let i=168;i<rows.length-9;i++){
  if(gp[i]!==gp[i-168]||rows[i+1].time!==rows[i].time+3600)continue;
  const prior24=rows.slice(i-24,i),f={symbol,rows,index:i,current:rows[i],r1:ret(rows,i,1),r4:ret(rows,i,4),prev1:rows[i-1].close/rows[i-2].close-1,prev4:rows[i-1].close/rows[i-5].close-1,volumeRatio:rows[i].volume/Math.max(median(prior24.map(x=>x.volume)),1e-12),rangeRatio:rangeRate(rows[i])/Math.max(median(prior24.map(rangeRate)),1e-9)};
  const a=byTime.get(rows[i].time)??[];a.push(f);byTime.set(rows[i].time,a);
}}
const contexts=[];
for(const [time,rows] of byTime){if(rows.length<9)continue;const m1=median(rows.map(x=>x.r1)),m4=median(rows.map(x=>x.r4)),pm1=median(rows.map(x=>x.prev1)),pm4=median(rows.map(x=>x.prev4));
  const es=rows.map(f=>({...f,rel1:f.r1-m1,rel4:f.r4-m4,prevRel1:f.prev1-pm1,prevRel4:f.prev4-pm4})),dispersion4=Math.max(0.001,median(es.map(x=>Math.abs(x.rel4)))),prevDispersion4=Math.max(0.001,median(es.map(x=>Math.abs(x.prevRel4))));
  contexts.push({time,rows:es,m1,m4,dispersion4,prevDispersion4,breadth1:rows.filter(x=>x.r1>0).length/rows.length,breadth4:rows.filter(x=>x.r4>0).length/rows.length});
}
contexts.sort((a,b)=>a.time-b.time);
const SPECIAL={minAbsRelative4:0.012,minRobustScore:1.8,minRunnerGap:0.002};
function extreme(ctx,direction){const ranked=ctx.rows.filter(f=>direction*f.rel4>0).sort((a,b)=>direction*(b.rel4-a.rel4));if(ranked.length<2)return null;const f=ranked[0],magnitude=direction*f.rel4,runner=direction*ranked[1].rel4,runnerGap=Math.max(0,magnitude-runner),robustScore=magnitude/ctx.dispersion4;if(magnitude<SPECIAL.minAbsRelative4||robustScore<SPECIAL.minRobustScore||runnerGap<SPECIAL.minRunnerGap)return null;return{f,magnitude,runnerGap,robustScore};}
const events=[];const lastPair=new Map();
for(const ctx of contexts){const up=extreme(ctx,1),down=extreme(ctx,-1);if(!up||!down||up.f.symbol===down.f.symbol)continue;const entryTime=up.f.rows[up.f.index+1].time,key=`${up.f.symbol}:${down.f.symbol}`,last=lastPair.get(key)??-Infinity;if(entryTime-last<7200)continue;lastPair.set(key,entryTime);
  const pressureSpread=up.f.rel1-down.f.rel1,prevPressureSpread=up.f.prevRel1-down.f.prevRel1,spread4=up.f.rel4-down.f.rel4,prevSpread4=up.f.prevRel4-down.f.prevRel4;
  const upExp=up.f.rel1>=0,downExp=down.f.rel1<=0,pathState=upExp?(downExp?'BOTH_EXPAND':'UP_EXPAND_DOWN_REVERT'):(downExp?'UP_REVERT_DOWN_EXPAND':'BOTH_REVERT');
  const features={spread4,spreadAcceleration:spread4-prevSpread4,pressureSpread,pressureAcceleration:pressureSpread-prevPressureSpread,dispersion4:ctx.dispersion4,dispersionAcceleration:ctx.dispersion4-ctx.prevDispersion4,upMagnitude:up.magnitude,downMagnitude:down.magnitude,magnitudeAsymmetry:Math.abs(up.magnitude-down.magnitude)/Math.max(spread4,1e-9),runnerGapSum:up.runnerGap+down.runnerGap,runnerGapMin:Math.min(up.runnerGap,down.runnerGap),marketAbs1:Math.abs(ctx.m1),marketAbs4:Math.abs(ctx.m4),breadthExtreme1:Math.abs(ctx.breadth1-0.5),breadthExtreme4:Math.abs(ctx.breadth4-0.5),upVolumeRatio:up.f.volumeRatio,downVolumeRatio:down.f.volumeRatio,upRangeRatio:up.f.rangeRatio,downRangeRatio:down.f.rangeRatio};
  events.push({time:entryTime,upSymbol:up.f.symbol,downSymbol:down.f.symbol,features,pathState});
}
const HORIZONS=[2,4,8],FEATURES=['spread4','spreadAcceleration','pressureSpread','pressureAcceleration','dispersion4','dispersionAcceleration','upMagnitude','downMagnitude','magnitudeAsymmetry','runnerGapSum','runnerGapMin','marketAbs1','marketAbs4','breadthExtreme1','breadthExtreme4','upVolumeRatio','downVolumeRatio','upRangeRatio','downRangeRatio'];
function pairReturn(ev,hours,mode,friction=FRICTION,slippage=SLIPPAGE){const endTime=ev.time+hours*3600,ur=execBySymbol.get(ev.upSymbol),dr=execBySymbol.get(ev.downSymbol),ui=lowerBound(ur,ev.time),ux=lowerBound(ur,endTime),di=lowerBound(dr,ev.time),dx=lowerBound(dr,endTime);if(ur[ui]?.time!==ev.time||ur[ux]?.time!==endTime||dr[di]?.time!==ev.time||dr[dx]?.time!==endTime)return null;for(let i=ui+1;i<=ux;i++)if(ur[i].time!==ur[i-1].time+300)return null;for(let i=di+1;i<=dx;i++)if(dr[i].time!==dr[i-1].time+300)return null;
  const du=mode==='CONTINUE'?1:-1,dd=-du,ue=ur[ui].open*(1+du*slippage),de=dr[di].open*(1+dd*slippage),ug=du*(ur[ux].open/ue-1),dg=dd*(dr[dx].open/de-1);return 0.5*(ug+dg)-friction;}
function monthKey(ms){const d=new Date(ms);return`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
function metrics(xs,hours,mode,start,end,friction=FRICTION,slippage=SLIPPAGE){const vals=[];const months=new Map();for(const ev of xs){if(ev.time*1000<start||ev.time*1000>=end)continue;const v=pairReturn(ev,hours,mode,friction,slippage);if(v==null)continue;vals.push(v);const k=monthKey(ev.time*1000),a=months.get(k)??[];a.push(v);months.set(k,a);}const g=vals.filter(v=>v>0),l=vals.filter(v=>v<=0),mm=[...months.values()].map(mean);return{trades:vals.length,tradesPerDay:vals.length/Math.max(1,(end-start)/86400000),totalNetReturn:sum(vals),meanNetReturn:mean(vals),profitFactor:l.length?sum(g)/Math.abs(sum(l)):g.length?99:0,winRate:vals.length?g.length/vals.length:0,activeMonths:mm.length,positiveMonths:mm.filter(v=>v>0).length};}
const cells=[];
function audit(meta,take){const ds=events.filter(ev=>ev.time*1000>=fromMs&&ev.time*1000<discoveryEnd&&take(ev)),rawCont=metrics(ds,meta.horizonHours,'CONTINUE',fromMs,discoveryEnd,0,0).meanNetReturn,mode=rawCont>=0?'CONTINUE':'REVERSE';const d=metrics(ds,meta.horizonHours,mode,fromMs,discoveryEnd),dsStress=metrics(ds,meta.horizonHours,mode,fromMs,discoveryEnd,STRESS_FRICTION),dsAdv=metrics(ds,meta.horizonHours,mode,fromMs,discoveryEnd,FRICTION,SLIPPAGE*2),v=metrics(events.filter(take),meta.horizonHours,mode,discoveryEnd,validationEnd),vs=metrics(events.filter(take),meta.horizonHours,mode,discoveryEnd,validationEnd,STRESS_FRICTION),e=metrics(events.filter(take),meta.horizonHours,mode,validationEnd,toMs),es=metrics(events.filter(take),meta.horizonHours,mode,validationEnd,toMs,STRESS_FRICTION);
  const folds=[[0,10],[10,20],[20,30]].map(([a,b])=>metrics(ds,meta.horizonHours,mode,monthStart(signalRaw.months[a]),monthStart(signalRaw.months[b]))),discoveryQualified=d.trades>=200&&d.totalNetReturn>0&&d.profitFactor>=1.08&&d.activeMonths>=18&&d.positiveMonths>=Math.ceil(d.activeMonths*0.55)&&folds.filter(x=>x.totalNetReturn>0).length>=2&&folds.at(-1).totalNetReturn>0&&dsStress.totalNetReturn>0&&dsStress.profitFactor>=1&&dsAdv.totalNetReturn>0&&dsAdv.profitFactor>=1;
  const validationPass=discoveryQualified&&v.trades>=60&&v.totalNetReturn>0&&v.profitFactor>=1.03&&vs.totalNetReturn>0&&vs.profitFactor>=1,evaluationPass=validationPass&&e.trades>=30&&e.totalNetReturn>0&&e.profitFactor>=1.03&&es.totalNetReturn>0&&es.profitFactor>=1;cells.push({...meta,mode,discovery:d,discoveryStress:dsStress,discoveryAdverse:dsAdv,folds,validation:v,stressValidation:vs,evaluation:e,stressEvaluation:es,discoveryQualified,validationPass,evaluationPass});}
for(const h of HORIZONS){const scope=events.filter(ev=>ev.time*1000>=fromMs&&ev.time*1000<discoveryEnd);for(const f of FEATURES){const vals=scope.map(ev=>ev.features[f]),q33=quantile(vals,1/3),q67=quantile(vals,2/3);for(const bin of ['LOW','MID','HIGH']){const take=ev=>bin==='LOW'?ev.features[f]<=q33:bin==='HIGH'?ev.features[f]>q67:ev.features[f]>q33&&ev.features[f]<=q67;audit({kind:'FEATURE',feature:f,bin,q33,q67,horizonHours:h},take);}}
  for(const state of ['BOTH_EXPAND','BOTH_REVERT','UP_EXPAND_DOWN_REVERT','UP_REVERT_DOWN_EXPAND'])audit({kind:'PATH_STATE',feature:'pathState',bin:state,horizonHours:h},ev=>ev.pathState===state);
}
const qualified=cells.filter(c=>c.discoveryQualified).sort((a,b)=>(b.discovery.profitFactor-a.discovery.profitFactor)||(b.discovery.totalNetReturn-a.discovery.totalNetReturn)),shortlist=qualified.slice(0,8),accepted=shortlist.filter(c=>c.validationPass&&c.evaluationPass),decision=accepted.length?'EXTERNAL_HOLDOUT_REQUIRED':shortlist.length?'NO_HELDOUT_PASS':'NO_DISCOVERY_SPREAD';
const result={research:'special-extreme-spread',premise:'when both positive and negative cross-sectional extremes are special, trade the market-neutral spread as expansion or convergence instead of predicting either coin absolute direction',canonical:{signalSha256:signalRaw.sha256,executionSha256:executionRaw.sha256,months:signalRaw.months.length,symbols:signalRaw.symbols},special:SPECIAL,eventCount:events.length,horizonsHours:HORIZONS,features:FEATURES,cells,shortlist,accepted:accepted.map(c=>({kind:c.kind,feature:c.feature,bin:c.bin,horizonHours:c.horizonHours,mode:c.mode})),decision,protocolNote:'Equal-gross two-leg returns are modeled with next-hour 5m open entry, canonical friction and entry slippage, higher-cost stress, doubled adverse entry, discovery-only bin thresholds and mode selection. Research-only; no production/PAPER/LIVE mutation.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,eventCount:events.length,qualified:qualified.length,shortlist:shortlist.map(c=>({kind:c.kind,feature:c.feature,bin:c.bin,h:c.horizonHours,mode:c.mode,d:c.discovery,v:c.validation,e:c.evaluation,validationPass:c.validationPass,evaluationPass:c.evaluationPass})),accepted:result.accepted},null,2));