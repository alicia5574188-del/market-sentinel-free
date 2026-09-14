import { readFileSync, writeFileSync } from "node:fs";

const INPUT=process.env.RESEARCH_DATASET??"/tmp/gate-history-frequency-aligned-12m.json";
const OUTPUT=process.env.WALKFORWARD_OUTPUT??"/tmp/walkforward-micro-gating.json";
const FRICTION=.0014,STRESS=.0022,DELTA=STRESS-FRICTION,DAY=86400,WEEK=7*DAY;
const raw=JSON.parse(readFileSync(INPUT,"utf8"));
if(raw.interval!=="5m"||raw.months.length!==12)throw new Error("Expected aligned 12-month 5m dataset");
const syms=raw.datasets.map(d=>d.symbol),by=new Map(raw.datasets.map(d=>[d.symbol,d.rows]));
const n=Math.min(...raw.datasets.map(d=>d.rows.length));
const monthStart=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000;
const trainEnd=monthStart(raw.months[8]),commonTrainStart=raw.from+90*DAY;
const sum=a=>a.reduce((x,y)=>x+y,0),median=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]??0;};
const ret=(r,i,k)=>r[i].close/r[i-k].close-1,days=(a,b)=>(b-a)/DAY;
const session=h=>h<7?"ASIA":h<13?"EU":h<21?"US":"LATE";

// 30-minute event clock: same representative event library used by the fast screen.
const events=[];
for(let i=288;i<n-24;i+=6){
  const time=raw.datasets[0].rows[i].time,s=[];
  for(const symbol of syms){const r=by.get(symbol);if(r[i]?.time!==time)continue;
    const r15=ret(r,i,3),r30=ret(r,i,6),r60=ret(r,i,12),r180=ret(r,i,36);
    const v=sum(r.slice(i-2,i+1).map(x=>x.volume))/3/Math.max(sum(r.slice(i-72,i-12).map(x=>x.volume))/60,1e-9);
    const q=sum(r.slice(i-2,i+1).map(x=>(x.high-x.low)/x.close))/3/Math.max(sum(r.slice(i-72,i-12).map(x=>(x.high-x.low)/x.close))/60,1e-9);
    s.push({symbol,r,i,time,r15,r30,r60,r180,v,q});}
  if(s.length<14)continue;
  const m30=median(s.map(x=>x.r30)),m60=median(s.map(x=>x.r60)),m180=median(s.map(x=>x.r180));
  const d=new Date(time*1000),ss=session(d.getUTCHours()),wk=[0,6].includes(d.getUTCDay());
  for(const x of s)events.push({...x,m30,m60,m180,res30:x.r30-m30,res60:x.r60-m60,res180:x.r180-m180,session:ss,weekend:wk});
}

const configs=[];const P=(...sets)=>sets.reduce((a,s)=>a.flatMap(x=>s.map(v=>[...x,v])),[[]]);
const add=(family,vs)=>vs.forEach((v,i)=>configs.push({family,id:`${family}-${i}`,...v}));
for(const mode of ["REV","CONT"])add(`RESIDUAL_${mode}`,P(["res30","res60"],[.005,.008,.012],[6,12,24],["ALL","US"]).map(([field,thr,hold,ss])=>({field,thr,hold,ss,mode})));
for(const mode of ["REV","CONT"])add(`SHOCK_${mode}`,P(["r30","r60"],[.008,.012,.020],[6,12,24],[1.5,2]).map(([field,thr,hold,vol])=>({field,thr,hold,vol,mode,ss:"ALL"})));
add("LAG_CATCHUP",P(["r60","r180"],[.006,.012],[.005,.010],[6,12]).map(([market,mt,rt,hold])=>({market,mt,rt,hold,ss:"ALL"})));
add("LEADER_CONT",P(["r60","r180"],[.006,.012],[.005,.010],[6,12]).map(([market,mt,rt,hold])=>({market,mt,rt,hold,ss:"ALL"})));
add("VOL_BREAK",P([2,3],[1.5,2.2],[.004,.008],[6,12]).map(([vol,range,thr,hold])=>({vol,range,thr,hold,ss:"ALL"})));
add("WEEKEND_RESIDUAL",P(["res30","res60"],[.005,.010],[6,12],["REV","CONT"]).map(([field,thr,hold,mode])=>({field,thr,hold,mode,ss:"ALL",weekend:true})));

