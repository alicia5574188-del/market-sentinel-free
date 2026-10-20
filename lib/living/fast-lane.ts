/**
 * B2/B3 fast lane: whole-market burst detector, a pure state machine fed every hub refresh (~2s) from the tape.
 * States: CALM → ALERT (→ CONFIRMED) → FAKE | EXHAUST → cooldown. Thresholds are the spec's initial values (config.FAST);
 * B7 can move the alert strength thresholds by ±0.5 a week (state.adjust.z).
 */
import {FAST} from "./config.ts";
import type {LivingTape,Basket} from "./tape.ts";
import {median,mad,r6,finite} from "./util.ts";

export type Side="LONG"|"SHORT";
export type W=30|60|180|300;
const WINDOWS=FAST.windows as readonly W[];
export type FastSample={at:number;healthy:boolean;reason:string|null;warm:boolean;fresh:number;disagreement:number;
  B:Record<W,number>;beta:Record<W,number>;z:Record<W,number>;btc60:number|null;eth60:number|null;btcZ60:number|null;ethZ60:number|null};
export type Episode={id:string;side:Side;phase:"ALERT"|"CONFIRMED";alertAt:number;alertKind:"z60"|"z30";confirmAt:number|null;
  anchorAt:number;anchor:Record<string,number>;level:number;extreme:number;extremeAt:number;retrace:number;maxRetrace:number;
  peakZ:number;quietSince:number|null;pullbackSeen:boolean;newExtremeAfterPullbackAt:number|null;
  confirm?:{b180:number;z180:number;beta180:number;btc:number|null;eth:number|null;agree:number}};
export type EpisodeEnd="FAKE"|"EXHAUST"|"TIMEOUT"|"REVERSED";
export type EpisodeRecord={id:string;side:Side;alertAt:number;alertKind:"z60"|"z30";confirmAt:number|null;endAt:number;end:EpisodeEnd;
  peakZ:number;extreme:number;maxRetrace:number;bucket:0|1|2|3;
  /** signed basket / BTC / ETH move after confirm (or alert) at 1,5,15,30,60,120 minutes; null until matured. */
  after:Record<string,[number|null,number|null,number|null]>;
  /** P8 fade: top-decile leaders at the end, and their signed move 30m later (negative = leaders reversed). */
  leaders:string[];leadersAfter30:number|null;follow30Net:number|null;entries:number;protections:number};
export type FastEvent={type:"ALERT"|"CONFIRM"|"FAKE"|"EXHAUST"|"TIMEOUT"|"REVERSED";at:number;episodeId:string;side:Side;detail:Record<string,number|string|null>};
export type FastState={v:1;sigma:Record<"30"|"60"|"180"|"300"|"btc"|"eth",number[]>;lastSigmaAt:number;
  streak:{side:Side;n:number;kind:"z60"|"z30";lastAt:number}|null;episode:Episode|null;
  cooldowns:{side:Side;until:number;kind:"END"|"FAKE"}[];adjust:{z:number;at:number;log:{at:number;delta:number;why:string}[]};
  lastSampleAt:number;lastReason:string|null;
  /** missed-move detector (B7): last 15m windows where the basket moved ≥1% without an alert. */
  missed:number[];alertsLog:{at:number;fake:boolean}[]};
export const AFTER_MIN=[1,5,15,30,60,120] as const;

