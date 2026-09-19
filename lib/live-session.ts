/** Owner activation fence. No strategy, credentials or network calls. */
export const LIVE_SESSION_VERSION = "new-orders-decimal-pnl-v1";
export type LiveSession = { version: typeof LIVE_SESSION_VERSION; enabledAt: number;
  sourceStartedAt: number | null; excludedSourceIds: string[]; migration: boolean;
  scaleRatio?: number; scaleSourceEquity?: number; scaleLiveEquity?: number; scaleAt?: number };
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
export function establishLiveScale(session:LiveSession,sourceEquity:number,liveEquity:number,now:number,preferredRatio?:number) {
  if(session.scaleRatio&&Number.isFinite(session.scaleRatio)&&session.scaleRatio>0)return session;
  const ratio=preferredRatio&&Number.isFinite(preferredRatio)&&preferredRatio>0?preferredRatio:liveEquity/sourceEquity;
  if(!(Number.isFinite(sourceEquity)&&sourceEquity>0&&Number.isFinite(liveEquity)&&liveEquity>0&&Number.isFinite(ratio)&&ratio>0))
    throw new Error("实盘复制比例无法建立");
  return {...session,scaleRatio:ratio,scaleSourceEquity:sourceEquity,scaleLiveEquity:liveEquity,scaleAt:now};
}
