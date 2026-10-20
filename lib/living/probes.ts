/**
 * C1 step 1 — "what is the market paying for right now". After every 5m close each probe looks for coins showing its
 * behaviour, registers ONE observation per (bar, probe) (coins averaged, so a whole-market move is not counted many times),
 * enters at the NEXT bar's open, and scores it net of the 0.19% round trip when its horizon matures. Scores are an EWMA
 * (half-life 6h; 48h for P6/P7) with a block-adjusted t; "rewarded" = score > 0.10%, t ≥ 2, ≥ 30 non-overlapping blocks.
 * Persistence self-check: correlation of consecutive 6h scores over 7 days; < 7 days or corr ≤ 0 → probe size only.
 */
import {STEPS,LIVING_MAX_VALUE_BYTES} from "./config.ts";
import type {MidBar} from "./tape.ts";
import {median,mean,quantile,corr,r6,clamp,bytesOf} from "./util.ts";

export type ProbeId="P1"|"P2"|"P3"|"P4"|"P5"|"P6"|"P7"|"P9"|"MOM";
export const PROBES:ProbeId[]=["P1","P2","P3","P4","P5","P6","P7","P9","MOM"];
export const PROBE_META:Record<ProbeId,{label:string;horizon:number;halfLife:number;payoff:"raw"|"excess";funding?:boolean}>={
  P1:{label:"突破延续",horizon:60,halfLife:STEPS.halfLifeShortMs,payoff:"raw"},
  P2:{label:"区间边缘回归",horizon:120,halfLife:STEPS.halfLifeShortMs,payoff:"raw"},
  P3:{label:"领涨延续",horizon:60,halfLife:STEPS.halfLifeShortMs,payoff:"excess"},
  P4:{label:"落后补涨",horizon:60,halfLife:STEPS.halfLifeShortMs,payoff:"excess"},
  P5:{label:"趋势回调",horizon:120,halfLife:STEPS.halfLifeShortMs,payoff:"raw"},
  P6:{label:"过度延伸反转",horizon:180,halfLife:STEPS.halfLifeLongMs,payoff:"raw"},
  P7:{label:"资金拥挤反转",horizon:360,halfLife:STEPS.halfLifeLongMs,payoff:"raw",funding:true},
  P9:{label:"BTC 带动",horizon:30,halfLife:STEPS.halfLifeShortMs,payoff:"raw"},
  MOM:{label:"动量（原残差动量）",horizon:60,halfLife:STEPS.halfLifeShortMs,payoff:"raw"},
};
export type Side="LONG"|"SHORT";
export type Trigger={probe:ProbeId;symbol:string;side:Side;strength:number;target?:number|null;stop?:number|null;ref?:number|null};
export type ProbeContext={at:number;members:string[];bars:(s:string)=>MidBar[];funding:Record<string,number>;oi1h:Record<string,number|null>;
  momentum:{symbol:string;side:Side}[]};
