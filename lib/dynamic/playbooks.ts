/**
 * dynamic-v1 playbook pool: pure rules over closed bars of one series (+ BTC daily for regime filters), and one simulator that
 * turns them into shadow trades. Entry at the signal bar's close; stops / targets touched intrabar (stop first if both, a gap
 * fills at the open); signal / time exits at a bar close; trails move only in the trade's favour and apply from the next bar.
 * Net % = side × (exit / entry − 1) − 0.19% (round-trip fees). Price %, not ROE. No request, no state.
 */
import {Series,ema,sma,atr,priorMax,priorMin,rollMin,rollMax,IV_SEC,Memo,type Iv} from "./series.ts";
import {SHORT_POOL} from "./playbooks-short.ts";
export const FEE=.0019;
export type Side="LONG"|"SHORT";
export type Entry={stop:number;target?:number|null;maxBars?:number|null;why:string};
export type Pos={ei:number;et:number;ep:number;stop0:number;stop:number;target:number|null;maxBars:number|null;why:string};
/** btcBull: daily regime; btc: BTC bars of the same interval over (at least) the same window (cross-asset playbooks); memo:
 * indicator cache for the series being replayed */
export type Ctx={btcBull:(tSec:number)=>boolean|null;btc?:Series|null;memo?:Memo};
export type Tier="short"|"long";
export type Playbook={id:string;label:string;iv:Iv;side:Side;warm:number;
  /** short = the core pool (holds minutes to ≤ 24 h); long = daily / 4h, record-only by default */
  tier?:Tier;family?:string;familyLabel?:string;
  /** majors = BTC/ETH only; alts = everything but BTC/ETH */
  only?:"majors"|"alts";
  /** minimum stop distance (fraction of entry); short playbooks widen their stops to it */
  minStop?:number;
  prep(s:Series,ctx:Ctx):Record<string,Float64Array>;
  enter(x:Record<string,Float64Array>,s:Series,i:number,ctx:Ctx):Entry|null;
  /** at the close of bar i (> ei): a signal exit and/or a new stop */
  manage?(x:Record<string,Float64Array>,s:Series,i:number,p:Pos):{exit?:string;stop?:number}|null;
  /** short description (dashboard) */
  rule:string};
export type ShadowTrade={id:string;pb:string;side:Side;sym:string;iv:Iv;et:number;xt:number;ep:number;xp:number;stop0:number;net:number;r:number;bars:number;why:string;exit:string};
export type OpenShadow={pb:string;side:Side;sym:string;iv:Iv;et:number;ep:number;stop0:number;stop:number;target:number|null;maxBars:number|null;bars:number;why:string;
  /** the entry happened on the last closed bar (a live entry would be due now) */fresh:boolean};
const ok=(v:number)=>Number.isFinite(v);
const close=(s:Series,i:number)=>s.c[i]!;
/** a bull-regime helper from BTC daily: close of the last daily bar that closed at or before `tSec` > its SMA100 */
export function btcRegime(btc:Series|null|undefined):Ctx{
  if(!btc||btc.n<101)return {btcBull:()=>null};
  const m=sma(btc.c,100);
  return {btcBull:(tSec:number)=>{const i=btc.indexAtOrBefore(tSec-86_400);if(i<0||!ok(m[i]!))return null;return btc.c[i]!>m[i]!;}};
}
const end=(s:Series,i:number)=>s.t[i]!+IV_SEC[s.iv];
// ---------------------------------------------------------------- pool
const donch:Playbook={id:"htf-donch20",label:"日线突破做多",iv:"1d",side:"LONG",warm:101,
  rule:"BTC 日线在 100 日均线上；日线收盘高于前 20 天最高价 → 收盘做多；止损 2×ATR20，之后按 10 日最低上移，没有时间限制",
  prep:s=>({hi:priorMax(s.h,20,s.n),a:atr(s,20),lo:rollMin(s.l,10,s.n)}),
  enter:(x,s,i,ctx)=>{if(ctx.btcBull(end(s,i))!==true)return null;const c=close(s,i),h=x.hi![i]!,a=x.a![i]!;
    return ok(h)&&ok(a)&&c>h?{stop:c-2*a,why:`收盘 ${c} > 20日高 ${h}`}:null;},
  manage:(x,_s,i,p)=>{const l=x.lo![i]!;return ok(l)&&l>p.stop?{stop:l}:null;}};
