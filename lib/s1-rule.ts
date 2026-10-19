/**
 * S1 — the BTC-branch entry/exit rule for the market-wide live stages TREND / SHOCK (user-approved 2026-10-19:
 * "直接把这条方案加到爆发和趋势的开单规则中"). It REPLACES the earlier entry gate's direction decisions
 * (lib/entry-gate.ts: BTC follow ±0.5, washout flip, pumped short) for those two stages; it is not stacked on top.
 * TRANSITION / ROTATION / anything else: PASS, untouched.
 *
 *   btc1h_aligned_pct = BTC 1h % move signed by the signal side (+ = BTC moving with the signal)
 *   >= 0.57  -> follow : open the signal side, take profit at +6% price move, stop at 1% price move (24 h at most)
 *   <  0.57  -> reverse: open the opposite side, the order's own stop distance mirrored to the other side,
 *               no take profit, time exit after 6 h
 *   BTC 1h unknown -> no entry (note only), same as the earlier gate.
 * Exits of an S1 trade are only this plan plus isolated liquidation. Same semantics as /workspace/combo/shadow_backfill.py.
 * Pure: no I/O, no clock. Percent units in notes/exports are price-move %, never ROE.
 */
export const S1_VERSION="S1" as const;
export const S1_FOLLOW_MIN_PCT=0.57;
export const S1_FOLLOW_TP_PCT=6,S1_FOLLOW_SL_PCT=1,S1_FOLLOW_MAX_MIN=1440;
export const S1_REVERSE_HOLD_MIN=360;

export type S1Side="LONG"|"SHORT";
export type S1Branch="follow"|"reverse";
/** Kept on the trade (entryContext.s1). Short keys: it lives in the hot Durable Object state. */
export type S1Note={v:typeof S1_VERSION;
  /** null = BTC 1h unknown, not opened (note-only row). */
  branch:S1Branch|null;
  /** original signal side and the side S1 opened */
  signal:S1Side;side:S1Side;
  /** btc1h_aligned_pct, rounded to 4 dp */
  btc:number|null;
  /** stop / take-profit distance in price-move %, hold limit in minutes (filled at open) */
  stop:number|null;tp:number|null;hold:number|null};
export type S1Decision={action:"PASS"}|{action:"BLOCK";note:S1Note}|{action:"OPEN";note:S1Note};

const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const r4=(v:number)=>Math.round(v*1e4)/1e4;
const opposite=(side:S1Side):S1Side=>side==="LONG"?"SHORT":"LONG";

export const s1Applies=(stage:string|null|undefined)=>stage==="TREND"||stage==="SHOCK";

export function s1Decision(input:{stage:string|null|undefined;signalSide:S1Side;btc1hPct:number|null|undefined}):S1Decision{
  if(!s1Applies(input.stage))return {action:"PASS"};
  const signal=input.signalSide;
  if(!finite(input.btc1hPct))return {action:"BLOCK",note:{v:S1_VERSION,branch:null,signal,side:signal,btc:null,stop:null,tp:null,hold:null}};
  const btc=r4(input.btc1hPct*(signal==="LONG"?1:-1));
  if(btc>=S1_FOLLOW_MIN_PCT)return {action:"OPEN",note:{v:S1_VERSION,branch:"follow",signal,side:signal,btc,
    stop:S1_FOLLOW_SL_PCT,tp:S1_FOLLOW_TP_PCT,hold:S1_FOLLOW_MAX_MIN}};
  return {action:"OPEN",note:{v:S1_VERSION,branch:"reverse",signal,side:opposite(signal),btc,stop:null,tp:null,hold:S1_REVERSE_HOLD_MIN}};
}

/**
 * Stop/target for the open path. ownStopRate is the order's own stop distance (fraction) on the signal side,
 * |signal-side entry price − own stop| / price. Follow ignores it (1%); reverse mirrors it to the other side.
 * Returns null when a reverse order has no usable own stop.
 */
