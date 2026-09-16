import { writeFileSync } from 'node:fs';

const SELECTED_BY_MONTH = {"202507":["ETH_USDT","BTC_USDT","SOL_USDT","FARTCOIN_USDT","PEPE_USDT","XRP_USDT","DOGE_USDT","SUI_USDT","PI_USDT","VIRTUAL_USDT","WIF_USDT","AAVE_USDT","UNI_USDT","TRUMP_USDT","PNUT_USDT","HYPE_USDT","GALA_USDT","TRB_USDT","ADA_USDT","KAS_USDT","POPCAT_USDT","LINK_USDT","ONDO_USDT","MOODENG_USDT","BCH_USDT","TRX_USDT","RESOLV_USDT","SHIB_USDT","LTC_USDT","FLOCK_USDT"],"202508":["ETH_USDT","BTC_USDT","SOL_USDT","XRP_USDT","DOGE_USDT","FARTCOIN_USDT","PEPE_USDT","SUI_USDT","ENA_USDT","VIRTUAL_USDT","AAVE_USDT","WIF_USDT","UNI_USDT","BONK_USDT","SPK_USDT","PUMP_USDT","EIGEN_USDT","ADA_USDT","TRUMP_USDT","AIN_USDT","PNUT_USDT","HYPE_USDT","LTC_USDT","BCH_USDT","ERA_USDT","POPCAT_USDT","MOODENG_USDT","ZORA_USDT","PI_USDT","ONDO_USDT"],"202509":["ETH_USDT","BTC_USDT","SOL_USDT","XRP_USDT","DOGE_USDT","ENA_USDT","LINK_USDT","ADA_USDT","FARTCOIN_USDT","PEPE_USDT","PROVE_USDT","SUI_USDT","LTC_USDT","PUMP_USDT","HYPE_USDT","AVAX_USDT","EIGEN_USDT","ZORA_USDT","PI_USDT","BIO_USDT","MYX_USDT","SOON_USDT","SPK_USDT","BCH_USDT","UNI_USDT","AAVE_USDT","M_USDT","WIF_USDT","IN_USDT","ARB_USDT"],"202510":["ETH_USDT","BTC_USDT","SOL_USDT","DOGE_USDT","XRP_USDT","AVAX_USDT","ENA_USDT","MYX_USDT","ADA_USDT","FARTCOIN_USDT","AVNT_USDT","LINK_USDT","WLFI_USDT","PEPE_USDT","ASTER_USDT","LTC_USDT","SUI_USDT","ARB_USDT","SOMI_USDT","PUMP_USDT","BNB_USDT","M_USDT","WLD_USDT","XPL_USDT","TA_USDT","HYPE_USDT","0G_USDT","PI_USDT","ALPINE_USDT","PTB_USDT"],"202511":["ETH_USDT","BTC_USDT","SOL_USDT","DOGE_USDT","XRP_USDT","COAI_USDT","AVAX_USDT","BNB_USDT","ENA_USDT","ASTER_USDT","ADA_USDT","LINK_USDT","FARTCOIN_USDT","PEPE_USDT","LTC_USDT","SUI_USDT","ARB_USDT","MYX_USDT","HYPE_USDT","XPL_USDT","WLFI_USDT","AVNT_USDT","KGEN_USDT","PUMP_USDT","BLESS_USDT","XPIN_USDT","TRUMP_USDT","BAS_USDT","EVAA_USDT"],"202512":["ETH_USDT","BTC_USDT","SOL_USDT","XRP_USDT","DOGE_USDT","ADA_USDT","AVAX_USDT","PEPE_USDT","FARTCOIN_USDT","ENA_USDT","LTC_USDT","BNB_USDT","ASTER_USDT","LINK_USDT","PIPPIN_USDT","SUI_USDT","GIGGLE_USDT","COAI_USDT","JELLYJELLY_USDT","FIL_USDT","HYPE_USDT","ICP_USDT","ARB_USDT","TRUST_USDT","UNI_USDT","WLFI_USDT","MMT_USDT","SOON_USDT","TNSR_USDT"],"202601":["ETH_USDT","BTC_USDT","SOL_USDT","XRP_USDT","DOGE_USDT","PIPPIN_USDT","PEPE_USDT","FARTCOIN_USDT","ADA_USDT","BEAT_USDT","ENA_USDT","AVAX_USDT","SUI_USDT","LINK_USDT","LIGHT_USDT","LTC_USDT","FOLKS_USDT","BNB_USDT","NIGHT_USDT","FHE_USDT","BCH_USDT","LUNA_USDT","JELLYJELLY_USDT","ARB_USDT","HYPE_USDT","ASTER_USDT","LUNC_USDT","ZBT_USDT","UNI_USDT"],"202602":["ETH_USDT","SOL_USDT","XRP_USDT","DOGE_USDT","PEPE_USDT","RIVER_USDT","ADA_USDT","SUI_USDT","FARTCOIN_USDT","AVAX_USDT","LTC_USDT","ENA_USDT","AXS_USDT","LINK_USDT","BNB_USDT","HYPE_USDT","BCH_USDT","FIL_USDT","FHE_USDT","LIGHT_USDT","DASH_USDT","ENSO_USDT","SKR_USDT","BEAT_USDT","ASTER_USDT","WLFI_USDT","PUMP_USDT","UNI_USDT"],"202603":["ETH_USDT","SOL_USDT","XRP_USDT","DOGE_USDT","ADA_USDT","PEPE_USDT","SUI_USDT","AVAX_USDT","FARTCOIN_USDT","HYPE_USDT","ENA_USDT","RIVER_USDT","LINK_USDT","LTC_USDT","BNB_USDT","SIREN_USDT","BCH_USDT","ARC_USDT","POWER_USDT","WLFI_USDT","MYX_USDT","ESP_USDT","AZTEC_USDT","AXS_USDT","FIL_USDT","ENSO_USDT","ASTER_USDT","BTR_USDT"],"202604":["ETH_USDT","SOL_USDT","XRP_USDT","DOGE_USDT","PEPE_USDT","SIREN_USDT","ADA_USDT","BNB_USDT","SUI_USDT","FARTCOIN_USDT","TAO_USDT","HYPE_USDT","RIVER_USDT","AVAX_USDT","TRUMP_USDT","LINK_USDT","ENA_USDT","PI_USDT","LTC_USDT","LYN_USDT","BCH_USDT","POWER_USDT","UAI_USDT","PIXEL_USDT","BARD_USDT","FIL_USDT","ROBO_USDT","KITE_USDT"],"202605":["ETH_USDT","SOL_USDT","RAVE_USDT","DOGE_USDT","XRP_USDT","PEPE_USDT","SIREN_USDT","ADA_USDT","BNB_USDT","STO_USDT","SUI_USDT","ORDI_USDT","CHIP_USDT","FARTCOIN_USDT","HYPE_USDT","AVAX_USDT","LINK_USDT","ENA_USDT","PIEVERSE_USDT","TAO_USDT","SKYAI_USDT","LTC_USDT","ARIA_USDT","KAT_USDT","TRUMP_USDT","APE_USDT","NOM_USDT","币安人生_USDT","BLESS_USDT"],"202606":["ETH_USDT","SOL_USDT","XRP_USDT","DOGE_USDT","LAB_USDT","HYPE_USDT","BNB_USDT","PEPE_USDT","SUI_USDT","SKYAI_USDT","ADA_USDT","TON_USDT","UB_USDT","LINK_USDT","B_USDT","ONDO_USDT","BILL_USDT","XLM_USDT","AVAX_USDT","LTC_USDT","FIL_USDT","BEAT_USDT","CL_USDT","WLD_USDT","FARTCOIN_USDT","BCH_USDT","EDEN_USDT","ALLO_USDT","ENA_USDT"],"202607":["ETH_USDT","SOL_USDT","XRP_USDT","DOGE_USDT","LAB_USDT","HYPE_USDT","BEAT_USDT","ADA_USDT","H_USDT","WLD_USDT","BNB_USDT","PEPE_USDT","ALLO_USDT","SUI_USDT","BTW_USDT","AVAX_USDT","SKYAI_USDT","ESPORTS_USDT","CL_USDT","LINK_USDT","ENA_USDT","SLX_USDT","BCH_USDT","SIREN_USDT","LTC_USDT"],"202608":["ETH_USDT","SOL_USDT","XRP_USDT","LAB_USDT","DOGE_USDT","AKE_USDT","BANK_USDT","HYPE_USDT","ADA_USDT","PEPE_USDT","DEXE_USDT","BNB_USDT","CL_USDT","EVAA_USDT","WLD_USDT","SUI_USDT","BEAT_USDT","UNI_USDT","AVAX_USDT","LINK_USDT","ESPORTS_USDT"]};
const MONTHS=Object.keys(SELECTED_BY_MONTH).sort();
const H=3600;
const HORIZONS=[1,2,4,8];
const monthStartSec=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000;
const nextMonthSec=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6),1)/1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2;};
const quantile=(a,q)=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),f=p-i;return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*f;};
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const pct=x=>x==null?null:+(x*100).toFixed(4);