export function initialFast():FastState{
  return {v:1,sigma:{"30":[],"60":[],"180":[],"300":[],btc:[],eth:[]},lastSigmaAt:0,streak:null,episode:null,cooldowns:[],
    adjust:{z:0,at:0,log:[]},lastSampleAt:0,lastReason:null,missed:[],alertsLog:[]};
}
export function normalizeFast(raw:unknown):FastState{
  const v=raw as FastState|undefined,base=initialFast();
  if(!v||v.v!==1||!v.sigma)return base;
  const sig={...base.sigma};for(const k of Object.keys(sig) as (keyof FastState["sigma"])[])if(Array.isArray(v.sigma[k]))sig[k]=v.sigma[k].filter(finite).slice(-FAST.sigmaKeep);
  return {...base,...v,sigma:sig,episode:v.episode??null,cooldowns:Array.isArray(v.cooldowns)?v.cooldowns:[],
    adjust:v.adjust?.log?v.adjust:base.adjust,missed:Array.isArray(v.missed)?v.missed:[],alertsLog:Array.isArray(v.alertsLog)?v.alertsLog:[]};
}
const sigmaOf=(xs:number[],floor:number)=>Math.max(floor,1.4826*(xs.length?mad(xs):0));
const sideOf=(v:number):Side=>v>=0?"LONG":"SHORT";
const sgn=(s:Side)=>s==="LONG"?1:-1;

/** B2: the per-sample basket read. */
export function sampleBasket(tape:LivingTape,basket:Basket,state:FastState,now:number):FastSample{
  const members=basket.members;let fresh=0,warmCount=0;const dis:number[]=[];
  const B={} as Record<W,number>,beta={} as Record<W,number>,z={} as Record<W,number>;
  const rets:Record<W,number[]>={30:[],60:[],180:[],300:[]};
  for(const s of members){
    if(!tape.fresh(s,now))continue;fresh++;
    const m=tape.meta.get(s);if(m)dis.push(m.disagreement);
    if(tape.coverageMs(s,now)>=300_000)warmCount++;
    for(const w of WINDOWS){const r=tape.ret(s,now,w);if(r!=null)rets[w].push(r);}
  }
  for(const w of WINDOWS){
    const xs=rets[w],b=xs.length>=10?median(xs):0;B[w]=b;
    const sd=Math.sign(b);beta[w]=xs.length?xs.filter(r=>Math.abs(r)>FAST.breadthMove&&Math.sign(r)===sd).length/xs.length:0;
    z[w]=b/sigmaOf(state.sigma[String(w) as "30"],FAST.sigmaFloor[w]);
  }
  const btc60=tape.ret("BTC_USDT",now,60),eth60=tape.ret("ETH_USDT",now,60);
  const disagreement=dis.length?median(dis):0;
  const warm=warmCount>=FAST.minFresh&&state.sigma["60"].length>=FAST.sigmaMinSamples;
  const reason=fresh<FAST.minFresh?`新鲜报价币数 ${fresh}<${FAST.minFresh}`:disagreement>=FAST.maxDisagreement?`各交易所中间价分歧 ${(disagreement*100).toFixed(2)}%≥0.3%`
    :!warm?"暖机中（2秒点不足5分钟或强度基准不足30分钟）":null;
  return {at:now,healthy:reason==null,reason,warm,fresh,disagreement,B,beta,z,btc60,eth60,
    btcZ60:btc60==null?null:btc60/sigmaOf(state.sigma.btc,FAST.sigmaFloor[60]),
    ethZ60:eth60==null?null:eth60/sigmaOf(state.sigma.eth,FAST.sigmaFloor[60])};
}
function pushSigma(state:FastState,s:FastSample){
  if(s.at-state.lastSigmaAt<FAST.sigmaEveryMs||s.fresh<FAST.minFresh)return;
  state.lastSigmaAt=s.at;
  for(const w of WINDOWS){const xs=state.sigma[String(w) as "30"];xs.push(r6(s.B[w]));if(xs.length>FAST.sigmaKeep)xs.splice(0,xs.length-FAST.sigmaKeep);}
  if(s.btc60!=null){state.sigma.btc.push(r6(s.btc60));if(state.sigma.btc.length>FAST.sigmaKeep)state.sigma.btc.shift();}
  if(s.eth60!=null){state.sigma.eth.push(r6(s.eth60));if(state.sigma.eth.length>FAST.sigmaKeep)state.sigma.eth.shift();}
}
/** Basket level of an episode: median over members of signed move since the anchor. */
export function episodeLevel(tape:LivingTape,ep:Pick<Episode,"side"|"anchor">,now:number){
  const d=sgn(ep.side),xs:number[]=[];
  for(const [s,a] of Object.entries(ep.anchor)){if(s==="BTC_USDT"||s==="ETH_USDT")continue;const l=tape.last(s);if(l&&now-l.at<=FAST.freshMs&&a>0)xs.push(d*(l.mid/a-1));}
  return xs.length>=10?median(xs):NaN;
}
export function coinMove(tape:LivingTape,ep:Pick<Episode,"side"|"anchor">,symbol:string,now:number){
  const a=ep.anchor[symbol],l=tape.last(symbol);if(!a||!l||now-l.at>FAST.freshMs)return null;return sgn(ep.side)*(l.mid/a-1);
}
function alertSide(s:FastSample,adj:number):{side:Side;kind:"z60"|"z30"}|null{
  for(const side of ["LONG","SHORT"] as Side[]){
    const d=sgn(side);
    const majors=(s.btcZ60!=null&&d*s.btcZ60>=FAST.alertMajorZ60)||(s.ethZ60!=null&&d*s.ethZ60>=FAST.alertMajorZ60);
    if(d*s.z[60]>=FAST.alertZ60+adj&&Math.sign(s.B[60])===d&&s.beta[60]>=FAST.alertBeta60&&majors)return{side,kind:"z60"};
    if(d*s.z[30]>=FAST.alertZ30+adj&&Math.sign(s.B[30])===d&&s.beta[30]>=FAST.alertBeta30)return{side,kind:"z30"};
  }
  return null;
}
export function bucketOf(z:number):0|1|2|3{const a=Math.abs(z);return a>=FAST.bucketEdges[2]?3:a>=FAST.bucketEdges[1]?2:a>=FAST.bucketEdges[0]?1:0;}

