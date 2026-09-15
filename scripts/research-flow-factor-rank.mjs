import { readFileSync, writeFileSync } from "node:fs";

const PRICE_INPUT=process.env.PRICE_DATASET??"/tmp/gate-price-5m-202604-202608.json";
const FLOW_INPUT=process.env.FLOW_DATASET??"/tmp/gate-flow-5m-202604-202608.json";
const OUTPUT=process.env.FLOW_FACTOR_OUTPUT??"/tmp/flow-factor-rank.json";
const FRICTION=.0014,STRESS=.0022,DELTA=STRESS-FRICTION,DAY=86400;
const priceRaw=JSON.parse(readFileSync(PRICE_INPUT,"utf8")),flowRaw=JSON.parse(readFileSync(FLOW_INPUT,"utf8"));
if(priceRaw.interval!=="5m"||flowRaw.interval!=="5m")throw new Error("Requires 5m inputs");
const symbols=priceRaw.symbols.filter(s=>flowRaw.symbols.includes(s));if(symbols.length<15)throw new Error(`Only ${symbols.length} common symbols`);
const TRAIN_END=Date.UTC(2026,6,1)/1000;
const VALID_END=Date.UTC(2026,7,1)/1000;
const TO=Math.min(priceRaw.now??priceRaw.to,flowRaw.to),FROM=Math.max(priceRaw.from,flowRaw.from);
const monthKey=t=>new Date(t*1000).toISOString().slice(0,7).replace("-","");
const days=(a,b)=>(b-a)/DAY,median=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]??0;};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const priceBy=new Map(priceRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,new Map(d.rows.map(r=>[r.time,r]))]));
const flowBy=new Map(flowRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,new Map(d.rows.map(r=>[r[0],r]))]));
const fundingBy=new Map(flowRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,d.funding??[]]));
const flowMeta=new Map(flowRaw.datasets.filter(d=>symbols.includes(d.symbol)).map(d=>[d.symbol,d]));
const flowRow=(s,t)=>flowBy.get(s)?.get(t)??null,priceRow=(s,t)=>priceBy.get(s)?.get(t)??null;
function fundingAt(symbol,time){const a=fundingBy.get(symbol)??[];let lo=0,hi=a.length-1,best=-1;while(lo<=hi){const m=(lo+hi)>>1;if(a[m][0]<=time){best=m;lo=m+1;}else hi=m-1;}return best>=0?Number(a[best][1]):0;}
function rankUnit(rows,key){const sorted=[...rows].sort((a,b)=>a[key]-b[key]);const n=Math.max(1,sorted.length-1);const out=new Map();sorted.forEach((r,i)=>out.set(r.symbol,i/n*2-1));return out;}
function zRank(rows,key){const r=rankUnit(rows,key);return new Map([...r].map(([s,v])=>[s,v]));}

