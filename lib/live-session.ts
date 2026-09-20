/** Owner activation fence. No strategy, credentials or network calls. */
export const LIVE_SESSION_VERSION = "new-orders-decimal-pnl-v1";
export type LiveSession = { version: typeof LIVE_SESSION_VERSION; enabledAt: number;
  sourceStartedAt: number | null; excludedSourceIds: string[]; migration: boolean;
  scaleRatio?: number; scaleSourceEquity?: number; scaleLiveEquity?: number; scaleAt?: number;
  scaleRebasedAt?: number; scaleRebaseFrom?: number; scaleRebaseReason?:"ANCHOR_MISMATCH"|"LIVE_CAPITAL_INCREASE" };
type SourceAccount = { startedAt: number; positions: { id: string; openedAt: number }[] };
export function startLiveSession(now: number, source: SourceAccount | null, migration = false): LiveSession {
  return { version: LIVE_SESSION_VERSION, enabledAt: now, sourceStartedAt: source?.startedAt ?? null,
    excludedSourceIds: source?.positions.map(t => t.id) ?? [], migration };
}
export function sourceAfterEnable(t: { id: string; openedAt: number }, session: LiveSession | null | undefined, sourceStartedAt: number) {
  return !!session && session.version === LIVE_SESSION_VERSION && session.sourceStartedAt === sourceStartedAt
    && t.openedAt > session.enabledAt && !session.excludedSourceIds.includes(t.id);
}
export function sameLiveSession(a: LiveSession | null | undefined, b: LiveSession | null | undefined) {
  return !!a && !!b && a.version === b.version && a.enabledAt === b.enabledAt && a.sourceStartedAt === b.sourceStartedAt;
}
const positive=(v:number|undefined)=>typeof v==="number"&&Number.isFinite(v)&&v>0;
const ratioGap=(a:number,b:number)=>a>b?a/b:b/a;

/** Establish once from current account capital. A persisted receipt may seed the
 * ratio across restart, but a seed that is wildly smaller than today's actual
 * capital ratio is stale and must not shrink every future order. */
export function establishLiveScale(session:LiveSession,sourceEquity:number,liveEquity:number,now:number,preferredRatio?:number) {
  if(session.scaleRatio&&positive(session.scaleRatio))return session;
  if(!(positive(sourceEquity)&&positive(liveEquity)))throw new Error("实盘复制比例无法建立");
  const currentRatio=liveEquity/sourceEquity;
  const preferred=preferredRatio&&positive(preferredRatio)?preferredRatio:null;
  const ratio=preferred&&currentRatio/preferred<4?preferred:currentRatio;
  if(!(Number.isFinite(ratio)&&ratio>0))throw new Error("实盘复制比例无法建立");
  return {...session,scaleRatio:ratio,scaleSourceEquity:sourceEquity,scaleLiveEquity:liveEquity,scaleAt:now,
    ...(preferred&&ratio!==preferred?{scaleRebasedAt:now,scaleRebaseFrom:preferred,scaleRebaseReason:"ANCHOR_MISMATCH" as const}:{})};
}

/** Keep normal fee/PnL drift frozen. Rebase upward only when there is objective
 * evidence the stored scale is stale: either its own anchor equities contradict
 * it, or LIVE capital has expanded by at least 4x relative to the anchor while
 * the current LIVE/PAPER ratio is also at least 4x larger. Downward divergence
 * remains fail-closed in the caller and is never silently resized. */
export function reconcileLiveScale(session:LiveSession,sourceEquity:number,liveEquity:number,now:number) {
  if(!(positive(sourceEquity)&&positive(liveEquity)))throw new Error("实盘复制比例无法核对");
  if(!positive(session.scaleRatio))return establishLiveScale(session,sourceEquity,liveEquity,now);
  const fixed=session.scaleRatio!;
  const currentRatio=liveEquity/sourceEquity;
  if(positive(session.scaleSourceEquity)&&positive(session.scaleLiveEquity)){
    const anchorRatio=session.scaleLiveEquity!/session.scaleSourceEquity!;
    if(anchorRatio>fixed&&ratioGap(anchorRatio,fixed)>1.05)
      return {...session,scaleRatio:anchorRatio,scaleRebasedAt:now,scaleRebaseFrom:fixed,scaleRebaseReason:"ANCHOR_MISMATCH" as const};
    const liveGrowth=liveEquity/session.scaleLiveEquity!;
    const ratioGrowth=currentRatio/fixed;
    if(liveGrowth>=4&&ratioGrowth>=4)
      return {...session,scaleRatio:currentRatio,scaleSourceEquity:sourceEquity,scaleLiveEquity:liveEquity,scaleAt:now,
        scaleRebasedAt:now,scaleRebaseFrom:fixed,scaleRebaseReason:"LIVE_CAPITAL_INCREASE" as const};
  } else if(currentRatio/fixed>=4) {
    // Legacy activation from before capital anchors existed. Only a very large
    // upward mismatch is safe to interpret as stale scale rather than PnL drift.
    return {...session,scaleRatio:currentRatio,scaleSourceEquity:sourceEquity,scaleLiveEquity:liveEquity,scaleAt:now,
      scaleRebasedAt:now,scaleRebaseFrom:fixed,scaleRebaseReason:"ANCHOR_MISMATCH" as const};
  }
  return session;
}