/** One fast-lane step. Pure apart from reading the tape; returns the new state, events, and a finished record if any. */
export function stepFast(prev:FastState,tape:LivingTape,basket:Basket,now:number):{state:FastState;sample:FastSample;events:FastEvent[];ended:EpisodeRecord|null}{
  const state:FastState={...prev,sigma:prev.sigma,cooldowns:prev.cooldowns.filter(c=>c.until>now),episode:prev.episode?{...prev.episode}:null};
  const sample=sampleBasket(tape,basket,state,now),events:FastEvent[]=[];let ended:EpisodeRecord|null=null;
  pushSigma(state,sample);state.lastSampleAt=now;state.lastReason=sample.reason;
  const adj=state.adjust.z;
  const finish=(ep:Episode,end:EpisodeEnd,detail:Record<string,number|string|null>)=>{
    events.push({type:end,at:now,episodeId:ep.id,side:ep.side,detail});
    state.cooldowns.push({side:ep.side,until:now+(end==="FAKE"?FAST.fakeCooldownMs:FAST.cooldownMs),kind:end==="FAKE"?"FAKE":"END"});
    state.alertsLog.push({at:ep.alertAt,fake:end==="FAKE"});state.alertsLog=state.alertsLog.filter(a=>now-a.at<=FAST.weekMs).slice(-400);
    const movers=Object.keys(ep.anchor).filter(s=>s!=="BTC_USDT"&&s!=="ETH_USDT").map(s=>[s,coinMove(tape,ep,s,now)] as const)
      .filter((x):x is readonly [string,number]=>x[1]!=null).sort((a,b)=>b[1]-a[1]);
    ended={id:ep.id,side:ep.side,alertAt:ep.alertAt,alertKind:ep.alertKind,confirmAt:ep.confirmAt,endAt:now,end,peakZ:r6(ep.peakZ),
      extreme:r6(ep.extreme),maxRetrace:r6(ep.maxRetrace),bucket:bucketOf(ep.peakZ),
      after:{},leaders:movers.slice(0,Math.max(1,Math.round(movers.length*.1))).map(x=>x[0]).slice(0,6),leadersAfter30:null,follow30Net:null,entries:0,protections:0};
    state.episode=null;
  };
  const ep=state.episode;
  if(ep){
    const level=episodeLevel(tape,ep,now);
    if(Number.isFinite(level)){
      ep.level=level;
      if(level>ep.extreme){
        if(ep.pullbackSeen)ep.newExtremeAfterPullbackAt=now;
        ep.extreme=level;ep.extremeAt=now;
      }
      ep.retrace=ep.extreme>0?Math.max(0,(ep.extreme-level)/ep.extreme):0;ep.maxRetrace=Math.max(ep.maxRetrace,ep.retrace);
      if(ep.retrace>=FAST.pullBasketMin)ep.pullbackSeen=true;
      ep.peakZ=Math.max(ep.peakZ,sgn(ep.side)*sample.z[60]);
    }
    const age=now-ep.alertAt;
    const opposite=sample.healthy?alertSide(sample,adj):null;
    if(opposite&&opposite.side!==ep.side&&state.streak?.side===opposite.side&&state.streak.n+1>=FAST.alertSamples){
      // An opposite alert inside the 5-minute fake window is a fake-out (the V turn); later it ends the episode as a reversal.
      if(age<=FAST.fakeWithinMs)finish(ep,"FAKE",{retrace:r6(ep.retrace),extreme:r6(ep.extreme),ageSec:Math.round(age/1000),reversal:1});
      else finish(ep,"REVERSED",{level:r6(ep.level),retrace:r6(ep.retrace),ageSec:Math.round(age/1000)});
    }else if(age<=FAST.fakeWithinMs&&ep.extreme>=FAST.fakeMinExtreme&&ep.retrace>=FAST.fakeRetrace){
      finish(ep,"FAKE",{retrace:r6(ep.retrace),extreme:r6(ep.extreme),ageSec:Math.round(age/1000)});
    }else if(age>=FAST.maxEpisodeMs){
      finish(ep,"TIMEOUT",{ageSec:Math.round(age/1000)});
    }else{
      if(sample.healthy){
        const zs=sgn(ep.side)*sample.z[60];
        if(zs<1){ep.quietSince??=now;}else ep.quietSince=null;
        const quiet=ep.quietSince!=null&&now-ep.quietSince>=FAST.exhaustQuietMs&&now-ep.extremeAt>=FAST.exhaustNoExtremeMs;
        if(quiet||(age>FAST.fakeWithinMs&&ep.retrace>=FAST.exhaustRetrace)){
          finish(ep,"EXHAUST",{retrace:r6(ep.retrace),quiet:quiet?1:0,ageSec:Math.round(age/1000)});
        }else if(ep.phase==="ALERT"&&age<=FAST.confirmWithinMs){
          const d=sgn(ep.side),btcA=ep.anchor.BTC_USDT,ethA=ep.anchor.ETH_USDT,btcL=tape.last("BTC_USDT"),ethL=tape.last("ETH_USDT");
          const btc=btcA&&btcL?d*(btcL.mid/btcA-1):null,eth=ethA&&ethL?d*(ethL.mid/ethA-1):null;
          const twelve=["BTC_USDT","ETH_USDT",...basket.top10];
          const agree=twelve.filter(s=>{const m=coinMove(tape,ep,s,now);return m!=null&&m>0;}).length;
          const ok=d*sample.B[180]>=FAST.confirmB180&&d*sample.z[180]>=FAST.confirmZ180&&sample.beta[180]>=FAST.confirmBeta180
            &&Math.sign(sample.B[180])===d&&ep.retrace<=FAST.confirmMaxRetrace
            &&((btc!=null&&btc>=FAST.confirmBtc)||(eth!=null&&eth>=FAST.confirmEth))&&agree>=FAST.confirmTopAgree;
          if(ok){
            ep.phase="CONFIRMED";ep.confirmAt=now;
            ep.confirm={b180:r6(sample.B[180]),z180:r6(sample.z[180]),beta180:r6(sample.beta[180]),btc:btc==null?null:r6(btc),eth:eth==null?null:r6(eth),agree};
            events.push({type:"CONFIRM",at:now,episodeId:ep.id,side:ep.side,detail:{...ep.confirm,level:r6(ep.level),retrace:r6(ep.retrace)}});
          }
        }
      }
    }
  }
  // Alert detection (also while an episode runs, for the streak / reversal bookkeeping).
  const hit=sample.healthy?alertSide(sample,adj):null;
  if(hit){
    if(state.streak&&state.streak.side===hit.side&&now-state.streak.lastAt<=FAST.freshMs+2_000)state.streak={...state.streak,n:state.streak.n+1,lastAt:now};
    else state.streak={side:hit.side,n:1,kind:hit.kind,lastAt:now};
  }else state.streak=null;
  if(!state.episode&&state.streak&&state.streak.n>=FAST.alertSamples){
    const side=state.streak.side,blocked=state.cooldowns.some(c=>c.side===side&&c.kind==="FAKE"&&c.until>now);
    if(!blocked){
      const anchorAt=now-60_000,anchor:Record<string,number>={};
      for(const s of [...basket.members,"BTC_USDT","ETH_USDT"]){const p=tape.midAt(s,anchorAt);if(p&&p.mid>0)anchor[s]=p.mid;}
      const e:Episode={id:`fe-${Math.floor(now/1000).toString(36)}-${side[0]}`,side,phase:"ALERT",alertAt:now,alertKind:state.streak.kind,confirmAt:null,
        anchorAt,anchor,level:0,extreme:0,extremeAt:now,retrace:0,maxRetrace:0,peakZ:Math.abs(sample.z[60]),quietSince:null,pullbackSeen:false,newExtremeAfterPullbackAt:null};
      const lv=episodeLevel(tape,e,now);if(Number.isFinite(lv)){e.level=lv;e.extreme=Math.max(0,lv);}
      state.episode=e;
      events.push({type:"ALERT",at:now,episodeId:e.id,side,detail:{kind:e.alertKind,z60:r6(sample.z[60]),z30:r6(sample.z[30]),beta60:r6(sample.beta[60]),
        beta30:r6(sample.beta[30]),btcZ60:sample.btcZ60==null?null:r6(sample.btcZ60),ethZ60:sample.ethZ60==null?null:r6(sample.ethZ60),level:r6(e.level)}});
    }
  }
  return {state,sample,events,ended};
}
/** Same-side fast entries are blocked during a cooldown (B3). */
export function fastFollowBlocked(state:FastState,side:Side,now:number){return state.cooldowns.some(c=>c.side===side&&c.until>now);}

