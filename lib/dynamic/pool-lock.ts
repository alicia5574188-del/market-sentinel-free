/**
 * Pool profit lock (2026-10-23, R version): dynamic profit protection for open pool-playbook trades (dp) only. Pure: no I/O, no request.
 * It can only close a trade EARLIER than the playbook's own exits (stop / target / signal / time stay as they are, nothing is
 * loosened). The yardstick is the trade's OWN planned risk R = |entry − initial stop| / entry (price move, not ROE), not a volatility
 * estimate: the playbook already sized its stop and (mostly) its 2R target from the structure it traded, so R is also the scale on
 * which "a meaningful profit" and "room for the trend" are measured. Cost (fees + buffer) is the only fixed number.
 *
 *  armed       peak ≥ max(ARM_FLOOR, min(ARM_R × R, ARM_CAP)). ARM_CAP is 1%: a wide stop no longer waits
 *              for half of R. Those trades were up about 3% and then stopped out red. A tiny R still needs the
 *              0.6% floor. A loser never arms.
 *  curve       keep line L2 = peak² / (peak + K × R): the kept share m/(m+K) (m = peak/R) grows with the peak (K=0.5: half at 0.5R,
 *              2/3 at 1R, 80% at 2R) while the room K·R scales with the trade's own risk
 *  stall       no new high for more than W minutes: allowed giveback goes from WIDE_K × R (never binds while fresh) down to
 *              TIGHT_K × R over the next W minutes (line L1 = peak − giveback). W follows the playbook's planned hold
 *              (maxBars × interval): planned / 8, clamped to 15–45 min
 *  line        max(L1, L2, cost floor): the stricter one, never below entry + fees + buffer (COST_FLOOR)
 *  trigger     current price move ≤ line → exit at the executable quote. Unknown peak / peak time / R / quote → no trigger.
 */
export const POOL_LOCK={armR:.5,armFloor:.006,armCap:.01,curveK:.5,wideK:1,tightK:.25,minR:.008,wMin:15,wMax:45,wDiv:8,defaultBars:24,
  /** round-trip fee 0.19% + 0.05% buffer: once armed, the line never sits below this (a winner is not allowed to turn into a loss) */
  costFloor:.0019+.0005} as const;
export const POOL_LOCK_CODE="LIVING_DYN_POOL_LOCK";
export const IV_MIN:Record<string,number>={"1m":1,"5m":5,"15m":15,"1h":60,"4h":240,"1d":1440};
const fin=(x:unknown):x is number=>typeof x==="number"&&Number.isFinite(x);
/** planned hold in minutes (bars × interval); no planned bars → default bars */
export function plannedMin(iv:string,maxBars:number|null|undefined):number{return (fin(maxBars)&&maxBars>0?maxBars:POOL_LOCK.defaultBars)*(IV_MIN[iv]??15);}
/** stall window (minutes) from the playbook's planned hold */
export function stallWindowMin(iv:string,maxBars:number|null|undefined):number{
  return Math.min(POOL_LOCK.wMax,Math.max(POOL_LOCK.wMin,plannedMin(iv,maxBars)/POOL_LOCK.wDiv));
}
/** the trade's planned risk R as a price-move fraction from entry and the INITIAL stop (never the trailed one); null when unusable.
 *  Floored at minR (the pool playbooks never plan a stop closer than that), so a degenerate tiny stop cannot make the line a touch-and-go. */
export function riskR(entry:number|null|undefined,initialStop:number|null|undefined):number|null{
  if(!fin(entry)||!fin(initialStop)||!(entry>0)||!(initialStop>0))return null;
  const r=Math.abs(entry-initialStop)/entry;return r>0&&r<1?Math.max(r,POOL_LOCK.minR):null;
}
export type LockIn={
  /** best price move so far in the trade's direction (Trade.favorable, persisted), fraction; null = lost */
  peak:number|null;
  /** current price move now (fraction, + = in profit) at the executable quote; null = no fresh quote */
  cur:number|null;
  /** minutes since the peak was last improved; null = unknown (lost after a restart) */
  stallMin:number|null;
  /** planned risk R (price-move fraction); null = unknown */
  r:number|null;windowMin:number};
export type LockVerdict={act:"HOLD"|"EXIT";armed:boolean;line:number|null;giveback:number|null;peak:number;cur:number;stallMin:number;why:string};
const p2=(x:number)=>`${(x*100).toFixed(2)}%`;
/** the protection line (price-move fraction) for a peak, or null while not armed. Pure function of (peak, R, stall, window). */
export function lockLine(peak:number,r:number,stallMin:number,windowMin:number):{line:number;giveback:number;armed:true}|null{
  if(!fin(peak)||!fin(r)||r<=0||peak<Math.max(POOL_LOCK.armFloor,Math.min(POOL_LOCK.armR*r,POOL_LOCK.armCap)))return null;
  const l2=peak*peak/(peak+POOL_LOCK.curveK*r);
  const w=Math.max(1,windowMin),over=Math.max(0,Math.min(1,(stallMin-w)/w));
  const g1=(POOL_LOCK.wideK+(POOL_LOCK.tightK-POOL_LOCK.wideK)*over)*r;
  const line=Math.min(peak,Math.max(l2,peak-g1,POOL_LOCK.costFloor));
  return {line,giveback:peak-line,armed:true};
}
export function poolLock(i:LockIn):LockVerdict|null{
  if(!fin(i.peak)||!fin(i.cur)||!fin(i.stallMin)||!fin(i.r)||i.r<=0)return null;// anything unknown → the rule stays out
  const r=lockLine(i.peak,i.r,i.stallMin,i.windowMin);
  if(!r)return {act:"HOLD",armed:false,line:null,giveback:null,peak:i.peak,cur:i.cur,stallMin:i.stallMin,why:""};
  if(i.cur<=r.line+1e-12)return {act:"EXIT",armed:true,line:r.line,giveback:r.giveback,peak:i.peak,cur:i.cur,stallMin:i.stallMin,
    why:`池内动态锁利：最高浮盈 ${p2(i.peak)}（${(i.peak/i.r).toFixed(2)}R，计划风险 R=${p2(i.r)}），保护线 ${p2(r.line)}（允许回吐 ${p2(r.giveback)}），${Math.round(i.stallMin)} 分钟没创新高，现在 ${p2(i.cur)}`};
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
