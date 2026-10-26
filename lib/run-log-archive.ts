/**
 * Long-term run-log copy in D1. It is being deleted: a pass only removes rows.
 * The run log that stays is the 1200-record book on the account. Nothing here is read by an entry, an exit,
 * sizing, a stop or live copying, and nothing here writes Durable Object storage.
 */
import type {ForwardState, Trade} from './forward-relations.ts';
import type {OrderJournal, OrderRecord} from './order-journal.ts';
import {ORDER_JOURNAL_CAP} from './order-journal.ts';
import type {EquityMinute} from './equity-minutes.ts';
import {collectEquityMinutes,equityGaps} from './equity-minutes.ts';
import {buildRunLogExport,closedLogRow,journalLogRow,shadowSignalOf,withResearchColumns,type LsrPositionRow} from './run-log.ts';
import {exportTradePaths,pathColumns,pathComplete,PATH_CAP,TAIL_MINUTES,type PathExport,type TradePath,type TradePathBook} from './trade-path.ts';
import {readStageTimeline} from './stage-chronicle.ts';
import {RESEARCH_NOTES} from './log-complete.ts';
import {beijingDayKey} from './beijing-time.ts';

export const ARCHIVE_VERSION='run-log-archive-v1' as const;
export const ARCHIVE_SEGMENT_SIZE=500;
/** Records written per pass. A pass runs at most once a minute while behind, every 5 minutes when caught up. */
export const ARCHIVE_BATCH=40;
export const ARCHIVE_STATEMENTS_PER_BATCH=20;
/** Self-imposed D1 budget for this archive (estimated rows written incl. index entries); D1 free tier is 100k/day. */
export const ARCHIVE_DAILY_ROW_WRITES=30_000;
const MIN=60_000,H=60*MIN,DAY=24*H;
/** Tail done: 24 h after the signal plus one 15-minute bucket and margin. */
export const TAIL_DONE_MS=(TAIL_MINUTES+20)*MIN;
/** The oldest rows of a book this full are archived before the tail is finished (they may be evicted first). */
export const EVICTION_GUARD_ROWS=150;
/** Stage entries are written once closed and their 30/60/120-minute follow-up is filled. */
export const STAGE_SETTLE_MS=150*MIN;
export const STAGE_BATCH=60;
const EQUITY_SEGMENT_DAYS=14;
/** The run log keeps this many records in the hot book. The D1 long-term copy is not kept. */
export const RUN_LOG_KEEP_ROWS=1200;

