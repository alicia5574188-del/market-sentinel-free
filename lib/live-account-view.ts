/** Exchange account observations. No PAPER prices, source decisions or orders. */
import {gateMarkedEquity,type GateLiveSnapshot} from './gate-live.ts';
export const LIVE_ACCOUNT_VIEW_POLICY='gate-authoritative-v1';
const finite=(v:unknown)=>v!=null&&String(v).trim()!==''&&Number.isFinite(Number(v))?Number(v):null;
export type LiveAccountMark={policy:typeof LIVE_ACCOUNT_VIEW_POLICY;sessionAt:number;accountUser:string|null;
  at:number;startedAt:number;initialEquity:number;initialFloating:number;initialTradingCash:number|null;
  equity:number;balance:number;floating:number;margin:number|null;positionCount:number;
  tradingPnl:number|null;capitalChange:number;peak:number;maxDrawdown:number};
export function observeLiveAccount(snapshot:GateLiveSnapshot,sessionAt:number,previous?:LiveAccountMark|null):LiveAccountMark {
  const equity=gateMarkedEquity(snapshot),balance=Number(snapshot.account.total),floating=equity-balance;
  const accountUser=snapshot.account.user==null?null:String(snapshot.account.user);
  const history=snapshot.account.history;
  const parts=[history?.pnl??snapshot.account.history_pnl,history?.fee??snapshot.account.history_fee,
    history?.fund??snapshot.account.history_fund].map(finite);
  const tradingCash=parts.every(v=>v!==null)?parts.reduce<number>((sum,v)=>sum+v!,0):null;
  const same=previous?.sessionAt===sessionAt&&previous.accountUser===accountUser;
  const anchor=same?previous:null,initialEquity=anchor?.initialEquity??equity,
    initialFloating=anchor?.initialFloating??floating,initialTradingCash=anchor?anchor.initialTradingCash:tradingCash;
  const peak=Math.max(anchor?.peak??equity,equity);
  const held=snapshot.positions.filter(p=>Number(p.size??0)!==0);
  const margins=held.map(p=>finite(p.margin)??finite(p.initial_margin));
  const margin=margins.every(v=>v!==null)?margins.reduce<number>((sum,v)=>sum+v!,0):null;
  return {policy:LIVE_ACCOUNT_VIEW_POLICY,sessionAt,accountUser,at:snapshot.checkedAt,
    startedAt:anchor?.startedAt??snapshot.checkedAt,initialEquity,initialFloating,initialTradingCash,
    equity,balance,floating,margin,positionCount:held.length,
    tradingPnl:tradingCash!==null&&initialTradingCash!==null?tradingCash-initialTradingCash+floating-initialFloating:null,
    capitalChange:equity-initialEquity,peak,maxDrawdown:Math.max(anchor?.maxDrawdown??0,peak>0?(peak-equity)/peak:0)};
}
