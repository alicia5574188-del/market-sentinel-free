/** Compact restart overlay for Adaptive Ten open-position protection only. */
import type {ForwardState,Trade} from "./forward-relations.ts";
import type {DirectMemory} from './direct-strategy-types.ts';
import {boundedDirectExitResearch} from './direct-exit-research.ts';
import {validMarketAuthority} from './market-authority.ts';
import {normalizeEpisodeResearch} from './episode-research.ts';
export const FORWARD_PROTECTION_CHECKPOINT_VERSION="adaptive-ten-protection-v1";
type Row=Pick<Trade,"id"|"openedAt"|"favorable"|"adverse"|"lastPrice"|"lastQuoteAt"|"stopPrice"|"firstProfitAt"|"holdScore"|"profitFloorRate"|"peakPnlRate"|"winnerManagement"|"review"|"unified"|"positionIntelligence"|"directExitResearch"|"directExitResearchOmitted">;
export type ForwardProtectionCheckpoint={version:typeof FORWARD_PROTECTION_CHECKPOINT_VERSION;startedAt:number;baseRevision:number;
  basePersistedAt:number;quoteCycleAt:number;peakEquity:number;maxDrawdown:number;positions:Row[];
  shadow?:{cutoverAt:number;peakEquity:number;maxDrawdown:number;positions:Row[]};
  unifiedReference?:{cutoverAt:number;peakEquity:number;maxDrawdown:number;positions:Row[]};
  directMemory?:{cutoverAt:number;memory:Record<string,DirectMemory>;marketAuthority?:import('./market-authority.ts').MarketAuthority;
    episodeResearch?:import('./episode-research.ts').EpisodeResearch}};
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
  if(next.directStrategy?.marketAuthority&&JSON.stringify(next.directStrategy.marketAuthority)!==JSON.stringify(previous.directStrategy?.marketAuthority))return true;
  if(next.directStrategy&&JSON.stringify(next.directStrategy.memory??{})!==JSON.stringify(previous.directStrategy?.memory??{}))return true;
  if(next.peakEquity>previous.peakEquity||next.maxDrawdown>previous.maxDrawdown)return true;
  const old=new Map(previous.positions.map(t=>[t.id,t]));
  return next.positions.some(t=>{const p=old.get(t.id);if(!p||p.openedAt!==t.openedAt)return false;
    return t.stopPrice!==p.stopPrice||t.favorable!==p.favorable||t.adverse!==p.adverse||t.firstProfitAt!==p.firstProfitAt
      ||t.holdScore!==p.holdScore||t.profitFloorRate!==p.profitFloorRate||t.peakPnlRate!==p.peakPnlRate
      ||(t.unified?.version==='dual-thesis-v2'&&t.unified.lastBarAt!==p.unified?.lastBarAt);});
}
export function buildForwardProtectionCheckpoint(s:ForwardState):ForwardProtectionCheckpoint{
  const rows=(positions:Trade[],review:boolean)=>positions.map(t=>({
      id:t.id,openedAt:t.openedAt,favorable:t.favorable,adverse:t.adverse,lastPrice:t.lastPrice,lastQuoteAt:t.lastQuoteAt,stopPrice:t.stopPrice,
      firstProfitAt:t.firstProfitAt??null,holdScore:t.holdScore??50,profitFloorRate:t.profitFloorRate??0,peakPnlRate:t.peakPnlRate??t.favorable,winnerManagement:t.winnerManagement?structuredClone(t.winnerManagement):undefined,
      unified:t.unified?structuredClone(t.unified):undefined,positionIntelligence:t.unified&&t.positionIntelligence?structuredClone(t.positionIntelligence):undefined,
      directExitResearch:boundedDirectExitResearch(t.directExitResearch),directExitResearchOmitted:t.directExitResearchOmitted,
      review:review&&t.review?.diagnosticVersion?structuredClone(t.review):undefined}));
  const checkpoint:ForwardProtectionCheckpoint={version:FORWARD_PROTECTION_CHECKPOINT_VERSION,startedAt:s.startedAt,baseRevision:s.revision,basePersistedAt:s.storage.persistedAt,
    quoteCycleAt:s.lastQuoteCycleAt,peakEquity:s.peakEquity,maxDrawdown:s.maxDrawdown,positions:rows(s.positions,true),
    ...(s.directStrategy?{directMemory:{cutoverAt:s.directStrategy.cutoverAt,memory:structuredClone(s.directStrategy.memory??{}),
      marketAuthority:s.directStrategy.marketAuthority?structuredClone(s.directStrategy.marketAuthority):undefined,
      episodeResearch:normalizeEpisodeResearch(s.directStrategy.episodeResearch)}}:{}),
    ...(s.inverseTrial&&!s.directStrategy?{shadow:{cutoverAt:s.inverseTrial.cutoverAt,peakEquity:s.inverseTrial.source.peakEquity,
      maxDrawdown:s.inverseTrial.source.maxDrawdown,positions:rows(s.inverseTrial.source.positions,false)}}:{}),
    ...(s.unifiedExecution&&!s.directStrategy?{unifiedReference:{cutoverAt:s.unifiedExecution.cutoverAt,peakEquity:s.unifiedExecution.reference.peakEquity,
      maxDrawdown:s.unifiedExecution.reference.maxDrawdown,positions:rows(s.unifiedExecution.reference.positions,false)}}:{})};
  // Leave room for host serialization and the existing write-budget metadata.
  // Optional observations cannot make a valid financial checkpoint oversized.
  if(checkpoint.directMemory?.episodeResearch&&new TextEncoder().encode(JSON.stringify(checkpoint)).length>112*1024)
    delete checkpoint.directMemory.episodeResearch;
  return checkpoint;
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
  if(next.directStrategy){const m=c.directMemory;
    if(!m||m.cutoverAt!==next.directStrategy.cutoverAt||!m.memory||Object.keys(m.memory).length>30
      ||Object.values(m.memory).some(r=>!r||typeof r.id!=='string'||!r.id||typeof r.continuationSeen!=='boolean'
        ||(r.region&&(![r.region.lower,r.region.upper,r.region.center,r.region.formedAt].every(finite)||r.region.lower<=0||r.region.upper<=r.region.lower))))
      throw new Error('独立策略事件检查点损坏；保留账户');
    next.directStrategy.memory=structuredClone(m.memory);
    const observed=normalizeEpisodeResearch(m.episodeResearch);
    if(observed&&observed.updatedAt>=(next.directStrategy.episodeResearch?.updatedAt??0))next.directStrategy.episodeResearch=observed;
    if(m.marketAuthority){if(!validMarketAuthority(m.marketAuthority))throw new Error('市场许可检查点损坏');
      next.directStrategy.marketAuthority=structuredClone(m.marketAuthority);}
    for(const [symbol,p] of Object.entries(next.directStrategy.plans)){const r=m.memory[symbol];
      if(r?.id===p.id){p.region=structuredClone(r.region);p.continuationSeen=!!p.continuationSeen||r.continuationSeen;}}
  }
  for(const t of next.positions){const r=rows.get(t.id);if(!r||r.openedAt!==t.openedAt||![r.favorable,r.adverse,r.lastPrice,r.lastQuoteAt,r.stopPrice,r.holdScore,r.profitFloorRate,r.peakPnlRate].every(finite)
      ||r.lastPrice<=0||r.stopPrice<=0||r.favorable<t.favorable||r.adverse<t.adverse||r.lastQuoteAt<t.lastQuoteAt
      ||(!t.inverseCopy&&(t.unified?.branch!=='RETURN'||t.unified.marketRoute)&&((t.side==="LONG"&&r.stopPrice+1e-12<t.stopPrice)||(t.side==="SHORT"&&r.stopPrice-1e-12>t.stopPrice))))
      throw new Error("前向保护检查点异常；保留账户");
    t.favorable=r.favorable;t.adverse=r.adverse;t.lastPrice=r.lastPrice;t.lastQuoteAt=r.lastQuoteAt;t.stopPrice=r.stopPrice;
    t.firstProfitAt=r.firstProfitAt??null;t.holdScore=r.holdScore;t.profitFloorRate=r.profitFloorRate;t.peakPnlRate=r.peakPnlRate;if(r.winnerManagement)t.winnerManagement=structuredClone(r.winnerManagement);
    if(r.review?.diagnosticVersion)t.review=structuredClone(r.review);
    const research=boundedDirectExitResearch(r.directExitResearch);
    if(research){t.directExitResearch=research;delete t.directExitResearchOmitted;}
    else if(r.directExitResearchOmitted){delete t.directExitResearch;t.directExitResearchOmitted=true;}}
  for(const t of next.positions){const r=rows.get(t.id)!;
    if(t.unified){if(!r.unified||r.unified.branch!==t.unified.branch||r.unified.sourceId!==t.unified.sourceId||r.unified.referenceId!==t.unified.referenceId||r.unified.initialStop!==t.unified.initialStop)
      throw new Error('统一策略保护身份不一致');t.unified=structuredClone(r.unified);
      if(r.positionIntelligence)t.positionIntelligence=structuredClone(r.positionIntelligence);}}
  if(next.unifiedExecution&&!next.directStrategy){
    const cRef=c.unifiedReference,ref=next.unifiedExecution.reference;
    if(!cRef||cRef.cutoverAt!==next.unifiedExecution.cutoverAt||![cRef.peakEquity,cRef.maxDrawdown].every(finite)
      ||!Array.isArray(cRef.positions)||cRef.positions.length!==ref.positions.length)
      throw new Error('统一策略原反向对照保护缺失');
    const byId=new Map(cRef.positions.map(t=>[t.id,t]));if(byId.size!==ref.positions.length)throw new Error('原反向对照保护重复');
    for(const t of ref.positions){const r=byId.get(t.id);
      if(!r||r.openedAt!==t.openedAt||![r.favorable,r.adverse,r.lastPrice,r.lastQuoteAt,r.stopPrice].every(finite)
        ||r.favorable<t.favorable||r.adverse<t.adverse||r.lastQuoteAt<t.lastQuoteAt||r.lastPrice<=0||r.stopPrice<=0)
        throw new Error('原反向对照保护不一致');Object.assign(t,r);}
    ref.peakEquity=Math.max(ref.peakEquity,cRef.peakEquity);ref.maxDrawdown=Math.max(ref.maxDrawdown,cRef.maxDrawdown);
  }
  if(next.inverseTrial&&!next.directStrategy){
    const shadow=c.shadow,source=next.inverseTrial.source;
    if(!shadow||shadow.cutoverAt!==next.inverseTrial.cutoverAt||![shadow.peakEquity,shadow.maxDrawdown].every(finite)
      ||!Array.isArray(shadow.positions)||shadow.positions.length!==source.positions.length)
      throw new Error('影子保护检查点缺失；保留原配对账户');
    const byId=new Map(shadow.positions.map(t=>[t.id,t]));
    if(byId.size!==shadow.positions.length)throw new Error('影子保护检查点重复');
    for(const t of source.positions){const r=byId.get(t.id);
      if(!r||r.openedAt!==t.openedAt||![r.favorable,r.adverse,r.lastPrice,r.lastQuoteAt,r.stopPrice,r.holdScore,r.profitFloorRate,r.peakPnlRate].every(finite)||r.lastPrice<=0
        ||r.lastQuoteAt<t.lastQuoteAt||r.favorable<t.favorable||r.adverse<t.adverse||r.stopPrice<=0
        ||(t.side==='LONG'?r.stopPrice+1e-12<t.stopPrice:r.stopPrice-1e-12>t.stopPrice))throw new Error('影子保护恢复不一致');
      Object.assign(t,r);
      const inverse=next.positions.find(p=>p.inverseCopy?.sourceId===t.id);
      if(inverse)inverse.inverseCopy!.sourceStopPrice=t.stopPrice;
      const referenceInverse=next.unifiedExecution?.reference.positions.find(p=>p.inverseCopy?.sourceId===t.id);
      if(referenceInverse)referenceInverse.inverseCopy!.sourceStopPrice=t.stopPrice;
    }
    source.peakEquity=Math.max(source.peakEquity,shadow.peakEquity);source.maxDrawdown=Math.max(source.maxDrawdown,shadow.maxDrawdown);
  }
  next.lastQuoteCycleAt=Math.max(next.lastQuoteCycleAt,c.quoteCycleAt);next.peakEquity=Math.max(next.peakEquity,c.peakEquity);
  next.maxDrawdown=Math.max(next.maxDrawdown,c.maxDrawdown);return next;
}