const breakdown:Playbook={id:"htf-down20",label:"日线跌破做空",iv:"1d",side:"SHORT",warm:101,
  rule:"BTC 日线在 100 日均线下；日线收盘低于前 20 天最低价 → 收盘做空；止损 2×ATR20，之后按 10 日最高下移",
  prep:s=>({lo:priorMin(s.l,20,s.n),a:atr(s,20),hi:rollMax(s.h,10,s.n)}),
  enter:(x,s,i,ctx)=>{if(ctx.btcBull(end(s,i))!==false)return null;const c=close(s,i),l=x.lo![i]!,a=x.a![i]!;
    return ok(l)&&ok(a)&&c<l?{stop:c+2*a,why:`收盘 ${c} < 20日低 ${l}`}:null;},
  manage:(x,_s,i,p)=>{const h=x.hi![i]!;return ok(h)&&h<p.stop?{stop:h}:null;}};
function emaCross(side:Side):Playbook{const L=side==="LONG";return {id:`ema4h-${L?"long":"short"}`,label:`4小时均线${L?"金叉做多":"死叉做空"}`,iv:"4h",side,warm:60,
  rule:`4小时 EMA20 ${L?"上穿":"下穿"} EMA50 → 收盘${L?"做多":"做空"}；止损 2.5×ATR14；反向交叉收盘离场`,
  prep:s=>({f:ema(s.c,20,s.n),w:ema(s.c,50,s.n),a:atr(s,14)}),
  enter:(x,s,i)=>{const f=x.f!,w=x.w!,a=x.a![i]!;if(!ok(w[i-1]!)||!ok(a))return null;const up=f[i-1]!<=w[i-1]!&&f[i]!>w[i]!,dn=f[i-1]!>=w[i-1]!&&f[i]!<w[i]!;
    const c=close(s,i);return (L?up:dn)?{stop:L?c-2.5*a:c+2.5*a,why:`EMA20 ${L?"上穿":"下穿"} EMA50`}:null;},
  manage:(x,_s,i)=>{const f=x.f![i]!,w=x.w![i]!;return (L?f<w:f>w)?{exit:"反向交叉"}:null;}};}
function boxBreak(side:Side):Playbook{const L=side==="LONG";return {id:`box1h-${L?"long":"short"}`,label:`1小时箱体${L?"上破做多":"下破做空"}`,iv:"1h",side,warm:50,
  rule:`前 48 根 1 小时 K 线高低差 ≤ 6%（箱体），收盘${L?"突破箱顶":"跌破箱底"} → ${L?"做多":"做空"}；止损箱体中线，目标 2R，最多 24 小时`,
  prep:s=>({hi:priorMax(s.h,48,s.n),lo:priorMin(s.l,48,s.n)}),
  enter:(x,s,i)=>{const h=x.hi![i]!,l=x.lo![i]!,c=close(s,i);if(!ok(h)||!ok(l)||(h-l)/c>.06)return null;const mid=(h+l)/2;
    if(L&&c>h)return {stop:mid,target:c+2*(c-mid),maxBars:24,why:`箱体 ${((h-l)/c*100).toFixed(1)}% 上破`};
    if(!L&&c<l)return {stop:mid,target:c-2*(mid-c),maxBars:24,why:`箱体 ${((h-l)/c*100).toFixed(1)}% 下破`};return null;}};}
function pullback(side:Side):Playbook{const L=side==="LONG";return {id:`pull4h-${L?"long":"short"}`,label:`4小时顺势回踩${L?"做多":"做空"}`,iv:"4h",side,warm:60,
  rule:`4小时 EMA50 ${L?"向上":"向下"}且价格在其${L?"上":"下"}方，K 线${L?"回踩":"反抽"} EMA20 后收${L?"阳":"阴"} → ${L?"做多":"做空"}；止损近 5 根${L?"最低":"最高"} ∓0.5ATR，目标 2R，最多 30 根`,
  prep:s=>({f:ema(s.c,20,s.n),w:ema(s.c,50,s.n),a:atr(s,14),lo:rollMin(s.l,5,s.n),hi:rollMax(s.h,5,s.n)}),
  enter:(x,s,i)=>{const f=x.f![i]!,w=x.w![i]!,w6=x.w![i-6]!,a=x.a![i]!,c=close(s,i),o=s.o[i]!;if(!ok(w6)||!ok(a))return null;
    if(L&&w>w6&&c>w&&s.l[i]!<=f&&c>f&&c>o){const st=x.lo![i]!-.5*a;return c>st?{stop:st,target:c+2*(c-st),maxBars:30,why:"上升趋势回踩 EMA20 收阳"}:null;}
    if(!L&&w<w6&&c<w&&s.h[i]!>=f&&c<f&&c<o){const st=x.hi![i]!+.5*a;return c<st?{stop:st,target:c-2*(st-c),maxBars:30,why:"下降趋势反抽 EMA20 收阴"}:null;}
    return null;}};}
