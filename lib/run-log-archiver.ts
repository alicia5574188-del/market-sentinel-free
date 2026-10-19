/**
 * Drives the D1 run-log archive in small passes. State is in memory only (rebuilt from D1 after a restart);
 * it never writes Durable Object storage and never touches the account. A failed pass only records its error.
 */
import type {ForwardState, Trade} from './forward-relations.ts';
import type {OrderJournal} from './order-journal.ts';
import type {EquityMinute} from './equity-minutes.ts';
import type {TradePathBook} from './trade-path.ts';
import {ARCHIVE_BATCH,ARCHIVE_DAILY_ROW_WRITES,ARCHIVE_VERSION,buildArchiveEntries,dueRecords,dueStages,ensureArchiveSchema,nextEquityDay,
  readMeta,sourceRows,writeArchiveEntries,writeEquityDay,writeStages,type ArchiveExportMark,type ArchiveStats,type D1Like} from './run-log-archive.ts';

export type ArchiveStatus={version:typeof ARCHIVE_VERSION;schemaReady:boolean;loaded:boolean;backfillDone:boolean;
  lastRunAt:number|null;lastOkAt:number|null;lastError:string|null;lastErrorAt:number|null;error:string|null;failures:number;
  day:string;rowWritesToday:number;budgetPerDay:number;budgetDeferred:boolean;
  recordsThisBoot:number;rejectedThisBoot:number;stagesThisBoot:number;equityDaysThisBoot:number;
  pending:number;stats:ArchiveStats;stageWatermark:number|null;equityWatermark:string|null;lastExport:ArchiveExportMark|null};
export type ArchiverDeps={
  db:()=>D1Like|null;
  /** Cold not-opened rows (DO storage reads only). */
  readCold:(ids:string[])=>Promise<Trade[]>;
  /** One Beijing day of stored equity minutes (DO storage read only). */
  readEquityDay:(day:string)=>Promise<EquityMinute[]|null>;
};
const RETRY_INCOMPLETE_MS=60*60_000,BEHIND_EVERY_MS=60_000,CAUGHT_UP_EVERY_MS=5*60_000,MAX_BACKOFF_MS=30*60_000;
const utcDay=(now:number)=>new Date(now).toISOString().slice(0,10);
const safe=(error:unknown)=>(error instanceof Error?error.message:String(error)).slice(0,300);

