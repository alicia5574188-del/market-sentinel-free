import { writeFileSync } from 'node:fs';

const SYMBOLS=['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','BNB_USDT','DOGE_USDT','ADA_USDT','LINK_USDT','LTC_USDT','AVAX_USDT','BCH_USDT'];
const H=3600;
const START=Date.UTC(2026,2,24,0,0,0)/1000; // warm-up, safely inside Gate's 180d window on 2026-09-16
const END=Date.UTC(2026,8,16,0,0,0)/1000;
const CHUNK=14*86400;
const LOOKBACK=168;
const MIN_HIST=72;
const BASE_COST=0.0014;
const STRESS_COST=0.0022;
const COOLDOWN=4*H;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url,attempts=6){
  for(let a=0;a<attempts;a++){
    try{
      const r=await fetch(url,{headers:{Accept:'application/json'}});
      if(r.ok)return await r.json();
      const text=await r.text();
      if(r.status===429||r.status>=500){await sleep(400*(a+1));continue;}
      throw new Error(`${r.status} ${text}`);
    }catch(e){if(a===attempts-1)throw e;await sleep(400*(a+1));}
  }
}
function num(x){const v=Number(x);return Number.isFinite(v)?v:null;}
function normalizeRow(x){
  const time=num(x.time), mark=num(x.mark_price), oi=num(x.open_interest_usd??x.open_interest);
  if(!(time>0)||!(mark>0)||!(oi>0))return null;
  return {
    time,mark,oi,
    takerLong:Math.max(0,num(x.long_taker_size)??0),takerShort:Math.max(0,num(x.short_taker_size)??0),
    longLiq:Math.max(0,num(x.long_liq_usd_new??x.long_liq_usd)??0),shortLiq:Math.max(0,num(x.short_liq_usd_new??x.short_liq_usd)??0),
    lsrAccount:num(x.lsr_account),topLsrSize:num(x.top_lsr_size),
    longUsers:Math.max(0,num(x.long_users)??0),shortUsers:Math.max(0,num(x.short_users)??0)
  };
}
async function fetchSymbol(symbol){
  const out=[];
  for(let from=START;from<END;from+=CHUNK){
    const to=Math.min(END-1,from+CHUNK-1);
    const url=`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(symbol)}&from=${from}&to=${to}&interval=1h&limit=1000`;
    const a=await getJson(url);
    if(!Array.isArray(a))throw new Error(`non-array ${symbol} ${from}`);
    out.push(...a.map(normalizeRow).filter(Boolean));
  }
  const dedup=new Map(out.map(r=>[r.time,r]));
  return [...dedup.values()].filter(r=>r.time>=START&&r.time<END).sort((a,b)=>a.time-b.time);
}
const raw=new Map();let cursor=0;
async function worker(){while(cursor<SYMBOLS.length){const s=SYMBOLS[cursor++];try{raw.set(s,await fetchSymbol(s));}catch(e){console.error('FETCH_FAIL',s,String(e));raw.set(s,[]);}}}
await Promise.all(Array.from({length:4},worker));

const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2;};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f;};
function robustZ(v,h){
  const a=h.filter(Number.isFinite);if(!Number.isFinite(v)||a.length<MIN_HIST)return null;
  const m=median(a),mad=median(a.map(x=>Math.abs(x-m)));
  if(!(mad>1e-12))return 0;
  return (v-m)/(1.4826*mad);
}
function sign(x){return x>0?1:x<0?-1:0;}
function splitOf(t){
  if(t<Date.UTC(2026,3,1)/1000)return 'warmup';
  if(t<Date.UTC(2026,5,1)/1000)return 'discovery';
  if(t<Date.UTC(2026,6,1)/1000)return 'validation';
  if(t<Date.UTC(2026,8,1)/1000)return 'evaluation';
  return 'holdout';
}

