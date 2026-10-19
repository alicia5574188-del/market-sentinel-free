/**
 * S1 — LEGACY, read-only. S1 was the TREND/SHOCK BTC-branch entry/exit rule live from 2026-10-19 17:15 (Beijing) until it
 * was withdrawn the same day at the user's request ("退回旧规则"). TREND/SHOCK entries are decided again by the earlier
 * entry gate (lib/entry-gate.ts) and exits by the earlier exit stack. Nothing in this file decides a trade any more.
 *
 * What is kept, so the trades S1 opened keep exporting/rendering:
 *   - the S1Note shape stored on those trades (entryContext.s1),
 *   - readS1Note / s1Fields for the run-log / export / archive columns of those rows,
 *   - the S1_* exit codes for rows S1 already closed (labels live in app/order-card.tsx and app/forward-dashboard.tsx).
 * A trade carrying an S1 note that is still open after the withdrawal is managed by the earlier exit stack like any other
 * TREND/SHOCK trade (its stored stop, liquidation price and leverage are untouched; see lib/forward-relations.ts).
 * Percent units are price-move %, never ROE.
 */
export const S1_VERSION="S1" as const;

export type S1Side="LONG"|"SHORT";
export type S1Branch="follow"|"reverse";
/** Stored on S1 trades (entryContext.s1). Short keys: it lives in the hot Durable Object state. */
export type S1Note={v:typeof S1_VERSION;
  /** null = BTC 1h unknown, not opened (note-only row). */
  branch:S1Branch|null;
  /** original signal side and the side S1 opened */
  signal:S1Side;side:S1Side;
  /** btc1h_aligned_pct, rounded to 4 dp */
  btc:number|null;
  /** stop / take-profit distance in price-move %, hold limit in minutes (filled at open) */
  stop:number|null;tp:number|null;hold:number|null};

/** Exit codes S1 wrote on the rows it closed. No new row gets them. */
export type S1ExitCode="S1_SL"|"S1_TP"|"S1_TIME_6H"|"S1_TIME_24H";
export const S1_EXIT_CODES:readonly S1ExitCode[]=["S1_SL","S1_TP","S1_TIME_6H","S1_TIME_24H"];

const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);

/** Run-log / export / archive columns. Only rows whose trade carries an S1 note get them (no bytes on other rows). */
export type S1Fields={btc1h_aligned_pct:number|null;s1_branch:S1Branch|null;original_side:S1Side;s1_side:S1Side;
  s1_plan:"TP6_SL1"|"own_stop_6h"|null;s1_stop_pct:number|null;s1_tp_pct:number|null;s1_exit_reason:string|null};
export function s1ExitReason(exitReason:string|null|undefined):string|null{
  if(!exitReason)return null;
  return exitReason.startsWith("S1_")?exitReason.slice(3):exitReason;
}
export function readS1Note(v:unknown):S1Note|null{
  const n=v as S1Note|null|undefined;
  if(!n||typeof n!=="object"||n.v!==S1_VERSION||(n.signal!=="LONG"&&n.signal!=="SHORT")||(n.side!=="LONG"&&n.side!=="SHORT"))return null;
  return n;
}
export function s1Fields(note:unknown,exitReason:string|null|undefined,closed:boolean):S1Fields|null{
  const n=readS1Note(note);if(!n)return null;
  return {btc1h_aligned_pct:finite(n.btc)?n.btc:null,s1_branch:n.branch,original_side:n.signal,s1_side:n.side,
    s1_plan:n.branch==="follow"?"TP6_SL1":n.branch==="reverse"?"own_stop_6h":null,
    s1_stop_pct:finite(n.stop)?n.stop:null,s1_tp_pct:finite(n.tp)?n.tp:null,s1_exit_reason:closed?s1ExitReason(exitReason):null};
}
