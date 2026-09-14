import { readFileSync, writeFileSync } from "node:fs";

const PRICE_INPUT=process.env.PRICE_DATASET??"/tmp/gate-price-5m-202604-202608.json";
const FLOW_INPUT=process.env.FLOW_DATASET??"/tmp/gate-flow-5m-202604-202608.json";
const OUTPUT=process.env.FLOW_SURPRISE_OUTPUT??"/tmp/flow-surprise-events.json";
const FRICTION=.0014,STRESS=.0022,DELTA=STRESS-FRICTION,DAY=86400;
const raw=JSON.parse(readFileSync(PRICE_INPUT,"utf8")),flow=JSON.parse(readFileSync(FLOW_INPUT,"utf8"));
if(raw.interval!=="5m"||flow.interval!=="5m")throw new Error("Expected 5m price and flow inputs");
const symbols=raw.symbols.filter(s=>flow.symbols.includes(s));if(symbols.length<15)throw new Error(`Need >=15 common symbols, got ${symbols.length}`);
const FROM=Math.max(raw.from,flow.from),TRAIN_END=Date.UTC(2026,6,1)/1000,VALID_END=Date.UTC(2026,7,1)/1000,TO=Math.min(raw.now??raw.to,flow.to);
const days=(a,b)=>(b-a)/DAY,month=t=>new Date(t*1000).toISOString().slice(0,7).replace("-","");
const median=a=>{const b=[...a].sort((x,y)=>x-y);const n=b.length;return n?b[Math.floor(n/2)]:0;};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const priceBy=new Map(raw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,new Map(d.rows.map(r=>[r.time,r]))]));
const flowBySymbol=new Map(flow.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,d]));