const events=[];
for(const [symbol,rows] of raw){
  if(rows.length<MIN_HIST+20)continue;
  const byTime=new Map(rows.map((r,i)=>[r.time,i]));
  const hist={oi4:[],taker:[],acct:[],top:[],div:[],liqMag:[],user:[]};
  for(let i=0;i<rows.length;i++){
    const r=rows[i],j=byTime.get(r.time-4*H),p4=j===undefined?null:rows[j];
    const oi4=p4&&p4.oi>0?Math.log(r.oi/p4.oi):null;
    const taker=Math.log((r.takerLong+1)/(r.takerShort+1));
    const acct=r.lsrAccount>0?Math.log(r.lsrAccount):null;
    const top=r.topLsrSize>0?Math.log(r.topLsrSize):null;
    const div=Number.isFinite(acct)&&Number.isFinite(top)?acct-top:null;
    const liqTotal=r.longLiq+r.shortLiq;
    const liqMag=Math.log1p((liqTotal/Math.max(r.oi,1))*1e6);
    const liqSkew=(r.shortLiq-r.longLiq)/(liqTotal+1);
    const user=Math.log((r.longUsers+1)/(r.shortUsers+1));
    const zOi=robustZ(oi4,hist.oi4.slice(-LOOKBACK));
    const zTaker=robustZ(taker,hist.taker.slice(-LOOKBACK));
    const zAcct=robustZ(acct,hist.acct.slice(-LOOKBACK));
    const zDiv=robustZ(div,hist.div.slice(-LOOKBACK));
    const zLiq=robustZ(liqMag,hist.liqMag.slice(-LOOKBACK));
    const zUser=robustZ(user,hist.user.slice(-LOOKBACK));
    const base={symbol,t:r.time,split:splitOf(r.time),zOi,zTaker,zAcct,zDiv,zLiq,zUser,liqSkew};
    if(base.split!=='warmup'&&[zOi,zTaker,zAcct,zDiv,zLiq,zUser].every(x=>x===null||Number.isFinite(x))){
      const sT=sign(zTaker),sD=sign(zDiv),sL=sign(liqSkew);
      // 1) OI expansion + taker + account crowding: test continuation and fade as a paired hypothesis.
      if(zOi>=1&&Math.abs(zTaker)>=1.5&&Math.abs(zAcct)>=0.75&&sT===sign(zAcct)){
        events.push({...base,family:'CROWD_CONT',dir:sT});
        events.push({...base,family:'CROWD_FADE',dir:-sT});
      }
      // 2) Liquidation shock + OI contraction: test cascade continuation vs exhaustion reversal.
      if(zLiq>=2&&Math.abs(liqSkew)>=0.65&&zOi<=-0.5){
        events.push({...base,family:'LIQ_CONT',dir:sL});
        events.push({...base,family:'LIQ_REV',dir:-sL});
      }
      // 3) Ordinary-account vs top-position divergence while OI expands: follow top side vs ordinary side.
      if(Math.abs(zDiv)>=1.5&&zOi>=0.5){
        events.push({...base,family:'DIV_TOP',dir:-sD});
        events.push({...base,family:'DIV_RETAIL',dir:sD});
      }
      // 4) Aggressive taker imbalance while OI contracts: continuation vs exhaustion.
      if(Math.abs(zTaker)>=2&&zOi<=-1){
        events.push({...base,family:'TAKER_CONT',dir:sT});
        events.push({...base,family:'TAKER_REV',dir:-sT});
      }
      // 5) Liquidation and taker direction agree: directional cascade vs snapback.
      if(zLiq>=1.5&&Math.abs(liqSkew)>=0.5&&Math.abs(zTaker)>=1.25&&sL!==0&&sL===sT){
        events.push({...base,family:'FLUSH_CONT',dir:sT});
        events.push({...base,family:'FLUSH_REV',dir:-sT});
      }
      // 6) User crowding confirms taker imbalance while OI grows.
      if(zOi>=0.75&&Math.abs(zTaker)>=1.25&&Math.abs(zUser)>=1&&sT===sign(zUser)){
        events.push({...base,family:'USER_CONT',dir:sT});
        events.push({...base,family:'USER_FADE',dir:-sT});
      }
    }
    for(const [k,v] of Object.entries({oi4,taker,acct,top,div,liqMag,user}))if(Number.isFinite(v))hist[k].push(v);
  }
}

// Same-family/symbol cooldown, applied chronologically before any return is measured.
events.sort((a,b)=>a.t-b.t||a.family.localeCompare(b.family)||a.symbol.localeCompare(b.symbol));
const last=new Map(),dedup=[];
for(const e of events){const k=`${e.family}|${e.symbol}`,p=last.get(k)??-Infinity;if(e.t-p<COOLDOWN)continue;last.set(k,e.t);dedup.push(e);}

