import { writeFileSync } from 'node:fs';

const SYMBOLS=['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','BNB_USDT','DOGE_USDT','ADA_USDT','LINK_USDT','LTC_USDT','AVAX_USDT','BCH_USDT'];
const STEP=300,DAY=86400,WINDOW=120*DAY,CHUNK=3*DAY,ROLL=7*24*12;
const BASE_COST=.00165,STRESS_COST=.00270,FRAC=.10,ENTRY_BUDGET=2.5,MAX_EXPOSURE=1.5,MAX_PER_STEP=3;
const HOLDS=[3,6,12],CONFIRMS=[1,2,3],QS=[.50,.70,.85];
const END=Math.floor(Date.now()/1000/STEP)*STEP,START=END-WINDOW,S1=START+30*DAY,S2=S1+30*DAY,S3=S2+30*DAY;
const split=t=>t<S1?'discovery':t<S2?'validation':t<S3?'evaluation1':'evaluation2';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url,tries=7){for(let a=0;a<tries;a++){try{const r=await fetch(url,{headers:{Accept:'application/json'}});if(r.ok)return await r.json();if(r.status!==429&&r.status<500)throw new Error(`${r.status} ${url}`);}catch(e){if(a===tries-1)throw e;}await sleep(300*(a+1));}}
const n=x=>{const v=Number(x);return Number.isFinite(v)?v:null;};
function norm(x){const time=n(x.time),mark=n(x.mark_price),oi=n(x.open_interest_usd??x.open_interest);if(!(time>0)||!(mark>0)||!(oi>0))return null;return {time,mark,oi,takerLong:Math.max(0,n(x.long_taker_size)??0),takerShort:Math.max(0,n(x.short_taker_size)??0),longLiq:Math.max(0,n(x.long_liq_usd_new??x.long_liq_usd)??0),shortLiq:Math.max(0,n(x.short_liq_usd_new??x.short_liq_usd)??0),acct:n(x.lsr_account),top:n(x.top_lsr_size),funding:n(x.last_funding_rate)??0,longUsers:Math.max(0,n(x.long_users)??0),shortUsers:Math.max(0,n(x.short_users)??0)};}
async function fetchSymbol(symbol){const out=[];for(let from=START-ROLL*STEP;from<END;from+=CHUNK){const to=Math.min(END-1,from+CHUNK-1),url=`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(symbol)}&from=${from}&to=${to}&interval=5m&limit=1000`;const a=await get(url);if(Array.isArray(a))out.push(...a.map(norm).filter(Boolean));}return [...new Map(out.map(r=>[r.time,r])).values()].filter(r=>r.time>=START-ROLL*STEP&&r.time<END).sort((a,b)=>a.time-b.time);}
const raw=new Map();let cursor=0;async function worker(){while(cursor<SYMBOLS.length){const s=SYMBOLS[cursor++];try{raw.set(s,await fetchSymbol(s));}catch(e){console.error('FETCH_FAIL',s,String(e));raw.set(s,[]);}}}await Promise.all(Array.from({length:6},worker));

