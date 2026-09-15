import { readFileSync, writeFileSync } from 'node:fs';

const DATASET = process.env.RESEARCH_SIGNAL_DATASET ?? '/tmp/gate-history-anomaly-44m-1h.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/anomaly-exhaustion-trajectory-44m.json';
const raw = JSON.parse(readFileSync(DATASET, 'utf8'));
if (raw.interval !== '1h' || raw.months.length !== 44 || raw.symbols.length !== 11) throw new Error('Requires frozen 44m / 11-symbol 1h core dataset');

const sum = (xs) => xs.reduce((a,b)=>a+b,0);
const mean = (xs) => xs.length ? sum(xs)/xs.length : 0;
const median = (xs) => { if (!xs.length) return 0; const ys=[...xs].sort((a,b)=>a-b); const m=Math.floor(ys.length/2); return ys.length%2?ys[m]:(ys[m-1]+ys[m])/2; };
const monthStart = (m) => Date.UTC(Number(m.slice(0,4)), Number(m.slice(4,6))-1, 1);
const fromMs = raw.from*1000, toMs = raw.now*1000;
const discoveryEnd = monthStart(raw.months[30]);
const validationEnd = monthStart(raw.months[38]);
const ret = (rows,i,h)=>rows[i].close/rows[i-h].close-1;
function gaps(rows){const p=[0];for(let i=1;i<rows.length;i++)p.push(p.at(-1)+Number(rows[i].time!==rows[i-1].time+3600));return p;}

const byTime = new Map();
for (const {symbol,rows} of raw.datasets) {
  const gp=gaps(rows);
  for(let i=168;i<rows.length-9;i++){
    if(gp[i]!==gp[i-168] || rows[i+1].time!==rows[i].time+3600) continue;
    const x={symbol,rows,index:i,current:rows[i],r1:ret(rows,i,1),r4:ret(rows,i,4),r12:ret(rows,i,12),r24:ret(rows,i,24),prev1:rows[i-1].close/rows[i-2].close-1,prev4:rows[i-1].close/rows[i-5].close-1};
    const a=byTime.get(rows[i].time)??[];a.push(x);byTime.set(rows[i].time,a);
  }
}

const contexts=[];
for(const [time,rows] of byTime){
  if(rows.length<9) continue;
  const c={m1:median(rows.map(x=>x.r1)),m4:median(rows.map(x=>x.r4)),pm1:median(rows.map(x=>x.prev1)),pm4:median(rows.map(x=>x.prev4))};
  const es=rows.map(x=>({...x,rel1:x.r1-c.m1,rel4:x.r4-c.m4,prevRel1:x.prev1-c.pm1,prevRel4:x.prev4-c.pm4}));
  const scale=Math.max(0.001,median(es.map(x=>Math.abs(x.rel4))));
  contexts.push({time,rows:es,c,scale});
}
contexts.sort((a,b)=>a.time-b.time);

const events=[];
for(const ctx of contexts){
  for(const direction of [1,-1]){
    const ranked=[...ctx.rows].sort((a,b)=>direction*(b.rel4-a.rel4));
    const f=ranked[0], second=ranked[1];
    const magnitude=direction*f.rel4;
    if(magnitude<0.012) continue;
    const runnerGap=magnitude-direction*second.rel4;
    const robustScore=magnitude/ctx.scale;
    if(robustScore<1.8 || runnerGap<0.002) continue;
    const prevRanked=[...ctx.rows].sort((a,b)=>direction*(b.prevRel4-a.prevRel4));
    const prevTop=prevRanked[0], prevSecond=prevRanked[1];
    const prevGapSame=direction*f.prevRel4-Math.max(...ctx.rows.filter(x=>x.symbol!==f.symbol).map(x=>direction*x.prevRel4));
    const e={
      time:ctx.time,ctx,f,direction,sideClass:direction>0?'UP_LEADER':'DOWN_LAGGARD',magnitude,runnerGap,robustScore,
      relPressure:direction*f.rel1,prevRelPressure:direction*f.prevRel1,absolutePressure:direction*f.r1,marketPressure:direction*ctx.c.m1,
      anomalyDelta:direction*(f.rel4-f.prevRel4),prevGapSame,gapDelta:runnerGap-prevGapSame,
      wasPrevLeader:prevTop.symbol===f.symbol,
    };
    events.push(e);
  }
}