export function s1Levels(note:S1Note,ownStopRate:number|null|undefined):{side:S1Side;stopRate:number;tpRate:number|null;holdMin:number;note:S1Note}|null{
  if(note.branch==="follow")return {side:note.side,stopRate:S1_FOLLOW_SL_PCT/100,tpRate:S1_FOLLOW_TP_PCT/100,holdMin:S1_FOLLOW_MAX_MIN,
    note:{...note,stop:S1_FOLLOW_SL_PCT,tp:S1_FOLLOW_TP_PCT,hold:S1_FOLLOW_MAX_MIN}};
  if(note.branch!=="reverse"||!finite(ownStopRate)||!(ownStopRate>0)||ownStopRate>=.2)return null;
  return {side:note.side,stopRate:ownStopRate,tpRate:null,holdMin:S1_REVERSE_HOLD_MIN,
    note:{...note,stop:r4(ownStopRate*100),tp:null,hold:S1_REVERSE_HOLD_MIN}};
}

export type S1ExitCode="S1_SL"|"S1_TP"|"S1_TIME_6H"|"S1_TIME_24H";
/**
 * Exit decision on one executable quote (bid for a long, ask for a short). Order: stop, then take profit, then time.
 * Isolated liquidation is checked by the caller before this (liquidateIfHit).
 */
export function s1Exit(input:{note:S1Note;side:S1Side;stopPrice:number;tpPrice:number|null;openedAt:number;now:number;price:number}):S1ExitCode|null{
  const {note,side,stopPrice,tpPrice,price}=input;
  if(!note.branch||!(price>0))return null;
  if(stopPrice>0&&(side==="LONG"?price<=stopPrice:price>=stopPrice))return "S1_SL";
  if(note.branch==="follow"&&tpPrice!=null&&tpPrice>0&&(side==="LONG"?price>=tpPrice:price<=tpPrice))return "S1_TP";
  const hold=finite(note.hold)&&note.hold>0?note.hold:note.branch==="follow"?S1_FOLLOW_MAX_MIN:S1_REVERSE_HOLD_MIN;
  if(input.now-input.openedAt>=hold*60_000)return hold>=S1_FOLLOW_MAX_MIN?"S1_TIME_24H":"S1_TIME_6H";
  return null;
}

/** Run-log / export / archive columns. Only rows whose trade carries an S1 note get them (no bytes on other rows). */
export type S1Fields={btc1h_aligned_pct:number|null;s1_branch:S1Branch|null;original_side:S1Side;s1_side:S1Side;
  s1_plan:"TP6_SL1"|"own_stop_6h"|null;s1_stop_pct:number|null;s1_tp_pct:number|null;s1_exit_reason:string|null};
export function s1ExitReason(exitReason:string|null|undefined):string|null{
  if(!exitReason)return null;
  return exitReason.startsWith("S1_")?exitReason.slice(3):exitReason;
}
export function readS1Note(v:unknown):S1Note|null{
  const n=v as S1Note|null|undefined;
  if(!n||n.v!==S1_VERSION||(n.signal!=="LONG"&&n.signal!=="SHORT")||(n.side!=="LONG"&&n.side!=="SHORT"))return null;
  return n;
}
export function s1Fields(note:unknown,exitReason:string|null|undefined,closed:boolean):S1Fields|null{
  const n=readS1Note(note);if(!n)return null;
  return {btc1h_aligned_pct:finite(n.btc)?n.btc:null,s1_branch:n.branch,original_side:n.signal,s1_side:n.side,
    s1_plan:n.branch==="follow"?"TP6_SL1":n.branch==="reverse"?"own_stop_6h":null,
    s1_stop_pct:finite(n.stop)?n.stop:null,s1_tp_pct:finite(n.tp)?n.tp:null,s1_exit_reason:closed?s1ExitReason(exitReason):null};
}
