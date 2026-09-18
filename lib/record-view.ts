/** Display windows only: never truncate trading, accounting or recovery ledgers. */
export const RECORD_VIEW_VERSION = "compact-records-pnl-v1";
export const RECENT_RECORDS = 10, ARCHIVE_RECORDS = 50;
export function recordWindows<T extends {id:string}>(rows: readonly T[], endedAt:(r:T)=>number) {
  const unique=new Map<string,T>();
  for(const row of rows)if(!unique.has(row.id))unique.set(row.id,row);
  const all=[...unique.values()].sort((a,b)=>endedAt(b)-endedAt(a)||a.id.localeCompare(b.id));
  return {recent:all.slice(0,RECENT_RECORDS),archive:all.slice(RECENT_RECORDS,RECENT_RECORDS+ARCHIVE_RECORDS)};
}
export function archivePage<T>(rows:readonly T[],page:number) {
  const pages=Math.max(1,Math.ceil(rows.length/RECENT_RECORDS));
  const index=Math.min(pages-1,Math.max(0,Number.isFinite(page)?Math.floor(page):0));
  return {items:rows.slice(index*RECENT_RECORDS,(index+1)*RECENT_RECORDS),page:index,pages};
}