class Rolling {
  constructor(limit=48){this.limit=limit;this.q=[];this.sum=0;this.sq=0;}
  z(x,min=12){if(this.q.length<min)return 0;const mean=this.sum/this.q.length;const variance=Math.max(0,this.sq/this.q.length-mean*mean);const sd=Math.sqrt(variance);return sd>1e-9?clamp((x-mean)/sd,-8,8):0;}
  push(x){if(!Number.isFinite(x))return;this.q.push(x);this.sum+=x;this.sq+=x*x;if(this.q.length>this.limit){const y=this.q.shift();this.sum-=y;this.sq-=y*y;}}
}
function fundingGetter(rows){const a=rows??[];let idx=0,last=0;return t=>{while(idx<a.length&&a[idx][0]<=t){last=Number(a[idx][1]??0);idx++;}return last;};}
const byTime=new Map(),allObs=[];
for(const symbol of symbols){
  const ds=flowBySymbol.get(symbol),pmap=priceBy.get(symbol),fundingAt=fundingGetter(ds.funding);
  const rows=ds.rows,tkRoll=new Rolling(),tkDeltaRoll=new Rolling(),oiRoll=new Rolling(),liqRoll=new Rolling(),priceRoll=new Rolling(),lsrRoll=new Rolling();
  let prevTaker=0,prevLsr=1;
  for(const f of rows){const t=f[0];if(t<FROM||t>=TO)continue;const p=pmap.get(t),p1=pmap.get(t-300),p3=pmap.get(t-900);if(!p||!p1||!p3)continue;
    const oi=Number(f[2]??0),pf=rows; // alias kept for compactness
    const prior=flowBySymbol.get(symbol)._rowMap??null;
    void pf;void prior;
  }
}
// Attach O(1) row maps after the warm declaration above.
for(const symbol of symbols){const ds=flowBySymbol.get(symbol);ds._rowMap=new Map(ds.rows.map(r=>[r[0],r]));}
byTime.clear();allObs.length=0;
for(const symbol of symbols){
  const ds=flowBySymbol.get(symbol),pmap=priceBy.get(symbol),fmap=ds._rowMap,fundingAt=fundingGetter(ds.funding);
  const tkRoll=new Rolling(),tkDeltaRoll=new Rolling(),oiRoll=new Rolling(),liqRoll=new Rolling(),priceRoll=new Rolling(),lsrRoll=new Rolling();
  let prevTaker=0,prevLsr=1;
  for(const f of ds.rows){const t=f[0];if(t<FROM||t>=TO)continue;const p=pmap.get(t),p1=pmap.get(t-300),p3=pmap.get(t-900),f1=fmap.get(t-300);if(!p||!p1||!p3||!f1)continue;
    const long=Number(f[3]??0),short=Number(f[4]??0),den=long+short,taker=den>0?(long-short)/den:0;
    const oi0=Number(f[2]??0),oi1=Number(f1[2]??0),oi5=oi0>0&&oi1>0?oi0/oi1-1:0;
    const r5=p.close/p1.close-1,r15=p.close/p3.close-1;
    const longLiq=Number(f[5]??0),shortLiq=Number(f[6]??0),liqTotal=longLiq+shortLiq,liqSigned=liqTotal>0?(shortLiq-longLiq)/liqTotal:0;
    const liqLog=Math.log1p(liqTotal),lsr=Math.max(Number(f[7]??1),1e-6),lsrChange=Math.log(lsr/Math.max(prevLsr,1e-6));
    const takerDelta=taker-prevTaker;
    const row={time:t,symbol,price:p.close,r5,r15,taker,oi5,liqTotal,liqSigned,funding:fundingAt(t),lsr,
      takerZ:tkRoll.z(taker),takerDeltaZ:tkDeltaRoll.z(takerDelta),oiZ:oiRoll.z(oi5),liqZ:liqRoll.z(liqLog),priceZ:priceRoll.z(r5),lsrChangeZ:lsrRoll.z(lsrChange)};
    tkRoll.push(taker);tkDeltaRoll.push(takerDelta);oiRoll.push(oi5);liqRoll.push(liqLog);priceRoll.push(r5);lsrRoll.push(lsrChange);prevTaker=taker;prevLsr=lsr;
    if(t<FROM+4*3600)continue;
    row.absorption= -Math.sign(row.takerZ||taker)*(Math.sign(row.takerZ||taker)*r5)/Math.max(Math.abs(taker),.08);
    row.newMoneyScore=Math.max(row.oiZ,0)*Math.abs(taker);
    row.flushScore=Math.max(-row.oiZ,0)*Math.abs(row.priceZ);
    row.liqImpulse=row.liqZ*Math.abs(row.liqSigned);
    allObs.push(row);if(!byTime.has(t))byTime.set(t,[]);byTime.get(t).push(row);
  }
}
for(const [t,rows] of byTime){if(rows.length<15)continue;const mt=median(rows.map(r=>r.takerZ)),mo=median(rows.map(r=>r.oiZ)),mp=median(rows.map(r=>r.priceZ));for(const r of rows){r.resTakerZ=r.takerZ-mt;r.resOiZ=r.oiZ-mo;r.resPriceZ=r.priceZ-mp;r.marketTakerZ=mt;r.marketOiZ=mo;r.marketPriceZ=mp;}}
const obs=allObs.filter(r=>byTime.get(r.time)?.length>=15);

const configs=[];const P=(...sets)=>sets.reduce((a,s)=>a.flatMap(x=>s.map(v=>[...x,v])),[[]]);const add=(family,rows)=>rows.forEach((r,i)=>configs.push({family,id:`${family}-${i}`,...r}));
add("TAKER_SHOCK_CONT",P([2.5,3.5],[0,.0015],[3,6,12]).map(([z,minMove,hold])=>({z,minMove,hold})));
add("TAKER_ABSORPTION_FADE",P([2.5,3.5],[.0005,.0015],[3,6,12]).map(([z,maxAlignedMove,hold])=>({z,maxAlignedMove,hold})));
add("FLOW_ACCEL_CONT",P([2.5,3.5],[.2,.4],[3,6,12]).map(([z,minTaker,hold])=>({z,minTaker,hold})));
add("NEW_MONEY_CONT",P([2,3],[.25,.45],[3,6,12]).map(([oiZ,minTaker,hold])=>({oiZ,minTaker,hold})));
add("OI_FLUSH_FADE",P([2,3],[2,3],[3,6,12]).map(([oiZ,priceZ,hold])=>({oiZ,priceZ,hold})));
add("LIQ_CASCADE_CONT",P([2,3,4],[.35,.65],[3,6]).map(([liqZ,minSigned,hold])=>({liqZ,minSigned,hold})));
add("LIQ_EXHAUST_FADE",P([2,3,4],[.004,.008],[3,6]).map(([liqZ,minMove,hold])=>({liqZ,minMove,hold})));
add("RESIDUAL_FLOW_CONT",P([2.5,3.5],[0,.0015],[3,6,12]).map(([z,minMove,hold])=>({z,minMove,hold})));
add("RESIDUAL_FLOW_FADE",P([2.5,3.5],[.0005,.0015],[3,6,12]).map(([z,maxAlignedMove,hold])=>({z,maxAlignedMove,hold})));
add("MARKET_FLOW_LAG",P([.8,1.2],[1.5,2.5],[3,6,12]).map(([marketZ,lagZ,hold])=>({marketZ,lagZ,hold})));