class RollZ{constructor(max){this.max=max;this.q=[];this.head=0;this.sum=0;this.sq=0;}push(v){if(!Number.isFinite(v))return;this.q.push(v);this.sum+=v;this.sq+=v*v;while(this.q.length-this.head>this.max){const x=this.q[this.head++];this.sum-=x;this.sq-=x*x;}if(this.head>4096&&this.head*2>this.q.length){this.q=this.q.slice(this.head);this.head=0;}}z(v){const k=this.q.length-this.head;if(!Number.isFinite(v)||k<288)return null;const m=this.sum/k,vr=Math.max(1e-12,this.sq/k-m*m);return (v-m)/Math.sqrt(vr);}}
const sgn=x=>x>0?1:x<0?-1:0;
const stateMaps=new Map(),shockEvents=[];
for(const [symbol,rows] of raw){
  if(rows.length<ROLL+100)continue;
  const idx=new Map(rows.map((r,i)=>[r.time,i])),states=new Map(),rz={r5:new RollZ(ROLL),r15:new RollZ(ROLL),oi15:new RollZ(ROLL),oi60:new RollZ(ROLL),taker:new RollZ(ROLL),acct:new RollZ(ROLL),top:new RollZ(ROLL),div:new RollZ(ROLL),user:new RollZ(ROLL),liq:new RollZ(ROLL),fund:new RollZ(ROLL)};
  for(let i=0;i<rows.length;i++){
    const r=rows[i],p1=idx.get(r.time-STEP),p3=idx.get(r.time-3*STEP),p12=idx.get(r.time-12*STEP),a1=p1===undefined?null:rows[p1],a3=p3===undefined?null:rows[p3],a12=p12===undefined?null:rows[p12];
    const r5=a1?Math.log(r.mark/a1.mark):null,r15=a3?Math.log(r.mark/a3.mark):null,oi15=a3?Math.log(r.oi/a3.oi):null,oi60=a12?Math.log(r.oi/a12.oi):null,taker=Math.log((r.takerLong+1)/(r.takerShort+1)),acct=r.acct>0?Math.log(r.acct):null,top=r.top>0?Math.log(r.top):null,div=Number.isFinite(acct)&&Number.isFinite(top)?acct-top:null,user=Math.log((r.longUsers+1)/(r.shortUsers+1)),liqTot=r.longLiq+r.shortLiq,liq=Math.log1p((liqTot/Math.max(r.oi,1))*1e6),liqSkew=(r.shortLiq-r.longLiq)/(liqTot+1),fund=r.funding;
    const z={r5:rz.r5.z(r5),r15:rz.r15.z(r15),oi15:rz.oi15.z(oi15),oi60:rz.oi60.z(oi60),taker:rz.taker.z(taker),acct:rz.acct.z(acct),top:rz.top.z(top),div:rz.div.z(div),user:rz.user.z(user),liq:rz.liq.z(liq),fund:rz.fund.z(fund)};
    if(Object.values(z).every(Number.isFinite)){
      const st={symbol,t:r.time,mark:r.mark,oi:r.oi,liqSkew,...z};states.set(r.time,st);
      if(r.time>=START){
        const dP=sgn(z.r15),dT=sgn(z.taker),dL=sgn(liqSkew),dA=sgn(z.acct);
        const add=(type,dir,score)=>{if(dir&&Number.isFinite(score)&&score>0)shockEvents.push({symbol,t:r.time,type,dir,score});};
        if(z.liq>=1.25&&Math.abs(liqSkew)>=.35)add('LIQ',dL,z.liq+.8*Math.abs(liqSkew)+.25*Math.abs(z.r15));
        if(Math.abs(z.taker)>=1.5&&Math.abs(z.r15)>=.5)add('FLOW',dT,Math.abs(z.taker)+.35*Math.abs(z.r15)+.2*Math.max(0,z.oi15));
        if(Math.abs(z.r15)>=1&&z.oi60>=.5)add('BREAK',dP,Math.abs(z.r15)+.6*z.oi60+.3*Math.abs(z.taker));
        if(z.oi15>=1&&Math.abs(z.taker)>=.75)add('OI_SHOCK',dT,z.oi15+.4*Math.abs(z.taker)+.2*Math.abs(z.r5));
        if(Math.abs(z.acct)>=1.25&&Math.abs(z.r15)>=.75&&dA===dP)add('CROWD',dA,Math.abs(z.acct)+.45*Math.abs(z.r15)+.25*Math.abs(z.div));
      }
    }
    for(const [k,v] of Object.entries({r5,r15,oi15,oi60,taker,acct,top,div,user,liq,fund}))if(Number.isFinite(v))rz[k].push(v);
  }
  stateMaps.set(symbol,states);
}

shockEvents.sort((a,b)=>a.t-b.t||a.type.localeCompare(b.type)||a.symbol.localeCompare(b.symbol));
const shockLast=new Map(),shocks=[];for(const e of shockEvents){const k=`${e.type}|${e.symbol}`,p=shockLast.get(k)??-Infinity;if(e.t-p<15*60)continue;shockLast.set(k,e.t);shocks.push(e);}

