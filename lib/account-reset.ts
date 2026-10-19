/** Funds-only reset of the paper account (page funds, page equity curve, page order records).
 * The log epoch (startedAt) is kept, so every run-log store keyed on it (order journal, minute paths, review log,
 * archived not-opened rows, equity minutes, export progress, D1 archive cursor) keeps going untouched.
 * With open positions nothing is closed: the reset is booked as pending and advanceForward runs it at the first
 * moment the account has no open position. Entries and exits keep running normally meanwhile. */
import {applyFundsReset,normalizeForward,type AccountReset,type ForwardState} from './forward-relations.ts';

export type FundsResetResult={state:ForwardState;status:'DONE'|'PENDING'|'ALREADY_PENDING';open:number;reset:AccountReset|null};

export function requestFundsReset(previous:ForwardState,now:number):FundsResetResult{
  const s=normalizeForward(structuredClone(previous),now),open=s.positions.length;
  if(!open){const reset=applyFundsReset(s,now);return{state:s,status:'DONE',open:0,reset};}
  if(s.pendingFundsReset)return{state:s,status:'ALREADY_PENDING',open,reset:null};
  s.pendingFundsReset={requestedAt:now};
  return{state:s,status:'PENDING',open,reset:null};
}

export function cancelFundsReset(previous:ForwardState,now:number){
  const s=normalizeForward(structuredClone(previous),now),had=!!s.pendingFundsReset;
  s.pendingFundsReset=null;
  return{state:s,cancelled:had};
}

/** Account epoch of a record: 0 before the first reset, n after the n-th. */
export function accountEpochAt(resets:readonly Pick<AccountReset,'at'>[]|undefined,at:number|null|undefined){
  if(!resets?.length||at==null||!Number.isFinite(at))return 0;
  let n=0;for(const r of resets)if(r.at<=at)n++;return n;
}

/** Cash taken out/added by resets; the run-log identity books it as prior_adjustment. */
export function resetAdjustment(resets:readonly AccountReset[]|undefined){
  return Number((resets??[]).reduce((n,r)=>n+(r.balanceAfter-r.balanceBefore),0).toFixed(4));
}