export const ARCHIVE_SCHEMA=[
  `CREATE TABLE IF NOT EXISTS run_log_archive (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, account_started_at INTEGER,
    opened_at INTEGER NOT NULL, archived_at INTEGER NOT NULL, partial INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL,
    row_json TEXT NOT NULL, path_json TEXT)`,
  `CREATE INDEX IF NOT EXISTS run_log_archive_opened ON run_log_archive (opened_at)`,
  `CREATE INDEX IF NOT EXISTS run_log_archive_archived ON run_log_archive (archived_at)`,
  `CREATE TABLE IF NOT EXISTS run_log_stages (at INTEGER PRIMARY KEY NOT NULL, archived_at INTEGER NOT NULL, entry_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS run_log_equity_days (day TEXT PRIMARY KEY NOT NULL, first_ts INTEGER, last_ts INTEGER,
    archived_at INTEGER NOT NULL, rows_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS run_log_archive_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
] as const;
const UPSERT=`INSERT INTO run_log_archive (id,kind,account_started_at,opened_at,archived_at,partial,bytes,row_json,path_json)
  VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,partial=excluded.partial,bytes=excluded.bytes,row_json=excluded.row_json,
    path_json=excluded.path_json,archived_at=excluded.archived_at
  WHERE run_log_archive.row_json IS NOT excluded.row_json OR run_log_archive.path_json IS NOT excluded.path_json
    OR run_log_archive.partial IS NOT excluded.partial`;
const META_UPSERT=`INSERT INTO run_log_archive_meta (key,value,updated_at) VALUES (?,?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`;

/** The subset of the D1 API used here (lets tests run on node:sqlite). */
export type D1Stmt={bind(...values:unknown[]):D1Stmt;run():Promise<unknown>;all<T=Record<string,unknown>>():Promise<{results:T[]}>;first<T=Record<string,unknown>>():Promise<T|null>};
export type D1Like={prepare(sql:string):D1Stmt;batch(statements:D1Stmt[]):Promise<unknown[]>};

export type ArchiveEntry={id:string;kind:'position'|'not_opened';openedAt:number;partial:boolean;row:Record<string,unknown>;path:PathExport|null};
export type ArchiveStats={records:number;bytes:number;firstOpenedAt:number|null;lastOpenedAt:number|null};
export type ArchiveCursor={at:number;id:string};
export type ArchiveExportMark={at:number;mode:string;rows:number};

export async function ensureArchiveSchema(db:D1Like){
  await db.batch(ARCHIVE_SCHEMA.map(sql=>db.prepare(sql)));
}

/** Which book rows are due: closed, tail finished (or about to be evicted), not yet archived in that form. */
export function dueRecords(book:readonly TradePath[],now:number,archived:ReadonlyMap<string,boolean>,retryAt:ReadonlyMap<string,number>,limit=ARCHIVE_BATCH){
  const guardFrom=book.length>=PATH_CAP-EVICTION_GUARD_ROWS?Math.max(0,PATH_CAP-EVICTION_GUARD_ROWS):Infinity;
  const due:{path:TradePath;partial:boolean}[]=[];let pending=0;
  // book.trades is newest first; walk oldest first.
  for(let i=book.length-1;i>=0;i--){
    const path=book[i]!;
    if(path.exitAt==null||!Number.isFinite(path.openedAt))continue;
    const tailDone=now-path.openedAt>=TAIL_DONE_MS,atRisk=i>=guardFrom,state=archived.get(path.id);
    // state: undefined = never archived, true = archived partial, false = archived final
    if(state===false)continue;
    if(!tailDone&&!(atRisk&&state===undefined))continue;
    if((retryAt.get(path.id)??0)>now)continue;
    pending++;
    if(due.length<limit)due.push({path,partial:!tailDone});
  }
  return {due,pending};
}

/** One pass, oldest and closest-to-eviction first. A stored id is not written again from the journal: that would replace a real path with nothing. */
export type ArchiveJob={id:string;priority:number;partial:boolean;path:TradePath|null};
export function planArchiveBatch(input:{trades:readonly TradePath[]|null;journalRows:readonly {id:string}[]|null;
  archived:ReadonlyMap<string,boolean>;retryAt:ReadonlyMap<string,number>;now:number;limit?:number}){
  const limit=input.limit??ARCHIVE_BATCH,trades=input.trades??[],journalRows=input.journalRows??[];
  const retry=(id:string)=>(input.retryAt.get(id)??0)>input.now;
  const jobs:ArchiveJob[]=[];
  const pathGuard=trades.length>=PATH_CAP-EVICTION_GUARD_ROWS?Math.max(0,PATH_CAP-EVICTION_GUARD_ROWS):Infinity;
  const journalGuard=journalRows.length>=ORDER_JOURNAL_CAP-EVICTION_GUARD_ROWS?Math.max(0,ORDER_JOURNAL_CAP-EVICTION_GUARD_ROWS):Infinity;
  const seen=new Set<string>();
  for(let i=trades.length-1;i>=0;i--){
    const path=trades[i]!;
    if(path.exitAt==null||!Number.isFinite(path.openedAt)||input.archived.get(path.id)===false||retry(path.id))continue;
    const tailDone=input.now-path.openedAt>=TAIL_DONE_MS,atRisk=i>=pathGuard,state=input.archived.get(path.id);
    if(!tailDone&&!(atRisk&&state===undefined))continue;
    seen.add(path.id);
    jobs.push({id:path.id,priority:atRisk?0:3,partial:!tailDone,path});
  }
  for(let i=journalRows.length-1;i>=0;i--){
    const id=journalRows[i]!.id;
    if(!id||seen.has(id)||input.archived.has(id)||retry(id))continue;
    seen.add(id);
    jobs.push({id,priority:i>=journalGuard?1:2,partial:false,path:null});
  }
  jobs.sort((a,b)=>a.priority-b.priority);
  return {jobs:jobs.slice(0,limit),pending:jobs.length};
}

/** The path book still has this record but the order row is already gone. Keep the path's own fields; do not invent minutes. */
export function pathFallbackRow(path:TradePath):LsrPositionRow{
  return {id:path.id,symbol:path.symbol,side:path.side,entry:path.entry,exit:path.exit,qty:path.qty,notional:path.notional,
    gross_pnl:null,fee:path.entryFee,net_pnl:path.net,holdSec:path.exitAt==null?0:Math.max(0,Math.round((path.exitAt-path.openedAt)/1000)),
    exit_reason:null,gapBps:null,opened_at:path.openedAt,closed_at:path.exitAt,trace:path.id} as LsrPositionRow;
}

export async function readArchivedFlags(db:D1Like,ids:readonly string[]){
  const out=new Map<string,boolean>(),unique=[...new Set(ids.filter(Boolean))];
  for(let i=0;i<unique.length;i+=90){
    const chunk=unique.slice(i,i+90);
    const found=await db.prepare(`SELECT id,partial FROM run_log_archive WHERE id IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all<{id:string;partial:number}>();
    for(const row of found.results)out.set(row.id,row.partial===1);
  }
  return out;
}

