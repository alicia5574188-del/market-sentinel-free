import { readFileSync, writeFileSync } from 'node:fs';

const INPUT=process.env.RESEARCH_DATASET??'/tmp/gate-history-44m-5m.json';
const OUTPUT=process.env.MAKER_OUTPUT??'/tmp/maker-first-v2.json';
const raw=JSON.parse(readFileSync(INPUT,'utf8'));
if(raw.interval!=='5m'||raw.months.length<44||raw.datasets.length<11)throw new Error('Need frozen 44-month 11-symbol Gate 5m archive');

const DECISION=900, COOLDOWN_MS=30*60_000;
const OFFSETS=[.0002,.0005,.0010], WAIT_BARS=[3,6,12], HORIZONS=[48,96], STOPS=[.02,.035];
// Fee scenarios are research scenarios, not an assertion about the user's exact VIP tier.
// Baseline: maker-style entry 2bp + taker-style exit 5bp + 2.5bp exit slippage = 9.5bp effective round-trip.
const COST_SCENARIOS={makerBase:{entryFee:.0002,exitFee:.0005,exitSlip:.00025},makerStress:{entryFee:.00025,exitFee:.00065,exitSlip:.00030},legacyConservative:{entryFee:.00045,exitFee:.0007,exitSlip:.00025}};
const monthStart=m=>Date.UTC(+m.slice(0,4),+m.slice(4)-1,1);
const from=monthStart(raw.months[0]),discEnd=monthStart(raw.months[30]),valEnd=monthStart(raw.months[38]);
const y=+raw.months.at(-1).slice(0,4),mo=+raw.months.at(-1).slice(4),end=Date.UTC(y,mo,1);
const folds=[[from,monthStart(raw.months[10])],[monthStart(raw.months[10]),monthStart(raw.months[20])],[monthStart(raw.months[20]),discEnd]];
const sum=a=>a.reduce((x,y)=>x+y,0),med=a=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[b.length>>1]:0},mad=a=>{const m=med(a);return Math.max(med(a.map(x=>Math.abs(x-m)))*1.4826,1e-6)};
const ds=raw.datasets.slice(0,11).map(d=>({symbol:d.symbol,rows:d.rows}));
function ix(r,t){let l=0,h=r.length-1;while(l<=h){const m=(l+h)>>1;if(r[m].time===t)return m;if(r[m].time<t)l=m+1;else h=m-1}return-1}
const ret=(r,i,n)=>r[i].close/r[i-n].close-1;
function bounds(r,a,b){let hi=-1e99,lo=1e99;for(let j=a;j<=b;j++){hi=Math.max(hi,r[j].high);lo=Math.min(lo,r[j].low)}return[hi,lo]}
function volBurst(r,i){let a=0,b=0;for(let j=i-2;j<=i;j++)a+=r[j].volume;for(let j=i-38;j<=i-3;j++)b+=r[j].volume;return(a/3)/Math.max(b/36,1e-9)}