function signal(c,r){
  if(c.family==="TAKER_SHOCK_CONT"){if(Math.abs(r.takerZ)<c.z)return 0;const d=Math.sign(r.takerZ);if(d*r.r5<c.minMove||d*r.r5>.012)return 0;return d;}
  if(c.family==="TAKER_ABSORPTION_FADE"){if(Math.abs(r.takerZ)<c.z)return 0;const d=Math.sign(r.takerZ);if(d*r.r5>c.maxAlignedMove||Math.abs(r.r5)>.008)return 0;return-d;}
  if(c.family==="FLOW_ACCEL_CONT"){if(Math.abs(r.takerDeltaZ)<c.z||Math.abs(r.taker)<c.minTaker)return 0;return Math.sign(r.takerDeltaZ);}
  if(c.family==="NEW_MONEY_CONT"){if(r.oiZ<c.oiZ||Math.abs(r.taker)<c.minTaker||Math.sign(r.taker)*r.r5<-.0015||Math.abs(r.r5)>.012)return 0;return Math.sign(r.taker);}
  if(c.family==="OI_FLUSH_FADE"){if(r.oiZ>-c.oiZ||Math.abs(r.priceZ)<c.priceZ||Math.sign(r.taker)!==Math.sign(r.r5))return 0;return-Math.sign(r.r5);}
  if(c.family==="LIQ_CASCADE_CONT"){if(r.liqZ<c.liqZ||Math.abs(r.liqSigned)<c.minSigned)return 0;return Math.sign(r.liqSigned);}
  if(c.family==="LIQ_EXHAUST_FADE"){if(r.liqZ<c.liqZ||Math.abs(r.r5)<c.minMove||Math.sign(r.liqSigned)!==Math.sign(r.r5))return 0;return-Math.sign(r.liqSigned);}
  if(c.family==="RESIDUAL_FLOW_CONT"){if(Math.abs(r.resTakerZ)<c.z)return 0;const d=Math.sign(r.resTakerZ);if(d*r.r5<c.minMove||d*r.r5>.012)return 0;return d;}
  if(c.family==="RESIDUAL_FLOW_FADE"){if(Math.abs(r.resTakerZ)<c.z)return 0;const d=Math.sign(r.resTakerZ);if(d*r.r5>c.maxAlignedMove||Math.abs(r.r5)>.008)return 0;return-d;}
  if(c.family==="MARKET_FLOW_LAG"){if(Math.abs(r.marketTakerZ)<c.marketZ)return 0;const d=Math.sign(r.marketTakerZ);if(d*r.resPriceZ>-c.lagZ)return 0;return d;}
  return 0;
}
function makeTrades(c){const out=[],busy=new Map();for(const r of obs){if(r.time<(busy.get(r.symbol)??0))continue;const d=signal(c,r);if(!d)continue;const exit=priceBy.get(r.symbol)?.get(r.time+c.hold*300);if(!exit)continue;const gross=d*(exit.close/r.price-1);out.push({time:r.time,symbol:r.symbol,dir:d,gross,ret:gross-FRICTION,hold:c.hold,family:c.family,configId:c.id});busy.set(r.symbol,r.time+c.hold*300);}return out;}
function metrics(t,a,b,delta=0){let n=0,g=0,l=0,net=0,gross=0,w=0,costCover=0;const m=new Map();for(const x of t){if(x.time<a||x.time>=b)continue;n++;const r=x.ret-delta;net+=r;gross+=x.gross;if(r>0){g+=r;w++;}else l-=r;if(x.gross>FRICTION+delta)costCover++;m.set(month(x.time),(m.get(month(x.time))??0)+r);}return{trades:n,tradesPerDay:n/Math.max(days(a,b),1),net,pf:l?g/l:g>0?99:0,win:n?w/n:0,mean:n?net/n:0,grossMean:n?gross/n:0,costCoverRate:n?costCover/n:0,positiveMonths:[...m.values()].filter(v=>v>0).length,activeMonths:m.size,monthly:Object.fromEntries(m)};}
const audit=[];for(const c of configs){const trades=makeTrades(c),train=metrics(trades,FROM,TRAIN_END),valid=metrics(trades,TRAIN_END,VALID_END),holdout=metrics(trades,VALID_END,TO),stressTrain=metrics(trades,FROM,TRAIN_END,DELTA);const stable=train.tradesPerDay>=.5&&train.net>0&&train.pf>=1.08&&train.positiveMonths>=2&&stressTrain.net>0&&stressTrain.pf>=1.0&&valid.net>0&&valid.pf>=1.03;const score=stable?Math.log1p(train.trades)*Math.log(train.pf)*Math.max(train.mean,0)*1000:0;audit.push({config:c,trades,train,valid,holdout,stressTrain,stable,score});}
audit.sort((a,b)=>b.score-a.score||b.valid.pf-a.valid.pf||b.train.pf-a.train.pf);
const selected=[],used=new Set();for(const r of audit){if(!r.stable||used.has(r.config.family))continue;selected.push(r);used.add(r.config.family);if(selected.length>=8)break;}
function portfolio(delta=0){const all=[];for(const r of selected)for(const t of r.trades)all.push({...t,ret:t.ret-delta,source:r.config.id});all.sort((a,b)=>a.time-b.time);const active=[],accepted=[];let eq=1000,peak=1000,dd=0;for(const t of all){for(let i=active.length-1;i>=0;i--)if(active[i].until<=t.time)active.splice(i,1);if(active.some(x=>x.symbol===t.symbol)||active.length>=10)continue;const pnl=eq*.10*t.ret;eq=Math.max(1,eq+pnl);peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak);accepted.push({...t,pnl});active.push({symbol:t.symbol,until:t.time+t.hold*300});}const pm=(a,b)=>{let n=0,g=0,l=0,net=0,w=0;for(const t of accepted){if(t.time<a||t.time>=b)continue;n++;net+=t.pnl;if(t.pnl>0){g+=t.pnl;w++;}else l-=t.pnl;}return{trades:n,tradesPerDay:n/Math.max(days(a,b),1),netPnl:net,pf:l?g/l:g>0?99:0,win:n?w/n:0};};return{endEquity:eq,netPnl:eq-1000,maxDrawdown:dd,train:pm(FROM,TRAIN_END),valid:pm(TRAIN_END,VALID_END),holdout:pm(VALID_END,TO),full:pm(FROM,TO),accepted:accepted.length};}
const base=portfolio(),stress=portfolio(DELTA);const gates={stableFamilies:selected.length>=3,frequency:base.holdout.tradesPerDay>=15,trainPositive:base.train.netPnl>0&&base.train.pf>=1.08,validationPositive:base.valid.netPnl>0&&base.valid.pf>=1.03,holdoutPositive:base.holdout.netPnl>0&&base.holdout.pf>=1.05,drawdown:base.maxDrawdown<=.12,stressHoldout:stress.holdout.netPnl>0&&stress.holdout.pf>=1};
const report={generatedAt:new Date().toISOString(),priceSha256:raw.sha256,flowSha256:flow.sha256,symbols,from:FROM,trainEnd:TRAIN_END,validationEnd:VALID_END,to:TO,friction:FRICTION,stressFriction:STRESS,observations:obs.length,candidateCount:configs.length,stableCount:audit.filter(r=>r.stable).length,selected:selected.map(r=>({config:r.config,train:r.train,valid:r.valid,holdout:r.holdout,stressTrain:r.stressTrain})),top:audit.slice(0,40).map(r=>({config:r.config,stable:r.stable,train:r.train,valid:r.valid,holdout:r.holdout,stressTrain:r.stressTrain})),base,stress,gates,targetMet:Object.values(gates).every(Boolean)};writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");console.log("FLOW_SURPRISE_RESULT="+JSON.stringify({targetMet:report.targetMet,stable:report.stableCount,candidates:configs.length,selected:report.selected,base,stress,gates,top:report.top.slice(0,15)},null,2));