/** Run-log rows for the given ids, from the same sources and in the same precedence as accountLogBook. */
export function sourceRows(ids:ReadonlySet<string>,state:ForwardState,journal:OrderJournal|null,cold:readonly Trade[]){
  const out=new Map<string,{row:LsrPositionRow;kind:'position'|'not_opened'}>();
  for(const saved of journal?.rows??[])if(ids.has(saved.id)&&!out.has(saved.id))out.set(saved.id,{row:journalLogRow(saved),kind:'position'});
  for(const t of state.history)if(ids.has(t.id)&&!out.has(t.id)&&!t.inverseCopy&&t.exitReason!=='ACCOUNT_RESET'&&t.status==='CLOSED')
    out.set(t.id,{row:closedLogRow(t),kind:'position'});
  for(const t of [...(state.unopenedTrades??[]),...cold])if(ids.has(t.id)&&!out.has(t.id)&&t.status==='CLOSED')
    out.set(t.id,{row:closedLogRow(t),kind:'not_opened'});
  return out;
}

/** Exactly the export's filter, cleaning and research columns, applied to these rows only. */
export function buildArchiveEntries(input:{due:readonly {path:TradePath;partial:boolean}[];rows:ReadonlyMap<string,{row:LsrPositionRow;kind:'position'|'not_opened'}>;
  tallySince:number|null;now:number;completeOnly?:boolean}):ArchiveEntry[]{
  const pathById=new Map(input.due.map(d=>[d.path.id,d.path])),partial=new Map(input.due.map(d=>[d.path.id,d.partial]));
  const positions:LsrPositionRow[]=[],notOpened:LsrPositionRow[]=[];
  for(const d of input.due){const r=input.rows.get(d.path.id);if(!r)continue;(r.kind==='position'?positions:notOpened).push(r.row);}
  const completeOnly=input.completeOnly!==false;
  const file=buildRunLogExport({events:[],funnel:null,health:{},gate:{},exportedAt:input.now,liveEnabled:false,
    positions,notOpened,tallySince:input.tallySince,completeOnly,
    ...(completeOnly?{pathReady:(id:string,closed:boolean)=>pathComplete(pathById.get(id),closed)}:{})});
  const columnsOf=(id:string,row:{side:'LONG'|'SHORT';gate_signal_side?:unknown;gate_btc_1h_pct?:unknown})=>{try{return pathColumns(pathById.get(id),shadowSignalOf(row));}catch{return null;}};
  const book={trades:[...pathById.values()]} as unknown as TradePathBook;
  const paths=new Map(exportTradePaths(book).map(p=>[p.id,p]));
  const out:ArchiveEntry[]=[];
  const add=(rows:Record<string,unknown>[],kind:'position'|'not_opened')=>{
    for(const row of rows){const id=String(row.id);out.push({id,kind,openedAt:Number(row.opened_at),partial:partial.get(id)===true,row,path:paths.get(id)??null});}
  };
  add(withResearchColumns(file.positions as never[],columnsOf) as Record<string,unknown>[],'position');
  add(withResearchColumns(file.not_opened as never[],columnsOf) as Record<string,unknown>[],'not_opened');
  return out;
}