const burstOf=(x:Record<string,Float64Array>,s:Series,i:number)=>{const a=x.a![i-1]!,vm=x.vm![i-1]!,body=s.c[i]!-s.o[i]!;
  return ok(a)&&ok(vm)&&a>0&&vm>0&&Math.abs(body)>=2.5*a&&s.v[i]!>=3*vm?(body>0?1:-1):0;};
function burstFollow(side:Side):Playbook{const L=side==="LONG";return {id:`burst1h-${L?"long":"short"}`,label:`1小时爆发跟随${L?"做多":"做空"}`,iv:"1h",side,warm:25,
  rule:`1 小时 K 线实体 ≥ 2.5×ATR14 且成交量 ≥ 3 倍均量，${L?"向上":"向下"} → 跟随；止损该 K 线${L?"最低":"最高"}，6 小时后离场`,
  prep:s=>({a:atr(s,14),vm:sma(s.v,20,s.n)}),
  enter:(x,s,i)=>{const b=burstOf(x,s,i);if(b!==(L?1:-1))return null;return {stop:L?s.l[i]!:s.h[i]!,maxBars:6,why:`爆发 K 线跟随`};}};}
function burstFade(side:Side):Playbook{const L=side==="LONG";return {id:`fade1h-${L?"long":"short"}`,label:`1小时爆发反打${L?"做多":"做空"}`,iv:"1h",side,warm:25,
  rule:`1 小时 K 线实体 ≥ 2.5×ATR14 且成交量 ≥ 3 倍均量，${L?"向下":"向上"} → 反向${L?"做多":"做空"}；止损超出该 K 线极值 0.25ATR，目标回到开盘价，6 小时后离场`,
  prep:s=>({a:atr(s,14),vm:sma(s.v,20,s.n)}),
  enter:(x,s,i)=>{const b=burstOf(x,s,i);if(b!==(L?-1:1))return null;const a=x.a![i]!;
    return {stop:L?s.l[i]!-.25*a:s.h[i]!+.25*a,target:s.o[i]!,maxBars:6,why:"爆发 K 线反打"};}};}
const LONG_POOL:readonly Playbook[]=[donch,breakdown,emaCross("LONG"),emaCross("SHORT"),pullback("LONG"),pullback("SHORT")].map(p=>({...p,tier:"long" as Tier,
  family:p.id.replace(/-(long|short)$/,""),familyLabel:p.iv==="1d"?"日线趋势":"4小时趋势"}));
const HOUR_POOL:readonly Playbook[]=[boxBreak("LONG"),boxBreak("SHORT"),burstFollow("LONG"),burstFollow("SHORT"),burstFade("LONG"),burstFade("SHORT")].map(p=>({...p,tier:"short" as Tier,
  family:p.id.replace(/-(long|short)$/,""),familyLabel:p.id.startsWith("box")?"箱体突破":p.id.startsWith("burst")?"爆发跟随":"爆发反打",minStop:.008}));
export const POOL:readonly Playbook[]=[...SHORT_POOL,...HOUR_POOL,...LONG_POOL];
export const POOL_BY_ID:Record<string,Playbook>=Object.fromEntries(POOL.map(p=>[p.id,p]));
export const POOL_INDEX:Record<string,number>=Object.fromEntries(POOL.map((p,i)=>[p.id,i]));
export const tierOf=(pb:Playbook):Tier=>pb.tier??"long";
export const MAJORS=new Set(["BTC_USDT","ETH_USDT"]);
export const applies=(pb:Playbook,sym:string)=>pb.only==="majors"?MAJORS.has(sym):pb.only==="alts"?!MAJORS.has(sym):true;
export const STOP_MIN=.004,STOP_MAX=.35;
export const tradeId=(pb:string,sym:string,et:number)=>`${pb}|${sym}|${et}`;
/** exit check of an open position on bar i (stop/target intrabar, then signal / time at the close, then the trail). Mutates p.stop. */
export function stepExit(pb:Playbook,x:Record<string,Float64Array>,s:Series,i:number,p:Pos):{px:number;why:string}|null{
  const L=pb.side==="LONG",o=s.o[i]!,h=s.h[i]!,l=s.l[i]!;
  if(L?l<=p.stop:h>=p.stop)return {px:L?Math.min(o,p.stop):Math.max(o,p.stop),why:p.stop===p.stop0?"止损":"跟踪止损"};
  if(p.target!=null&&(L?h>=p.target:l<=p.target))return {px:L?Math.max(o,p.target):Math.min(o,p.target),why:"目标"};
  const m=pb.manage?.(x,s,i,p);
  if(m?.exit)return {px:s.c[i]!,why:m.exit};
  if(p.maxBars!=null&&i-p.ei>=p.maxBars)return {px:s.c[i]!,why:"到时"};
  if(m?.stop!=null&&ok(m.stop)&&(L?m.stop>p.stop:m.stop<p.stop))p.stop=m.stop;
  return null;
}
/**
 * Replay one playbook over one series. `fromT` skips entries before it (exits still run). Returns closed trades and the open one
 * (if any) at the last bar. Deterministic: the same bars always give the same trades and ids.
 */
