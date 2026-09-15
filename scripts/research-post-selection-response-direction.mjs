import { readFileSync, writeFileSync } from 'node:fs';

const SIGNAL_DATASET=process.env.RESEARCH_SIGNAL_DATASET??'/tmp/gate-history-response-44m-1h.json';
const EXECUTION_DATASET=process.env.RESEARCH_EXECUTION_DATASET??'/tmp/gate-history-response-44m-5m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/post-selection-response-direction-44m.json';
const signalRaw=JSON.parse(readFileSync(SIGNAL_DATASET,'utf8'));
const executionRaw=JSON.parse(readFileSync(EXECUTION_DATASET,'utf8'));
if(signalRaw.interval!=='1h'||executionRaw.interval!=='5m'||signalRaw.months.join()!==executionRaw.months.join())throw new Error('Requires matching canonical 1h + 5m datasets');
if(signalRaw.months.length!==44||signalRaw.symbols.length!==11)throw new Error('Requires frozen 44m / 11-symbol core universe');

const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>xs.length?sum(xs)/xs.length:0;
const median=xs=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b),m=Math.floor(ys.length/2);return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2;};
const quantile=(xs,q)=>{if(!xs.length)return 0;const ys=[...xs].sort((a,b)=>a-b),p=(ys.length-1)*q,lo=Math.floor(p),hi=Math.ceil(p);return lo===hi?ys[lo]:ys[lo]+(ys[hi]-ys[lo])*(p-lo);};
const monthStart=m=>Date.UTC(Number(m.slice(0,4)),Number(m.slice(4,6))-1,1);
const fromMs=signalRaw.from*1000,toMs=signalRaw.now*1000,discoveryEnd=monthStart(signalRaw.months[30]),validationEnd=monthStart(signalRaw.months[38]);
const ret=(rows,i,h)=>rows[i].close/rows[i-h].close-1;
const rangeRate=r=>(r.high-r.low)/Math.max(r.close,1e-12);
function gapPrefix(rows,step){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+step));return p;}
function lowerBound(rows,time){let lo=0,hi=rows.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid].time<time)lo=mid+1;else hi=mid;}return lo;}
const execBySymbol=new Map(executionRaw.datasets.map(d=>[d.symbol,d.rows]));

// Hourly cross-section used only to select the unusual coin. Direction is deliberately unresolved here.
const byTime=new Map();
for(const {symbol,rows} of signalRaw.datasets){
  const gp=gapPrefix(rows,3600);
  for(let i=168;i<rows.length-6;i++){
    if(gp[i]!==gp[i-168]||rows[i+1].time!==rows[i].time+3600)continue;
    const f={symbol,rows,index:i,current:rows[i],r1:ret(rows,i,1),r4:ret(rows,i,4),prev1:rows[i-1].close/rows[i-2].close-1,prev4:rows[i-1].close/rows[i-5].close-1};
    const a=byTime.get(rows[i].time)??[];a.push(f);byTime.set(rows[i].time,a);
  }
}
const contexts=[];
for(const [time,rows] of byTime){
  if(rows.length<9)continue;
  const m1=median(rows.map(x=>x.r1)),m4=median(rows.map(x=>x.r4)),pm1=median(rows.map(x=>x.prev1)),pm4=median(rows.map(x=>x.prev4));
  const es=rows.map(f=>({...f,rel1:f.r1-m1,rel4:f.r4-m4,prevRel1:f.prev1-pm1,prevRel4:f.prev4-pm4}));
  const scale4=Math.max(0.001,median(es.map(x=>Math.abs(x.rel4))));contexts.push({time,rows:es,scale4});
}
contexts.sort((a,b)=>a.time-b.time);
const SPECIAL={minAbsRelative4:0.012,minRobustScore:1.8,minRunnerGap:0.002};
const selected=[];const lastEmit=new Map();
for(const ctx of contexts){for(const direction of [1,-1]){
  const ranked=ctx.rows.filter(f=>direction*f.rel4>0).sort((a,b)=>direction*(b.rel4-a.rel4));if(ranked.length<2)continue;
  const f=ranked[0],magnitude=direction*f.rel4,runner=direction*ranked[1].rel4,runnerGap=Math.max(0,magnitude-runner),robustScore=magnitude/ctx.scale4;
  if(magnitude<SPECIAL.minAbsRelative4||robustScore<SPECIAL.minRobustScore||runnerGap<SPECIAL.minRunnerGap)continue;
  const decisionTime=f.rows[f.index+1].time,key=`${direction}:${f.symbol}`,last=lastEmit.get(key)??-Infinity;if(decisionTime-last<7200)continue;lastEmit.set(key,decisionTime);
  selected.push({decisionTime,direction,side:direction>0?'UP':'DOWN',symbol:f.symbol,f,ctx,magnitude,runnerGap,robustScore});
}}