const rawSignals=[];const base=ds[0].rows;
for(let bi=288;bi<base.length-110;bi++){
  const t=base[bi].time;if(t%DECISION)continue;const ss=[];
  for(const d of ds){const i=ix(d.rows,t);if(i<288||i+110>=d.rows.length)continue;let ok=true;for(let j=i-288;j<i;j++)if(d.rows[j+1].time!==d.rows[j].time+300){ok=false;break}if(!ok||d.rows[i+1].time!==t+300)continue;const [h2,l2]=bounds(d.rows,i-24,i-1),[h6,l6]=bounds(d.rows,i-72,i-1);ss.push({...d,i,t,close:d.rows[i].close,r15:ret(d.rows,i,3),r30:ret(d.rows,i,6),r1:ret(d.rows,i,12),r2:ret(d.rows,i,24),r4:ret(d.rows,i,48),r6:ret(d.rows,i,72),h2,l2,h6,l6,vol:volBurst(d.rows,i)})}
  if(ss.length<9)continue;const m15=med(ss.map(s=>s.r15)),m30=med(ss.map(s=>s.r30)),m1=med(ss.map(s=>s.r1)),m2=med(ss.map(s=>s.r2)),m4=med(ss.map(s=>s.r4)),sc2=mad(ss.map(s=>s.r2-m2)),breadth=ss.filter(s=>s.r1>0).length/ss.length;
  for(const s of ss){const rel15=s.r15-m15,rel30=s.r30-m30,rel1=s.r1-m1,rel2=s.r2-m2,rel4=s.r4-m4,z2=rel2/sc2,w=Math.max(s.h6-s.l6,s.close*1e-9),loc=(s.close-s.l6)/w;
    let d=Math.sign(z2);if(d&&Math.abs(z2)>=1&&Math.sign(rel30)===d&&Math.sign(rel4)===d&&d*rel30>=.0005)rawSignals.push({family:'XR_MOM',symbol:s.symbol,index:s.i,signalTime:t,baseDir:d,score:Math.abs(z2)+Math.abs(rel30)*100,signalClose:s.close});
    if(Math.abs(s.r6)<=.02&&loc<=.25&&s.r15>=.001)rawSignals.push({family:'RANGE_REV',symbol:s.symbol,index:s.i,signalTime:t,baseDir:1,score:.5-loc,signalClose:s.close});else if(Math.abs(s.r6)<=.02&&loc>=.75&&-s.r15>=.001)rawSignals.push({family:'RANGE_REV',symbol:s.symbol,index:s.i,signalTime:t,baseDir:-1,score:loc-.5,signalClose:s.close});
    const up=s.close>s.h2,down=s.close<s.l2;if(up!==down){d=up?1:-1;if(d*s.r1>=.006&&s.vol>=1)rawSignals.push({family:'BREAKOUT',symbol:s.symbol,index:s.i,signalTime:t,baseDir:d,score:Math.abs(s.r1)+s.vol*.01,signalClose:s.close})}
    d=Math.sign(m1);const bok=d>0?breadth>=.65:breadth<=.35;if(d&&Math.abs(m1)>=.006&&bok&&d*rel1<=-.003&&d*s.r15>=.001)rawSignals.push({family:'MARKET_JOIN',symbol:s.symbol,index:s.i,signalTime:t,baseDir:d,score:Math.abs(m1)+Math.abs(rel1),signalClose:s.close});
  }
}

function simulate(sig,orientation,offset,waitBars,horizon,stopRate,cost){const dset=ds.find(x=>x.symbol===sig.symbol),r=dset.rows,dir=sig.baseDir*(orientation==='FLIP'?-1:1),limit=sig.signalClose*(1-dir*offset);let fill=-1;
  for(let k=1;k<=waitBars&&sig.index+k<r.length;k++){const b=r[sig.index+k];if(k>1&&b.time!==r[sig.index+k-1].time+300)return null;const touched=dir>0?b.low<=limit:b.high>=limit;if(touched){fill=sig.index+k;break}}
  if(fill<0)return{filled:false};const entry=limit,stop=entry*(1-dir*stopRate);let exit=entry,closedAt=r[fill].time*1000;
  // To avoid intrabar path optimism, stop/time evaluation begins on the bar after the maker fill.
  for(let k=1;k<=horizon&&fill+k<r.length;k++){const b=r[fill+k];if(b.time!==r[fill+k-1].time+300){exit=r[fill+k-1].close;closedAt=r[fill+k-1].time*1000;break}const hit=dir>0?b.low<=stop:b.high>=stop;if(hit){exit=stop;closedAt=b.time*1000;break}exit=b.close*(1-dir*cost.exitSlip);closedAt=b.time*1000}
  const gross=dir*(exit-entry)/entry,net=gross-cost.entryFee-cost.exitFee;return{filled:true,openedAt:r[fill].time*1000,closedAt,gross,net,dir,entry,stop};}
function met(family,orientation,offset,waitBars,horizon,stopRate,cost,start,finish){const candidates=rawSignals.filter(s=>s.family===family&&s.signalTime*1000>=start&&s.signalTime*1000<finish).sort((a,b)=>a.signalTime-b.signalTime||b.score-a.score),cool=new Map(),open=new Map(),take=[];let attempted=0,filled=0;
  for(const s of candidates){attempted++;const key=s.symbol,prior=open.get(key);if(prior&&prior.closedAt>s.signalTime*1000)continue;if((cool.get(key)??0)>s.signalTime*1000)continue;const tr=simulate(s,orientation,offset,waitBars,horizon,stopRate,cost);if(!tr?.filled)continue;filled++;take.push({...s,...tr});open.set(key,tr);cool.set(key,tr.closedAt+COOLDOWN_MS)}
  const gain=sum(take.filter(x=>x.net>0).map(x=>x.net)),loss=Math.abs(sum(take.filter(x=>x.net<=0).map(x=>x.net))),gg=sum(take.filter(x=>x.gross>0).map(x=>x.gross)),gl=Math.abs(sum(take.filter(x=>x.gross<=0).map(x=>x.gross))),days=(finish-start)/86400_000;
  return{attempted,filled,trades:take.length,fillRate:attempted?filled/attempted:0,tpd:take.length/days,avgGross:take.length?sum(take.map(x=>x.gross))/take.length:0,avgNet:take.length?sum(take.map(x=>x.net))/take.length:0,grossPF:gl?gg/gl:gg?99:0,netPF:loss?gain/loss:gain?99:0,win:take.length?take.filter(x=>x.net>0).length/take.length:0};}
