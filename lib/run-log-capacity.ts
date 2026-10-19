/**
 * Run-log storage progress and export deadline for the 运行日志 panel. Pure: no I/O, no clock.
 * Display only. Nothing here is read by an entry, an exit, sizing, a stop, live copying or a storage write.
 *
 * Count classes evict their oldest rows once more than `cap` are stored (the trade-path book: 1200 records
 * incl. their price paths; the closed-order journal: 4000; the stage timeline: 2000 switches).
 * The window class is the equity-minute series: the export carries the last 8 Beijing days only.
 */
export const RUN_LOG_EXPORT_KEY="log:export:last";
export type RunLogExportMark={at:number;rows:number|null};

const H=3_600_000,DAY=24*H,BEIJING=8*H;
export const RATE_MIN_WINDOW_MS=6*H,RATE_MAX_WINDOW_MS=24*H,SAFE_MARGIN_MIN_MS=12*H,SAFE_MARGIN_SHARE=.2;

export type CountClass={key:string;label:string;cap:number;times:readonly number[]};
export type WindowClass={key:string;label:string;days:number;since:number|null};
export type ClassReport={key:string;label:string;kind:"count"|"window";stored:number;cap:number;usedPct:number;
  /** Rows (count) created after the last export, or all stored rows before any export. */
  sinceBase:number;
  /** sinceBase / cap: how much of the room before a not-yet-exported row is lost is used. */
  pendingPct:number;ratePerHour:number|null;deadline:number|null;overdue:boolean};
export type RunLogCapacity={now:number;lastExportAt:number|null;lastExportRows:number|null;
  primary:ClassReport|null;binding:ClassReport|null;classes:ClassReport[];
  deadline:number|null;hoursLeft:number|null;safeAt:number|null;overdue:boolean;
  hot:{rawBytes:number;budgetBytes:number;usedPct:number}|null};

const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const pct=(a:number,b:number)=>b>0?Math.round(a/b*1000)/10:0;
/** Beijing midnight (as a UTC ms timestamp) of the day containing ts. */
export const beijingDayStart=(ts:number)=>Math.floor((ts+BEIJING)/DAY)*DAY-BEIJING;

/** Records per hour over the recent 6-24 h, from stored creation times (survives restarts: times are persisted). */
export function recentRate(times:readonly number[],now:number):number|null{
  const ok=times.filter(t=>finite(t)&&t<=now);
  if(!ok.length)return null;
  const span=now-Math.min(...ok);
  // Up to the last 24 h of history; a younger book uses all it has (at least 1 h so one burst is not extrapolated).
  const window=span>=RATE_MIN_WINDOW_MS?Math.min(RATE_MAX_WINDOW_MS,span):Math.max(H,span);
  const n=ok.filter(t=>t>=now-window).length;
  return n>0?n/(window/H):0;
}

function countReport(c:CountClass,now:number,lastExportAt:number|null):ClassReport{
  const times=c.times.filter(finite),stored=times.length;
  const sinceBase=lastExportAt==null?stored:times.filter(t=>t>lastExportAt).length;
  const remaining=c.cap-sinceBase,rate=recentRate(times,now);
  // A post-export row is lost only after rows created since the export exceed the cap (oldest go first).
  // With no export yet: the oldest stored row goes once the stored count exceeds the cap.
  const overdue=lastExportAt==null?stored>=c.cap:remaining<0;
  let deadline:number|null;
  if(overdue)deadline=now;
  else if(rate==null||rate<=0)deadline=null;
  else deadline=now+Math.max(0,remaining)/rate*H;
  return {key:c.key,label:c.label,kind:"count",stored,cap:c.cap,usedPct:pct(stored,c.cap),sinceBase,pendingPct:Math.min(100,pct(sinceBase,c.cap)),
    ratePerHour:rate==null?null:Math.round(rate*100)/100,deadline,overdue};
}
function windowReport(w:WindowClass,now:number,lastExportAt:number|null):ClassReport|null{
  const base=lastExportAt??w.since;
  if(!finite(base))return null;
  // The export reads the newest `days` Beijing day keys: the day holding `base` must still be one of them.
  const deadline=beijingDayStart(base)+w.days*DAY,elapsed=Math.max(0,now-beijingDayStart(base));
  return {key:w.key,label:w.label,kind:"window",stored:Math.floor(elapsed/DAY)+1,cap:w.days,usedPct:Math.min(100,pct(elapsed,w.days*DAY)),
    sinceBase:Math.floor(elapsed/DAY)+1,pendingPct:Math.min(100,pct(elapsed,w.days*DAY)),ratePerHour:null,deadline:Math.max(now,deadline),overdue:now>=deadline};
}

export function runLogCapacity(input:{now:number;lastExport:RunLogExportMark|null;counts:readonly CountClass[];
  windows?:readonly WindowClass[];hot?:{rawBytes?:number|null;budgetBytes?:number|null}|null}):RunLogCapacity{
  const {now}=input,lastExportAt=finite(input.lastExport?.at)?input.lastExport!.at:null;
  const counts=input.counts.map(c=>countReport(c,now,lastExportAt));
  const windows=(input.windows??[]).map(w=>windowReport(w,now,lastExportAt)).filter((r):r is ClassReport=>!!r);
  const classes=[...counts,...windows];
  const timed=classes.filter(r=>r.deadline!=null).sort((a,b)=>a.deadline!-b.deadline!);
  const binding=timed[0]??null,deadline=binding?.deadline??null;
  const left=deadline==null?null:Math.max(0,deadline-now);
  const safeAt=deadline==null?null:Math.max(now,deadline-Math.max(SAFE_MARGIN_MIN_MS,left!*SAFE_MARGIN_SHARE));
  const raw=input.hot?.rawBytes,budget=input.hot?.budgetBytes;
  return {now,lastExportAt,lastExportRows:finite(input.lastExport?.rows)?input.lastExport!.rows:null,
    primary:counts[0]??null,binding,classes,deadline,hoursLeft:left==null?null:Math.round(left/H*10)/10,safeAt,
    overdue:classes.some(r=>r.overdue),
    hot:finite(raw)&&finite(budget)&&budget>0?{rawBytes:raw,budgetBytes:budget,usedPct:pct(raw,budget)}:null};
}