function makeTrade(e,horizon,cost){
  const rows=raw.get(e.symbol)||[],m=new Map(rows.map(r=>[r.time,r]));
  // Signal uses completed t stats; execute one full hour later to avoid interval-boundary look-ahead.
  const entry=m.get(e.t+H),exit=m.get(e.t+(horizon+1)*H);
  if(!entry||!exit)return null;
  const gross=e.dir*(exit.mark/entry.mark-1);
  return {...e,horizon,entryTime:entry.time,exitTime:exit.time,gross,net:gross-cost,cost};
}
const trades=[];
for(const e of dedup)for(const horizon of [4,8])for(const [scenario,cost] of [['base',BASE_COST],['stress',STRESS_COST]]){
  const x=makeTrade(e,horizon,cost);if(x)trades.push({...x,scenario});
}
function metrics(a){
  if(!a.length)return {trades:0};
  const v=a.map(x=>x.net),sum=v.reduce((s,x)=>s+x,0),g=v.filter(x=>x>0).reduce((s,x)=>s+x,0),l=-v.filter(x=>x<=0).reduce((s,x)=>s+x,0);
  const lo=quantile(v,.05),hi=quantile(v,.95),wins=v.map(x=>Math.max(lo,Math.min(hi,x)));
  let eq=0,peak=0,maxDD=0;for(const x of a.slice().sort((x,y)=>x.exitTime-y.exitTime)){eq+=x.net;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq);}
  return {trades:a.length,meanNet:sum/a.length,medianNet:median(v),hit:a.filter(x=>x.net>0).length/a.length,pf:l?g/l:null,sumNet:sum,winsor5Mean:wins.reduce((s,x)=>s+x,0)/wins.length,maxAdditiveDD:maxDD};
}
const families=[...new Set(dedup.map(x=>x.family))].sort();
const rows=[];
for(const family of families)for(const horizon of [4,8]){
  const rec={family,horizon,splits:{}};
  for(const sp of ['discovery','validation','evaluation','holdout'])for(const sc of ['base','stress']){
    rec.splits[sp]??={};rec.splits[sp][sc]=metrics(trades.filter(x=>x.family===family&&x.horizon===horizon&&x.split===sp&&x.scenario===sc));
  }
  const train=trades.filter(x=>x.family===family&&x.horizon===horizon&&(x.split==='discovery'||x.split==='validation'));
  rec.train={base:metrics(train.filter(x=>x.scenario==='base')),stress:metrics(train.filter(x=>x.scenario==='stress'))};
  const d=rec.splits.discovery.base,v=rec.splits.validation.base,ts=rec.train.stress;
  rec.eligible=(d.trades>=12&&v.trades>=5&&d.meanNet>0&&v.meanNet>0&&ts.meanNet>0&&(ts.pf??0)>1);
  rows.push(rec);
}
const eligible=rows.filter(x=>x.eligible).sort((a,b)=>b.train.stress.meanNet-a.train.stress.meanNet);
const finalists=eligible.map(x=>{
  const e=x.splits.evaluation,h=x.splits.holdout;
  const evalPass=e.base.trades>=8&&e.base.meanNet>0&&e.stress.meanNet>0&&(e.stress.pf??0)>1;
  const holdoutPass=h.base.trades>=3?h.base.meanNet>0&&h.stress.meanNet>-0.0005:null;
  return {...x,evalPass,holdoutPass};
});
const accepted=finalists.filter(x=>x.evalPass&&x.holdoutPass===true);
const watch=finalists.filter(x=>x.evalPass&&x.holdoutPass===null);
const activeSymbols=[...raw].filter(([,v])=>v.length>=MIN_HIST+20).map(([k])=>k);
const availability=Object.fromEntries([...raw].map(([s,a])=>[s,{rows:a.length,from:a[0]?.time??null,to:a.at(-1)?.time??null}]));
const report={
  decision:accepted.length?'RECENT_MICROSTRUCTURE_SUPPORT_INCUBATOR':watch.length?'EVAL_SUPPORT_HOLDOUT_INSUFFICIENT':'NO_STABLE_RECENT_MICROSTRUCTURE_EDGE',
  authority:'RESEARCH_INCUBATOR_ONLY_NEVER_DEPLOY_FROM_180D_WINDOW',
  data:{endpoint:'Gate futures/usdt/contract_stats',interval:'1h',start:START,endExclusive:END,availability,activeSymbols},
  splits:{warmup:'20260324-20260331',discovery:'202604-202605',validation:'202606',evaluation:'202607-202608',holdout:'20260901-20260915'},
  safeguards:['completed-hour features only','execute t+1h','168h trailing robust normalization excludes current observation','4h same-family/symbol cooldown','selection uses discovery+validation only','evaluation and September holdout not used for selection','14bp base and 22bp stress round-trip cost'],
  eventCount:dedup.length,tradeCount:trades.length,eligibleCount:eligible.length,accepted:accepted.map(x=>({family:x.family,horizon:x.horizon,train:x.train,evaluation:x.splits.evaluation,holdout:x.splits.holdout})),watch:watch.map(x=>({family:x.family,horizon:x.horizon,train:x.train,evaluation:x.splits.evaluation,holdout:x.splits.holdout})),all:rows
};
writeFileSync('/tmp/contract-stats-incubator.json',JSON.stringify(report,null,2));
writeFileSync('/tmp/contract-stats-incubator-trades.json',JSON.stringify(trades));
console.log(JSON.stringify({decision:report.decision,authority:report.authority,data:report.data,splits:report.splits,eventCount:report.eventCount,eligibleCount:report.eligibleCount,accepted:report.accepted,watch:report.watch},null,2));
