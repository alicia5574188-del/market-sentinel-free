/** Compact restart overlay for Adaptive Ten open-position protection only. */
import type {ForwardState,Trade} from "./forward-relations.ts";
export const FORWARD_PROTECTION_CHECKPOINT_VERSION="adaptive-ten-protection-v1";
type Row=Pick<Trade,"id"|"openedAt"|"favorable"|"adverse"|"lastPrice"|"lastQuoteAt"|"stopPrice"|"firstProfitAt"|"holdScore"|"profitFloorRate"|"peakPnlRate">;
type LegacyRow=Pick<Trade,"id"|"openedAt"|"favorable"|"adverse"|"lastPrice"|"lastQuoteAt">&{
  stopPrice?:number;profitProtection?:{floorRate?:number};
};
type ProtectionEnvelope={version?:string;startedAt?:number;baseRevision?:number;basePersistedAt?:number;
  quoteCycleAt?:number;peakEquity?:number;maxDrawdown?:number;positions?:unknown[]};
export type ForwardProtectionCheckpoint={version:typeof FORWARD_PROTECTION_CHECKPOINT_VERSION;startedAt:number;baseRevision:number;
  basePersistedAt:number;quoteCycleAt:number;peakEquity:number;maxDrawdown:number;positions:Row[]};

const finite=(v:unknown)=>typeof v==="number"&&Number.isFinite(v);
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
  const c=value as ProtectionEnvelope;
  if(!c||c.startedAt!==s.startedAt||c.baseRevision!==s.revision||c.basePersistedAt!==s.storage.persistedAt)return s;
  // A protection overlay can only change currently open risk. With no open
  // positions it is intentionally inert, including overlays from retired engines.
  if(s.positions.length===0)return s;
  if(c.version==="forward-protection-checkpoint-v1"){
    if(!finite(c.quoteCycleAt)||!finite(c.peakEquity)||!finite(c.maxDrawdown)
      ||!Array.isArray(c.positions)||c.positions.length!==s.positions.length)throw new Error("旧版前向保护检查点异常；保留账户");
    const legacyRows=c.positions as LegacyRow[];
    const rows=new Map(legacyRows.map(r=>[r?.id,r]));if(rows.size!==legacyRows.length)throw new Error("旧版前向保护检查点异常；保留账户");
    const next=structuredClone(s);
    for(const t of next.positions){const r=rows.get(t.id);if(!r||r.openedAt!==t.openedAt
        ||![r.favorable,r.adverse,r.lastPrice,r.lastQuoteAt].every(finite)||r.lastPrice<=0||r.lastQuoteAt<t.lastQuoteAt
        ||r.favorable<t.favorable||r.adverse<t.adverse)throw new Error("旧版前向保护检查点异常；保留账户");
      t.favorable=r.favorable;t.adverse=r.adverse;t.lastPrice=r.lastPrice;t.lastQuoteAt=r.lastQuoteAt;
      if(r.stopPrice!=null){if(!finite(r.stopPrice)||r.stopPrice<=0
          ||(t.side==="LONG"&&r.stopPrice+1e-12<t.stopPrice)||(t.side==="SHORT"&&r.stopPrice-1e-12>t.stopPrice))
          throw new Error("旧版前向保护检查点异常；保留账户");
        t.stopPrice=r.stopPrice;
      }
      const locked=t.side==="LONG"?t.stopPrice/t.entryPrice-1:1-t.stopPrice/t.entryPrice;
      t.profitFloorRate=Math.max(t.profitFloorRate??0,locked>0?locked:0,finite(r.profitProtection?.floorRate)?r.profitProtection!.floorRate!:0);
      t.peakPnlRate=Math.max(t.peakPnlRate??0,t.favorable);
    }
    next.lastQuoteCycleAt=Math.max(next.lastQuoteCycleAt,c.quoteCycleAt as number);next.peakEquity=Math.max(next.peakEquity,c.peakEquity as number);
    next.maxDrawdown=Math.max(next.maxDrawdown,c.maxDrawdown as number);return next;
  }
  if(c.version!==FORWARD_PROTECTION_CHECKPOINT_VERSION||!finite(current.quoteCycleAt)||!finite(current.peakEquity)||!finite(current.maxDrawdown)
    ||!Array.isArray(c.positions)||current.positions.length!==s.positions.length)throw new Error("前向保护检查点异常；保留账户");
  const current=c as ForwardProtectionCheckpoint;
  const rows=new Map(current.positions.map(r=>[r?.id,r]));if(rows.size!==current.positions.length)throw new Error("前向保护检查点异常；保留账户");
  const next=structuredClone(s);
  for(const t of next.positions){const r=rows.get(t.id);if(!r||r.openedAt!==t.openedAt||![r.favorable,r.adverse,r.lastPrice,r.lastQuoteAt,r.stopPrice,r.holdScore,r.profitFloorRate,r.peakPnlRate].every(finite)
      ||r.lastPrice<=0||r.stopPrice<=0||r.favorable<t.favorable||r.adverse<t.adverse||r.lastQuoteAt<t.lastQuoteAt
      ||(t.side==="LONG"&&r.stopPrice+1e-12<t.stopPrice)||(t.side==="SHORT"&&r.stopPrice-1e-12>t.stopPrice))
      throw new Error("前向保护检查点异常；保留账户");
    t.favorable=r.favorable;t.adverse=r.adverse;t.lastPrice=r.lastPrice;t.lastQuoteAt=r.lastQuoteAt;t.stopPrice=r.stopPrice;
    t.firstProfitAt=r.firstProfitAt??null;t.holdScore=r.holdScore;t.profitFloorRate=r.profitFloorRate;t.peakPnlRate=r.peakPnlRate;}
  next.lastQuoteCycleAt=Math.max(next.lastQuoteCycleAt,current.quoteCycleAt);next.peakEquity=Math.max(next.peakEquity,current.peakEquity);
  next.maxDrawdown=Math.max(next.maxDrawdown,current.maxDrawdown);return next;
}