const pathEvents=[];
for(const e of shocks){
  const sm=stateMaps.get(e.symbol),s0=sm?.get(e.t);if(!s0)continue;
  for(const confirm of CONFIRMS){
    const ct=e.t+confirm*STEP,c=sm.get(ct),prev=sm.get(ct-STEP);if(!c||!prev)continue;
    const pathRet=Math.log(c.mark/s0.mark),dPath=e.dir*pathRet,dLast=e.dir*c.r5,dFlow=e.dir*c.taker,dPrev=e.dir*prev.r5,dLiq=e.dir*c.liqSkew;
    const flowFlip=dFlow<=-.5,flowConfirm=dFlow>=.5,priceFail=dPath<=0||dLast<=-.25,priceConfirm=dPath>0&&dLast>=.20;
    const add=(family,dir,score)=>{if(dir&&Number.isFinite(score)&&score>0)pathEvents.push({symbol:e.symbol,shockTime:e.t,t:ct,confirm,family,shockType:e.type,dir,score,pathRet,dPath,dLast,dFlow,zOi15:c.oi15,zOi60:c.oi60,zLiq:c.liq,liqSkew:c.liqSkew,split:split(ct)});};
    if(priceConfirm&&flowConfirm&&c.oi15>=-.5)add('FOLLOW_ACCEL',e.dir,e.score+1.2*dLast+.6*dFlow+.35*Math.max(0,c.oi15));
    if((e.type==='FLOW'||e.type==='OI_SHOCK')&&priceFail&&dFlow>=.5)add('ABSORPTION_REV',-e.dir,e.score+.9*dFlow+.8*Math.max(0,-dLast)+.4*Math.max(0,-dPath*100));
    if(flowFlip&&(dPath<=.002||dLast<0))add('FLOW_FLIP_REV',-e.dir,e.score+.9*Math.max(0,-dFlow)+.5*Math.max(0,-dLast));
    if(e.type==='LIQ'&&c.oi15<=-.5&&(dLast<0||flowFlip))add('DELEVERAGE_EXHAUST_REV',-e.dir,e.score+.7*Math.max(0,-c.oi15)+.5*Math.max(0,-dLast)+.25*c.liq);
    if(confirm>=2&&dPrev<0&&dLast>=.35&&flowConfirm)add('SECOND_WAVE_CONT',e.dir,e.score+.8*dLast+.45*dFlow+.25*Math.max(0,c.oi15));
    if(e.type==='BREAK'&&priceFail&&(flowFlip||c.oi15>=0))add('FAILED_BREAK_REV',-e.dir,e.score+.7*Math.max(0,-dLast)+.45*Math.max(0,-dFlow)+.2*Math.max(0,c.oi15));
    if((e.type==='BREAK'||e.type==='OI_SHOCK')&&priceConfirm&&flowConfirm&&c.oi15>=.25)add('OI_CONFIRM_CONT',e.dir,e.score+.8*dLast+.5*dFlow+.45*c.oi15);
    if(e.type==='LIQ'&&dPath>0&&dLiq>=.25&&c.liq>=.75&&dLast>=0)add('LIQ_CHAIN_CONT',e.dir,e.score+.55*c.liq+.45*dLiq+.35*Math.max(0,dLast));
  }
}