const baseTimes=[...new Set((flowMeta.get(symbols[0])?.rows??[]).map(r=>r[0]).filter(t=>t>=FROM&&t<TO))].sort((a,b)=>a-b);
const snapshots=[];
for(let ti=12;ti<baseTimes.length-24;ti+=3){
  const time=baseTimes[ti],rows=[];
  for(const symbol of symbols){const f0=flowRow(symbol,time),p0=priceRow(symbol,time);if(!f0||!p0)continue;
    const get=bars=>({f:flowRow(symbol,time-bars*300),p:priceRow(symbol,time-bars*300)}),b1=get(1),b3=get(3),b6=get(6),b12=get(12);if(!b1.f||!b1.p||!b3.f||!b3.p||!b6.f||!b6.p||!b12.f||!b12.p)continue;
    const ret=p=>p0.close/p.close-1,oi=f=>f0[2]>0&&f[2]>0?f0[2]/f[2]-1:0;
    const taker=f=>{const l=Number(f[3]??0),s=Number(f[4]??0),d=l+s;return d>0?(l-s)/d:0;};
    const liq=f=>{const l=Number(f[5]??0),s=Number(f[6]??0),d=l+s;return{signed:d>0?(s-l)/d:0,rate:d/Math.max(Number(f[1]??0),1)}};
    const tk0=taker(f0),tk1=taker(b1.f),tk3=taker(b3.f),lq=liq(f0),r15=ret(b3.p),r30=ret(b6.p),oi15=oi(b3.f),oi30=oi(b6.f);
    const lsr=Math.max(Number(f0[7]??0),1e-6),top=Math.max(Number(f0[9]??0),1e-6),fund=fundingAt(symbol,time);
    rows.push({symbol,time,price:p0.close,r5:ret(b1.p),r15,r30,r60:ret(b12.p),oi5:oi(b1.f),oi15,oi30,
      taker:tk0,takerPrev:tk1,taker15:(tk0+tk1+tk3)/3,liqSigned:lq.signed,liqRate:lq.rate,liqPressure:lq.signed*Math.min(1,Math.log1p(lq.rate*1e6)/4),
      lsrLog:Math.log(lsr),topLsrLog:Math.log(top),funding:fund,
      newMoney:tk0*Math.max(oi15,0),squeezeFlow:tk0*Math.max(-oi15,0),oiPrice:Math.sign(r15)*oi15,
      absorption:tk0-clamp(r15/.006,-1,1),flowChange:tk0-tk1});
  }
  if(rows.length<15)continue;
  const fields=["taker","taker15","oi15","oi30","newMoney","squeezeFlow","oiPrice","liqSigned","liqRate","liqPressure","lsrLog","topLsrLog","funding","absorption","flowChange"];
  const ranks=Object.fromEntries(fields.map(k=>[k,zRank(rows,k)]));
  const medT=median(rows.map(r=>r.taker)),medOi=median(rows.map(r=>r.oi15)),medP=median(rows.map(r=>r.r15));
  for(const row of rows){row.resTaker=row.taker-medT;row.resOi=row.oi15-medOi;row.resPrice=row.r15-medP;
    row.flowComposite=(ranks.taker.get(row.symbol)??0)*.35+(ranks.taker15.get(row.symbol)??0)*.15+(ranks.oiPrice.get(row.symbol)??0)*.20+(ranks.newMoney.get(row.symbol)??0)*.15+(ranks.liqSigned.get(row.symbol)??0)*.15;
  }
  const rrT=zRank(rows,"resTaker"),rrO=zRank(rows,"resOi"),rrP=zRank(rows,"resPrice");
  for(const row of rows){
    row.resFlow=(rrT.get(row.symbol)??0)*.5+(rrO.get(row.symbol)??0)*.25+(rrP.get(row.symbol)??0)*.25;
    row.absorbFade=-(ranks.absorption.get(row.symbol)??0)*.55-(rrP.get(row.symbol)??0)*.25-(ranks.funding.get(row.symbol)??0)*.20;
    row.crowding=(ranks.lsrLog.get(row.symbol)??0)*.6+(ranks.topLsrLog.get(row.symbol)??0)*.4;
  }
  snapshots.push({time,rows});
}

const factors=["taker","taker15","oi15","oi30","newMoney","squeezeFlow","oiPrice","liqSigned","liqPressure","lsrLog","topLsrLog","crowding","funding","absorption","flowChange","resTaker","resOi","resPrice","flowComposite","resFlow","absorbFade"];
const candidates=[];for(const factor of factors)for(const topN of [1,2,3])for(const hold of [3,6,12])candidates.push({factor,topN,hold,id:`${factor}-n${topN}-h${hold}`});