const dir=(s:Side)=>s==="LONG"?1:-1;
export function atr(rows:MidBar[],n=14){
  const xs:number[]=[];for(let i=Math.max(1,rows.length-n);i<rows.length;i++){const r=rows[i]!,p=rows[i-1]!.close;
    xs.push(Math.max(r.high-r.low,Math.abs(r.high-p),Math.abs(r.low-p)));}
  return xs.length?mean(xs):NaN;
}
export function efficiency(rows:MidBar[]){
  if(rows.length<3)return 0;let path=0;for(let i=1;i<rows.length;i++)path+=Math.abs(rows[i]!.close-rows[i-1]!.close);
  return path>0?Math.abs(rows.at(-1)!.close-rows[0]!.close)/path:0;
}
const ret=(rows:MidBar[],bars:number)=>rows.length>bars?rows.at(-1)!.close/rows[rows.length-1-bars]!.close-1:NaN;
/** All probe triggers on the bar that just closed (ctx.at = its close time). */
export function detectProbes(ctx:ProbeContext):Trigger[]{
  const out:Trigger[]=[],rows:Record<string,MidBar[]>={};
  for(const s of ctx.members){const r=ctx.bars(s);if(r.length>=13&&(r.at(-1)!.time+300)*1000===ctx.at)rows[s]=r;}
  const syms=Object.keys(rows);
  for(const s of syms){
    const r=rows[s]!,last=r.at(-1)!,A=atr(r);if(!(A>0))continue;
    if(r.length>=50){
      const prior=r.slice(-49,-1),hi=Math.max(...prior.map(x=>x.high)),lo=Math.min(...prior.map(x=>x.low));
      // P1 breakout
      if(last.close>hi+.2*A)out.push({probe:"P1",symbol:s,side:"LONG",strength:(last.close-hi)/A,ref:hi});
      else if(last.close<lo-.2*A)out.push({probe:"P1",symbol:s,side:"SHORT",strength:(lo-last.close)/A,ref:lo});
      // P2 range edge reversion (range measured before the touching bar)
      const prev=r.at(-2)!,base=r.slice(-50,-2),bh=Math.max(...base.map(x=>x.high)),bl=Math.min(...base.map(x=>x.low)),W=bh-bl;
      if(W>0&&W<=6*A&&efficiency(base)<.3){
        if(prev.high>=bh-.1*W&&last.close<bh-.1*W&&last.close>bl)out.push({probe:"P2",symbol:s,side:"SHORT",strength:1,target:(bh+bl)/2,stop:bh+.3*A,ref:bh});
        else if(prev.low<=bl+.1*W&&last.close>bl+.1*W&&last.close<bh)out.push({probe:"P2",symbol:s,side:"LONG",strength:1,target:(bh+bl)/2,stop:bl-.3*A,ref:bl});
      }
      // P5 trend pullback
      const w=r.slice(-48),e=efficiency(w),up=w.at(-1)!.close>w[0]!.close;
      if(e>=.5){
        const ext=up?Math.max(...w.map(x=>x.high)):Math.min(...w.map(x=>x.low)),ei=w.findIndex(x=>(up?x.high:x.low)===ext);
        if(ei>=0&&ei<w.length-2){
          const before=w.slice(0,ei+1),start=up?Math.min(...before.map(x=>x.low)):Math.max(...before.map(x=>x.high)),leg=Math.abs(ext-start);
          const after=w.slice(ei+1),pull=up?Math.min(...after.map(x=>x.low)):Math.max(...after.map(x=>x.high)),depth=leg>0?Math.abs(ext-pull)/leg:0;
          const resume=up?last.close>last.open&&last.close>prev.close:last.close<last.open&&last.close<prev.close;
          if(depth>=.38&&depth<=.62&&resume)out.push({probe:"P5",symbol:s,side:up?"LONG":"SHORT",strength:e,target:ext,stop:pull,ref:pull});
        }
      }
      // P7 crowding reversal
      const f=ctx.funding[s],oi=ctx.oi1h[s],fs=Object.values(ctx.funding).filter(Number.isFinite);
      if(f!=null&&oi!=null&&fs.length>=20&&oi>=.03){
        const hiF=quantile(fs,.95),loF=quantile(fs,.05),m4=last.close-w[0]!.close,hourly=A*Math.sqrt(12);
        if(f>0&&f>=hiF&&m4>=2*hourly)out.push({probe:"P7",symbol:s,side:"SHORT",strength:f*1e4,ref:Math.max(...w.map(x=>x.high))});
        else if(f<0&&f<=loF&&-m4>=2*hourly)out.push({probe:"P7",symbol:s,side:"LONG",strength:-f*1e4,ref:Math.min(...w.map(x=>x.low))});
      }
    }
    // P6 over-extension reversal over 10h
    if(r.length>=121){
      const w=r.slice(-121),m=last.close/w[0]!.close-1,rs:number[]=[];
      for(let i=1;i<w.length;i++)rs.push(w[i]!.close/w[i-1]!.close-1);
      const sd=Math.sqrt(mean(rs.map(x=>x*x))),daily=sd*Math.sqrt(288);
      if(Math.abs(m)>=.06||(daily>0&&Math.abs(m)>=3*daily)){
        const up=m>0,ext=up?Math.max(...w.map(x=>x.high)):Math.min(...w.map(x=>x.low)),ei=w.findIndex(x=>(up?x.high:x.low)===ext);
        if(ei<=w.length-4)out.push({probe:"P6",symbol:s,side:up?"SHORT":"LONG",strength:Math.abs(m),ref:ext});
      }
    }
  }
  // P3 / P4 cross-section over 60 minutes
  const r60=syms.map(s=>[s,ret(rows[s]!,12)] as const).filter((x):x is readonly [string,number]=>Number.isFinite(x[1]));
  if(r60.length>=20){
    const m=median(r60.map(x=>x[1])),sorted=[...r60].sort((a,b)=>b[1]-a[1]),k=Math.max(1,Math.round(sorted.length*.10));
    for(const [s,v] of sorted.slice(0,k))out.push({probe:"P3",symbol:s,side:"LONG",strength:v-m});
    for(const [s,v] of sorted.slice(-k))out.push({probe:"P3",symbol:s,side:"SHORT",strength:m-v});
    const agree=r60.filter(x=>Math.sign(x[1])===Math.sign(m)).length/r60.length;
    if(Math.abs(m)>=.003&&agree>=.65){
      const k2=Math.max(1,Math.round(sorted.length*.20)),lag=m>0?sorted.slice(-k2):sorted.slice(0,k2);
      for(const [s,v] of lag)out.push({probe:"P4",symbol:s,side:m>0?"LONG":"SHORT",strength:Math.abs(m-v)});
    }
  }
  // P9 BTC lead
  const btc=ctx.bars("BTC_USDT");
  if(btc.length>=25&&(btc.at(-1)!.time+300)*1000===ctx.at){
    const b15=ret(btc,3);
    if(Math.abs(b15)>=.004){
      const br:number[]=[];for(let i=btc.length-24;i<btc.length;i++)br.push(btc[i]!.close/btc[i-1]!.close-1);
      const vb=mean(br.map(x=>x*x));
      const betas=syms.filter(s=>s!=="ETH_USDT").flatMap(s=>{const r=rows[s]!;if(r.length<25)return[];const xs:number[]=[];
        for(let i=r.length-24;i<r.length;i++)xs.push(r[i]!.close/r[i-1]!.close-1);
        const cov=mean(xs.map((x,i)=>x*br[i]!));return vb>0?[[s,cov/vb] as const]:[];}).sort((a,b)=>b[1]-a[1]);
      for(const [s,b] of betas.slice(0,Math.max(1,Math.round(betas.length*.3))))if(b>0)out.push({probe:"P9",symbol:s,side:b15>0?"LONG":"SHORT",strength:b});
    }
  }
  for(const m of ctx.momentum)if(rows[m.symbol])out.push({probe:"MOM",symbol:m.symbol,side:m.side,strength:1});
  return out;
}