async function fetchJson(url,attempts=6){
  for(let a=0;a<attempts;a++){
    try{const r=await fetch(url);if(r.ok)return await r.json();if(r.status===429||r.status>=500){await sleep(600*(a+1));continue;}throw new Error(`${r.status} ${url}`);}
    catch(e){if(a===attempts-1)throw e;await sleep(600*(a+1));}
  }
}
function parseRows(a){
  if(!Array.isArray(a))return [];
  return a.flatMap(x=>{
    const t=Number(x.t??x[0]),o=Number(x.o??x[5]),h=Number(x.h??x[3]),l=Number(x.l??x[4]),c=Number(x.c??x[2]),v=Number(x.v??x[1]??0);
    return Number.isFinite(t)&&[o,h,l,c].every(Number.isFinite)&&o>0&&h>0&&l>0&&c>0?[{t,o,h,l,c,v}]:[];
  }).sort((x,y)=>x.t-y.t);
}

const tasks=[];
for(const m of MONTHS)for(const s of SELECTED_BY_MONTH[m])tasks.push({m,s});
let cursor=0; const data=new Map();
async function worker(){
  while(cursor<tasks.length){
    const {m,s}=tasks[cursor++];
    const from=monthStartSec(m)-30*H,to=nextMonthSec(m)+9*H;
    const u=`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(s)}&from=${from}&to=${to}&interval=1h`;
    try{const rows=parseRows(await fetchJson(u));data.set(`${m}|${s}`,new Map(rows.map(r=>[r.t,r])));}
    catch(e){console.error('fetch failed',m,s,String(e));data.set(`${m}|${s}`,new Map());}
  }
}
await Promise.all(Array.from({length:10},worker));