function candidateTrades(c,orientation=1){const trades=[],busy=new Map();for(const snap of snapshots){const ranked=[...snap.rows].sort((a,b)=>b[c.factor]-a[c.factor]);const picks=[...ranked.slice(0,c.topN).map(x=>[x,1]),...ranked.slice(-c.topN).map(x=>[x,-1])];for(const [row,side] of picks){if(row.time<(busy.get(row.symbol)??0))continue;const exit=priceRow(row.symbol,row.time+c.hold*300);if(!exit)continue;const d=side*orientation;const ret=d*(exit.close/row.price-1)-FRICTION;trades.push({time:row.time,symbol:row.symbol,ret,dir:d,factor:c.factor,hold:c.hold});busy.set(row.symbol,row.time+c.hold*300);}}return trades;}
function metrics(t,a,b,delta=0){let n=0,g=0,l=0,net=0,w=0;const m=new Map();for(const x of t){if(x.time<a||x.time>=b)continue;n++;const r=x.ret-delta;net+=r;m.set(monthKey(x.time),(m.get(monthKey(x.time))??0)+r);if(r>0){g+=r;w++;}else l-=r;}return{trades:n,tradesPerDay:n/Math.max(days(a,b),1),net,pf:l?g/l:g>0?99:0,win:n?w/n:0,mean:n?net/n:0,positiveMonths:[...m.values()].filter(v=>v>0).length,monthly:Object.fromEntries(m)};}
const audit=[];
for(const c of candidates){let best=null;for(const orientation of [1,-1]){const trades=candidateTrades(c,orientation),train=metrics(trades,FROM,TRAIN_END),valid=metrics(trades,TRAIN_END,VALID_END),holdout=metrics(trades,VALID_END,TO),stressTrain=metrics(trades,FROM,TRAIN_END,DELTA);const score=train.net>0&&train.pf>1?Math.log1p(train.trades)*Math.log(train.pf)*Math.max(train.mean,0):0;const row={config:{...c,orientation},trades,train,valid,holdout,stressTrain,score};if(!best||row.score>best.score)best=row;}audit.push(best);}
const qualified=audit.filter(r=>r.train.tradesPerDay>=8&&r.train.pf>=1.03&&r.train.net>0&&r.train.positiveMonths>=2&&r.stressTrain.pf>=.98&&r.valid.net>0&&r.valid.pf>=1.01).sort((a,b)=>b.score-a.score);
const selected=[],used=new Set();for(const row of qualified){if(used.has(row.config.factor))continue;selected.push(row);used.add(row.config.factor);if(selected.length>=6)break;}
function portfolio(delta=0){const all=[];for(const r of selected)for(const t of r.trades)all.push({...t,ret:t.ret-delta,source:r.config.id});all.sort((a,b)=>a.time-b.time);const active=[],accepted=[];let eq=1000,peak=1000,dd=0;for(const t of all){for(let i=active.length-1;i>=0;i--)if(active[i].until<=t.time)active.splice(i,1);if(active.some(x=>x.symbol===t.symbol)||active.length>=10)continue;const pnl=eq*.10*t.ret;eq=Math.max(1,eq+pnl);peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak);accepted.push({...t,pnl});active.push({symbol:t.symbol,until:t.time+t.hold*300});}const pm=(a,b)=>{let n=0,g=0,l=0,net=0,w=0;for(const t of accepted){if(t.time<a||t.time>=b)continue;n++;net+=t.pnl;if(t.pnl>0){g+=t.pnl;w++;}else l-=t.pnl;}return{trades:n,tradesPerDay:n/Math.max(days(a,b),1),netPnl:net,pf:l?g/l:g>0?99:0,win:n?w/n:0};};return{endEquity:eq,netPnl:eq-1000,maxDrawdown:dd,train:pm(FROM,TRAIN_END),valid:pm(TRAIN_END,VALID_END),holdout:pm(VALID_END,TO),full:pm(FROM,TO)};}
const base=portfolio(),stress=portfolio(DELTA);const gates={qualifiedFactors:selected.length>=2,frequency:base.holdout.tradesPerDay>=15,train:base.train.netPnl>0&&base.train.pf>=1.03,validation:base.valid.netPnl>0&&base.valid.pf>=1.01,holdout:base.holdout.netPnl>0&&base.holdout.pf>=1.05,drawdown:base.maxDrawdown<=.12,stressHoldout:stress.holdout.netPnl>0&&stress.holdout.pf>=1};
const report={generatedAt:new Date().toISOString(),priceSha256:priceRaw.sha256,flowSha256:flowRaw.sha256,symbols,from:FROM,trainEnd:TRAIN_END,validationEnd:VALID_END,to:TO,friction:FRICTION,stressFriction:STRESS,snapshotCount:snapshots.length,candidateCount:candidates.length,qualifiedCount:qualified.length,selected:selected.map(r=>({config:r.config,train:r.train,valid:r.valid,holdout:r.holdout,stressTrain:r.stressTrain})),top:audit.sort((a,b)=>b.score-a.score).slice(0,40).map(r=>({config:r.config,train:r.train,valid:r.valid,holdout:r.holdout,stressTrain:r.stressTrain})),base,stress,gates,targetMet:Object.values(gates).every(Boolean)};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n");console.log("FLOW_FACTOR_RANK_RESULT="+JSON.stringify({targetMet:report.targetMet,qualified:qualified.length,selected:report.selected,base,stress,gates,top:report.top.slice(0,12)},null,2));