type Member={s:string;side:Side;entry:number|null;target:number|null;stop:number|null;fund:number|null};
export type PendingObs={id:string;probe:ProbeId;at:number;h:number;dir:"U"|"D"|"F";members:Member[]};
type Acc={w:number;wx:number;wxx:number;w2:number;at:number};
export type ProbeScore={probe:ProbeId;score:number;t:number;n:number;rewarded:boolean;persistence:"unverified"|"ok"|"negative";corr:number|null;
  regimeScore:number|null;regimeN:number};
export type CompletedObs={id:string;probe:ProbeId;at:number;value:number;members:{s:string;side:Side;v:number}[]};
export type ProbeState={v:1;pending:PendingObs[];acc:Record<string,Acc>;blocks:Record<string,number[]>;
  windows:Record<string,[number,number,number][]>;firstAt:number|null;lastBarAt:number;
  oi:Record<string,[number,number][]>;series:[number,string,number,number,number][]};
export function initialProbes():ProbeState{
  return {v:1,pending:[],acc:{},blocks:{},windows:{},firstAt:null,lastBarAt:0,oi:{},series:[]};
}
export function normalizeProbes(raw:unknown):ProbeState{
  const v=raw as ProbeState|undefined;if(!v||v.v!==1||!Array.isArray(v.pending))return initialProbes();
  return {...initialProbes(),...v};
}
const decay=(a:Acc,now:number,half:number)=>{const k=Math.pow(.5,Math.max(0,now-a.at)/half);a.w*=k;a.wx*=k;a.wxx*=k;a.w2*=k*k;a.at=now;};
export function registerObservations(state:ProbeState,triggers:Trigger[],at:number,dirTag:"U"|"D"|"F"){
  const by=new Map<ProbeId,Trigger[]>();
  for(const t of triggers){const xs=by.get(t.probe)??[];xs.push(t);by.set(t.probe,xs);}
  for(const [probe,xs] of by){
    const top=[...xs].sort((a,b)=>b.strength-a.strength).slice(0,8);
    state.pending.push({id:`${probe}-${Math.floor(at/1000).toString(36)}`,probe,at,h:PROBE_META[probe].horizon,dir:dirTag,
      members:top.map(t=>({s:t.symbol,side:t.side,entry:null,target:t.target??null,stop:t.stop??null,fund:null}))});
  }
  state.firstAt??=at;
}
/** Matures pending observations from closed 5m bars; returns those that completed. */
export function matureObservations(state:ProbeState,bars:(s:string)=>MidBar[],members:string[],funding:Record<string,number>,now:number):CompletedObs[]{
  const done:CompletedObs[]=[],keep:PendingObs[]=[];
  const bar=(s:string,time:number)=>{const r=bars(s);let lo=0,hi=r.length-1;while(lo<=hi){const m=(lo+hi)>>1;if(r[m]!.time===time)return r[m]!;if(r[m]!.time<time)lo=m+1;else hi=m-1;}return null;};
  for(const o of state.pending){
    const t0=o.at/1000,t1=t0+o.h*60-300;// entry bar opens at o.at; exit = close of the bar that ends at at+h
    if((t1+300)*1000>now){
      if(now-o.at>(o.h+60)*60_000)continue;// data never came: drop
      for(const m of o.members)if(m.entry==null){const b=bar(m.s,t0);if(b)m.entry=b.open;if(o.probe==="P7")m.fund=funding[m.s]??null;}
      keep.push(o);continue;
    }
    const vals:{s:string;side:Side;v:number}[]=[];
    const basketRet=(()=>{const xs:number[]=[];for(const s of members){const a=bar(s,t0),b=bar(s,t1);if(a&&b&&a.open>0)xs.push(b.close/a.open-1);}return xs.length>=10?median(xs):0;})();
    for(const m of o.members){
      const a=bar(m.s,t0),b=bar(m.s,t1);const entry=m.entry??a?.open;if(!entry||!b)continue;
      let exit=b.close;
      if(m.target!=null||m.stop!=null){
        for(let t=t0;t<=t1;t+=300){const x=bar(m.s,t);if(!x)continue;const d=dir(m.side);
          const hitStop=m.stop!=null&&(d>0?x.low<=m.stop:x.high>=m.stop),hitTarget=m.target!=null&&(d>0?x.high>=m.target:x.low<=m.target);
          if(hitStop){exit=m.stop!;break;}if(hitTarget){exit=m.target!;break;}}
      }
      const raw=dir(m.side)*(exit/entry-1);
      let v=PROBE_META[o.probe].payoff==="excess"?raw-dir(m.side)*basketRet:raw;
      if(PROBE_META[o.probe].funding&&m.fund!=null)v+=(m.side==="SHORT"?1:-1)*m.fund*(o.h/480);
      vals.push({s:m.s,side:m.side,v:v-STEPS.cost});
    }
    if(!vals.length)continue;
    const value=mean(vals.map(x=>x.v));
    record(state,o.probe,o.at,value,o.dir,o.h);
    done.push({id:o.id,probe:o.probe,at:o.at,value,members:vals});
  }
  state.pending=keep;
  return done;
}
function record(state:ProbeState,probe:ProbeId,at:number,value:number,dirTag:string,h:number){
  const half=PROBE_META[probe].halfLife,wi=Math.floor(at/STEPS.persistenceWindowMs),keepFrom=wi-Math.ceil(STEPS.persistenceSpanMs/STEPS.persistenceWindowMs)-1;
  for(const key of [probe,`${probe}|${dirTag}`]){
    const a=state.acc[key]??{w:0,wx:0,wxx:0,w2:0,at};decay(a,Math.max(a.at,at),half);
    a.w+=1;a.wx+=value;a.wxx+=value*value;a.w2+=1;state.acc[key]=a;
    const ws=state.windows[key]??[],last=ws.at(-1);
    if(last&&last[0]===wi){last[1]=r6(last[1]+value);last[2]++;}else ws.push([wi,r6(value),1]);
    state.windows[key]=ws.filter(w=>w[0]>=keepFrom);
  }
  // non-overlapping blocks (minutes since epoch) over the last 7 days, overall key only
  const minute=Math.floor(at/60_000),blocks=state.blocks[probe]??[];
  if(!blocks.length||minute>=blocks.at(-1)!+h)blocks.push(minute);
  state.blocks[probe]=blocks.filter(t=>minute-t<=STEPS.persistenceSpanMs/60_000);
}
function accScore(state:ProbeState,key:string,probe:ProbeId,now:number){
  const a0=state.acc[key];if(!a0||a0.w<=0)return{score:0,t:0,n:0};
  const a={...a0};decay(a,Math.max(a.at,now),PROBE_META[probe].halfLife);
  const m=a.wx/a.w,v=Math.max(1e-12,a.wxx/a.w-m*m),kish=a.w*a.w/Math.max(a.w2,1e-12);
  const wi=Math.floor(now/STEPS.persistenceWindowMs),span=Math.ceil(STEPS.persistenceSpanMs/STEPS.persistenceWindowMs);
  const obs=(state.windows[key]??[]).filter(w=>w[0]>wi-span).reduce((n,w)=>n+w[2],0);
  const blocks=(state.blocks[probe]??[]).filter(t=>Math.floor(now/60_000)-t<=STEPS.persistenceSpanMs/60_000).length;
  const n=key===probe?blocks:Math.round(obs*(blocks/Math.max(1,(state.windows[probe]??[]).filter(w=>w[0]>wi-span).reduce((x,w)=>x+w[2],0))));
  const neff=Math.max(1,kish*(obs>0?Math.min(1,blocks/Math.max(1,(state.windows[probe]??[]).filter(w=>w[0]>wi-span).reduce((x,w)=>x+w[2],0))):1));
  return {score:m,t:m/Math.sqrt(v/neff),n};
}
export function probeScore(state:ProbeState,probe:ProbeId,now:number,dirTag?:"U"|"D"|"F"):ProbeScore{
  const all=accScore(state,probe,probe,now),reg=dirTag?accScore(state,`${probe}|${dirTag}`,probe,now):null;
  const ws=(state.windows[probe]??[]).filter(w=>w[2]>0),xs:number[]=[],ys:number[]=[];
  for(let i=1;i<ws.length;i++)if(ws[i]![0]===ws[i-1]![0]+1){xs.push(ws[i-1]![1]/ws[i-1]![2]);ys.push(ws[i]![1]/ws[i]![2]);}
  const c=xs.length>=3?corr(xs,ys):NaN,span=state.firstAt==null?0:now-state.firstAt;
  const persistence=span<STEPS.persistenceSpanMs||xs.length<10||!Number.isFinite(c)?"unverified":c>0?"ok":"negative";
  const regimeOk=!reg||reg.n<10||reg.score>0;
  const rewarded=all.score>STEPS.rewardScore&&all.t>=STEPS.rewardT&&all.n>=STEPS.rewardN&&regimeOk;
  return {probe,score:r6(all.score),t:Math.round(all.t*100)/100,n:all.n,rewarded,persistence,corr:Number.isFinite(c)?Math.round(c*100)/100:null,
    regimeScore:reg?r6(reg.score):null,regimeN:reg?.n??0};
}
export function allScores(state:ProbeState,now:number,dirTag?:"U"|"D"|"F"){return PROBES.map(p=>probeScore(state,p,now,dirTag));}
/** Hourly score time series for the export (bounded). */
export function noteSeries(state:ProbeState,now:number,dirTag:"U"|"D"|"F"){
  const hour=Math.floor(now/3_600_000);if(state.series.length&&Math.floor(state.series.at(-1)![0]/3_600_000)===hour)return false;
  for(const s of allScores(state,now,dirTag))state.series.push([now,s.probe,s.score,s.t,s.n]);
  if(state.series.length>1800)state.series.splice(0,state.series.length-1800);return true;
}
/** OI history for P7 (one sample per 5 minutes per symbol, ~1h kept). */
export function noteOpenInterest(state:ProbeState,oi:Record<string,number>,now:number){
  for(const [s,v] of Object.entries(oi)){if(!(v>0))continue;const xs=state.oi[s]??[];
    if(!xs.length||now-xs.at(-1)![0]>=280_000){xs.push([now,v]);if(xs.length>14)xs.shift();state.oi[s]=xs;}}
}
export function oiChange1h(state:ProbeState,now:number){
  const out:Record<string,number|null>={};
  for(const [s,xs] of Object.entries(state.oi)){const old=xs.find(x=>now-x[0]>=55*60_000&&now-x[0]<=70*60_000),last=xs.at(-1);
    out[s]=old&&last&&old[1]>0?last[1]/old[1]-1:null;}
  return out;
}
/** Bound the stored value below 96KB: oldest series rows, then oldest pending observations. */
export function fitProbes(state:ProbeState){
  let guard=0;
  while(bytesOf(state)>LIVING_MAX_VALUE_BYTES-1024&&guard++<200){
    if(state.series.length>100)state.series.splice(0,Math.ceil(state.series.length*.1));
    else if(state.pending.length>20)state.pending.splice(0,Math.ceil(state.pending.length*.1));
    else{for(const k of Object.keys(state.blocks))state.blocks[k]=state.blocks[k]!.slice(-Math.ceil(state.blocks[k]!.length*.8));}
  }
  return state;
}
export const clampScore=(v:number)=>clamp(v,-1,1);
