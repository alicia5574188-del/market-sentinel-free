/** The 模拟净值 chart used to keep a copy of the curve in the browser under this prefix.
 * The chart is gone; this only deletes those old copies so the phone gets the space back.
 * No other browser key is touched. Server-side equity history is not affected. */
export const EQUITY_CACHE_PREFIX="sentinel:equity-cache:v1:";
type BrowserStorage=Pick<Storage,"removeItem"|"key"|"length">;
export function clearEquityBrowserCache(storage:BrowserStorage|null|undefined){
  if(!storage)return;
  try{
    const keys:string[]=[];
    for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key?.startsWith(EQUITY_CACHE_PREFIX))keys.push(key);}
    for(const key of keys)storage.removeItem(key);
  }catch{/* Storage can be blocked (private mode); nothing to free then. */}
}
/** Both storages: localStorage held the saved curve, sessionStorage the older per-tab copy. */
export function purgeEquityBrowserCache(){
  if(typeof window==="undefined")return;
  for(const pick of [()=>window.localStorage,()=>window.sessionStorage])
    try{clearEquityBrowserCache(pick());}catch{/* Optional */}
}
