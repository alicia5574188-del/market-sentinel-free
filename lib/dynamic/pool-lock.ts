/**
 * Pool profit lock (2026-10-23): dynamic profit protection for open pool-playbook trades (dp) only. Pure: no I/O, no request.
 * It can only close a trade EARLIER than the playbook's own exits (stop / target / signal / time stay as they are, nothing is
 * loosened). Everything is in the coin's own volatility unit a = max(0.15%, 15-min 1-minute unit, 5-minute ATR14), price-move %.
 *
 *  armed       peak ≥ max(ARM_A × a, ARM_MIN): smaller profits are left alone (noise), a loser never arms
 *  curve       keep line L2 = peak² / (peak + CURVE_C × a): the kept share peak/(peak+C·a) grows with the peak (a small peak keeps
 *              ~half, a big one keeps most of it) but the room C·a never drops to a touch-and-go value
 *  stall       no new high for more than W minutes: the allowed giveback goes from WIDE_A × a down to TIGHT_A × a over the next W
 *              minutes (line L1 = peak − giveback). W follows the playbook's planned hold: planned / 24, clamped to 15–45 min
 *  line        max(L1, L2, cost floor): the stricter (closer to the peak) one, never below entry + fees + buffer (COST_FLOOR)
 *  trigger     current price move ≤ line → exit at the executable quote. Unknown peak / peak time / unit / quote → no trigger.
 */
export const POOL_LOCK={armA:3,armMin:.006,curveC:3,wideA:3,tightA:1.5,wMin:15,wMax:45,wDiv:24,defaultBars:24,
  /** round-trip fee 0.19% + 0.05% buffer: once armed, the line never sits below this (a winner is not allowed to turn into a loss) */
  costFloor:.0019+.0005} as const;
export const POOL_LOCK_CODE="LIVING_DYN_POOL_LOCK";
export const IV_MIN:Record<string,number>={"1m":1,"5m":5,"15m":15,"1h":60,"4h":240,"1d":1440};
const fin=(x:unknown):x is number=>typeof x==="number"&&Number.isFinite(x);
/** stall window (minutes) from the playbook's planned hold (bars × interval); no planned hold → default bars */
export function stallWindowMin(iv:string,maxBars:number|null|undefined):number{
  const ivm=IV_MIN[iv]??15,planned=(fin(maxBars)&&maxBars>0?maxBars:POOL_LOCK.defaultBars)*ivm;
  return Math.min(POOL_LOCK.wMax,Math.max(POOL_LOCK.wMin,planned/POOL_LOCK.wDiv));
}
/** the coin's volatility unit (price-move fraction): max of the floor, the existing 15-min unit and the 5-minute ATR14 (both optional) */
export function lockUnit(unit1m:number|null|undefined,atr5:number|null|undefined):number{return Math.max(.0015,fin(unit1m)?unit1m:0,fin(atr5)?atr5:0);}
/** 5-minute ATR14 as a fraction of the last close (mean true range over the last ≤14 closed bars); null with < 6 bars */
export function atr5Frac(bars:readonly {high:number;low:number;close:number}[]):number|null{
  const xs=bars.slice(-15);if(xs.length<7)return null;let s=0,n=0;
  for(let i=1;i<xs.length;i++){const b=xs[i]!,pc=xs[i-1]!.close;if(!(pc>0))continue;s+=Math.max(b.high-b.low,Math.abs(b.high-pc),Math.abs(b.low-pc));n++;}
  const c=xs[xs.length-1]!.close;return n>=5&&c>0?s/n/c:null;
}
export type LockIn={
  /** best price move so far in the trade's direction (Trade.favorable, persisted), fraction; null = lost */
  peak:number|null;
  /** current price move now (fraction, + = in profit) at the executable quote; null = no fresh quote */
  cur:number|null;
  /** minutes since the peak was last improved; null = unknown (lost after a restart) */
  stallMin:number|null;
  a:number|null;windowMin:number};
export type LockVerdict={act:"HOLD"|"EXIT";armed:boolean;line:number|null;giveback:number|null;peak:number;cur:number;stallMin:number;why:string};
const p2=(x:number)=>`${(x*100).toFixed(2)}%`;
/** the protection line (price-move fraction) for a peak, or null while not armed. Pure function of (peak, a, stall, window). */
export function lockLine(peak:number,a:number,stallMin:number,windowMin:number):{line:number;giveback:number;armed:true}|null{
  if(!fin(peak)||!fin(a)||a<=0||peak<Math.max(POOL_LOCK.armA*a,POOL_LOCK.armMin))return null;
  const l2=peak*peak/(peak+POOL_LOCK.curveC*a);
  const w=Math.max(1,windowMin),over=Math.max(0,Math.min(1,(stallMin-w)/w));
  const g1=(POOL_LOCK.wideA+(POOL_LOCK.tightA-POOL_LOCK.wideA)*over)*a;
  const line=Math.min(peak,Math.max(l2,peak-g1,POOL_LOCK.costFloor));
  return {line,giveback:peak-line,armed:true};
}
export function poolLock(i:LockIn):LockVerdict|null{
  if(!fin(i.peak)||!fin(i.cur)||!fin(i.stallMin)||!fin(i.a)||i.a<=0)return null;// anything unknown → the rule stays out
  const r=lockLine(i.peak,i.a,i.stallMin,i.windowMin);
  if(!r)return {act:"HOLD",armed:false,line:null,giveback:null,peak:i.peak,cur:i.cur,stallMin:i.stallMin,why:""};
  if(i.cur<=r.line+1e-12)return {act:"EXIT",armed:true,line:r.line,giveback:r.giveback,peak:i.peak,cur:i.cur,stallMin:i.stallMin,
    why:`池内动态锁利：最高浮盈 ${p2(i.peak)}，保护线 ${p2(r.line)}（允许回吐 ${p2(r.giveback)}），${Math.round(i.stallMin)} 分钟没创新高，现在 ${p2(i.cur)}`};
  return {act:"HOLD",armed:true,line:r.line,giveback:r.giveback,peak:i.peak,cur:i.cur,stallMin:i.stallMin,why:""};
}
/** per-trade peak clock kept in the living trades state (persisted with its normal 45 s batch): [peak seen, since ms] */
export type PeakClock=Record<string,[number,number]>;
/**
 * Advance the clock of one trade with this tick's persisted peak. Returns the minutes since the last new high, or null when the
 * clock did not exist (first sight / lost) — it is then started at `now` and the rule stays out this tick.
 */
export function tickClock(ck:PeakClock,id:string,peak:number|null,now:number):number|null{
  if(!fin(peak)||peak<0)return null;
  const c=ck[id];
  if(!c||!fin(c[0])||!fin(c[1])){ck[id]=[peak,now];return null;}
  if(peak>c[0]+1e-12){ck[id]=[peak,now];return 0;}
  return Math.max(0,(now-c[1])/60_000);
}