const OBS_MINUTES=[30,60],HORIZONS_HOURS=[2,4];
function pathSnapshot(ev,obsMinutes){
  const bars=obsMinutes/5,startTime=ev.decisionTime,endTime=startTime+obsMinutes*60,rows=execBySymbol.get(ev.symbol),si=lowerBound(rows,startTime),ei=lowerBound(rows,endTime);
  if(rows[si]?.time!==startTime||rows[ei]?.time!==endTime)return null;for(let i=si+1;i<=ei;i++)if(rows[i].time!==rows[i-1].time+300)return null;
  const start=rows[si].open,end=rows[ei].open,d=ev.direction,used=rows.slice(si,ei);
  let hi=start,lo=start,totalAbs=0,same=0,prev=start,vol=0,rng=0;
  for(const r of used){hi=Math.max(hi,r.high);lo=Math.min(lo,r.low);const nxt=r.close,total=nxt/prev-1;totalAbs+=Math.abs(total);same+=Number(d*total>0);prev=nxt;vol+=r.volume;rng+=rangeRate(r);}
  const halfTime=startTime+(obsMinutes/2)*60,hi2=lowerBound(rows,halfTime);if(rows[hi2]?.time!==halfTime)return null;
  const half=rows[hi2].open,first=d*(half/start-1),second=d*(end/half-1),candidateRaw=end/start-1,candidate=d*candidateRaw;
  const favorable=d>0?hi/start-1:1-lo/start,adverse=d>0?1-lo/start:hi/start-1,closeLocation=(hi-lo)>1e-12?(d>0?(end-lo)/(hi-lo):(hi-end)/(hi-lo)):0.5;
  const baselineStart=Math.max(0,si-bars);if(si-baselineStart<bars)return null;let baseVol=0,baseRng=0;for(const r of rows.slice(baselineStart,si)){baseVol+=r.volume;baseRng+=rangeRate(r);}
  const peerReturns=[];for(const p of ev.ctx.rows){const pr=execBySymbol.get(p.symbol),pi=lowerBound(pr,startTime),pj=lowerBound(pr,endTime);if(pr[pi]?.time!==startTime||pr[pj]?.time!==endTime)continue;let ok=true;for(let k=pi+1;k<=pj;k++)if(pr[k].time!==pr[k-1].time+300){ok=false;break;}if(!ok)continue;peerReturns.push({symbol:p.symbol,r:pr[pj].open/pr[pi].open-1});}
  if(peerReturns.length<9)return null;const marketRaw=median(peerReturns.map(x=>x.r)),market=d*marketRaw,relative=candidate-market,breadth=peerReturns.filter(x=>d*x.r>0).length/peerReturns.length,ranked=[...peerReturns].sort((a,b)=>d*(b.r-a.r)),rank=ranked.findIndex(x=>x.symbol===ev.symbol)+1,rankStrength=rank>0&&ranked.length>1?1-(rank-1)/(ranked.length-1):0.5;
  const pathState=`C${candidate>=0?'C':'R'}_R${relative>=0?'C':'R'}_M${market>=0?'C':'R'}`;
  return{obsMinutes,startTime,endTime,entryTime:endTime,candidate,market,relative,firstHalf:first,secondHalf:second,responseAcceleration:second-first,favorable,adverse,retracement:favorable-candidate,closeLocation,efficiency:totalAbs>1e-12?candidate/totalAbs:0,sameDirBarShare:used.length?same/used.length:0,breadth,rankStrength,volumeRatio:vol/Math.max(baseVol,1e-12),rangeRatio:(rng/Math.max(used.length,1))/Math.max(baseRng/Math.max(bars,1),1e-9),anomalyAfter:ev.magnitude+relative,pathState};
}
function futureOutcome(ev,snap,hours){
  const rows=execBySymbol.get(ev.symbol),start=snap.entryTime,end=start+hours*3600,si=lowerBound(rows,start),ei=lowerBound(rows,end);if(rows[si]?.time!==start||rows[ei]?.time!==end)return null;for(let i=si+1;i<=ei;i++)if(rows[i].time!==rows[i-1].time+300)return null;return ev.direction*(rows[ei].open/rows[si].open-1);
}
const observations=[];
for(const ev of selected)for(const obsMinutes of OBS_MINUTES){const snap=pathSnapshot(ev,obsMinutes);if(!snap)continue;for(const h of HORIZONS_HOURS){const y=futureOutcome(ev,snap,h);if(y!=null)observations.push({time:snap.entryTime,side:ev.side,symbol:ev.symbol,obsMinutes,horizonHours:h,features:snap,pathState:snap.pathState,y});}}

