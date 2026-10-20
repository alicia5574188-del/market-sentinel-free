/** Closed-order archive. The hot account only keeps a short history; this book keeps the review rows. */
import type {EntryStructure} from './entry-structure.ts';
import type {Trade} from './forward-relations.ts';
import {coinPathVersus} from './coin-path.ts';
import {s1Fields as s1Columns,type S1Fields} from './s1-rule.ts';
import {livingFields as livingColumns,type LivingFields} from './living/run-log-fields.ts';

export const ORDER_JOURNAL_KEY='market-intelligence:order-journal:v1';
export const ORDER_JOURNAL_VERSION='order-journal-v1' as const;
export const ORDER_JOURNAL_CAP=4_000;
const CAP=ORDER_JOURNAL_CAP;

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
  signal_n?:number|null;signal_gap_min?:number|null;entry_spread_bps?:number|null;
  signal_n_symbol?:number|null;prev_side?:'LONG'|'SHORT'|null;prev_gap_min?:number|null;prev_net_pct?:number|null;prev_mfe_pct?:number|null;prev_mae_pct?:number|null;
  /** 这笔用的杠杆（没开的单是如果开会用的杠杆）。 */
  leverage?:number|null;
  shock_seen?:boolean|null;
  mode?:string|null;trade_plan?:string|null;intent?:string|null;long_score?:number|null;short_score?:number|null;residual_z?:number|null;
  score?:number|null;stop_price?:number|null;planned_hold_min?:number|null;volume24h_usd?:number|null;funding_rate?:number|null;trend_score?:number|null;factor_30m_pct?:number|null;
  gap_bps?:number|null;gap_applicable?:boolean|null;
  /** 趋势/爆发开仓规则：btc_follow / washout_flip / washout_long / pumped_short / btc_follow_block / btc_missing_block；其它阶段为空。 */
  entry_gate?:string|null;gate_signal_side?:'LONG'|'SHORT'|null;gate_btc_1h_pct?:number|null;gate_coin_bg_pct?:number|null;
}&Partial<S1Fields>&Partial<LivingFields>;
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
    leverage:typeof t.leverage==="number"&&t.leverage>0?t.leverage:null,
    entry_rule:entryRuleOf(t),
    ...entryDecision(t),...stageFields(t),...qualityFields(t),...pathFields(t),...signalFields(t),...snapFields(t),...gapFields(t),...gateFields(t),...s1Fields(t),...livingFields(t)};
}
function stageFields(t:Trade):Pick<OrderRecord,'live_stage'|'prior_stage'|'stage_age_min'|'minutes_since_shock'|'shock_push'|'sync_drop'|'shock_seen'>{
  const note=t.entryContext?.stageNote;
  if(!note)return {live_stage:null,prior_stage:null,stage_age_min:null,minutes_since_shock:null,shock_push:null,sync_drop:null,shock_seen:null};
  const seen=note.liveStage==="SHOCK"||note.minutesSinceShock!=null;
  return {live_stage:note.liveStage,prior_stage:note.priorStage,stage_age_min:note.stageAgeMin,
    minutes_since_shock:note.minutesSinceShock,shock_push:note.shockPush,sync_drop:note.syncDrop,shock_seen:seen};
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
export function signalFields(t:Trade):Pick<OrderRecord,'signal_n'|'signal_gap_min'|'entry_spread_bps'|'signal_n_symbol'|'prev_side'|'prev_gap_min'|'prev_net_pct'|'prev_mfe_pct'|'prev_mae_pct'>{
  const row=t.signalRepeat,spread=t.entrySpreadBps;
  const n=row?.n,gap=row?.gapMin;
  return {signal_n:typeof n==="number"&&n>=1?n:null,
    signal_gap_min:typeof gap==="number"&&Number.isFinite(gap)?gap:null,
    entry_spread_bps:typeof spread==="number"&&Number.isFinite(spread)?spread:null,
    signal_n_symbol:typeof row?.nSymbol==="number"&&row.nSymbol>=1?row.nSymbol:null,
    prev_side:row?.prevSide==="LONG"||row?.prevSide==="SHORT"?row.prevSide:null,
    prev_gap_min:typeof row?.prevGapMin==="number"&&Number.isFinite(row.prevGapMin)?row.prevGapMin:null,
    prev_net_pct:typeof row?.prevNetPct==="number"&&Number.isFinite(row.prevNetPct)?row.prevNetPct:null,
    prev_mfe_pct:typeof row?.prevMfePct==="number"&&Number.isFinite(row.prevMfePct)?row.prevMfePct:null,
    prev_mae_pct:typeof row?.prevMaePct==="number"&&Number.isFinite(row.prevMaePct)?row.prevMaePct:null};
}
export function snapFields(t:Trade):Pick<OrderRecord,'mode'|'trade_plan'|'intent'|'long_score'|'short_score'|'residual_z'|'score'|'stop_price'|'planned_hold_min'|'volume24h_usd'|'funding_rate'|'trend_score'|'factor_30m_pct'>{
  const snap=t.entryContext?.entrySnap;
  const empty={mode:null,trade_plan:null,intent:null,long_score:null,short_score:null,residual_z:null,score:null,stop_price:null,planned_hold_min:null,volume24h_usd:null,funding_rate:null,trend_score:null,factor_30m_pct:null};
  if(!snap)return empty;
  return {...empty,...snap};
}
export function gateFields(t:Trade):Pick<OrderRecord,'entry_gate'|'gate_signal_side'|'gate_btc_1h_pct'|'gate_coin_bg_pct'>{
  const g=t.entryContext?.entryGate;
  if(!g)return {entry_gate:null,gate_signal_side:null,gate_btc_1h_pct:null,gate_coin_bg_pct:null};
  return {entry_gate:g.rule,gate_signal_side:g.signalSide,gate_btc_1h_pct:typeof g.btc1hPct==="number"&&Number.isFinite(g.btc1hPct)?g.btc1hPct:null,
    gate_coin_bg_pct:typeof g.coinBgPct==="number"&&Number.isFinite(g.coinBgPct)?g.coinBgPct:null};
}
/** entry_rule of a record. An opened S1 trade (TREND/SHOCK) is 'S1'; a not-opened row stays NOT_OPENED (its S1 columns say why). */
export function entryRuleOf(t:Trade):string|null{
  if(t.unopened)return "NOT_OPENED";
  if(t.entryContext?.s1?.branch)return "S1";
  return t.entryContext?.shockRoom?"SHOCK_EPISODE":t.entryContext?.transitionRule?"TRANSITION_ROOM":null;
}
/** S1 columns (btc1h_aligned_pct, s1_branch, original_side, s1_side, s1_plan, s1_stop_pct, s1_tp_pct, s1_exit_reason).
 * Only trades carrying an S1 note get the keys, so older/other rows (and the stored journal) carry no extra bytes. */
/** Living layer columns (lib/living): only present on trades it opened or protected. */
export function livingFields(t:Trade):Partial<LivingFields>{
  return livingColumns(t.entryContext?.living,t.livingGuard);
}
export function s1Fields(t:Trade):Partial<S1Fields>{
  return s1Columns(t.entryContext?.s1,t.exitReason,t.status==="CLOSED")??{};
}
const STOP_EXIT=/STOP|INVALIDAT|HARD_RISK/;
export function gapFields(t:Trade):Pick<OrderRecord,'gap_bps'|'gap_applicable'>{
  const exit=t.exitPrice,stop=t.stopPrice,reason=t.exitReason??"";
  if(t.status!=="CLOSED"||!STOP_EXIT.test(reason)||!(exit&&exit>0)||!(stop&&stop>0))return {gap_bps:null,gap_applicable:false};
  const signed=(exit-stop)/stop*10_000*(t.side==="LONG"?1:-1);
  return {gap_bps:Number(signed.toFixed(2)),gap_applicable:true};
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
