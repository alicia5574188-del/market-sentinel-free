/** Member (会员) projections: a member page only shows the member's own live copy account.
 * The shared PAPER strategy stays on the server; a member receives the few fields the
 * live cards and the health pill need, never research, run-log or account internals. */

type SourceTrade={id:string;symbol?:string;side?:string;status?:string;entryPrice?:number;lastPrice?:number;exitPrice?:number|null;
  netPnl?:number|null;notional?:number;openedAt?:number;closedAt?:number|null};
type ForwardLike={startedAt?:number;mode?:string;version?:string;engineVersion?:string;updatedAt?:number;lastCycleAt?:number|null;strategyRemoved?:boolean;
  storage?:{error?:string|null;persistedAt?:number|null}|null;positions?:SourceTrade[];history?:SourceTrade[]};
type StateLike={positions?:SourceTrade[];history?:SourceTrade[]};

/** Only the source fields the live position card compares against (entry/last/exit price, PAPER net result). */
const sourceFields=(t:SourceTrade):SourceTrade=>({id:t.id,symbol:t.symbol,side:t.side,status:t.status,entryPrice:t.entryPrice,lastPrice:t.lastPrice,
  exitPrice:t.exitPrice??null,netPnl:t.netPnl??null,notional:t.notional,openedAt:t.openedAt,closedAt:t.closedAt??null});

/** Shared-source view for a member: health fields plus the PAPER source of this member's own live orders only. */
export function memberForwardView(view:ForwardLike|null|undefined,state:StateLike|null|undefined,liveIds:Iterable<string>){
  if(!view)return null;
  const ids=new Set(liveIds),pick=(rows:SourceTrade[]|undefined)=>(rows??[]).filter(t=>ids.has(t.id));
  const positions=pick(view.positions),history=pick(view.history),seen=new Set([...positions,...history].map(t=>t.id));
  // A page-level PAPER reset filters the summary history; the raw state still knows those sources.
  for(const t of [...pick(state?.positions),...pick(state?.history)])if(!seen.has(t.id)){seen.add(t.id);(t.status==="OPEN"?positions:history).push(t);}
  return {startedAt:view.startedAt,mode:view.mode,version:view.version,engineVersion:view.engineVersion,updatedAt:view.updatedAt,lastCycleAt:view.lastCycleAt??null,...(view.strategyRemoved===true?{strategyRemoved:true as const}:{}),
    storage:{error:view.storage?.error??null,persistedAt:view.storage?.persistedAt??null},
    positions:positions.map(sourceFields),history:history.map(sourceFields),memberProjection:true as const};
}

export const RUNTIME_ACTIVE_MS=10_000;
/** Owner page when nothing on screen moves quickly (brain/settings, or no open position on the tab shown). */
export const OWNER_IDLE_MS=120_000;
export const MEMBER_IDLE_MS=30_000;
type RuntimeLike={liveMode?:{requestedEnabled?:boolean}|null;live?:{requestedEnabled?:boolean;positions?:Record<string,{status?:string}|null|undefined>;
  entries?:Record<string,{status?:string}|null|undefined>}|null;forward?:{positions?:{status?:string}[]|null}|null}|null;
const DONE_ENTRY=new Set(["FILLED","CANCELLED","FINISHED","REJECTED"]);
/** Real-money activity: copy switch on, an open live position, or an unfinished live entry. */
function liveBusy(runtime:RuntimeLike){
  const live=runtime?.live;
  return Boolean(live?.requestedEnabled||runtime?.liveMode?.requestedEnabled)
    ||Object.values(live?.positions??{}).some(p=>p?.status==="OPEN")
    ||Object.values(live?.entries??{}).some(e=>e&&!DONE_ENTRY.has(String(e.status)));
}
/** Page refresh cadence.
 * Owner: 10s on the 实盘 tab, while real money is active, or while the tab shown (模拟/执行) lists an open
 * paper position whose floating P&L moves; 120s otherwise (大脑/设置, or nothing open on the tab shown).
 * Member: 10s while copying or holding anything, 30s when copy-trading is off with nothing open. */
export function runtimeRefreshMs(role:string|undefined,runtime:RuntimeLike,tab?:string|null){
  if(!runtime)return RUNTIME_ACTIVE_MS;
  if(role==="member")return liveBusy(runtime)?RUNTIME_ACTIVE_MS:MEMBER_IDLE_MS;
  if(tab==="live"||liveBusy(runtime))return RUNTIME_ACTIVE_MS;
  const paperOpen=(runtime.forward?.positions??[]).some(p=>p?.status==="OPEN");
  return paperOpen&&(tab==="home"||tab==="paper"||tab==="execution")?RUNTIME_ACTIVE_MS:OWNER_IDLE_MS;
}

type LiveIdsLike={positions?:Record<string,{id?:string}|null|undefined>;entries?:Record<string,{planId?:string}|null|undefined>;history?:{id:string}[]};
/** Source ids of a member's own live orders (open, pending, recent closed): the only PAPER sources the page may show. */
export function liveSourceIds(live:LiveIdsLike|null|undefined){
  const ids=new Set<string>();
  for(const [key,p] of Object.entries(live?.positions??{}))ids.add(p?.id??key);
  for(const [key,e] of Object.entries(live?.entries??{}))ids.add(e?.planId??key);
  for(const h of live?.history??[])ids.add(h.id);
  return ids;
}