// Predeclared relationship tags. These deliberately separate “who is unusual” from “what to do”.
const FILTERS={
  SPECIAL_BASE:e=>true,
  EXPANDING:e=>e.relPressure>=0.0015 && e.anomalyDelta>=0.001,
  RELATIVE_BREAK:e=>e.relPressure<=-0.001,
  FIRST_BREAK:e=>e.relPressure<=-0.001 && e.prevRelPressure>0,
  PERSISTENT_BREAK:e=>e.relPressure<=-0.001 && e.prevRelPressure<=-0.0005,
  BREAK_MARKET_SAME:e=>e.relPressure<=-0.001 && e.marketPressure>=0.0005,
  BREAK_SHRINK:e=>e.relPressure<=-0.001 && e.anomalyDelta<=-0.001 && e.gapDelta<=0,
  FIRST_BREAK_SHRINK_MARKET_SAME:e=>e.relPressure<=-0.001 && e.prevRelPressure>0 && e.marketPressure>=0.0005 && e.anomalyDelta<=-0.001 && e.gapDelta<=0,
  PERSIST_BREAK_SHRINK_MARKET_SAME:e=>e.relPressure<=-0.001 && e.prevRelPressure<=-0.0005 && e.marketPressure>=0.0005 && e.anomalyDelta<=-0.001 && e.gapDelta<=0,
  ABS_TURN_MARKET_SAME:e=>e.absolutePressure<=-0.001 && e.marketPressure>=0.0005,
  ABS_TURN_SHRINK_MARKET_SAME:e=>e.absolutePressure<=-0.001 && e.marketPressure>=0.0005 && e.anomalyDelta<=-0.001 && e.gapDelta<=0,
  MARKET_TURN:e=>e.marketPressure<=-0.0005,
};