const families=['XR_MOM','RANGE_REV','BREAKOUT','MARKET_JOIN'],grid=[];
for(const family of families)for(const orientation of ['NORMAL','FLIP'])for(const offset of OFFSETS)for(const waitBars of WAIT_BARS)for(const horizon of HORIZONS)for(const stop of STOPS){const d=met(family,orientation,offset,waitBars,horizon,stop,COST_SCENARIOS.makerBase,from,discEnd),fold=folds.map(([a,b])=>met(family,orientation,offset,waitBars,horizon,stop,COST_SCENARIOS.makerBase,a,b));grid.push({family,orientation,offset,waitBars,horizon,stop,discovery:d,folds:fold,validation:met(family,orientation,offset,waitBars,horizon,stop,COST_SCENARIOS.makerBase,discEnd,valEnd),evaluation:met(family,orientation,offset,waitBars,horizon,stop,COST_SCENARIOS.makerBase,valEnd,end),stressEvaluation:met(family,orientation,offset,waitBars,horizon,stop,COST_SCENARIOS.makerStress,valEnd,end),legacyEvaluation:met(family,orientation,offset,waitBars,horizon,stop,COST_SCENARIOS.legacyConservative,valEnd,end)})}
const eligible=grid.filter(x=>x.discovery.trades>=1000&&x.discovery.tpd>=1&&x.discovery.avgNet>0&&x.discovery.netPF>=1.01&&x.folds.filter(f=>f.avgNet>0).length>=2).sort((a,b)=>b.discovery.tpd-a.discovery.tpd||b.discovery.netPF-a.discovery.netPF);const selected=[];for(const f of families){const rows=eligible.filter(x=>x.family===f);if(rows[0])selected.push(rows[0])}const stable=selected.filter(x=>x.validation.avgNet>0&&x.evaluation.avgNet>0&&x.validation.netPF>=1&&x.evaluation.netPF>=1).sort((a,b)=>b.evaluation.tpd-a.evaluation.tpd);
const allStable=grid.filter(x=>x.discovery.avgNet>0&&x.discovery.netPF>=1&&x.validation.avgNet>0&&x.validation.netPF>=1&&x.evaluation.avgNet>0&&x.evaluation.netPF>=1).sort((a,b)=>b.evaluation.tpd-a.evaluation.tpd);
const report={generatedAt:new Date().toISOString(),datasetSha256:raw.sha256,costScenarios:COST_SCENARIOS,rawSignalCounts:Object.fromEntries(families.map(f=>[f,rawSignals.filter(s=>s.family===f).length])),selected,stable,allStable:allStable.slice(0,50),top:grid.sort((a,b)=>Number(b.evaluation.avgNet>0)-Number(a.evaluation.avgNet>0)||b.evaluation.tpd-a.evaluation.tpd||b.evaluation.netPF-a.evaluation.netPF).slice(0,80)};writeFileSync(OUTPUT,JSON.stringify(report,null,2)+'\n');console.log('MAKER_FIRST_RESULT='+JSON.stringify({rawSignalCounts:report.rawSignalCounts,selected:selected.map(x=>({family:x.family,orientation:x.orientation,offset:x.offset,waitBars:x.waitBars,horizon:x.horizon,stop:x.stop,d:x.discovery,v:x.validation,e:x.evaluation,stress:x.stressEvaluation,legacy:x.legacyEvaluation})),stable:stable.map(x=>({family:x.family,orientation:x.orientation,offset:x.offset,waitBars:x.waitBars,horizon:x.horizon,stop:x.stop,d:x.discovery,v:x.validation,e:x.evaluation,stress:x.stressEvaluation})),allStable:report.allStable.slice(0,15).map(x=>({family:x.family,orientation:x.orientation,offset:x.offset,waitBars:x.waitBars,horizon:x.horizon,stop:x.stop,d:x.discovery,v:x.validation,e:x.evaluation,stress:x.stressEvaluation}))}));