function splitOf(m){return m<'202603'?'discovery':m<'202606'?'validation':'evaluation';}
function row(m,s,t){return data.get(`${m}|${s}`)?.get(t)??null;}
function ret(m,s,t,h){const a=row(m,s,t),b=row(m,s,t-h*H);return a&&b?a.c/b.c-1:null;}
function fwd(m,s,t,h){const a=row(m,s,t),b=row(m,s,t+h*H);return a&&b?b.c/a.c-1:null;}

const rawEvents=[];
for(const m of MONTHS){
  const syms=SELECTED_BY_MONTH[m],start=monthStartSec(m)+24*H,end=nextMonthSec(m)-8*H;
  for(let t=start;t<end;t+=H){
    const obs=[];
    for(const s of syms){
      const r1=ret(m,s,t,1),prev1=ret(m,s,t-H,1),r4=ret(m,s,t,4),r24=ret(m,s,t,24);
      if([r1,prev1,r4,r24].some(x=>x==null||!Number.isFinite(x)))continue;
      obs.push({s,r1,prev1,r4,r24});
    }
    if(obs.length<Math.max(12,Math.ceil(syms.length*.60)))continue;
    const med4=median(obs.map(x=>x.r4)),mad4=median(obs.map(x=>Math.abs(x.r4-med4)))||1e-9,scale=1.4826*mad4;
    const med1=median(obs.map(x=>x.r1));
    for(const x of obs)x.rel4=x.r4-med4,x.z4=x.rel4/scale;
    const sorted=[...obs].sort((a,b)=>b.rel4-a.rel4);
    for(const side of ['leader','loser']){
      const x=side==='leader'?sorted[0]:sorted.at(-1);
      const second=side==='leader'?sorted[1]:sorted.at(-2);
      const dir=side==='leader'?1:-1,z=dir*x.z4;
      if(z<1.5)continue;
      const gap=side==='leader'?x.rel4-second.rel4:second.rel4-x.rel4;
      const directional1=dir*x.r1,directionalPrev1=dir*x.prev1;
      const signFlip=directional1<0;
      const decel=directional1<directionalPrev1;
      const rankFade=dir===1?x.r1<=med1:x.r1>=med1;
      const decelRankFade=decel&&rankFade;
      const exhaustion=signFlip||decelRankFade;
      const directional1s=obs.map(o=>dir*o.r1),q75=quantile(directional1s,.75);
      const persistence=directional1>0&&directional1>=q75;
      const forwards={};
      let complete=true;
      for(const h of HORIZONS){
        const sf=fwd(m,x.s,t,h);if(sf==null){complete=false;break;}
        const peer=obs.map(o=>fwd(m,o.s,t,h)).filter(v=>v!=null);
        if(peer.length<Math.max(10,Math.ceil(obs.length*.60))){complete=false;break;}
        const mf=median(peer);
        forwards[h]={abs:sf,rel:sf-mf,reversion:-dir*(sf-mf),continuation:dir*(sf-mf)};
      }
      if(!complete)continue;
      rawEvents.push({m,split:splitOf(m),t,symbol:x.s,side,dir,z4:z,gap4:gap,signFlip,decel,rankFade,decelRankFade,exhaustion,persistence,forwards});
    }
  }
}