/** Closed orders whose price path has already left the 1200 book. Oldest first, so the ones about to fall out of the
 *  4000 journal are copied before they disappear. A final archive row is not written again. */
export function journalBackfillIds(rows:readonly {id:string}[],archived:ReadonlyMap<string,boolean>,retryAt:ReadonlyMap<string,number>,inBook:ReadonlySet<string>,now:number,limit:number){
  const ids:string[]=[];
  for(let i=rows.length-1;i>=0&&ids.length<limit;i--){
    const id=rows[i]!.id;
    if(!id||inBook.has(id)||archived.has(id))continue;
    if((retryAt.get(id)??0)>now)continue;
    ids.push(id);
  }
  return ids;
}

/** Order rows only. No path is invented; the export still lists the order so the sequence does not break. */
export function buildJournalArchiveEntries(records:readonly OrderRecord[],now:number):ArchiveEntry[]{
  if(!records.length)return [];
  const file=buildRunLogExport({events:[],funnel:null,health:{},gate:{},exportedAt:now,liveEnabled:false,
    positions:records.map(journalLogRow),notOpened:[],completeOnly:false});
  return (file.positions as Record<string,unknown>[]).map(row=>({id:String(row.id),kind:'position' as const,openedAt:Number(row.opened_at),partial:false,row,path:null}));
}

/** One id, one order. Hot rows win (they are newer). Sorted by open time so an export reads straight through. */
export function mergeContinuousOrders<T extends {id?:unknown;opened_at?:unknown}>(hot:readonly T[],archived:readonly T[]):T[]{
  const byId=new Map<string,T>();
  for(const row of archived){const id=String(row?.id??"");if(id)byId.set(id,row);}
  for(const row of hot){const id=String(row?.id??"");if(id)byId.set(id,row);}
  return [...byId.values()].sort((a,b)=>Number(a.opened_at)-Number(b.opened_at));
}

/** Closed stage-timeline entries whose follow-up is settled and that are newer than the watermark. */
export function dueStages(state:ForwardState,now:number,watermark:number|null,limit=STAGE_BATCH){
  return readStageTimeline(state.stageChronicle,now).filter(e=>!e.open&&e.at<=now-STAGE_SETTLE_MS&&(watermark==null||e.at>watermark)).slice(0,limit);
}
/** The next whole Beijing day of equity minutes to archive (finished at least 30 minutes ago), or null. */
export function nextEquityDay(now:number,accountStartedAt:number,watermark:string|null){
  const first=beijingDayKey(accountStartedAt),today=beijingDayKey(now-30*MIN);
  const day=watermark&&watermark>=first?addDay(watermark):first;
  if(day>=today)return null;
  return day;
}
export function addDay(day:string){const t=Date.parse(`${day}T00:00:00Z`)+DAY;return new Date(t).toISOString().slice(0,10);}

