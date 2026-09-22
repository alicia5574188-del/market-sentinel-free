import { type TurnTimeframe } from "./multi-turn-engine.ts";

export const MULTI_TURN_ENTRY_MEMORY_VERSION="multi-turn-entry-memory-v1";
export const MULTI_TURN_MIN_REENTRY_MS=10*60_000;
export const MULTI_TURN_SAME_SIDE_LOSS_COOLDOWN_MS=30*60_000;
export const MULTI_TURN_LOSS_CLUSTER_COOLDOWN_MS=60*60_000;
export const MULTI_TURN_LOSS_WINDOW_MS=6*60*60_000;

export type MultiTurnClosedOutcome={
  symbol:string;side:"LONG"|"SHORT";timeframe:TurnTimeframe;closedAt:number;netPnl:number;exitReason:string|null;
};
export type MultiTurnEntryMemoryDecision={
  version:typeof MULTI_TURN_ENTRY_MEMORY_VERSION;allowed:boolean;scoreMultiplier:number;blockedUntil:number;reason:string|null;
  recentCount:number;lossCount:number;recentNetPnl:number;
};

/**
 * Pure short-lived execution memory. It prevents immediate churn without
 * creating a shadow/promotion gate or permanently blacklisting a symbol.
 */
export function evaluateMultiTurnEntryMemory(input:{
  now:number;symbol:string;side:"LONG"|"SHORT";recent:MultiTurnClosedOutcome[];
}):MultiTurnEntryMemoryDecision{
  const rows=input.recent.filter(row=>row.symbol===input.symbol&&Number.isFinite(row.closedAt)&&row.closedAt<=input.now)
    .sort((a,b)=>b.closedAt-a.closedAt).slice(0,6);
  if(!rows.length)return{version:MULTI_TURN_ENTRY_MEMORY_VERSION,allowed:true,scoreMultiplier:1,blockedUntil:0,reason:null,
    recentCount:0,lossCount:0,recentNetPnl:0};
  const last=rows[0],windowRows=rows.filter(row=>input.now-row.closedAt<=MULTI_TURN_LOSS_WINDOW_MS);
  const lossRows=windowRows.filter(row=>row.netPnl<0),recentNetPnl=windowRows.reduce((n,row)=>n+row.netPnl,0);
  let blockedUntil=last.closedAt+MULTI_TURN_MIN_REENTRY_MS,reason:string|null=null;
  if(last.netPnl<0&&last.side===input.side){
    blockedUntil=Math.max(blockedUntil,last.closedAt+MULTI_TURN_SAME_SIDE_LOSS_COOLDOWN_MS);
    reason="同币同方向刚发生亏损，等待30分钟再重新评估，避免连续追入同一失效路径";
  }
  if(lossRows.length>=3&&recentNetPnl<0){
    blockedUntil=Math.max(blockedUntil,last.closedAt+MULTI_TURN_LOSS_CLUSTER_COOLDOWN_MS);
    reason="同币近期亏损形成簇，暂停60分钟让市场状态重新形成，不进入长期影子门槛";
  }
  if(!reason&&input.now<blockedUntil)reason="同币刚完成一轮交易，至少等待10分钟避免立即重复开仓";
  const clustered=lossRows.length>=3&&recentNetPnl<0;
  const scoreMultiplier=clustered?.45:last.netPnl<0?.72:1;
  return{version:MULTI_TURN_ENTRY_MEMORY_VERSION,allowed:input.now>=blockedUntil,scoreMultiplier,blockedUntil,
    reason:input.now>=blockedUntil?null:reason,recentCount:windowRows.length,lossCount:lossRows.length,recentNetPnl};
}