function dir(c,e){
  if(c.ss!=="ALL"&&e.session!==c.ss)return 0;if(c.weekend&&!e.weekend)return 0;
  if(c.family.startsWith("RESIDUAL")||c.family==="WEEKEND_RESIDUAL"){if(Math.abs(e[c.field])<c.thr)return 0;const s=Math.sign(e[c.field]);return c.mode==="REV"?-s:s;}
  if(c.family.startsWith("SHOCK")){if(e.v<c.vol||Math.abs(e[c.field])<c.thr)return 0;const s=Math.sign(e[c.field]);return c.mode==="REV"?-s:s;}
  if(c.family==="LAG_CATCHUP"||c.family==="LEADER_CONT"){const m=c.market==="r60"?e.m60:e.m180,r=c.market==="r60"?e.res60:e.res180;if(Math.abs(m)<c.mt)return 0;const s=Math.sign(m);return c.family==="LAG_CATCHUP"?(s*r<=-c.rt?s:0):(s*r>=c.rt?s:0);}
  if(c.family==="VOL_BREAK")return e.v>=c.vol&&e.q>=c.range&&Math.abs(e.r15)>=c.thr?Math.sign(e.r15):0;
  return 0;
}
function makeTrades(c){const out=[],next=new Map();for(const e of events){if(e.time<(next.get(e.symbol)??0))continue;const d=dir(c,e);if(!d)continue;const px=e.r[e.i+c.hold]?.close;if(!(px>0))continue;out.push({time:e.time,symbol:e.symbol,ret:d*(px/e.r[e.i].close-1)-FRICTION,hold:c.hold,family:c.family,configId:c.id});next.set(e.symbol,e.time+c.hold*300);}return out;}
const cache=new Map(configs.map(c=>[c.id,makeTrades(c)]));
function perf(t,a,b,delta=0){const x=t.filter(z=>z.time>=a&&z.time<b);let gp=0,gl=0,net=0,w=0;for(const z of x){const r=z.ret-delta;net+=r;if(r>0){gp+=r;w++;}else gl-=r;}return{trades:x.length,tradesPerDay:x.length/Math.max(days(a,b),1),net,pf:gl?gp/gl:gp>0?99:0,win:x.length?w/x.length:0,mean:x.length?net/x.length:0};}

const gateModels=[];for(const lookbackDays of [30,60,90])for(const minPf of [1.05,1.10,1.15])for(const minStressPf of [1.0,1.03])for(const maxFamilies of [3,5,8])gateModels.push({lookbackDays,minPf,minStressPf,maxFamilies,id:`lb${lookbackDays}-pf${minPf}-spf${minStressPf}-n${maxFamilies}`});