/** B7: fill matured post-episode moves from the tape's 1m mid bars. Returns true when anything changed. */
export function matureRecords(records:EpisodeRecord[],tape:LivingTape,members:string[],now:number){
  let changed=false;
  const close=(s:string,at:number)=>closeAt(tape.m1.get(s),at,now);
  for(const r of records){
    const base=r.confirmAt??r.alertAt,d=r.side==="LONG"?1:-1;
    for(const m of AFTER_MIN){
      const key=String(m);if(r.after[key]&&r.after[key]!.every(x=>x!=null))continue;
      const at=base+m*60_000;if(at+60_000>now)continue;
      const xs:number[]=[];for(const s of members){const a=close(s,base),b=close(s,at);if(a&&b)xs.push(d*(b/a-1));}
      const btcA=close("BTC_USDT",base),btcB=close("BTC_USDT",at),ethA=close("ETH_USDT",base),ethB=close("ETH_USDT",at);
      r.after[key]=[xs.length>=10?r6(median(xs)):null,btcA&&btcB?r6(d*(btcB/btcA-1)):null,ethA&&ethB?r6(d*(ethB/ethA-1)):null];changed=true;
      if(m===30&&r.after[key]![0]!=null)r.follow30Net=r6(r.after[key]![0]!-2*(.0007+.00025));
    }
    if(r.leadersAfter30==null&&r.endAt+31*60_000<=now){
      const xs:number[]=[];for(const s of r.leaders){const a=close(s,r.endAt),b=close(s,r.endAt+30*60_000);if(a&&b)xs.push(d*(b/a-1));}
      if(xs.length){r.leadersAfter30=r6(median(xs));changed=true;}
    }
  }
  return changed;
}
/** B7 fast multiple per strength bucket from the live episode record. */
export function fastMultiple(records:EpisodeRecord[],bucket:0|1|2|3){
  const xs=records.filter(r=>r.bucket===bucket&&r.confirmAt!=null&&r.follow30Net!=null).map(r=>r.follow30Net!);
  if(xs.length<FAST.step2)return 1;
  const meanAll=xs.reduce((a,b)=>a+b,0)/xs.length,worst=[...xs].sort((a,b)=>a-b).slice(0,3).reduce((a,b)=>a+b,0)*100;// R≈1% stop
  const last8=xs.slice(-8),m8=last8.reduce((a,b)=>a+b,0)/last8.length;
  let mult=1;
  if(meanAll>0&&worst>=FAST.worst3)mult=2;
  if(xs.length>=FAST.step3&&meanAll>0&&worst>=FAST.worst3)mult=3;
  if(m8<0)mult=Math.max(1,mult-1);
  return mult;
}
/** B7 weekly alert-threshold step: false alerts >60% → +0.5; a missed ≥1% basket move → −0.5. One step a week, logged. */
export function weeklyAdjust(state:FastState,now:number){
  if(now-state.adjust.at<FAST.weekMs)return false;
  const week=state.alertsLog.filter(a=>now-a.at<=FAST.weekMs),fakeShare=week.length?week.filter(a=>a.fake).length/week.length:0;
  const missed=state.missed.filter(t=>now-t<=FAST.weekMs).length;
  let delta=0,why="";
  if(week.length>=5&&fakeShare>FAST.fakeShareUp){delta=.5;why=`过去一周 ${week.length} 次警报里 ${(fakeShare*100).toFixed(0)}% 是假动作`;}
  else if(missed>0){delta=-.5;why=`过去一周漏掉 ${missed} 次 15 分钟内一篮子 ≥1% 的大行情`;}
  if(state.adjust.at===0){state.adjust={...state.adjust,at:now};return false;}// first week: start the clock only
  state.adjust={z:Math.max(-1.5,Math.min(2,state.adjust.z+delta)),at:now,log:[...state.adjust.log,{at:now,delta,why:why||"无调整"}].slice(-20)};
  return true;
}
/** B7 missed-move detector, call about once a minute. */
export function noteMissed(state:FastState,tape:LivingTape,members:string[],now:number){
  const xs:number[]=[];
  for(const s of members){const rows=tape.m1.get(s);if(!rows||rows.length<16)continue;const a=rows.at(-16)!,b=rows.at(-1)!;if(a.close>0)xs.push(b.close/a.close-1);}
  if(xs.length<20)return;
  const m=median(xs);if(Math.abs(m)<FAST.missedMove)return;
  const alerted=state.episode!=null||state.alertsLog.some(a=>now-a.at<=15*60_000);
  if(!alerted&&!state.missed.some(t=>now-t<15*60_000)){state.missed.push(now);state.missed=state.missed.slice(-50);}
}
export const sideSign=sgn;export {sideOf};

/** Close of the last completed 1m bar at or before `at` (binary search; tolerates gaps up to 3 minutes). */
export function closeAt(rows:{time:number;close:number}[]|undefined,at:number,now:number){
  if(!rows?.length)return null;const t=Math.floor(at/60_000)*60;let lo=0,hi=rows.length-1,best=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(rows[m]!.time<=t){best=m;lo=m+1;}else hi=m-1;}
  if(best<0)return null;const r=rows[best]!;if(t-r.time>180||(r.time+60)*1000>now)return null;return r.close;
}
