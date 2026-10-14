/** Closed-order archive. The hot account only keeps a short history; this book keeps the review rows. */
import type {EntryStructure} from './entry-structure.ts';
import type {Trade} from './forward-relations.ts';

export const ORDER_JOURNAL_KEY='market-intelligence:order-journal:v1';
export const ORDER_JOURNAL_VERSION='order-journal-v1' as const;
const CAP=4_000;

export type OrderRecord={
  id:string;symbol:string;side:'LONG'|'SHORT';entry:number;exit:number|null;qty:number;notional:number;
  gross_pnl:number|null;fee:number;net_pnl:number|null;holdSec:number;opened_at:number;closed_at:number|null;
  exit_trigger:string|null;entry_stage:string|null;entry_phase:string|null;exit_stage:string|null;exit_phase:string|null;
  market_expectancy:number|null;entry_structure:EntryStructure|null;
};
export type OrderJournal={version:typeof ORDER_JOURNAL_VERSION;accountStartedAt:number;rows:OrderRecord[]};

export function emptyOrderJournal(accountStartedAt:number):OrderJournal{
  return {version:ORDER_JOURNAL_VERSION,accountStartedAt,rows:[]};
}
export function restoreOrderJournal(saved:OrderJournal|undefined,accountStartedAt:number){
  if(!saved||saved.version!==ORDER_JOURNAL_VERSION||saved.accountStartedAt!==accountStartedAt||!Array.isArray(saved.rows))return emptyOrderJournal(accountStartedAt);
  return saved;
}
export function orderRecord(t:Trade):OrderRecord{
  return {id:t.id,symbol:t.symbol,side:t.side,entry:t.entryPrice,exit:t.exitPrice,qty:t.quantity,notional:t.notional,
    gross_pnl:t.grossPnl,fee:round(t.entryFee+t.exitFee+t.fundingAllowance),net_pnl:t.netPnl,
    holdSec:t.closedAt==null?0:Math.max(0,Math.round((t.closedAt-t.openedAt)/1000)),
    opened_at:t.openedAt,closed_at:t.closedAt,exit_trigger:t.exitReason,
    entry_stage:t.entryContext?.environment??null,entry_phase:t.entryContext?.marketEvolutionPhase??null,
    exit_stage:t.exitRegime?.stage??null,exit_phase:t.exitRegime?.phase??null,
    market_expectancy:t.entryContext?.marketExpectancy??null,entry_structure:t.entryContext?.entryStructure??null};
}
export function observeOrderJournal(book:OrderJournal,history:Trade[],accountStartedAt:number){
  let changed=false;
  if(book.accountStartedAt!==accountStartedAt){book.accountStartedAt=accountStartedAt;book.rows=[];changed=true;}
  const known=new Set(book.rows.map(row=>row.id));
  const fresh:OrderRecord[]=[];
  for(const t of history){
    if(t.status!=='CLOSED'||t.inverseCopy||t.exitReason==='ACCOUNT_RESET'||known.has(t.id))continue;
    fresh.push(orderRecord(t));known.add(t.id);
  }
  if(fresh.length){book.rows=[...fresh,...book.rows];changed=true;}
  if(book.rows.length>CAP){book.rows.length=CAP;changed=true;}
  return changed;
}
function round(n:number){return Number(n.toFixed(4));}