const est=(entries:number)=>entries*3; // row + two index entries

export async function writeArchiveEntries(db:D1Like,entries:readonly ArchiveEntry[],accountStartedAt:number,now:number,stats:ArchiveStats){
  if(!entries.length)return {written:0,inserted:0,rowWrites:0,stats};
  // Serialize before any await: the live path book keeps changing between ticks.
  const ready=entries.map(e=>{const rowJson=JSON.stringify(e.row),pathJson=e.path?JSON.stringify(e.path):null;
    return {e,rowJson,pathJson,bytes:rowJson.length+(pathJson?.length??0)};});
  const ids=entries.map(e=>e.id);
  const known=new Set<string>();
  for(let i=0;i<ids.length;i+=90){
    const chunk=ids.slice(i,i+90);
    const found=await db.prepare(`SELECT id FROM run_log_archive WHERE id IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all<{id:string}>();
    for(const row of found.results)known.add(row.id);
  }
  const next={...stats};let inserted=0;
  const statements:D1Stmt[]=[];
  for(const {e,rowJson,pathJson,bytes} of ready){
    statements.push(db.prepare(UPSERT).bind(e.id,e.kind,accountStartedAt,e.openedAt,now,e.partial?1:0,bytes,rowJson,pathJson));
    if(!known.has(e.id)){
      inserted++;next.records++;next.bytes+=bytes;
      next.firstOpenedAt=next.firstOpenedAt==null?e.openedAt:Math.min(next.firstOpenedAt,e.openedAt);
      next.lastOpenedAt=next.lastOpenedAt==null?e.openedAt:Math.max(next.lastOpenedAt,e.openedAt);
    }
  }
  for(let i=0;i<statements.length;i+=ARCHIVE_STATEMENTS_PER_BATCH){
    const chunk=statements.slice(i,i+ARCHIVE_STATEMENTS_PER_BATCH);
    // Stats ride in the last chunk's transaction, so a failed chunk never counts its rows.
    if(i+ARCHIVE_STATEMENTS_PER_BATCH>=statements.length)chunk.push(db.prepare(META_UPSERT).bind('stats',JSON.stringify(next),now));
    await db.batch(chunk);
  }
  return {written:entries.length,inserted,rowWrites:est(entries.length)+1,stats:next};
}
export async function writeStages(db:D1Like,stages:readonly ReturnType<typeof readStageTimeline>[number][],now:number){
  if(!stages.length)return 0;
  await db.batch(stages.map(s=>db.prepare(`INSERT INTO run_log_stages (at,archived_at,entry_json) VALUES (?,?,?)
    ON CONFLICT(at) DO UPDATE SET entry_json=excluded.entry_json,archived_at=excluded.archived_at WHERE run_log_stages.entry_json IS NOT excluded.entry_json`)
    .bind(s.at,now,JSON.stringify(s))));
  return stages.length;
}
export async function writeEquityDay(db:D1Like,day:string,rows:readonly EquityMinute[],now:number){
  const clean=collectEquityMinutes([[...rows]]);
  await db.prepare(`INSERT INTO run_log_equity_days (day,first_ts,last_ts,archived_at,rows_json) VALUES (?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET first_ts=excluded.first_ts,last_ts=excluded.last_ts,archived_at=excluded.archived_at,rows_json=excluded.rows_json`)
    .bind(day,clean[0]?.ts??null,clean.at(-1)?.ts??null,now,JSON.stringify(clean)).run();
  return 1;
}

export async function readMeta<T>(db:D1Like,key:string):Promise<T|null>{
  const row=await db.prepare(`SELECT value FROM run_log_archive_meta WHERE key=?`).bind(key).first<{value:string}>();
  if(!row)return null;try{return JSON.parse(row.value) as T;}catch{return null;}
}
export async function writeMeta(db:D1Like,key:string,value:unknown,now:number){
  await db.prepare(META_UPSERT).bind(key,JSON.stringify(value),now).run();
}

/* ---------- export ---------- */
export type ArchiveMode='since'|'range'|'all';
export type ArchiveQuery={mode:ArchiveMode;from?:number|null;to?:number|null;cursor?:ArchiveCursor|null};
type StoredRow={id:string;kind:string;opened_at:number;archived_at:number;row_json:string;path_json:string|null};

export const segmentCount=(total:number,size=ARCHIVE_SEGMENT_SIZE)=>total<=0?0:Math.ceil(total/size);

function where(q:ArchiveQuery):{sql:string;binds:unknown[];order:string}{
  if(q.mode==='since'){
    const c=q.cursor;
    return c?{sql:`WHERE (archived_at>? OR (archived_at=? AND id>?))`,binds:[c.at,c.at,c.id],order:`ORDER BY archived_at,id`}
      :{sql:``,binds:[],order:`ORDER BY archived_at,id`};
  }
  if(q.mode==='range'){
    const from=Number.isFinite(q.from)?q.from!:0,to=Number.isFinite(q.to)?q.to!:Number.MAX_SAFE_INTEGER;
    return {sql:`WHERE opened_at>=? AND opened_at<?`,binds:[from,to],order:`ORDER BY opened_at,id`};
  }
  return {sql:``,binds:[],order:`ORDER BY opened_at,id`};
}
export async function countArchive(db:D1Like,q:ArchiveQuery){
  const w=where(q);
  const row=await db.prepare(`SELECT COUNT(*) AS n FROM run_log_archive ${w.sql}`).bind(...w.binds).first<{n:number}>();
  return Number(row?.n??0);
}
/** Delete the long-term archive. One bounded pass. Does not touch the account, the 1200-record book, or open positions. */
export async function pruneRunLog(db:D1Like,_now:number,limit=2_000){
  const arch=await db.prepare(`DELETE FROM run_log_archive WHERE rowid IN (SELECT rowid FROM run_log_archive ORDER BY opened_at LIMIT ?)`).bind(limit).run();
  const stages=await db.prepare(`DELETE FROM run_log_stages WHERE rowid IN (SELECT rowid FROM run_log_stages ORDER BY at LIMIT ?)`).bind(limit).run();
  const equity=await db.prepare(`DELETE FROM run_log_equity_days WHERE rowid IN (SELECT rowid FROM run_log_equity_days ORDER BY day LIMIT ?)`).bind(limit).run();
  const n=(r:unknown)=>{const c=(r as {meta?:{changes?:number}}).meta?.changes;return typeof c==="number"?c:0;};
  return {archive:n(arch),stages:n(stages),equity:n(equity)};
}
/** One segment (1-based). The 'since' mode always reads the first segment after the cursor. */
export async function readSegment(db:D1Like,q:ArchiveQuery,segment:number,size=ARCHIVE_SEGMENT_SIZE){
  const w=where(q),offset=q.mode==='since'?0:Math.max(0,(segment-1)*size),rows:StoredRow[]=[];
  for(let got=0;got<size;){
    const take=Math.min(100,size-got);
    const page=await db.prepare(`SELECT id,kind,opened_at,archived_at,row_json,path_json FROM run_log_archive ${w.sql} ${w.order} LIMIT ? OFFSET ?`)
      .bind(...w.binds,take,offset+got).all<StoredRow>();
    rows.push(...page.results);got+=page.results.length;
    if(page.results.length<take)break;
  }
  return rows;
}
export async function readStagesFor(db:D1Like,from:number,to:number){
  const r=await db.prepare(`SELECT entry_json FROM run_log_stages WHERE at>=? AND at<=? ORDER BY at`).bind(from-DAY,to+DAY).all<{entry_json:string}>();
  return r.results.map(row=>JSON.parse(row.entry_json));
}
export async function readEquityFor(db:D1Like,from:number,to:number){
  const first=beijingDayKey(from),last=beijingDayKey(to);
  const r=await db.prepare(`SELECT day,rows_json FROM run_log_equity_days WHERE day>=? AND day<=? ORDER BY day DESC LIMIT ?`)
    .bind(first,last,EQUITY_SEGMENT_DAYS).all<{day:string;rows_json:string}>();
  const days=r.results.map(row=>row.day);
  const minutes=collectEquityMinutes(r.results.map(row=>JSON.parse(row.rows_json) as EquityMinute[]));
  const spanDays=Math.round((Date.parse(`${last}T00:00:00Z`)-Date.parse(`${first}T00:00:00Z`))/DAY)+1;
  return {minutes,days:days.sort(),truncated:spanDays>EQUITY_SEGMENT_DAYS};
}

/** A standalone file with the same top-level keys as the live run-log export, rows exactly as archived. */
export function buildArchiveFile(input:{rows:readonly StoredRow[];stages:unknown[];equity:{minutes:EquityMinute[];days:string[];truncated:boolean};
  exportedAt:number;mode:ArchiveMode;segment:number;segments:number;total:number;from:number|null;to:number|null}){
  const positions:Record<string,unknown>[]=[],notOpened:Record<string,unknown>[]=[],paths:PathExport[]=[];
  for(const r of input.rows){
    const row=JSON.parse(r.row_json) as Record<string,unknown>;
    (r.kind==='position'?positions:notOpened).push(row);
    if(r.path_json)paths.push(JSON.parse(r.path_json) as PathExport);
  }
  const base=buildRunLogExport({events:[],funnel:null,health:{},gate:{},exportedAt:input.exportedAt,liveEnabled:false,
    positions:[],notOpened:[],stageTimeline:input.stages as never,equityMinutes:input.equity.minutes,completeOnly:true});
  const opened=input.rows.map(r=>r.opened_at);
  return {...base,
    log_completeness:{...(base as {log_completeness?:Record<string,unknown>}).log_completeness,positions_shown:positions.length,not_opened_shown:notOpened.length},
    positions,not_opened:notOpened,
    equity_minutes_since:input.equity.minutes[0]?.ts??null,
    equity_gaps:(()=>{try{return equityGaps(input.equity.minutes);}catch{return [];}})(),
    equity_filled_min:input.equity.minutes.filter(row=>row.filled).length,
    researchNotes:RESEARCH_NOTES,archive_read:{rows:input.rows.length,missing:0},path_check:true,paths,
    holding:{trades:paths.length,best:null,profitable:false,verdict:'归档分段不重算固定止盈止损扫描；需要时用 paths 自己算。'},
    archive:{version:ARCHIVE_VERSION,mode:input.mode,segment:input.segment,segments:input.segments,total:input.total,
      segment_rows:input.rows.length,from:input.from,to:input.to,
      opened_first:opened.length?Math.min(...opened):null,opened_last:opened.length?Math.max(...opened):null,
      equity_days:input.equity.days,equity_truncated:input.equity.truncated,
      note:'长期归档里的一段。每条记录和 paths 与当时运行日志导出里的完全一样，可以按 id 合并；stageTimeline 和 equity_minutes 只带这一段时间附近的。'}};
}

/** File name: mode, range and segment. */
export function archiveFileName(input:{mode:ArchiveMode;segment:number;segments:number;from?:number|null;to?:number|null;openedFirst?:number|null;openedLast?:number|null}){
  const day=(v:number|null|undefined)=>v==null||!Number.isFinite(v)?'x':new Date(v+8*H).toISOString().slice(0,16).replace(/[-:T]/g,'');
  const range=input.mode==='range'?`${day(input.from)}-${day(input.to)}`:`${day(input.openedFirst)}-${day(input.openedLast)}`;
  return `lsr-run-log-archive-${input.mode}-${range}-seg${input.segment}of${Math.max(1,input.segments)}.json`;
}
