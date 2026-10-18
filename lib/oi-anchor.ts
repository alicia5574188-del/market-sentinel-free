/**
 * Open-interest baseline for the run log's oi_chg_pct. Log only: never read by an entry, exit, sizing, stop or live copy.
 * Built from the all-ticker radar the worker already fetches (no request of its own): one snapshot every 15 minutes,
 * the last ~2.25 hours kept. Each snapshot is also stored under its own small key so a restart does not blank the
 * baseline for the next hour. The anchor is the newest snapshot at least 60 minutes old (at most 135).
 */
export const OI_SNAPSHOT_PREFIX='log:oi:';
export const OI_SNAPSHOT_EVERY_MS=15*60_000;
export const OI_ANCHOR_MIN_AGE_MS=60*60_000;
export const OI_ANCHOR_MAX_AGE_MS=135*60_000;
export type OiSnapshot={at:number;oi:Record<string,number>};
export type OiRing=OiSnapshot[];

export const oiSnapshotKey=(at:number)=>`${OI_SNAPSHOT_PREFIX}${String(Math.floor(at)).padStart(16,'0')}`;

/** Adds a snapshot if 15 minutes passed since the newest one. Returns what to store and which keys to drop. */
export function noteOiSnapshot(ring:OiRing,rows:readonly {symbol:string;openInterest:number}[],at:number):{ring:OiRing;put:OiSnapshot|null;drop:string[]}{
  const newest=ring.at(-1);
  if(newest&&at-newest.at<OI_SNAPSHOT_EVERY_MS)return {ring,put:null,drop:[]};
  const oi:Record<string,number>={};
  for(const row of rows)if(row&&typeof row.symbol==='string'&&Number.isFinite(row.openInterest)&&row.openInterest>0)oi[row.symbol]=row.openInterest;
  if(!Object.keys(oi).length)return {ring,put:null,drop:[]};
  const snap={at,oi};
  return mergeOiRing(ring,[snap],at,snap);
}
/** Merges snapshots (e.g. read back from storage), keeps order and drops anything older than the window. */
export function mergeOiRing(ring:OiRing,extra:readonly OiSnapshot[],now:number,put:OiSnapshot|null=null):{ring:OiRing;put:OiSnapshot|null;drop:string[]}{
  const byAt=new Map<number,OiSnapshot>();
  for(const snap of [...ring,...extra])if(snap&&Number.isFinite(snap.at)&&snap.oi&&typeof snap.oi==='object')byAt.set(snap.at,snap);
  const all=[...byAt.values()].sort((a,b)=>a.at-b.at);
  const keep=all.filter(snap=>now-snap.at<=OI_ANCHOR_MAX_AGE_MS&&snap.at<=now+60_000);
  const drop=all.filter(snap=>!keep.includes(snap)).map(snap=>oiSnapshotKey(snap.at));
  return {ring:keep,put,drop};
}
/** The baseline: newest snapshot 60-135 minutes old, or null. */
export function oiAnchor(ring:OiRing,now:number):{at:number;oi:ReadonlyMap<string,number>}|null{
  for(let i=ring.length-1;i>=0;i--){
    const snap=ring[i]!,age=now-snap.at;
    if(age<OI_ANCHOR_MIN_AGE_MS)continue;
    if(age>OI_ANCHOR_MAX_AGE_MS)return null;
    return {at:snap.at,oi:new Map(Object.entries(snap.oi))};
  }
  return null;
}