export class RunLogArchiver{
  status:ArchiveStatus;
  private archived=new Map<string,boolean>(); // id -> partial?
  private retryAt=new Map<string,number>();
  private busy=false;
  private deps:ArchiverDeps;
  constructor(deps:ArchiverDeps,now=Date.now()){
    this.deps=deps;
    this.status={version:ARCHIVE_VERSION,schemaReady:false,loaded:false,backfillDone:false,lastRunAt:null,lastOkAt:null,lastError:null,lastErrorAt:null,
      error:null,failures:0,day:utcDay(now),rowWritesToday:0,budgetPerDay:ARCHIVE_DAILY_ROW_WRITES,budgetDeferred:false,
      recordsThisBoot:0,rejectedThisBoot:0,stagesThisBoot:0,equityDaysThisBoot:0,pending:0,
      stats:{records:0,bytes:0,firstOpenedAt:null,lastOpenedAt:null},stageWatermark:null,equityWatermark:null,lastExport:null};
  }
  /** Caught up: loaded, backfill done, no error, nothing due beyond one batch, and a pass succeeded recently. */
  healthy(now:number){
    const s=this.status;
    return s.loaded&&s.backfillDone&&s.error==null&&s.pending<=ARCHIVE_BATCH&&s.lastOkAt!=null&&now-s.lastOkAt<=20*60_000;
  }
  due(now:number){
    if(this.busy)return false;
    const s=this.status;if(s.lastRunAt==null)return true;
    const every=s.failures>0?Math.min(MAX_BACKOFF_MS,BEHIND_EVERY_MS*2**Math.min(5,s.failures))
      :s.pending>ARCHIVE_BATCH||!s.backfillDone?BEHIND_EVERY_MS:CAUGHT_UP_EVERY_MS;
    return now-s.lastRunAt>=every;
  }
  noteExport(mark:ArchiveExportMark){this.status.lastExport=mark;}
  /** One pass. Never throws. */
  async step(input:{now:number;state:ForwardState;book:TradePathBook|null;journal:OrderJournal|null}):Promise<void>{
    if(this.busy)return;this.busy=true;
    const {now,state}=input,s=this.status;s.lastRunAt=now;
    try{
      const db=this.deps.db();if(!db)throw new Error('D1 binding missing');
      if(s.day!==utcDay(now)){s.day=utcDay(now);s.rowWritesToday=0;s.budgetDeferred=false;}
      if(!s.schemaReady){await ensureArchiveSchema(db);s.schemaReady=true;}
      const book=input.book&&input.book.accountStartedAt===state.startedAt?input.book:null;
      if(!s.loaded){
        if(!book||!input.journal)return; // wait until the book and journal are loaded for this account
        const oldest=book.trades.reduce((m,row)=>Math.min(m,row.openedAt),Infinity);
        if(Number.isFinite(oldest)){
          const known=await db.prepare(`SELECT id,partial FROM run_log_archive WHERE opened_at>=?`).bind(oldest-1).all<{id:string;partial:number}>();
          for(const row of known.results)this.archived.set(row.id,row.partial===1);
        }
        s.stats=(await readMeta<ArchiveStats>(db,'stats'))??s.stats;
        s.lastExport=await readMeta<ArchiveExportMark>(db,'last_export');
        s.stageWatermark=(await db.prepare(`SELECT MAX(at) AS m FROM run_log_stages`).first<{m:number|null}>())?.m??null;
        s.equityWatermark=(await db.prepare(`SELECT MAX(day) AS m FROM run_log_equity_days`).first<{m:string|null}>())?.m??null;
        s.loaded=true;
      }
      // records
      if(book){
        const {due,pending}=dueRecords(book.trades,now,this.archived,this.retryAt,ARCHIVE_BATCH);
        s.pending=pending;
        const budgetLeft=s.budgetPerDay-s.rowWritesToday;
        if(due.length&&budgetLeft<due.length*3+1){s.budgetDeferred=true;}
        else if(due.length){
          const ids=new Set(due.map(d=>d.path.id));
          let rows=sourceRows(ids,state,input.journal,[]);
          const missing=[...ids].filter(id=>!rows.has(id));
          if(missing.length){
            let cold:Trade[]=[];try{cold=await this.deps.readCold(missing);}catch{cold=[];}
            if(cold.length)rows=sourceRows(ids,state,input.journal,cold);
          }
          const entries=buildArchiveEntries({due,rows,tallySince:state.signalTallyMeta?.from??null,now});
          const written=await writeArchiveEntries(db,entries,state.startedAt,now,s.stats);
          s.stats=written.stats;s.rowWritesToday+=written.rowWrites;s.recordsThisBoot+=written.written;
          const done=new Set(entries.map(e=>e.id));
          for(const e of entries)this.archived.set(e.id,e.partial);
          for(const d of due)if(!done.has(d.path.id)){this.retryAt.set(d.path.id,now+RETRY_INCOMPLETE_MS);s.rejectedThisBoot++;}
          s.pending=Math.max(0,pending-entries.length-(due.length-entries.length));
        }
        if(s.pending===0||(due.length===0))s.backfillDone=true;
        // forget ids that left the book
        if(this.archived.size>book.trades.length*2){const live=new Set(book.trades.map(r=>r.id));for(const id of this.archived.keys())if(!live.has(id))this.archived.delete(id);}
        for(const [id,at] of this.retryAt)if(at<=now)this.retryAt.delete(id);
      }
      // stage timeline
      const stages=dueStages(state,now,s.stageWatermark);
      if(stages.length&&s.rowWritesToday+stages.length*2<=s.budgetPerDay){
        s.stagesThisBoot+=await writeStages(db,stages,now);s.rowWritesToday+=stages.length*2;
        s.stageWatermark=Math.max(s.stageWatermark??0,...stages.map(e=>e.at));
      }
      // equity minutes: one finished Beijing day per pass
      const day=nextEquityDay(now,state.startedAt,s.equityWatermark);
      if(day&&s.rowWritesToday+2<=s.budgetPerDay){
        const rows=await this.deps.readEquityDay(day);
        if(rows&&rows.length){s.equityDaysThisBoot+=await writeEquityDay(db,day,rows,now);s.rowWritesToday+=2;}
        s.equityWatermark=day; // an empty day (worker down all day) is skipped, not retried forever
      }
      s.lastOkAt=now;s.error=null;s.failures=0;
    }catch(error){
      s.lastError=safe(error);s.lastErrorAt=now;s.error=s.lastError;s.failures++;
    }finally{this.busy=false;}
  }
}
