/**
 * Empties the D1 long-term run-log archive. The run log itself is the 1200-record book in the account.
 * Nothing here writes Durable Object storage or touches an order. A failed pass only records its error.
 */
import type {ForwardState, Trade} from './forward-relations.ts';
import type {OrderJournal} from './order-journal.ts';
import type {EquityMinute} from './equity-minutes.ts';
import type {TradePathBook} from './trade-path.ts';
import {ARCHIVE_BATCH,ARCHIVE_DAILY_ROW_WRITES,ARCHIVE_VERSION,ensureArchiveSchema,pruneRunLog,type ArchiveExportMark,type ArchiveStats,type D1Like} from './run-log-archive.ts';

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
const BEHIND_EVERY_MS=60_000,CAUGHT_UP_EVERY_MS=5*60_000,MAX_BACKOFF_MS=30*60_000;
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
  /** Make D1 readable before the background pass has run (a restart otherwise reports "not ready" and zero rows). */
  async ensureSchema(){
    try{
      const db=this.deps.db();if(!db)return false;
      if(!this.status.schemaReady){await ensureArchiveSchema(db);this.status.schemaReady=true;}
      return true;
    }catch(error){this.status.lastError=safe(error);this.status.lastErrorAt=Date.now();this.status.error=this.status.lastError;return false;}
  }
  /** After the run-log wipe emptied the D1 tables: forget what was archived and reload from D1 on the next pass. */
  reset(now:number){
    const s=this.status;this.archived.clear();this.retryAt.clear();
    this.status={...s,loaded:false,backfillDone:false,recordsThisBoot:0,rejectedThisBoot:0,stagesThisBoot:0,equityDaysThisBoot:0,pending:0,
      stats:{records:0,bytes:0,firstOpenedAt:null,lastOpenedAt:null},stageWatermark:null,equityWatermark:null,lastExport:null,lastRunAt:null,
      error:null,failures:0,day:s.day||utcDay(now)};
  }
  /** One pass. Never throws. */
  async step(input:{now:number;state:ForwardState;book:TradePathBook|null;journal:OrderJournal|null}):Promise<void>{
    if(this.busy)return;this.busy=true;
    const {now}=input,s=this.status;s.lastRunAt=now;
    try{
      const db=this.deps.db();if(!db)throw new Error('D1 binding missing');
      if(s.day!==utcDay(now)){s.day=utcDay(now);s.rowWritesToday=0;s.budgetDeferred=false;}
      if(!s.schemaReady){await ensureArchiveSchema(db);s.schemaReady=true;}
      // The long-term copy is gone. A pass only deletes what is still in D1. The 1200-record book is not touched.
      await pruneRunLog(db,now);
      s.loaded=true;s.pending=0;s.backfillDone=true;s.lastOkAt=now;s.error=null;s.failures=0;
    }catch(error){
      s.lastError=safe(error);s.lastErrorAt=now;s.error=s.lastError;s.failures++;
    }finally{this.busy=false;}
  }
}
