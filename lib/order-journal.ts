/** Closed-order archive. The hot account only keeps a short history; this book keeps the review rows. */
import type {EntryStructure} from './entry-structure.ts';
import type {Trade} from './forward-relations.ts';
import {coinPathVersus} from './coin-path.ts';

export const ORDER_JOURNAL_KEY='market-intelligence:order-journal:v1';
export const ORDER_JOURNAL_VERSION='order-journal-v1' as const;
const CAP=4_000;

export type OrderRecord={
  id:string;symbol:string;side:'LONG'|'SHORT';entry:number;exit:number|null;qty:number;notional:number;
  gross_pnl:number|null;fee:number;net_pnl:number|null;holdSec:number;opened_at:number;closed_at:number|null;
  exit_trigger:string|null;entry_stage:string|null;entry_phase:string|null;exit_stage:string|null;exit_phase:string|null;
  market_expectancy:number|null;entry_structure:EntryStructure|null;entry_rule?:string|null;
  entry_signal?:'LONG'|'SHORT'|null;entry_fade?:boolean|null;entry_room_pct?:number|null;entry_room_touches?:number|null;
  live_stage?:string|null;prior_stage?:string|null;stage_age_min?:number|null;minutes_since_shock?:number|null;shock_push?:number|null;sync_drop?:number|null;
  trend_side?:'LONG'|'SHORT'|null;with_trend?:boolean|null;book?:number|null;residual?:number|null;relative_strength?:number|null;
  move30?:number|null;sync?:number|null;breadth?:number|null;
  coin_background?:string|null;coin_recent?:string|null;coin_label?:string|null;coin_versus?:string|null;
  coin_background_pct?:number|null;coin_recent_pct?:number|null;coin_window_min?:number|null;
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
    market_expectancy:t.entryContext?.marketExpectancy??null,entry_structure:t.entryContext?.entryStructure??null,
    entry_rule:t.unopened?"NOT_OPENED":t.entryContext?.shockRoom?"SHOCK_EPISODE":t.entryContext?.transitionRule?"TRANSITION_ROOM":null,
    ...entryDecision(t),...stageFields(t),...qualityFields(t),...pathFields(t)};
}
function stageFields(t:Trade):Pick<OrderRecord,'live_stage'|'prior_stage'|'stage_age_min'|'minutes_since_shock'|'shock_push'|'sync_drop'>{
  const note=t.entryContext?.stageNote;
  if(!note)return {live_stage:null,prior_stage:null,stage_age_min:null,minutes_since_shock:null,shock_push:null,sync_drop:null};
  return {live_stage:note.liveStage,prior_stage:note.priorStage,stage_age_min:note.stageAgeMin,
    minutes_since_shock:note.minutesSinceShock,shock_push:note.shockPush,sync_drop:note.syncDrop};
}
export function qualityFields(t:Trade):Pick<OrderRecord,'trend_side'|'with_trend'|'book'|'residual'|'relative_strength'|'move30'|'sync'|'breadth'>{
  const read=t.entryContext?.entryRead;
  if(!read)return {trend_side:null,with_trend:null,book:null,residual:null,relative_strength:null,move30:null,sync:null,breadth:null};
  return {trend_side:read.trendSide,with_trend:read.withTrend,book:read.book,residual:read.residual,
    relative_strength:read.relativeStrength,move30:read.move30,sync:read.sync,breadth:read.breadth};
}
export function pathFields(t:Trade):Pick<OrderRecord,'coin_background'|'coin_recent'|'coin_label'|'coin_versus'|'coin_background_pct'|'coin_recent_pct'|'coin_window_min'>{
  const path=t.entryContext?.coinPath;
  if(!path)return {coin_background:null,coin_recent:null,coin_label:null,coin_versus:null,coin_background_pct:null,coin_recent_pct:null,coin_window_min:null};
  return {coin_background:path.background,coin_recent:path.recent,coin_label:path.label,coin_versus:coinPathVersus(path,t.side),
    coin_background_pct:path.backgroundPct,coin_recent_pct:path.recentPct,coin_window_min:path.windowMin};
}
function entryDecision(t:Trade):Pick<OrderRecord,'entry_signal'|'entry_fade'|'entry_room_pct'|'entry_room_touches'>{
  const rule=t.entryContext?.transitionRule??t.entryContext?.shockRoom;
  if(!rule)return {entry_signal:null,entry_fade:null,entry_room_pct:null,entry_room_touches:null};
  return {entry_signal:rule.signalSide,entry_fade:rule.fade===true,
    entry_room_pct:typeof rule.roomPct==="number"?rule.roomPct:null,
    entry_room_touches:typeof rule.touches==="number"?rule.touches:null};
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