function future(e,h){
  const {f,ctx,direction}=e;
  if(f.index+h>=f.rows.length || f.rows[f.index+h].time!==f.current.time+h*3600) return null;
  const sr=f.rows[f.index+h].close/f.current.close-1;
  const prs=[];
  for(const p of ctx.rows){if(p.index+h>=p.rows.length || p.rows[p.index+h].time!==p.current.time+h*3600) continue;prs.push(p.rows[p.index+h].close/p.current.close-1);}
  if(prs.length<9) return null;
  const mr=median(prs), rel=sr-mr;
  return {symbolReturn:sr,marketReturn:mr,continuationRel:direction*rel,reversionRel:-direction*rel,continuationAbs:direction*sr,reversionAbs:-direction*sr};
}
function monthKey(ms){const d=new Date(ms);return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
function summarize(xs,start,end){
  const out={events:xs.length,eventsPerDay:xs.length/Math.max(1,(end-start)/86400000),up:xs.filter(e=>e.direction>0).length,down:xs.filter(e=>e.direction<0).length};
  for(const h of [1,2,4,8]){
    const snaps=xs.map(e=>({e,x:future(e,h)})).filter(z=>z.x);
    const r=snaps.map(z=>z.x.reversionRel),a=snaps.map(z=>z.x.reversionAbs);
    const months=new Map();
    for(const z of snaps){const k=monthKey(z.e.time*1000);const arr=months.get(k)??[];arr.push(z.x.reversionRel);months.set(k,arr);}
    const monthMeans=[...months.values()].map(mean);
    out[`${h}h`]={samples:snaps.length,reversionRelMean:mean(r),reversionRelWinRate:r.length?r.filter(v=>v>0).length/r.length:0,reversionAbsMean:mean(a),reversionAbsWinRate:a.length?a.filter(v=>v>0).length/a.length:0,activeMonths:monthMeans.length,positiveRelativeMonths:monthMeans.filter(v=>v>0).length};
  }
  return out;
}
function study(start,end){
  const base=events.filter(e=>e.time*1000>=start&&e.time*1000<end);
  const out={};
  for(const [name,fn] of Object.entries(FILTERS)){
    const group=base.filter(fn);
    out[name]={ALL:summarize(group,start,end),UP_LEADER:summarize(group.filter(e=>e.direction>0),start,end),DOWN_LAGGARD:summarize(group.filter(e=>e.direction<0),start,end)};
  }
  return out;
}

// A condition is only structurally interesting if discovery supports it before held-out segments are consulted.
function discoveryQualification(s){
  const hs=['1h','2h','4h','8h'].map(h=>s[h]);
  return s.events>=200 && hs.filter(x=>x.reversionRelMean>0).length>=3 && s['4h'].reversionRelMean>=0.0005 && s['4h'].positiveRelativeMonths>=Math.ceil(s['4h'].activeMonths*0.55);
}
const discovery=study(fromMs,discoveryEnd),validation=study(discoveryEnd,validationEnd),evaluation=study(validationEnd,toMs);
const candidates=[];
for(const name of Object.keys(FILTERS)) for(const side of ['ALL','UP_LEADER','DOWN_LAGGARD']) if(discoveryQualification(discovery[name][side])) candidates.push({name,side});
const heldOutChecks=candidates.map(c=>({
  ...c,
  discovery4h:discovery[c.name][c.side]['4h'],validation4h:validation[c.name][c.side]['4h'],evaluation4h:evaluation[c.name][c.side]['4h'],
  validationSameSign:validation[c.name][c.side]['4h'].reversionRelMean>0,
  evaluationSameSign:evaluation[c.name][c.side]['4h'].reversionRelMean>0,
}));
const result={research:'anomaly-exhaustion-trajectory',canonical:{signalSha256:raw.sha256,months:raw.months.length,symbols:raw.symbols},eventDefinition:{special:'most positive and most negative relative-4h member each hour; |relative4|>=1.2%, robustScore>=1.8, gap to runner-up>=0.2%',note:'selection finds unusual coins only; tags describe their relationship trajectory and do not assume trade direction'},thresholds:{relativeBreak:-0.001,marketSame:0.0005,anomalyShrink:-0.001,absoluteTurn:-0.001},events:events.length,discoveryCandidates:candidates,heldOutChecks,study:{discovery,validation,evaluation},protocolNote:'UP_LEADER and DOWN_LAGGARD are separated a priori because the user hypothesis specifically concerns asymmetric exhaustion of the strongest riser; no validation/evaluation outcome was used to define the tags.'};
writeFileSync(OUTPUT,JSON.stringify(result,null,2));
console.log(JSON.stringify({events:result.events,discoveryCandidates,heldOutChecks,focus:{discovery:{FIRST_BREAK_SHRINK_MARKET_SAME:discovery.FIRST_BREAK_SHRINK_MARKET_SAME,ABS_TURN_SHRINK_MARKET_SAME:discovery.ABS_TURN_SHRINK_MARKET_SAME},validation:{FIRST_BREAK_SHRINK_MARKET_SAME:validation.FIRST_BREAK_SHRINK_MARKET_SAME,ABS_TURN_SHRINK_MARKET_SAME:validation.ABS_TURN_SHRINK_MARKET_SAME},evaluation:{FIRST_BREAK_SHRINK_MARKET_SAME:evaluation.FIRST_BREAK_SHRINK_MARKET_SAME,ABS_TURN_SHRINK_MARKET_SAME:evaluation.ABS_TURN_SHRINK_MARKET_SAME}}},null,2));
