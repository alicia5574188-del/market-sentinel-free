/** Compact restart overlay for Adaptive Ten open-position protection only. */
import type {ForwardState,Trade} from "./forward-relations.ts";
export const FORWARD_PROTECTION_CHECKPOINT_VERSION="adaptive-ten-protection-v1";
type Row=Pick<Trade,"id"|"openedAt"|"favorable"|"adverse"|"lastPrice"|"lastQuoteAt"|"stopPrice"|"firstProfitAt"|"holdScore"|"profitFloorRate"|"peakPnlRate">;
export type ForwardProtectionCheckpoint={version:typeof FORWARD_PROTECTION_CHECKPOINT_VERSION;startedAt:number;baseRevision:number;
  basePersistedAt:number;quoteCycleAt:number;peakEquity:number;maxDrawdown:number;positions:Row[]};
type LegacyProtectionRow=Partial<Row>&{id?:string;openedAt?:number;favorable?:number;adverse?:number;lastPrice?:number;lastQuoteAt?:number;
  stopPrice?:number;profitProtection?:{floorRate?:number}|null};
type LegacyProtectionCheckpoint={version:"forward-protection-checkpoint-v1";startedAt:number;baseRevision:number;basePersistedAt:number;
  quoteCycleAt:number;peakEquity:number;maxDrawdown:number;positions:LegacyProtectionRow[]};

const finite=(v:unknown)=>typeof v==="number"&&Number.isFinite(v);
function migrateLegacyCheckpoint(s:ForwardState,c:LegacyProtectionCheckpoint):ForwardProtectionCheckpoint{
  if(!Array.isArray(c.positions)||c.positions.length!==s.positions.length)throw new Error("前向保护检查点异常；保留账户");
  const base=new Map(s.positions.map(t=>[t.id,t]));
  const positions=c.positions.map(row=>{
    const t=row.id?base.get(row.id):null;
    if(!t||row.openedAt!==t.openedAt||![row.favorable,row.adverse,row.lastPrice,row.lastQuoteAt].every(finite))
      throw new Error("前向保护检查点异常；保留账户");
    const floor=finite(row.profitProtection?.floorRate)?Math.max(0,row.profitProtection!.floorRate!):Math.max(0,t.profitFloorRate??0);
    return{id:t.id,openedAt:t.openedAt,favorable:row.favorable!,adverse:row.adverse!,lastPrice:row.lastPrice!,
      lastQuoteAt:row.lastQuoteAt!,stopPrice:finite(row.stopPrice)?row.stopPrice!:t.stopPrice,
      firstProfitAt:t.firstProfitAt??null,holdScore:t.holdScore??50,profitFloorRate:floor,
      peakPnlRate:Math.max(row.favorable!,t.peakPnlRate??0)} satisfies Row;
  });
  return{version:FORWARD_PROTECTION_CHECKPOINT_VERSION,startedAt:c.startedAt,baseRevision:c.baseRevision,
    basePersistedAt:c.basePersistedAt,quoteCycleAt:c.quoteCycleAt,peakEquity:c.peakEquity,maxDrawdown:c.maxDrawdown,positions};
}
export function forwardProtectionChanged(previous:ForwardState,next:ForwardState){
  if(next.peakEquity>previous.peakEquity||next.maxDrawdown>previous.maxDrawdown)return true;
  const old=new Map(previous.positions.map(t=>[t.id,t]));
  return next.positions.some(t=>{const p=old.get(t.id);if(!p||p.openedAt!==t.openedAt)return false;
    return t.stopPrice!==p.stopPrice||t.favorable!==p.favorable||t.adverse!==p.adverse||t.firstProfitAt!==p.firstProfitAt
      ||t.holdScore!==p.holdScore||t.profitFloorRate!==p.profitFloorRate||t.peakPnlRate!==p.peakPnlRate;});
}
export function buildForwardProtectionCheckpoint(s:ForwardState):ForwardProtectionCheckpoint{
  return{version:FORWARD_PROTECTION_CHECKPOINT_VERSION,startedAt:s.startedAt,baseRevision:s.revision,basePersistedAt:s.storage.persistedAt,
    quoteCycleAt:s.lastQuoteCycleAt,peakEquity:s.peakEquity,maxDrawdown:s.maxDrawdown,positions:s.positions.map(t=>({
      id:t.id,openedAt:t.openedAt,favorable:t.favorable,adverse:t.adverse,lastPrice:t.lastPrice,lastQuoteAt:t.lastQuoteAt,stopPrice:t.stopPrice,
      firstProfitAt:t.firstProfitAt??null,holdScore:t.holdScore??50,profitFloorRate:t.profitFloorRate??0,peakPnlRate:t.peakPnlRate??t.favorable}))};
}
export function restoreForwardProtectionCheckpoint(s:ForwardState,value:unknown):ForwardState{
  if(value==null)return s;
  const raw=value as ForwardProtectionCheckpoint|LegacyProtectionCheckpoint;
  if(!raw||raw.startedAt!==s.startedAt||raw.baseRevision!==s.revision||raw.basePersistedAt!==s.storage.persistedAt)return s;
  const c=raw.version===FORWARD_PROTECTION_CHECKPOINT_VERSION?raw
    :raw.version==="forward-protection-checkpoint-v1"?migrateLegacyCheckpoint(s,raw)
    :(()=>{throw new Error("前向保护检查点异常；保留账户");})();
  if(!finite(c.quoteCycleAt)||!finite(c.peakEquity)||!finite(c.maxDrawdown)
    ||!Array.isArray(c.positions)||c.positions.length!==s.positions.length)throw new Error("前向保护检查点异常；保留账户");
  const rows=new Map(c.positions.map(r=>[r?.id,r]));if(rows.size!==c.positions.length)throw new Error("前向保护检查点异常；保留账户");
  const next=structuredClone(s);
  for(const t of next.positions){const r=rows.get(t.id);if(!r||r.openedAt!==t.openedAt||![r.favorable,r.adverse,r.lastPrice,r.lastQuoteAt,r.stopPrice,r.holdScore,r.profitFloorRate,r.peakPnlRate].every(finite)
      ||r.lastPrice<=0||r.stopPrice<=0||r.favorable<t.favorable||r.adverse<t.adverse||r.lastQuoteAt<t.lastQuoteAt
      ||(t.side==="LONG"&&r.stopPrice+1e-12<t.stopPrice)||(t.side==="SHORT"&&r.stopPrice-1e-12>t.stopPrice))
      throw new Error("前向保护检查点异常；保留账户");
    t.favorable=r.favorable;t.adverse=r.adverse;t.lastPrice=r.lastPrice;t.lastQuoteAt=r.lastQuoteAt;t.stopPrice=r.stopPrice;
    t.firstProfitAt=r.firstProfitAt??null;t.holdScore=r.holdScore;t.profitFloorRate=r.profitFloorRate;t.peakPnlRate=r.peakPnlRate;}
  next.lastQuoteCycleAt=Math.max(next.lastQuoteCycleAt,c.quoteCycleAt);next.peakEquity=Math.max(next.peakEquity,c.peakEquity);
  next.maxDrawdown=Math.max(next.maxDrawdown,c.maxDrawdown);return next;
}