const FEATURE_NAMES=['candidate','market','relative','firstHalf','secondHalf','responseAcceleration','favorable','adverse','retracement','closeLocation','efficiency','sameDirBarShare','breadth','rankStrength','volumeRatio','rangeRatio','anomalyAfter'];
function monthKey(sec){const d=new Date(sec*1000);return`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
function summarize(xs,mode){const vals=xs.map(x=>mode*x.y),months=new Map();for(const x of xs){const k=monthKey(x.time),a=months.get(k)??[];a.push(mode*x.y);months.set(k,a);}const mm=[...months.values()].map(mean);return{samples:vals.length,meanSigned:mean(vals),hitRate:vals.length?vals.filter(v=>v>0).length/vals.length:0,activeMonths:mm.length,positiveMonths:mm.filter(v=>v>0).length};}
const dRows=observations.filter(x=>x.time*1000>=fromMs&&x.time*1000<discoveryEnd),vRows=observations.filter(x=>x.time*1000>=discoveryEnd&&x.time*1000<validationEnd),eRows=observations.filter(x=>x.time*1000>=validationEnd&&x.time*1000<toMs);
const cells=[];
function addCell(meta,take){
  const ds=dRows.filter(take);if(!ds.length)return;const rawMean=mean(ds.map(x=>x.y)),mode=rawMean>=0?1:-1,d=summarize(ds,mode),v=summarize(vRows.filter(take),mode),e=summarize(eRows.filter(take),mode);
  const discoveryQualified=d.samples>=200&&d.meanSigned>=0.003&&d.hitRate>=0.54&&d.activeMonths>=18&&d.positiveMonths>=Math.ceil(d.activeMonths*0.55);
  cells.push({...meta,mode:mode>0?'CONTINUE':'REVERSE',discovery:d,validation:v,evaluation:e,discoveryQualified});
}
for(const side of ['UP','DOWN'])for(const obsMinutes of OBS_MINUTES)for(const h of HORIZONS_HOURS){
  const scope=dRows.filter(x=>x.side===side&&x.obsMinutes===obsMinutes&&x.horizonHours===h);
  for(const feature of FEATURE_NAMES){const vals=scope.map(x=>x.features[feature]),q33=quantile(vals,1/3),q67=quantile(vals,2/3);for(const bin of ['LOW','MID','HIGH']){const take=x=>x.side===side&&x.obsMinutes===obsMinutes&&x.horizonHours===h&&(bin==='LOW'?x.features[feature]<=q33:bin==='HIGH'?x.features[feature]>q67:x.features[feature]>q33&&x.features[feature]<=q67);addCell({kind:'FEATURE',side,obsMinutes,horizonHours:h,feature,bin,q33,q67},take);}}
  for(const state of ['CC_RCC_MC','CC_RCC_MR','CC_RR_MC','CC_RR_MR','CR_RCC_MC','CR_RCC_MR','CR_RR_MC','CR_RR_MR']){const take=x=>x.side===side&&x.obsMinutes===obsMinutes&&x.horizonHours===h&&x.pathState===state;addCell({kind:'PATH_STATE',side,obsMinutes,horizonHours:h,feature:'pathState',bin:state},take);}
}
const qualified=cells.filter(c=>c.discoveryQualified).sort((a,b)=>(b.discovery.meanSigned*Math.sqrt(b.discovery.samples))-(a.discovery.meanSigned*Math.sqrt(a.discovery.samples))),shortlist=qualified.slice(0,12);
for(const c of shortlist){c.validationPass=c.validation.samples>=60&&c.validation.meanSigned>0.001&&c.validation.hitRate>0.50;c.evaluationPass=c.evaluation.samples>=30&&c.evaluation.meanSigned>0.001&&c.evaluation.hitRate>0.50;}
const stable=shortlist.filter(c=>c.validationPass&&c.evaluationPass),decision=stable.length?'STABLE_POST_RESPONSE_SIGNAL':'NO_STABLE_POST_RESPONSE_SIGNAL';
const result={research:'post-selection-response-direction',premise:'specialness selects who to watch; direction is inferred only after observing the candidate and peer market response for 30 or 60 minutes, then tested on the remaining 2 or 4 hour move',canonical:{signalSha256:signalRaw.sha256,executionSha256:executionRaw.sha256,months:signalRaw.months.length,symbols:signalRaw.symbols},special:SPECIAL,selectedEvents:selected.length,observations:observations.length,observationMinutes:OBS_MINUTES,horizonsHours:HORIZONS_HOURS,featureNames:FEATURE_NAMES,cells,shortlist,stable,decision,protocolNote:'Observation features use only completed 5m bars after the special candidate was identified; future outcome begins at the observation-end open. Discovery terciles and direction signs are frozen into validation/evaluation. This is an information audit, not production/PAPER/LIVE logic.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({decision,selectedEvents:selected.length,observations:observations.length,qualified:qualified.length,shortlist:shortlist.map(c=>({kind:c.kind,side:c.side,obs:c.obsMinutes,h:c.horizonHours,feature:c.feature,bin:c.bin,mode:c.mode,d:c.discovery,v:c.validation,e:c.evaluation,validationPass:c.validationPass,evaluationPass:c.evaluationPass})),stable:stable.map(c=>({kind:c.kind,side:c.side,obs:c.obsMinutes,h:c.horizonHours,feature:c.feature,bin:c.bin,mode:c.mode}))},null,2));