function schedule(model){
  const out=[],selectionLog=[];const first=raw.from+model.lookbackDays*DAY;
  for(let at=first;at<raw.now;at+=WEEK){const end=Math.min(at+WEEK,raw.now),start=at-model.lookbackDays*DAY,eligible=[];
    for(const c of configs){const t=cache.get(c.id),base=perf(t,start,at),stress=perf(t,start,at,DELTA);const minTrades=Math.max(12,Math.floor(model.lookbackDays*.25));
      if(base.trades<minTrades||base.net<=0||base.pf<model.minPf||stress.net<=0||stress.pf<model.minStressPf)continue;
      const score=Math.log(Math.max(base.pf,1))*Math.sqrt(base.trades)*Math.max(base.mean,0)*1000;
      eligible.push({c,base,stress,score});}
    eligible.sort((a,b)=>b.score-a.score||b.base.net-a.base.net);
    const chosen=[],families=new Set();for(const row of eligible){if(families.has(row.c.family))continue;chosen.push(row);families.add(row.c.family);if(chosen.length>=model.maxFamilies)break;}
    for(const row of chosen)for(const t of cache.get(row.c.id))if(t.time>=at&&t.time<end)out.push(t);
    selectionLog.push({at,end,eligible:eligible.length,chosen:chosen.map(x=>({id:x.c.id,family:x.c.family,pf:x.base.pf,stressPf:x.stress.pf,trades:x.base.trades}))});
  }
  return{trades:out,selectionLog};
}
function simulate(model){const scheduled=schedule(model),uniq=[...new Map(scheduled.trades.map(t=>[`${t.time}:${t.symbol}:${t.family}`,t])).values()].sort((a,b)=>a.time-b.time);let eq=1000,peak=1000,dd=0;const active=[],accepted=[];
  for(const t of uniq){for(let i=active.length-1;i>=0;i--)if(active[i].until<=t.time)active.splice(i,1);if(active.some(x=>x.symbol===t.symbol)||active.length>=10)continue;const pnl=eq*.10*t.ret;eq=Math.max(1,eq+pnl);peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak);accepted.push({...t,pnl});active.push({symbol:t.symbol,until:t.time+t.hold*300});}
  const stressAccepted=accepted.map(t=>({...t,pnl:null,stressRet:t.ret-DELTA}));
  function pm(a,b,stress=false){const x=(stress?stressAccepted:accepted).filter(z=>z.time>=a&&z.time<b);let gp=0,gl=0,net=0,w=0,e=1000;for(const z of x){const r=stress?z.stressRet:z.ret,p=e*.10*r;e=Math.max(1,e+p);net+=p;if(p>0){gp+=p;w++;}else gl-=p;}return{trades:x.length,tradesPerDay:x.length/Math.max(days(a,b),1),netPnl:net,pf:gl?gp/gl:gp>0?99:0,win:x.length?w/x.length:0};}
  return{model,endEquity:eq,netPnl:eq-1000,maxDrawdown:dd,train:pm(commonTrainStart,trainEnd),test:pm(trainEnd,raw.now),full:pm(commonTrainStart,raw.now),stressTrain:pm(commonTrainStart,trainEnd,true),stressTest:pm(trainEnd,raw.now,true),selectionLog:scheduled.selectionLog};}

const results=gateModels.map(simulate);
const trainQualified=results.filter(r=>r.train.trades>=100&&r.train.netPnl>0&&r.train.pf>=1.05&&r.stressTrain.netPnl>0&&r.stressTrain.pf>=1.0&&r.maxDrawdown<=.20);
const rank=r=>(Math.min(r.train.tradesPerDay/15,1.2)+.25)*Math.log(Math.max(r.train.pf,1))*Math.log1p(Math.max(r.train.netPnl,0));
(trainQualified.length?trainQualified:results).sort((a,b)=>rank(b)-rank(a));const chosen=(trainQualified.length?trainQualified:results)[0];
const gates={trainQualified:trainQualified.length>0,frequency:chosen.test.tradesPerDay>=15,testPositive:chosen.test.netPnl>0&&chosen.test.pf>=1.05,drawdown:chosen.maxDrawdown<=.12,stressTest:chosen.stressTest.netPnl>0&&chosen.stressTest.pf>=1.0};
const summaryResults=results.map(r=>({model:r.model,train:r.train,test:r.test,stressTrain:r.stressTrain,stressTest:r.stressTest,maxDrawdown:r.maxDrawdown,netPnl:r.netPnl})).sort((a,b)=>(b.train.tradesPerDay*Math.log(Math.max(b.train.pf,1)))-(a.train.tradesPerDay*Math.log(Math.max(a.train.pf,1))));
const report={generatedAt:new Date().toISOString(),datasetSha256:raw.sha256,months:raw.months,symbols:syms,eventRows:events.length,candidateCount:configs.length,gateModelCount:gateModels.length,commonTrainStart,trainEnd,friction:FRICTION,stressFriction:STRESS,chosen:{...chosen,selectionLog:chosen.selectionLog},gates,targetMet:Object.values(gates).every(Boolean),results:summaryResults};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");console.log("WALKFORWARD_MICRO_RESULT="+JSON.stringify({targetMet:report.targetMet,trainQualified:trainQualified.length,chosen:{model:chosen.model,train:chosen.train,test:chosen.test,stressTrain:chosen.stressTrain,stressTest:chosen.stressTest,dd:chosen.maxDrawdown,net:chosen.netPnl},gates,top:summaryResults.slice(0,10)},null,2));