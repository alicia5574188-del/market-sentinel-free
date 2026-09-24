import { type TurnTimeframe } from "./multi-turn-engine.ts";

export const MULTI_TURN_ENTRY_MEMORY_VERSION="multi-turn-entry-memory-v1";
export const MULTI_TURN_MIN_REENTRY_MS=10*60_000;
export const MULTI_TURN_OPPOSITE_REENTRY_MS=2*60_000;
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
  const lossRows=windowRows.filter(row=>row.netPnl<0),sameSideLossRows=lossRows.filter(row=>row.side===input.side);
  const sameSideRows=windowRows.filter(row=>row.side===input.side),recentNetPnl=windowRows.reduce((n,row)=>n+row.netPnl,0);
  const sameSideNetPnl=sameSideRows.reduce((n,row)=>n+row.netPnl,0),oppositeSide=last.side!==input.side;
  let blockedUntil=last.closedAt+(oppositeSide?MULTI_TURN_OPPOSITE_REENTRY_MS:MULTI_TURN_MIN_REENTRY_MS),reason:string|null=null;
  if(last.netPnl<0&&last.side===input.side){
    blockedUntil=Math.max(blockedUntil,last.closedAt+MULTI_TURN_SAME_SIDE_LOSS_COOLDOWN_MS);
    reason="同币同方向刚发生亏损，等待30分钟再重新评估，避免连续追入同一失效路径";
  }
  if(sameSideLossRows.length>=3&&sameSideNetPnl<0){
    blockedUntil=Math.max(blockedUntil,last.closedAt+MULTI_TURN_LOSS_CLUSTER_COOLDOWN_MS);
    reason="同币同方向近期亏损形成簇，暂停60分钟避免重复追入；反方向新机会不继承这段冷却";
  }
  if(!reason&&input.now<blockedUntil)reason=oppositeSide
    ?"同币刚结束反方向订单，等待2分钟确认新方向不是瞬时反抽"
    :"同币刚完成同方向一轮交易，至少等待10分钟避免立即重复开仓";
  const clustered=sameSideLossRows.length>=3&&sameSideNetPnl<0,lastSameSideLoss=last.netPnl<0&&last.side===input.side;
  const scoreMultiplier=clustered?.45:lastSameSideLoss?.72:1;
  return{version:MULTI_TURN_ENTRY_MEMORY_VERSION,allowed:input.now>=blockedUntil,scoreMultiplier,blockedUntil,
    reason:input.now>=blockedUntil?null:reason,recentCount:windowRows.length,lossCount:sameSideLossRows.length,recentNetPnl};
}