export function simulate(pb:Playbook,s:Series,ctx:Ctx,opts:{fromT?:number;toT?:number}={}):{trades:ShadowTrade[];open:OpenShadow|null}{
  const trades:ShadowTrade[]=[],n=s.n;if(n<pb.warm+2||!applies(pb,s.sym))return {trades,open:null};
  const x=pb.prep(s,ctx),d=pb.side==="LONG"?1:-1,minStop=pb.minStop??STOP_MIN;let p:Pos|null=null;
  for(let i=pb.warm;i<n;i++){
    if(p){const q:Pos=p,e=stepExit(pb,x,s,i,q);
      if(e){const net=d*(e.px/q.ep-1)-FEE,rr=Math.abs(q.ep-q.stop0)/q.ep;
        trades.push({id:tradeId(pb.id,s.sym,q.et),pb:pb.id,side:pb.side,sym:s.sym,iv:s.iv,et:q.et,xt:end(s,i),ep:q.ep,xp:e.px,stop0:q.stop0,net,r:rr>0?net/rr:0,bars:i-q.ei,why:q.why,exit:e.why});
        p=null;}
      continue;// no re-entry on the bar that closed a trade
    }
    const t=end(s,i);if(opts.fromT!=null&&t<opts.fromT)continue;if(opts.toT!=null&&t>=opts.toT)continue;
    const e=pb.enter(x,s,i,ctx);if(!e)continue;
    const c=s.c[i]!;let stop=e.stop,rate=d*(c-stop)/c;
    // short tier: a stop tighter than the minimum (fees) is widened to it, not skipped
    if(pb.tier==="short"&&ok(rate)&&rate>0&&rate<minStop){stop=c*(1-d*minStop);rate=minStop;}
    if(!(rate>=minStop*.999&&rate<=STOP_MAX))continue;
    if(e.target!=null&&!(d*(e.target-c)>0))continue;
    p={ei:i,et:t,ep:c,stop0:stop,stop,target:e.target??null,maxBars:e.maxBars??null,why:e.why};
  }
  const q=p as Pos|null;
  return {trades,open:q?{pb:pb.id,side:pb.side,sym:s.sym,iv:s.iv,et:q.et,ep:q.ep,stop0:q.stop0,stop:q.stop,target:q.target,maxBars:q.maxBars,bars:n-1-q.ei,why:q.why,fresh:q.ei===n-1}:null};
}
/**
 * A live paper trade of a pool playbook, managed by the same rule on the same closed bars: the signal bar is the last bar closed
 * at the open time; the target and the time limit are the signal's (stored on the trade). Returns the current stop, or an exit.
 */
export function manageLive(pb:Playbook,s:Series,t:{openedAtMs:number;entry:number;stop0:number;stop:number;target?:number|null;maxBars?:number|null}):{exit:{why:string;px:number}|null;stop:number;bars:number}|null{
  const n=s.n;if(n<pb.warm+2)return null;const x=pb.prep(s,{btcBull:()=>null,memo:new Memo()}),sig=s.indexAtOrBefore(t.openedAtMs/1000-IV_SEC[s.iv]);if(sig<pb.warm)return null;
  const p:Pos={ei:sig,et:t.openedAtMs/1000,ep:t.entry,stop0:t.stop0,stop:t.stop,target:t.target!=null&&ok(t.target)?t.target:null,maxBars:t.maxBars??null,why:""};
  // stop touches are the forward core's (real Gate price); here only target / signal / time exits and the trail
  for(let i=sig+1;i<n;i++){if(s.t[i]!<p.et-1)continue;const ex=stepExit(pb,x,s,i,p);if(ex&&!/止损/.test(ex.why))return {exit:ex,stop:p.stop,bars:i-sig};}
  return {exit:null,stop:p.stop,bars:n-1-sig};
}