const lastSeen=new Map(),events=[];
for(const e of rawEvents.sort((a,b)=>a.t-b.t)){
  const k=`${e.symbol}|${e.side}`,last=lastSeen.get(k)??-Infinity;
  if(e.t-last<4*H)continue;
  lastSeen.set(k,e.t);events.push(e);
}

const conditions={
  baseline:e=>true,
  sign_flip:e=>e.signFlip,
  decel_rank_fade:e=>e.decelRankFade,
  exhaustion:e=>e.exhaustion,
  persistence:e=>e.persistence
};
const zThresholds=[1.5,2,3];
function summarize(list){
  const out={n:list.length};
  for(const h of HORIZONS){
    const rev=list.map(e=>e.forwards[h].reversion),cont=list.map(e=>e.forwards[h].continuation),rel=list.map(e=>e.forwards[h].rel);
    out[`h${h}`]={
      meanRel:pct(mean(rel)),medianRel:pct(median(rel)),
      meanReversion:pct(mean(rev)),reversionHit:rev.length?+(rev.filter(x=>x>0).length/rev.length).toFixed(4):null,
      meanContinuation:pct(mean(cont)),continuationHit:cont.length?+(cont.filter(x=>x>0).length/cont.length).toFixed(4):null
    };
  }
  out.meanZ=list.length?+mean(list.map(e=>e.z4)).toFixed(3):null;
  out.meanGap4=pct(mean(list.map(e=>e.gap4)));
  return out;
}
const matrix={};
for(const split of ['discovery','validation','evaluation','all']){
  matrix[split]={};
  for(const side of ['leader','loser','both']){
    matrix[split][side]={};
    for(const z of zThresholds){
      matrix[split][side][`z${z}`]={};
      for(const [name,fn] of Object.entries(conditions)){
        const list=events.filter(e=>(split==='all'||e.split===split)&&(side==='both'||e.side===side)&&e.z4>=z&&fn(e));
        matrix[split][side][`z${z}`][name]=summarize(list);
      }
    }
  }
}
function routeGate(side){
  const checks=[];
  for(const split of ['discovery','validation','evaluation']){
    const ex=matrix[split][side].z2.exhaustion,ps=matrix[split][side].z2.persistence;
    checks.push({
      split,
      exhaustionN:ex.n,exhaustion2h:ex.h2.meanReversion,exhaustion4h:ex.h4.meanReversion,
      persistenceN:ps.n,persistence2h:ps.h2.meanContinuation,persistence4h:ps.h4.meanContinuation
    });
  }
  const enough=checks.every(x=>x.exhaustionN>=20&&x.persistenceN>=20);
  const exhaustionStable=checks.every(x=>x.exhaustion2h>0&&x.exhaustion4h>0);
  const persistenceStable=checks.every(x=>x.persistence2h>0&&x.persistence4h>0);
  return {enough,exhaustionStable,persistenceStable,pass:enough&&exhaustionStable&&persistenceStable,checks};
}
const gates={leader:routeGate('leader'),loser:routeGate('loser')};
const decision=gates.leader.pass||gates.loser.pass?'RELATION_ROUTER_MECHANISM_FOUND':'NO_STABLE_RELATION_ROUTER_YET';
const monthlyCounts=Object.fromEntries(MONTHS.map(m=>[m,events.filter(e=>e.m===m).length]));
const result={
  decision,
  universePolicy:'causal previous-month Top30 ranking inherited from prior audit; explicit non-crypto/metals blacklist; no production strategy reuse',
  months:MONTHS,
  selectedCounts:Object.fromEntries(MONTHS.map(m=>[m,SELECTED_BY_MONTH[m].length])),
  eventRule:'completed-hour cross-section; top1/bottom1 4h relative extreme; robust MAD z; 4h same-symbol cooldown',
  conditions:['baseline','sign_flip','decel_rank_fade','exhaustion=sign_flip OR (decel AND rank_fade)','persistence=directional 1h return in cross-sectional top quartile'],
  horizonsHours:HORIZONS,
  rawEvents:rawEvents.length,dedupedEvents:events.length,monthlyCounts,gates,matrix
};
writeFileSync('/tmp/special-coin-relation-router.json',JSON.stringify(result,null,2));
writeFileSync('/tmp/special-coin-relation-events.json',JSON.stringify(events));
console.log(JSON.stringify({decision,rawEvents:rawEvents.length,dedupedEvents:events.length,selectedCounts:result.selectedCounts,gates,all:matrix.all.both.z2},null,2));