pathEvents.sort((a,b)=>a.t-b.t||a.family.localeCompare(b.family)||a.symbol.localeCompare(b.symbol));
const pathLast=new Map(),dedup=[];for(const e of pathEvents){const k=`${e.family}|${e.symbol}`,p=pathLast.get(k)??-Infinity;if(e.t-p<15*60)continue;pathLast.set(k,e.t);dedup.push(e);}
const tradeMaps=new Map([...raw].map(([symbol,rows])=>[symbol,new Map(rows.map(r=>[r.time,r]))]));
function trade(e,hold,orientation,cost){const map=tradeMaps.get(e.symbol);if(!map)return null;const en=map.get(e.t+STEP),ex=map.get(e.t+(hold+1)*STEP);if(!en||!ex)return null;const gross=orientation*e.dir*(ex.mark/en.mark-1);return {...e,hold,orientation,entryTime:en.time,exitTime:ex.time,gross,net:gross-cost};}
const qtile=(a,q)=>{if(!a.length)return Infinity;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f;};
function metrics(a){if(!a.length)return {trades:0,meanNet:null,medianNet:null,hit:null,pf:null,sumNet:0};const v=a.map(x=>x.net),sum=v.reduce((s,x)=>s+x,0),g=v.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-v.filter(x=>x<=0).reduce((s,x)=>s+x,0);return {trades:a.length,meanNet:sum/a.length,medianNet:qtile(v,.5),hit:v.filter(x=>x>0).length/v.length,pf:l?g/l:g?99:0,sumNet:sum};}
const allTrades=[];for(const e of dedup)for(const hold of HOLDS)for(const orientation of [1,-1]){const b=trade(e,hold,orientation,BASE_COST),s=trade(e,hold,orientation,STRESS_COST);if(b)allTrades.push({...b,scenario:'base'});if(s)allTrades.push({...s,scenario:'stress'});}
const families=[...new Set(dedup.map(e=>e.family))],candidates=[];
for(const family of families){for(const confirm of CONFIRMS){const discEvents=dedup.filter(e=>e.family===family&&e.confirm===confirm&&e.split==='discovery'),scores=discEvents.map(e=>e.score);if(!scores.length)continue;for(const q of QS){const threshold=qtile(scores,q);for(const hold of HOLDS)for(const orientation of [1,-1]){const pick=(sp,sc)=>allTrades.filter(x=>x.family===family&&x.confirm===confirm&&x.split===sp&&x.hold===hold&&x.orientation===orientation&&x.scenario===sc&&x.score>=threshold),dm=metrics(pick('discovery','base')),ds=metrics(pick('discovery','stress')),vm=metrics(pick('validation','base')),vs=metrics(pick('validation','stress'));const eligible=dm.trades>=40&&vm.trades>=30&&dm.meanNet>0&&vm.meanNet>0&&ds.meanNet>-0.00025&&vs.meanNet>-0.00025&&(dm.pf??0)>1&&(vm.pf??0)>1;const rank=(Math.min(dm.meanNet??-1,vm.meanNet??-1)+.5*Math.min(ds.meanNet??-1,vs.meanNet??-1));candidates.push({family,confirm,q,threshold,hold,orientation,discovery:dm,discoveryStress:ds,validation:vm,validationStress:vs,eligible,rank});}}}}
const sleeves=candidates.filter(x=>x.eligible).sort((a,b)=>b.rank-a.rank);
const nearMiss=candidates.filter(x=>x.discovery.trades>=40&&x.validation.trades>=30).sort((a,b)=>b.rank-a.rank).slice(0,12).map(x=>({family:x.family,confirm:x.confirm,q:x.q,hold:x.hold,orientation:x.orientation,rank:x.rank,discovery:x.discovery,discoveryStress:x.discoveryStress,validation:x.validation,validationStress:x.validationStress}));
function evalSleeve(s,sp,scenario){return metrics(allTrades.filter(x=>x.family===s.family&&x.confirm===s.confirm&&x.split===sp&&x.hold===s.hold&&x.orientation===s.orientation&&x.scenario===scenario&&x.score>=s.threshold));}
const sleeveDetails=sleeves.slice(0,20).map(s=>({...s,evaluation1:{base:evalSleeve(s,'evaluation1','base'),stress:evalSleeve(s,'evaluation1','stress')},evaluation2:{base:evalSleeve(s,'evaluation2','base'),stress:evalSleeve(s,'evaluation2','stress')}}));
function evalPortfolio(splitName,costScenario){
  const eventMap=new Map();for(const s of sleeves){for(const e of dedup){if(e.family!==s.family||e.confirm!==s.confirm||e.split!==splitName||e.score<s.threshold)continue;const t=trade(e,s.hold,s.orientation,costScenario==='base'?BASE_COST:STRESS_COST);if(!t)continue;const k=`${e.symbol}|${e.t}`,p=eventMap.get(k),priority=s.rank+e.score*1e-6;if(!p||priority>p.priority)eventMap.set(k,{...t,priority,sleeve:s});}}
  const es=[...eventMap.values()].sort((a,b)=>a.entryTime-b.entryTime||b.priority-a.priority),grouped=new Map();for(const e of es){const a=grouped.get(e.entryTime)??[];a.push(e);grouped.set(e.entryTime,a);}
  let equity=1,peak=1,maxDD=0;const active=[],busy=new Map(),used=new Map(),turn=new Map(),entries=new Map(),pnlDay=new Map(),trades=[];const day=x=>new Date(x*1000).toISOString().slice(0,10);
  function release(t){active.sort((a,b)=>a.exitTime-b.exitTime);while(active.length&&active[0].exitTime<=t){const p=active.shift(),pnl=p.entryEq*FRAC*p.net;equity+=pnl;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/Math.max(peak,1e-9));const d=day(p.exitTime);turn.set(d,(turn.get(d)??0)+FRAC);pnlDay.set(d,(pnlDay.get(d)??0)+pnl);}}
  for(const [t,a] of [...grouped].sort((x,y)=>x[0]-y[0])){release(t);const d=day(t),u=used.get(d)??0;if(u>=ENTRY_BUDGET-FRAC/2)continue;let local=u;for(const e of a.sort((x,y)=>y.priority-x.priority).slice(0,MAX_PER_STEP)){if((busy.get(e.symbol)??0)>t)continue;if(local+FRAC>ENTRY_BUDGET+1e-9||active.length*FRAC+FRAC>MAX_EXPOSURE+1e-9)break;active.push({exitTime:e.exitTime,entryEq:equity,net:e.net});busy.set(e.symbol,e.exitTime);local+=FRAC;turn.set(d,(turn.get(d)??0)+FRAC);entries.set(d,(entries.get(d)??0)+1);trades.push(e);}used.set(d,local);}
  const end=splitName==='evaluation1'?S3:END;release(end+20*STEP);const start=splitName==='evaluation1'?S2:S3,days=(end-start)/DAY,keys=[];for(let t=Math.floor(start/DAY)*DAY;t<end;t+=DAY)keys.push(day(t));const turns=keys.map(d=>turn.get(d)??0),ents=keys.map(d=>entries.get(d)??0),pd=keys.map(d=>pnlDay.get(d)??0),rates=trades.map(x=>x.net),g=rates.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-rates.filter(x=>x<=0).reduce((s,x)=>s+x,0),mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0,med=a=>qtile(a,.5),norm=equity>0?equity**(30/days)-1:-1;return {days,trades:trades.length,avgTradesPerDay:trades.length/days,totalReturn:equity-1,normalized30Return:norm,maxDD,avgDailyTurnover:mean(turns),medianDailyTurnover:med(turns),coverage45:turns.filter(x=>x>=4.5).length/Math.max(1,turns.length),zeroTradeDays:ents.filter(x=>x===0).length,positivePnlDays:pd.filter(x=>x>0).length/Math.max(1,pd.filter(x=>x!==0).length),winRate:rates.length?rates.filter(x=>x>0).length/rates.length:0,meanTradeNet:mean(rates),pf:l?g/l:g?99:0,families:Object.fromEntries([...new Set(trades.map(x=>x.family))].map(f=>[f,trades.filter(x=>x.family===f).length]))};
}
const evaluation={evaluation1:{base:evalPortfolio('evaluation1','base'),stress:evalPortfolio('evaluation1','stress')},evaluation2:{base:evalPortfolio('evaluation2','base'),stress:evalPortfolio('evaluation2','stress')}};
const promising=sleeves.length>0&&evaluation.evaluation1.base.trades>0&&evaluation.evaluation2.base.trades>0&&evaluation.evaluation1.base.normalized30Return>0&&evaluation.evaluation2.base.normalized30Return>0&&evaluation.evaluation1.base.meanTradeNet>0&&evaluation.evaluation2.base.meanTradeNet>0&&evaluation.evaluation1.stress.meanTradeNet>-0.00025&&evaluation.evaluation2.stress.meanTradeNet>-0.00025;
const report={decision:promising?'FIVE_MIN_PATH_CONFIRMATION_PROMISING':'FIVE_MIN_PATH_CONFIRMATION_NOT_PROVEN',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',goal:'test whether post-shock 5m price/flow/OI path confirmation creates positive-edge sleeves that can contribute toward 5x daily turnover',periods:{start:new Date(START*1000).toISOString(),discovery:[new Date(START*1000).toISOString(),new Date(S1*1000).toISOString()],validation:[new Date(S1*1000).toISOString(),new Date(S2*1000).toISOString()],evaluation1:[new Date(S2*1000).toISOString(),new Date(S3*1000).toISOString()],evaluation2:[new Date(S3*1000).toISOString(),new Date(END*1000).toISOString()]},cost:{base:BASE_COST,stress:STRESS_COST},method:'base 5m shocks are identified causally; wait 1/2/3 completed 5m bars, classify the observed path as follow-through, absorption, flow flip, deleveraging exhaustion, second wave, failed break, OI confirmation or liquidation chain; enter only on next 5m bar; discovery threshold then validation qualification; two untouched 30d evaluations',data:{interval:'5m',symbols:SYMBOLS,availability:Object.fromEntries([...raw].map(([s,a])=>[s,{rows:a.length,first:a[0]?.time??null,last:a.at(-1)?.time??null}]))},shockCount:shocks.length,pathEventCount:dedup.length,candidateCount:candidates.length,eligibleSleeveCount:sleeves.length,eligibleSleeves:sleeveDetails,nearMiss,evaluation,promising};
writeFileSync('/tmp/5m-path-confirmation-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({decision:report.decision,authority:report.authority,goal:report.goal,periods:report.periods,cost:report.cost,shockCount:report.shockCount,pathEventCount:report.pathEventCount,candidateCount:report.candidateCount,eligibleSleeveCount:report.eligibleSleeveCount,eligibleSleeves:report.eligibleSleeves,nearMiss:report.nearMiss,evaluation:report.evaluation,promising:report.promising},null,2));
