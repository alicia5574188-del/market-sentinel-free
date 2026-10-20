/**
 * One-shot "clean log" wipe (runlog-wipe:v1). The owner asked for every run-log record to be cleared — Durable Object
 * side stores and the D1 long-term tables — so that the next export starts empty at the wipe time.
 *
 * Never touched: open positions, the balance, fees/turnover totals, the live switch, the inverse-trial ledger rows,
 * the forward financial event archive (`…archive:` packets: the account's immutable audit trail, also read by the
 * equity chart and by member closed-trade lookups), learning state (episodes, thesis, probes) and strategy state.
 * No Gate request is made.
 *
 * Pure helpers here; the worker drives the storage and D1 parts (worker/index-clean.ts runLogWipeOnce).
 */
import type {ForwardState} from "./forward-relations.ts";
import type {AccountReset} from "./forward-relations.ts";

export const RUNLOG_WIPE_KEY="runlog-wipe:v1";
export const RUNLOG_WIPE_VERSION="runlog-wipe-v1" as const;
/** DO key prefixes that hold nothing but run-log rows (all deleted, in batches). */
export const RUNLOG_WIPE_PREFIXES=["log:review:v1:","log:eqmin:","market-intelligence:trade-paths:"] as const;
/** D1 run-log tables: every row is deleted, the schema stays. */
export const RUNLOG_WIPE_D1_TABLES=["run_log_archive","run_log_stages","run_log_equity_days","run_log_archive_meta","living_run_log",
  "paper_events","paper_positions"] as const;

export type RunLogWipePhase="storage"|"d1"|"done";
export type RunLogWipeRecord={
  version:typeof RUNLOG_WIPE_VERSION;
  /** Wipe time: the export window, the identity baseline and every "since" start here. */
  at:number;
  /** Run-log identity baseline: equity − initial − open unrealized at `at` (prior_adjustment before later resets). */
  adjust:number;
  balanceAtWipe:number;
  openAtWipe:number;
  phase:RunLogWipePhase;
  doneAt:number|null;
  passes:number;
  cleared:Record<string,number>;
  d1:Record<string,number|string>;
  lastError:string|null;
};

export function newWipeRecord(at:number,adjust:number,balance:number,open:number):RunLogWipeRecord{
  return {version:RUNLOG_WIPE_VERSION,at,adjust:Number(adjust.toFixed(4)),balanceAtWipe:balance,openAtWipe:open,phase:"storage",
    doneAt:null,passes:0,cleared:{},d1:{},lastError:null};
}
export function normalizeWipeRecord(v:unknown):RunLogWipeRecord|null{
  const r=v as RunLogWipeRecord|undefined;
  if(!r||r.version!==RUNLOG_WIPE_VERSION||!(typeof r.at==="number"&&r.at>0)||!Number.isFinite(r.adjust))return null;
  return {...r,cleared:r.cleared??{},d1:r.d1??{},passes:r.passes??0,doneAt:r.doneAt??null,lastError:r.lastError??null,
    phase:r.phase==="d1"||r.phase==="done"?r.phase:"storage"};
}

/**
 * The forward account with its run-log rows removed (copy). Idempotent for a given `at`: only rows that ended before
 * the wipe go. Open positions, balance and every financial total are carried over unchanged.
 */
export function wipeForwardLog(state:ForwardState,at:number){
  const next=structuredClone(state);
  const closedBefore=(t:{closedAt?:number|null;openedAt:number})=>(t.closedAt??t.openedAt)<at;
  const history=next.history.filter(t=>t.inverseCopy||!closedBefore(t));
  const unopened=(next.unopenedTrades??[]).filter(t=>t.status==="OPEN"||!closedBefore(t));
  const stageChanges=next.stageChronicle?.changes?.filter(c=>c.at>=at)??[];
  const counts={history:next.history.length-history.length,unopened:(next.unopenedTrades??[]).length-unopened.length,
    stageChanges:(next.stageChronicle?.changes?.length??0)-stageChanges.length,tally:Object.keys(next.signalTally??{}).length};
  next.history=history;next.unopenedTrades=unopened;
  if(next.stageChronicle)next.stageChronicle={...next.stageChronicle,changes:stageChanges};
  next.signalTally={};next.signalTallyMeta={backfilled:true,from:at};
  return {state:next,counts};
}

/** Identity baseline at the wipe: the part of equity that no exported row explains (all of it, when flat). */
export function wipeBaseline(book:{equity:number;initial:number;positions:{net_pnl:number|null;gross_pnl:number|null;fee:number}[]}){
  const unrealized=book.positions.filter(r=>r.net_pnl==null).reduce((n,r)=>n+(r.gross_pnl??0)-r.fee,0);
  return Number((book.equity-book.initial-unrealized).toFixed(4));
}

export type LogSince={at:number;adjust:number};
/** Resets after the wipe and the prior_adjustment the run-log identity uses from the wipe on. */
export function sinceAdjustment(since:LogSince,resets:readonly AccountReset[]|undefined){
  const kept=(resets??[]).filter(r=>r.at>=since.at);
  return {resets:kept,prior:Number((since.adjust+kept.reduce((n,r)=>n+(r.balanceAfter-r.balanceBefore),0)).toFixed(4))};
}
export const logSinceOf=(r:RunLogWipeRecord|null):LogSince|null=>r?{at:r.at,adjust:r.adjust}:null;
